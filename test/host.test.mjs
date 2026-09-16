/**
 * Host 半身集成测试：驱动**真实的工具定义与 HTTP 路由**，而不是断言产物字符串。
 *
 * 为什么值得单独一个文件：`store.test.mjs` 只测数据层的纯函数，`build.test.mjs`
 * 只断言产物里「有没有这些字符串」。两者都挡不住一类真实故障——工具接错
 * store 的哪个函数、路由忘了带上 sessionId、参数名写错。这里用一个假的
 * Cordis 上下文把插件真跑一遍，覆盖的正是「agent 与面板的写入路径」。
 *
 * 假上下文只实现两件事：`tools.register` 收集工具、`inject(['webServer'])`
 * 收集路由（顺带验证 webServer 不存在时工具照常可用）。
 */

import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, readdir, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { apply } from '../src/index.js'

const SESSION_ID = 'session-1'

let dir = ''
let tools = new Map()
let routes = new Map()

/**
 * 三个**可选**的宿主服务。默认全是 null（= 宿主没装），用例要用就自己装上：
 * AI 入口必须在这三个都缺失时也能给出人话错误，而不是崩在 ctx.get 上。
 */
let fakeLlm = null
let fakeAttachments = null
let fakeDefaultModel = null

/** 一个按脚本回话的假模型：只发 text-delta + finish，够覆盖解析路径。 */
function llmReturning(text, opts = {}) {
  const calls = []
  return {
    calls,
    resolveModelInfo: async () => ({ inputModalities: opts.modalities === undefined ? ['text', 'image'] : opts.modalities }),
    stream: async function* (options) {
      calls.push(options)
      yield { type: 'text-delta', text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

/** 假附件库：只记录收到了什么，返回一个够用的 ImageAttachmentRef。 */
function attachmentsReturning() {
  const saved = []
  return {
    saved,
    saveImages: async (inputs) => inputs.map((input, i) => {
      saved.push({ bytes: input.data.length, mediaType: input.mediaType, name: input.name })
      return {
        attachmentId: 'att' + i, mediaType: input.mediaType,
        bytes: input.data.length, width: 1, height: 1, name: input.name,
      }
    }),
  }
}

/** 假 Cordis 上下文。 */
function bootstrap() {
  const t = new Map()
  const r = new Map()
  const serverCtx = {
    webServer: {
      register: (def) => {
        r.set(def.path, def.handler)
        return () => {}
      },
    },
    get: (name) => {
      if (name === 'agents') {
        return { list: () => [{ session: { header: { id: SESSION_ID, cwd: dir } } }] }
      }
      if (name === 'llm') return fakeLlm
      if (name === 'attachments') return fakeAttachments
      if (name === 'agentDefaultModel') return fakeDefaultModel
      return undefined
    },
  }
  const ctx = {
    tools: { register: (tool) => { t.set(tool.name, tool); return () => {} } },
    // 宿主没有 webServer 时不会回调；这里模拟「有」，以便同时测数据面。
    inject: (deps, fn) => { if (deps.includes('webServer')) fn(serverCtx) },
    effect: () => {},
  }
  apply(ctx)
  return { tools: t, routes: r }
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-wb-host-'))
  const booted = bootstrap()
  tools = booted.tools
  routes = booted.routes
})

after(async () => {
  if (dir !== '') await rm(dir, { recursive: true, force: true })
})

// 每个用例前把三个可选服务摘掉：宿主没装模型插件是**默认情形**，
// 想测「有模型」的用例自己装。不重置的话前一个用例的假模型会漏进后面，
// 表现是「明明没装 llm，/ai-parse 却成功了」。
beforeEach(() => {
  fakeLlm = null
  fakeAttachments = null
  fakeDefaultModel = null
})

/** 调一个工具（模拟 agent 调用：会话 header 里带 cwd）。 */
const call = (name, args) => tools.get(name).execute(args ?? {}, { agent: { session: { header: { cwd: dir } } } })

/** 调一个 HTTP 路由（模拟浏览器面板：body 里带 sessionId）。 */
async function post(path, body) {
  const handler = routes.get('/api/workbench' + path)
  assert.ok(handler, '缺少路由 ' + path)
  let payload = null
  const res = {
    statusCode: 200,
    writeHead(code) { this.statusCode = code },
    end(text) { payload = JSON.parse(text) },
  }
  await handler(Readable.from([JSON.stringify(body)]), res)
  return { status: res.statusCode, payload }
}

const readPlan = async () => JSON.parse(await readFile(join(dir, 'plan', 'plan.json'), 'utf8'))

/** 在整棵树里按 id 找节点（面板拿到的形态是嵌套的，测试里要能挖到）。 */
const dig = (nodes, id) => {
  for (const node of nodes ?? []) {
    if (node.id === id) return node
    const hit = dig(node.children, id)
    if (hit !== undefined) return hit
  }
  return undefined
}

/** 把嵌套树摊平——节点可能被移到任意深度，按标题找东西时用它。 */
const flatNodes = (nodes) => (nodes ?? []).reduce((acc, n) => acc.concat([n], flatNodes(n.children)), [])

// ------------------------------------------------------------------ 注册面

test('注册了完整的工具集（节点模型：增删改移 + 待办状态 + 委派 + 留档 + 文件库关联）', () => {
  const expected = [
    'plan_show', 'plan_node_add', 'plan_node_set', 'plan_node_move', 'plan_node_remove',
    'plan_todo_set', 'plan_priority_set',
    'plan_delegate_set', 'plan_delegate_receipt', 'plan_delegated',
    'plan_snapshot', 'plan_history', 'plan_restore',
    'plan_config_set', 'plan_file_read',
  ]
  assert.deepEqual([...tools.keys()].sort(), expected.slice().sort())
})

test('注册了 HTTP 数据面路由', () => {
  // /ai-parse 是 AI 入口的解析口（只解析、不写入），写操作仍走 node-* / todo-set。
  assert.deepEqual(
    [...routes.keys()].sort(),
    ['/api/workbench/ai-parse', '/api/workbench/config-set', '/api/workbench/file-read',
      '/api/workbench/get', '/api/workbench/history',
      '/api/workbench/init', '/api/workbench/node-add', '/api/workbench/node-move',
      '/api/workbench/node-remove', '/api/workbench/node-set', '/api/workbench/snapshot',
      '/api/workbench/todo-set'].sort(),
  )
})

test('会话没有 cwd 时报可读错误，而不是写到别处', async () => {
  await assert.rejects(
    () => tools.get('plan_show').execute({}, { agent: { session: { header: {} } } }),
    /没有工作区目录/,
  )
})

// ------------------------------------------------------------------ 建树

test('plan_node_add 可以建计划、子计划、任意深度的待办', async () => {
  const g = await call('plan_node_add', { title: '完成低电压治理攻坚', type: 'plan', owner: '张三', start: '2026-10-01', end: '2026-12-31' })
  assert.equal(g.ok, true)
  assert.equal(g.node.type, 'plan')

  const k = await call('plan_node_add', { title: '建立治理台账', type: 'plan', parent: '完成低电压治理攻坚' })
  assert.equal(k.node.type, 'plan')
  // 子计划下再挂待办
  const t = await call('plan_node_add', { title: '收集基础数据', parent: k.node.id, due: '2026-11-01' })
  assert.equal(t.node.type, 'todo', '不传 type 默认待办')

  const plan = await readPlan()
  assert.equal(plan.schema, 2)
  assert.equal(plan.nodes.length, 1)
  const root = plan.nodes[0]
  assert.equal(root.children.length, 1)
  assert.equal(root.children[0].children.length, 1, '待办挂在第二层')
  assert.equal(root.children[0].children[0].title, '收集基础数据')
})

test('plan_node_add 不传 parent 就放在顶层（即收件箱）', async () => {
  const r = await call('plan_node_add', { title: '开会时记的一条' })
  assert.equal(r.ok, true)
  const plan = await readPlan()
  const top = plan.nodes[plan.nodes.length - 1]
  assert.equal(top.id, r.node.id, '顶层待办')
  assert.equal(top.type, 'todo')

  const shown = await call('plan_show')
  assert.equal(shown.plan.control.inboxOpen, 1)
})

test('plan_node_add 拒绝非法的 type / 空标题 / 挂到待办下', async () => {
  await assert.rejects(() => call('plan_node_add', { title: 'x', type: '目标' }), /type 必须是 plan \/ todo/)
  await assert.rejects(() => call('plan_node_add', { title: '   ' }), /标题不能为空/)
  await assert.rejects(
    () => call('plan_node_add', { title: 'x', parent: '开会时记的一条' }),
    /是待办，不能往里放子项/,
  )
})

test('plan_show 返回递归树与派生标注（进度、管控、委派清单）', async () => {
  const r = await call('plan_show')
  assert.equal(r.ok, true)
  const root = r.plan.nodes[0]
  assert.equal(root.type, 'plan')
  assert.equal(root.priority, 'normal', '缺省补成 normal，前端不必兜底')
  assert.equal(typeof root.progress, 'number')
  assert.ok(Array.isArray(root.warnings))
  assert.ok(r.plan.control, '应该带管控汇总')
  assert.ok(Array.isArray(r.plan.delegated))
  assert.equal(r.plan.nodes[0].children[0].children[0].progress, 0, '待办没完成 → 0')
})

test('plan_show 能读到老格式的 plan.json（读时自动迁移，无需手工步骤）', async () => {
  const legacy = {
    version: 3,
    title: '老计划',
    goals: [{
      id: 'g1', title: '老目标', status: 'active',
      krs: [{ id: 'k1', title: '老 KR', status: 'active', target: 4, current: 1, unit: '个', tasks: [{ id: 't1', title: '老任务', status: 'todo' }] }],
    }],
    inbox: [{ id: 't9', title: '老收件箱项', status: 'todo' }],
  }
  const file = join(dir, 'plan', 'plan.json')
  const backup = await readFile(file, 'utf8')
  await writeFile(file, JSON.stringify(legacy), 'utf8')

  const r = await call('plan_show')
  assert.equal(r.plan.schema, 2)
  assert.equal(r.plan.nodes.length, 2)
  assert.equal(r.plan.nodes[0].children[0].metric.target, 4)
  assert.equal(r.plan.nodes[1].id, 't9', '收件箱项变成顶层待办')

  // 一次写入后就落成新格式
  await call('plan_node_set', { node: 't9', status: 'done' })
  const onDisk = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(onDisk.schema, 2)
  assert.equal(onDisk.goals, undefined)

  await writeFile(file, backup, 'utf8')
})

// ------------------------------------------------------------- 勾选与归位

test('勾一条子计划下的待办，自动写 doneAt', async () => {
  const r = await call('plan_todo_set', { todo: '收集基础数据', status: 'done' })
  assert.equal(r.ok, true)
  assert.equal(r.todo.status, 'done')
  assert.ok(r.todo.doneAt, '完成时应该写入 doneAt')

  const plan = await readPlan()
  assert.equal(plan.nodes[0].children[0].children[0].status, 'done')
  assert.ok(plan.nodes[0].children[0].children[0].doneAt)
})

test('勾一条收件箱里的待办（顶层待办也要能定位到）', async () => {
  const shown = await call('plan_show')
  const top = shown.plan.nodes[shown.plan.nodes.length - 1]
  const r = await call('plan_todo_set', { todo: top.id, status: 'done' })
  assert.equal(r.ok, true)

  const plan = await readPlan()
  const last = plan.nodes[plan.nodes.length - 1]
  assert.equal(last.status, 'done')
})

test('plan_todo_set 只接受待办，误传计划时给出可读错误', async () => {
  await assert.rejects(
    () => call('plan_todo_set', { todo: '完成低电压治理攻坚', status: 'done' }),
    /找不到 待办/,
  )
})

test('plan_node_move 把收件箱待办归位到计划下（本次新增的关键能力）', async () => {
  const added = await call('plan_node_add', { title: '待归位的待办' })
  const targetsBefore = await call('plan_show')
  assert.equal(targetsBefore.plan.control.inboxOpen >= 1, true, '先在收件箱里')

  const shown = await call('plan_show')
  const kId = shown.plan.nodes[0].children.find((x) => x.title === '建立治理台账').id

  const r = await call('plan_node_move', { node: added.node.id, parent: kId })
  assert.equal(r.ok, true)
  assert.equal(r.from, null, '原来在顶层')
  assert.equal(r.to, kId)

  const plan = await readPlan()
  const k = plan.nodes[0].children[0]
  assert.ok(k.children.some((x) => x.id === added.node.id), '已挂到子计划下')
})

test('plan_node_move 支持移回顶层与同层重排', async () => {
  // 移回顶层 = 省略 parent（工具参数不接受 null）
  const r = await call('plan_node_move', { node: '待归位的待办' })
  assert.equal(r.to, null)
  const plan = await readPlan()
  assert.ok(plan.nodes.some((x) => x.title === '待归位的待办'))

  const shown = await call('plan_show')
  const kId = shown.plan.nodes[0].children.find((x) => x.title === '建立治理台账').id
  await call('plan_node_move', { node: '待归位的待办', parent: kId, index: 0 })
  const after = await readPlan()
  assert.equal(after.nodes[0].children[0].children[0].title, '待归位的待办', '落在第一个位置')
})

test('plan_node_move 拒绝把计划移到自己的子孙下面（否则成环）', async () => {
  await assert.rejects(
    () => call('plan_node_move', { node: '建立治理台账', parent: '建立治理台账' }),
    /不能把一个节点移到它自己下面/,
  )
  await assert.rejects(
    () => call('plan_node_move', { node: '建立治理台账', parent: '待归位的待办' }),
    /是待办，不能作为父节点/,
  )
})

test('plan_node_remove 删计划会连带子树，并报告删了多少', async () => {
  const added = await call('plan_node_add', { title: '待删除的子计划', type: 'plan', parent: '建立治理台账' })
  await call('plan_node_add', { title: '会被一起删掉', parent: added.node.id })

  const r = await call('plan_node_remove', { node: '待删除的子计划' })
  assert.equal(r.ok, true)
  assert.equal(r.removed.stats.plans, 1)
  assert.equal(r.removed.stats.todos, 1, '子项被连带删除，且提前告知了数量')

  const plan = await readPlan()
  assert.equal(dig(plan.nodes, added.node.id), undefined)
})

// ------------------------------------------------------- 重要程度与管控警告

test('高重要度的计划缺周期与负责人时给出警告（而不是拦下）', async () => {
  const r = await call('plan_node_add', { title: 'Q4 数据治理专项', type: 'plan', priority: 'high' })
  assert.equal(r.node.type, 'plan')
  assert.equal(r.warnings.length, 2, '应同时缺周期与负责人：' + JSON.stringify(r.warnings))
  assert.match(r.warnings.join('；'), /周期/)
  assert.match(r.warnings.join('；'), /负责人/)
})

test('补齐周期与负责人后警告消失', async () => {
  const r = await call('plan_node_set', {
    node: 'Q4 数据治理专项',
    owner: '张三',
    start: '2026-10-01',
    end: '2026-12-31',
  })
  assert.equal(r.warnings.length, 0)
  const plan = await readPlan()
  assert.equal(plan.nodes.find((x) => x.title === 'Q4 数据治理专项').owner, '张三')
})

test('中重要度的待办缺截止时提示，低重要度不打扰', async () => {
  const mid = await call('plan_node_add', { title: '中等的没有截止' })
  assert.match(mid.warnings.join('；'), /截止/)
  const low = await call('plan_node_add', { title: '低等的没有截止', priority: 'low' })
  assert.deepEqual(low.warnings, [])
})

test('plan_priority_set 对任意节点生效，并能按标题定位', async () => {
  const r = await call('plan_priority_set', { node: '中等的没有截止', priority: 'high' })
  assert.equal(r.node.priority, 'high')
  assert.match(r.warnings.join('；'), /截止/)
  const plan = await readPlan()
  assert.equal(plan.nodes.find((t) => t.title === '中等的没有截止').priority, 'high')
})

test('非法的 priority 被拒绝', async () => {
  await assert.rejects(() => call('plan_priority_set', { node: '中等的没有截止', priority: 'urgent' }), /priority 必须是/)
})

test('plan_node_set 能改标题、备注与量化进度', async () => {
  const r = await call('plan_node_set', {
    node: '完成低电压治理攻坚',
    title: '完成低电压治理攻坚（Q4）',
    note: '重点专项',
    target: 12,
    current: 4,
    unit: '个',
  })
  assert.equal(r.node.title, '完成低电压治理攻坚（Q4）')
  const plan = await readPlan()
  const g = plan.nodes.find((x) => x.id === r.node.id)
  assert.deepEqual(g.metric, { target: 12, current: 4, unit: '个' })
  assert.equal(g.note, '重点专项')
})

test('plan_node_set 按类型校验状态取值', async () => {
  await assert.rejects(() => call('plan_node_set', { node: '中等的没有截止', status: 'active' }), /待办的状态必须是/)
  await assert.rejects(() => call('plan_node_set', { node: 'Q4 数据治理专项', status: 'doing' }), /计划的状态必须是/)
})

test('plan_node_set 换型：待办提升为计划后就能往下拆', async () => {
  // 场景：开会时随手记了一条，事后发现这事得拆开做。
  const made = await call('plan_node_add', { title: '事后发现要拆的一条' })
  assert.equal(made.node.type, 'todo')

  const up = await call('plan_node_set', { node: made.node.id, type: 'plan' })
  assert.equal(up.node.type, 'plan')
  const plan = await readPlan()
  assert.deepEqual(dig(plan.nodes, made.node.id).children, [], '计划恒带 children 数组')

  // 提升之后才能往它下面挂东西——待办是叶子，之前会被拒。
  const kid = await call('plan_node_add', { title: '拆出来的第一步', parent: made.node.id })
  assert.equal(kid.node.type, 'todo')

  // 空计划可以降回待办；有子节点的则必须被拒（孩子们会变成孤儿）。
  const empty = await call('plan_node_add', { title: '其实不用拆的空计划', type: 'plan' })
  const down = await call('plan_node_set', { node: empty.node.id, type: 'todo' })
  assert.equal(down.node.type, 'todo')
  assert.ok(!('children' in down.node), '降回待办不留空的 children 键')
  await assert.rejects(
    () => call('plan_node_set', { node: made.node.id, type: 'todo' }),
    /还有 1 个子节点，不能降级为待办/,
  )
  await assert.rejects(() => call('plan_node_set', { node: '不存在的节点', type: 'plan' }), /找不到/)
  await assert.rejects(() => call('plan_node_set', { node: made.node.id, type: '目标' }), /节点类型必须是/)

  // 收拾干净——后面的用例依赖树里的节点数量与委派/计数，别留残留。
  await call('plan_node_remove', { node: made.node.id })
  await call('plan_node_remove', { node: empty.node.id })
})

// ---------------------------------------------------------------------- 委派

test('建立委派：回执初始为待接受', async () => {
  await call('plan_node_add', { title: '给张三的活' })
  const r = await call('plan_delegate_set', {
    node: '给张三的活',
    to: '张三',
    expectAt: '2026-09-20',
  })
  assert.equal(r.delegate.status, 'pending')
  assert.equal(r.delegate.to, '张三')
  assert.equal(r.delegate.overdueReceipt, false)
})

test('plan_delegated 列出委派出去的事项（含类型与期望时间）', async () => {
  const r = await call('plan_delegated')
  assert.equal(r.ok, true)
  assert.equal(r.items.length, 1)
  assert.equal(r.items[0].delegate.expectAt, '2026-09-20')
  assert.equal(r.items[0].typeLabel, '待办')
})

test('过期的委派被标成逾期未回执，并出现在节点警告里', async () => {
  await call('plan_node_add', { title: '给李四的活' })
  await call('plan_delegate_set', { node: '给李四的活', to: '李四', expectAt: '2000-01-01' })
  const r = await call('plan_delegated')
  assert.equal(r.items[0].delegate.overdueReceipt, true, '逾期项应排在前面')

  const got = await call('plan_show')
  const node = got.plan.nodes.find((t) => t.title === '给李四的活')
  assert.equal(node.delegateState.overdueReceipt, true)
  assert.match(node.warnings.join('；'), /逾期未回执/)
})

test('记回执：改成已接受后不再算逾期未回执', async () => {
  const r = await call('plan_delegate_receipt', { node: '给李四的活', status: 'accepted', note: '已接单' })
  assert.equal(r.delegate.status, 'accepted')
  assert.equal(r.delegate.overdueReceipt, false)
  assert.equal(r.delegate.overdueWork, true, '过期的活仍然是逾期未完成')
})

test('没有委派记录时不能直接记回执', async () => {
  await assert.rejects(() => call('plan_delegate_receipt', { node: '中等的没有截止', status: 'accepted' }), /还没有委派记录/)
})

test('重新委派会重置回执并刷新委派时间', async () => {
  const before = await call('plan_delegate_set', { node: '给张三的活', to: '张三', expectAt: '2026-09-20' })
  await call('plan_delegate_receipt', { node: '给张三的活', status: 'accepted' })
  const after = await call('plan_delegate_set', { node: '给张三的活', to: '王五', expectAt: '2026-09-25' })
  assert.equal(after.delegate.to, '王五')
  assert.equal(after.delegate.status, 'pending')
  assert.equal(before.delegate.status, 'pending')
})

// ---------------------------------------------------------------- 时间戳

test('状态流转维护 doneAt / startedAt', async () => {
  const added = await call('plan_node_add', { title: '带时间戳的待办' })
  const id = added.node.id

  const doing = await call('plan_todo_set', { todo: id, status: 'doing' })
  assert.ok(doing.todo.startedAt, '进入进行中应记 startedAt')
  const startedAt = doing.todo.startedAt

  const done = await call('plan_todo_set', { todo: id, status: 'done' })
  assert.ok(done.todo.doneAt, '完成应记 doneAt')
  assert.equal(done.todo.startedAt, startedAt, 'startedAt 只在首次写入')

  const again = await call('plan_todo_set', { todo: id, status: 'done' })
  assert.equal(again.todo.doneAt, done.todo.doneAt, '重复标记完成不应刷新时间')

  const back = await call('plan_todo_set', { todo: id, status: 'todo' })
  assert.equal(back.todo.doneAt, undefined, '离开 done 要清掉 doneAt，否则周报会重复统计')
})

test('计划的完成也会写入 doneAt', async () => {
  const r = await call('plan_node_set', { node: 'Q4 数据治理专项', status: 'done' })
  assert.ok(r.node.doneAt)
})

// -------------------------------------------------- HTTP 面板写入路径

test('HTTP /node-add 记一条到收件箱', async () => {
  const { status, payload } = await post('/node-add', { sessionId: SESSION_ID, title: '面板记的一条' })
  assert.equal(status, 200)
  assert.equal(payload.ok, true)
  const plan = await readPlan()
  assert.ok(plan.nodes.some((t) => t.title === '面板记的一条'))
})

test('HTTP /node-add 能在指定计划下加子计划', async () => {
  const { payload } = await post('/node-add', {
    sessionId: SESSION_ID, title: '面板加的子计划', type: 'plan', parent: '建立治理台账',
  })
  assert.equal(payload.node.type, 'plan')
  const plan = await readPlan()
  assert.ok(plan.nodes[0].children[0].children.some((x) => x.type === 'plan' && x.title === '面板加的子计划'))
})

test('HTTP /todo-set 能勾选深层待办（面板与 agent 共用一条写入路径）', async () => {
  const shown = await post('/get', { sessionId: SESSION_ID })
  const panelTodo = shown.payload.plan.nodes.find((t) => t.title === '面板记的一条')
  const { payload } = await post('/todo-set', { sessionId: SESSION_ID, todo: panelTodo.id, status: 'done' })
  assert.equal(payload.ok, true)
  const plan = await readPlan()
  assert.equal(plan.nodes.find((t) => t.id === panelTodo.id).status, 'done')
})

test('HTTP /node-move 能归位（面板上的 ↳ 按钮走这条）', async () => {
  const shown = await post('/get', { sessionId: SESSION_ID })
  const target = shown.payload.plan.nodes.find((t) => t.title === '面板记的一条')
  const parent = shown.payload.plan.nodes.find((t) => t.type === 'plan')
  const { payload } = await post('/node-move', { sessionId: SESSION_ID, node: target.id, parent: parent.id })
  assert.equal(payload.ok, true)
  assert.equal(payload.to, parent.id)
  const plan = await readPlan()
  assert.ok(dig(plan.nodes, target.id).children === undefined, '它现在是子节点')
  assert.ok(dig(plan.nodes, parent.id).children.some((x) => x.id === target.id))
})

test('HTTP /node-move 带 index 能同层重排（面板拖拽走这条）', async () => {
  // 面板把拖拽落点算成 { parent, index } 之后走这条路由。index 的语义是
  // 「**先把自己摘掉**再插入」，客户端必须按同一套坐标系算——两边只要错一位，
  // 表现是「拖完之后顺序差一格」，很像手滑，是最难从现象倒推回来的那类错。
  const made = await call('plan_node_add', { title: '拖拽排序测试计划', type: 'plan' })
  const pid = made.node.id
  const a = await call('plan_node_add', { title: '排序甲', type: 'todo', parent: pid })
  await call('plan_node_add', { title: '排序乙', type: 'todo', parent: pid })
  await call('plan_node_add', { title: '排序丙', type: 'todo', parent: pid })

  const order = async () => (await post('/get', { sessionId: SESSION_ID })).payload.plan.nodes
    .find((n) => n.id === pid).children.map((x) => x.title)

  assert.deepEqual(await order(), ['排序甲', '排序乙', '排序丙'])

  // 把「甲」拖到「丙」后面：摘掉甲之后列表是 [乙, 丙]，丙在下标 1，插到它之后 = 2
  const moved = await post('/node-move', { sessionId: SESSION_ID, node: a.node.id, parent: pid, index: 2 })
  assert.equal(moved.payload.ok, true)
  assert.deepEqual(await order(), ['排序乙', '排序丙', '排序甲'], 'index 按「摘掉自己之后」的坐标系解释')

  // 拖回最前面：摘掉甲之后是 [乙, 丙]，插到下标 0
  await post('/node-move', { sessionId: SESSION_ID, node: a.node.id, parent: pid, index: 0 })
  assert.deepEqual(await order(), ['排序甲', '排序乙', '排序丙'])

  // 不传 index = 追加到末尾（↳ 归位选择器走这条，与拖到空白处等效）
  await post('/node-move', { sessionId: SESSION_ID, node: a.node.id, parent: pid })
  assert.deepEqual(await order(), ['排序乙', '排序丙', '排序甲'])
})

test('HTTP /node-set 只传 title 就能改名（面板双击改名走这条）', async () => {
  const made = await call('plan_node_add', { title: '改名测试计划', type: 'plan' })
  const { payload } = await post('/node-set', { sessionId: SESSION_ID, node: made.node.id, title: '改过名字的计划' })
  assert.equal(payload.ok, true)
  const plan = await readPlan()
  assert.equal(dig(plan.nodes, made.node.id).title, '改过名字的计划')
  // 改名不该顺手改动别的字段——双击改名是最高频的就地编辑，误伤代价最大。
  assert.equal(dig(plan.nodes, made.node.id).type, 'plan')
  assert.equal(dig(plan.nodes, made.node.id).status, 'active')
})

test('HTTP /node-set 能改重要程度与记回执', async () => {
  const shown = await post('/get', { sessionId: SESSION_ID })
  const target = shown.payload.plan.nodes.find((t) => t.title === '给张三的活')

  const pri = await post('/node-set', { sessionId: SESSION_ID, node: target.id, priority: 'high' })
  assert.equal(pri.payload.ok, true)

  const rc = await post('/node-set', { sessionId: SESSION_ID, node: target.id, receipt: 'returned' })
  assert.equal(rc.payload.ok, true)

  const plan = await readPlan()
  const got = plan.nodes.find((t) => t.id === target.id)
  assert.equal(got.priority, 'high')
  assert.equal(got.delegate.status, 'returned')
})

test('HTTP /node-set 没给任何属性时报错，不做空写入', async () => {
  const { status, payload } = await post('/node-set', { sessionId: SESSION_ID, node: 'n1' })
  assert.equal(status, 500)
  assert.match(payload.error, /没有要改的属性/)
})

test('HTTP /node-set 能换型（面板的 ⇧/⇩ 走这条）', async () => {
  const added = await post('/node-add', { sessionId: SESSION_ID, title: '面板上提升为计划', type: 'todo' })
  const id = added.payload.node.id

  const up = await post('/node-set', { sessionId: SESSION_ID, node: id, type: 'plan' })
  assert.equal(up.payload.node.type, 'plan')

  // 提升之后才挂得上子项；有子节点后再降级会被拒。
  await post('/node-add', { sessionId: SESSION_ID, title: '提升后加的子项', parent: id })
  const down = await post('/node-set', { sessionId: SESSION_ID, node: id, type: 'todo' })
  assert.equal(down.status, 500)
  assert.match(down.payload.error, /不能降级为待办/)

  const { payload } = await post('/node-remove', { sessionId: SESSION_ID, node: id })
  assert.equal(payload.ok, true)
})

test('HTTP /node-remove 删掉一个节点', async () => {
  const shown = await post('/get', { sessionId: SESSION_ID })
  // 它在上一个测试里被归位到计划下了，所以要在整棵树里找，不能只看顶层
  const target = flatNodes(shown.payload.plan.nodes).find((t) => t.title === '面板记的一条')
  const { payload } = await post('/node-remove', { sessionId: SESSION_ID, node: target.id })
  assert.equal(payload.ok, true)
  const plan = await readPlan()
  assert.equal(dig(plan.nodes, target.id), undefined)
})

test('HTTP 面板接口缺少 sessionId 时报错（不能猜工作区）', async () => {
  const { status, payload } = await post('/get', {})
  assert.equal(status, 500)
  assert.match(payload.error, /缺少 sessionId/)
})

// ------------------------------------------------- 落后预警 / 完成证据

/** 相对今天偏移 n 天的 YYYY-MM-DD——配速要一个「正在走」的周期。 */
const dayOffset = (n) => {
  const d = new Date()
  d.setDate(d.getDate() + n)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return d.getFullYear() + '-' + m + '-' + dd
}

/** 在 plan_show 的结果里按标题挖一个节点（整棵树，不限层级）。 */
const shownNode = async (title) => {
  const shown = await call('plan_show', {})
  return { plan: shown.plan, node: flatNodes(shown.plan.nodes).find((n) => n.title === title) }
}

test('落后的计划会被 plan_show 标出来，进度跟上后标记消失', async () => {
  await call('plan_node_add', {
    title: '落后预警测试计划', type: 'plan', start: dayOffset(-10), end: dayOffset(10), target: 10, current: 0,
  })
  const before = await shownNode('落后预警测试计划')
  assert.equal(before.node.behind, true, '时间过了一半、进度 0 → 落后')
  assert.equal(before.node.pace.expected, 0.5)
  assert.equal(before.node.pace.actual, 0)
  assert.ok(before.plan.behind.some((x) => x.id === before.node.id), 'behind 清单里要有它')
  assert.ok(before.plan.control.behind >= 1)

  // 进度跟上之后标记自动消失——它是派生量，不需要谁去清。
  const updated = await call('plan_node_set', { node: '落后预警测试计划', current: 10 })
  assert.equal(updated.plan.control.behind, 0)
  const after = await shownNode('落后预警测试计划')
  assert.equal(after.node.behind, false)
  assert.equal(after.node.pace.actual, 1, 'target 没被只传 current 的那次更新抹掉')
  assert.ok(after.node.pace.gap < 0, '超前于期，gap 为负')
})

test('待办没有周期，只讲截止不讲配速', async () => {
  await call('plan_node_add', { title: '一个有截止的待办', type: 'todo', due: dayOffset(3) })
  const { node } = await shownNode('一个有截止的待办')
  assert.equal(node.pace, null, '待办的落后表现就是逾期，不走配速')
  assert.equal(node.behind, false)
})

test('已过周期但没完成的计划算逾期，不算落后（两种信号分开）', async () => {
  await call('plan_node_add', {
    title: '逾期但不算落后的计划', type: 'plan', start: dayOffset(-20), end: dayOffset(-1),
  })
  const { node } = await shownNode('逾期但不算落后的计划')
  assert.equal(node.overdue, true)
  assert.equal(node.pace, null, '已过结束日交给逾期信号，不重复报落后')
  assert.equal(node.behind, false)
})

test('plan_todo_set 标完成时附证据：落盘、可核验、退出无证据清单', async () => {
  // 造一个真实存在的交付物——file 类证据是按工作区根解析并核验的。
  await writeFile(join(dir, '交付物.md'), '# 产物\n')
  await call('plan_node_add', { title: '带证据的待办', type: 'todo' })
  const r = await call('plan_todo_set', {
    todo: '带证据的待办', status: 'done', evidenceKind: 'file', evidenceRef: '交付物.md',
  })
  assert.equal(r.unverified, false, '附了证据就不该进「无证据」')
  assert.deepEqual(r.evidenceWarnings, [], '文件确实在工作区里')
  assert.equal(r.todo.evidence.length, 1)

  const disk = await readPlan()
  const saved = flatNodes(disk.nodes).find((n) => n.title === '带证据的待办')
  assert.equal(saved.evidence[0].kind, 'file')
  assert.equal(saved.evidence[0].ref, '交付物.md')
  assert.ok(saved.evidence[0].at, '证据要带时间戳')

  const { plan } = await shownNode('带证据的待办')
  assert.equal(plan.unverified.some((x) => x.title === '带证据的待办'), false)
})

test('无证据的完成项进 unverified 清单（agent 打的勾要能一次审查）', async () => {
  await call('plan_node_add', { title: '没证据的完成', type: 'todo' })
  const r = await call('plan_todo_set', { todo: '没证据的完成', status: 'done' })
  assert.equal(r.unverified, true)

  const { node, plan } = await shownNode('没证据的完成')
  assert.equal(node.unverified, true)
  assert.ok(plan.unverified.some((x) => x.title === '没证据的完成'))
  assert.ok(plan.control.unverified >= 1)
})

test('证据指向不存在的文件会被标出来（唯一能机器核验的一类）', async () => {
  await call('plan_node_add', { title: '证据指向空气', type: 'todo' })
  const r = await call('plan_todo_set', {
    todo: '证据指向空气', status: 'done', evidenceKind: 'file', evidenceRef: '不存在的产物.md',
  })
  assert.equal(r.evidenceWarnings.length, 1)
  assert.match(r.evidenceWarnings[0], /证据所指的文件不存在/)

  const { node } = await shownNode('证据指向空气')
  assert.equal(node.evidenceWarnings.length, 1, '标注也要带上，面板才有得显示')
})

test('note 类证据只记录、不核验（不假装能验）', async () => {
  await call('plan_node_add', { title: '只说一句的完成', type: 'todo' })
  const r = await call('plan_todo_set', {
    todo: '只说一句的完成', status: 'done', evidenceRef: '口头确认过，无需文件',
  })
  assert.equal(r.todo.evidence[0].kind, 'note', '不传 kind 按 note')
  assert.deepEqual(r.evidenceWarnings, [])
  assert.equal(r.unverified, false)
})

test('同一条证据重复提交不会追加两条（agent 重试不该污染留档）', async () => {
  await call('plan_node_add', { title: '重复附证据的待办', type: 'todo' })
  await call('plan_node_set', { node: '重复附证据的待办', evidenceKind: 'link', evidenceRef: 'https://example.com/x' })
  await call('plan_node_set', { node: '重复附证据的待办', evidenceKind: 'link', evidenceRef: 'https://example.com/x' })
  const disk = await readPlan()
  const saved = flatNodes(disk.nodes).find((n) => n.title === '重复附证据的待办')
  assert.equal(saved.evidence.length, 1)
})

test('plan_node_set 传错证据类型时报错，不写半截数据', async () => {
  await call('plan_node_add', { title: '证据类型写错', type: 'todo' })
  await assert.rejects(
    () => call('plan_node_set', { node: '证据类型写错', evidenceKind: 'filee', evidenceRef: 'x.md' }),
    /证据类型必须是/,
  )
})

test('HTTP /todo-set 也能附证据（工具与数据面走同一条路径）', async () => {
  const added = await post('/node-add', { sessionId: SESSION_ID, title: '面板上带证据完成' })
  const id = added.payload.node.id
  const done = await post('/todo-set', {
    sessionId: SESSION_ID, todo: id, status: 'done', evidenceKind: 'session', evidenceRef: 'sess-42',
  })
  assert.equal(done.payload.ok, true)
  const disk = await readPlan()
  const saved = flatNodes(disk.nodes).find((n) => n.id === id)
  assert.equal(saved.evidence[0].kind, 'session')
  assert.equal(saved.evidence[0].ref, 'sess-42')
})

test('HTTP /node-set 不带状态也能补证据（补交凭据不必再动状态）', async () => {
  const shown = await post('/get', { sessionId: SESSION_ID })
  const target = flatNodes(shown.payload.plan.nodes).find((n) => n.title === '没证据的完成')
  assert.equal(target.unverified, true, '前提：它当前是无证据的完成项')

  const fixed = await post('/node-set', {
    sessionId: SESSION_ID, node: target.id, evidenceKind: 'file', evidenceRef: '交付物.md',
  })
  assert.equal(fixed.payload.ok, true)
  assert.equal(fixed.payload.node.unverified, false, '补了证据就不再是待核验项')
})

// ------------------------------------------------------------ 版本留档

test('每一次写入都留下了快照（面板与 agent 都不绕过归档）', async () => {
  const files = await readdir(join(dir, 'plan', '.versions'))
  const snapshots = files.filter((f) => f.endsWith('.json'))
  assert.ok(snapshots.length >= 15, '写入次数远多于快照数说明有路径绕过了归档：' + snapshots.length)
  assert.ok(snapshots.some((f) => f.includes('-add')), '快照标签应记录改动原因')
})

test('回滚能把计划恢复到历史版本', async () => {
  const history = await call('plan_history', { limit: 5 })
  assert.ok(history.versions.length > 0)
  const first = history.versions[history.versions.length - 1]
  const r = await call('plan_restore', { file: first.file })
  assert.equal(r.ok, true)
  assert.equal(r.restoredFrom, first.file)
})

// ---------------------------------------------------------------- AI 入口

/**
 * 这一节的立场：/ai-parse 是**只读**的解析口。它读计划、问模型、返回候选，
 * 但一个字节都不写——「采纳」是用户点了之后走 /node-add 的。所以除了断言
 * 返回值，还要断言**计划文件与版本快照都没动**：一旦它偷偷写盘，用户改主意
 * 就会留下一堆垃圾，而版本历史也会被冲淡。
 */
async function snapshotOfAiFixture() {
  const files = await readdir(join(dir, 'plan', '.versions'))
  return {
    plan: await readFile(join(dir, 'plan', 'plan.json'), 'utf8'),
    versions: files.filter((f) => f.endsWith('.json')).length,
  }
}

test('/get 下发 AI 可用性：没有模型服务时是 false，并说明缺什么', async () => {
  const r = await post('/get', { sessionId: SESSION_ID })
  assert.equal(r.payload.ai.available, false)
  assert.match(r.payload.ai.reason, /模型服务/)
})

test('/get 下发 AI 可用性：有模型但没选默认模型时也是 false', async () => {
  fakeLlm = llmReturning('{}')
  const r = await post('/get', { sessionId: SESSION_ID })
  assert.equal(r.payload.ai.available, false)
  assert.match(r.payload.ai.reason, /默认模型/)
})

test('/ai-parse 把模型回复变成待办 + 归位候选，且不写入任何数据', async () => {
  await call('plan_node_add', { title: 'AI解析用计划', type: 'plan' })
  await call('plan_node_add', { title: 'AI解析用子计划', type: 'plan', parent: 'AI解析用计划' })
  fakeDefaultModel = { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) }
  fakeLlm = llmReturning('```json\n{"tasks":[{"title":"补台账","due":"2026-10-01","priority":"高","plan":"AI解析用子计划"}]}\n```')

  const before = await snapshotOfAiFixture()
  const r = await post('/ai-parse', { sessionId: SESSION_ID, text: '下周三前把台账补完' })
  const after = await snapshotOfAiFixture()

  assert.equal(r.status, 200)
  assert.equal(r.payload.ok, true)
  assert.equal(r.payload.tasks.length, 1)
  const task = r.payload.tasks[0]
  assert.equal(task.title, '补台账')
  assert.equal(task.due, '2026-10-01')
  assert.equal(task.priority, 'high', '中文「高」要在 host 侧收敛成合法取值')
  // 模型点名的计划排最前（与 src/ai.js 的 attachSuggestions 同一条规则）。
  assert.equal(task.candidates[0].kind, 'plan')
  assert.equal(task.candidates[0].title, 'AI解析用子计划')
  assert.equal(task.candidates[0].why, '模型判断归到这里')
  // 收件箱与新建计划永远在末尾。
  assert.equal(task.candidates[task.candidates.length - 2].kind, 'inbox')
  assert.equal(task.candidates[task.candidates.length - 1].kind, 'new')

  assert.equal(after.plan, before.plan, '解析不该改计划文件')
  assert.equal(after.versions, before.versions, '解析不该留版本快照')
})

test('/ai-parse 把文本与计划大纲一起交给模型（模型得知道现有计划才能建议归位）', async () => {
  fakeDefaultModel = { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) }
  fakeLlm = llmReturning('{"tasks":[]}')
  const r = await post('/ai-parse', { sessionId: SESSION_ID, text: '把台账补完' })
  // tasks 为空会走 error 分支，这里只关心**发出去的请求**长什么样。
  assert.equal(r.payload.ok, false)
  const sent = fakeLlm.calls[0]
  assert.equal(sent.provider, 'deepseek')
  assert.equal(sent.model, 'deepseek-chat')
  assert.equal(sent.messages[0].role, 'user')
  assert.ok(sent.system.includes('AI解析用计划'), '系统提示词要带上现有计划大纲')
  assert.ok(sent.messages[0].content.some((b) => b.type === 'text' && b.text.includes('把台账补完')))
})

test('/ai-parse 图片先入附件库，再以 image block 交给模型', async () => {
  fakeDefaultModel = { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-vl' }) }
  fakeLlm = llmReturning('{"tasks":[{"title":"看图记的一条"}]}')
  fakeAttachments = attachmentsReturning()
  // 1x1 的 PNG，base64 后很短；用真字节是为了验证 host 侧确实解了 base64。
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const r = await post('/ai-parse', {
    sessionId: SESSION_ID,
    text: '',
    images: [{ mediaType: 'image/png', data: png, name: '白板.png' }],
  })
  assert.equal(r.payload.ok, true)
  assert.equal(fakeAttachments.saved.length, 1)
  assert.equal(fakeAttachments.saved[0].bytes, 70, '收到的是**解码后**的字节数，不是 base64 长度')
  const blocks = fakeLlm.calls[0].messages[0].content
  assert.equal(blocks[0].type, 'image')
  assert.equal(blocks[0].attachment.attachmentId, 'att0')
  assert.equal(blocks[1].type, 'text', '文字块压在图片之后')
})

test('/ai-parse 模型不支持图片时明确报错，而不是把图丢掉', async () => {
  fakeDefaultModel = { currentSelection: () => ({ provider: 'deepseek', model: 'text-only' }) }
  fakeLlm = llmReturning('{}', { modalities: ['text'] })
  fakeAttachments = attachmentsReturning()
  const r = await post('/ai-parse', {
    sessionId: SESSION_ID,
    text: '',
    images: [{ mediaType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' }],
  })
  assert.equal(r.payload.ok, false)
  assert.match(r.payload.error, /不支持图片输入/)
  assert.equal(fakeAttachments.saved.length, 0, '能力检查要在入附件库之前')
})

test('/ai-parse 的四条入参护栏：空输入 / 图片超限 / 坏类型 / 没有模型服务', async () => {
  fakeDefaultModel = { currentSelection: () => ({ provider: 'deepseek', model: 'm' }) }
  fakeLlm = llmReturning('{}')
  fakeAttachments = attachmentsReturning()

  const empty = await post('/ai-parse', { sessionId: SESSION_ID, text: '   ', images: [] })
  assert.match(empty.payload.error, /没有可解析的内容/)

  const many = await post('/ai-parse', {
    sessionId: SESSION_ID,
    text: 'x',
    images: [1, 2, 3, 4, 5].map(() => ({ mediaType: 'image/png', data: 'AAAA' })),
  })
  assert.match(many.payload.error, /一次最多 4 张图片/)

  const badType = await post('/ai-parse', {
    sessionId: SESSION_ID, text: '',
    images: [{ mediaType: 'application/pdf', data: 'AAAA' }],
  })
  assert.match(badType.payload.error, /不支持的图片类型/)

  // 没有 llm：连默认模型都问不到，直接给「为什么不能用」。
  fakeLlm = null
  const none = await post('/ai-parse', { sessionId: SESSION_ID, text: 'x' })
  assert.equal(none.payload.ok, false)
  assert.match(none.payload.error, /AI 解析不可用/)
})

test('/ai-parse 少 sessionId 时与其它路由一样报「找不到工作区」', async () => {
  const r = await post('/ai-parse', { text: 'x' })
  assert.equal(r.payload.ok, false)
  assert.match(r.payload.error, /sessionId/)
})

// ------------------------------------------------------------------ 文件库关联（Obsidian）

test('plan_config_set 配置 / 清除 vault 路径（机器相关配置存 plan.json 顶层）', async () => {
  const vault = join(dir, 'vault')
  await mkdir(vault, { recursive: true })
  await writeFile(join(vault, 'keep.txt'), 'hi')
  const r = await call('plan_config_set', { vaultPath: vault })
  assert.equal(r.ok, true)
  assert.equal(r.vaultPath, vault)
  const plan = await readPlan()
  assert.equal(plan.vaultPath, vault, 'vaultPath 应落在 plan.json 顶层')
})

test('plan_config_set 不传或传空即清除 vault 配置', async () => {
  const vault = join(dir, 'vault')
  await mkdir(vault, { recursive: true })
  await call('plan_config_set', { vaultPath: vault })
  const cleared = await call('plan_config_set', { vaultPath: '' })
  assert.equal(cleared.cleared, true)
  const plan = await readPlan()
  assert.equal(plan.vaultPath, undefined)
})

test('plan_config_set 路径不存在时抛错而不是写半截', async () => {
  await assert.rejects(
    () => call('plan_config_set', { vaultPath: join(dir, 'no-such-vault') }),
    /vault 路径不存在或不是目录/,
  )
})

test('plan_node_set 可以挂 / 摘文件关联（与证据同款 file* 参数）', async () => {
  const g = await call('plan_node_add', { title: '资料关联测试计划', type: 'plan' })
  const id = g.node.id
  const add = await call('plan_node_set', { node: id, fileRef: '需求.md', fileKind: 'file', fileNote: '终版' })
  const node = dig(add.plan.nodes, id)
  assert.equal(node.files.length, 1)
  assert.equal(node.files[0].ref, '需求.md')
  assert.equal(node.files[0].note, '终版')
  // 再挂一个文件夹
  const add2 = await call('plan_node_set', { node: id, fileRef: '设计稿', fileKind: 'folder' })
  assert.equal(dig(add2.plan.nodes, id).files.length, 2)
  // 摘掉文件
  const rm = await call('plan_node_set', { node: id, fileRemove: '需求.md' })
  const after = dig(rm.plan.nodes, id)
  assert.equal(after.files.length, 1)
  assert.equal(after.files[0].ref, '设计稿')
})

test('plan_todo_set 同样能挂 / 摘文件关联', async () => {
  const t = await call('plan_node_add', { title: '关联待办', type: 'todo' })
  const id = t.node.id
  const add = await call('plan_todo_set', { todo: id, status: 'todo', fileRef: '备忘.md' })
  assert.equal(dig(add.plan.nodes, id).files.length, 1)
  const rm = await call('plan_todo_set', { todo: id, status: 'todo', fileRemove: '备忘.md' })
  assert.equal(dig(rm.plan.nodes, id).files.length, 0)
})

test('plan_file_read 读文件内容、列文件夹，且越界路径被拒', async () => {
  const vault = join(dir, 'vault-read')
  await mkdir(vault, { recursive: true })
  await writeFile(join(vault, 'note.md'), 'hello vault')
  await writeFile(join(vault, 'sub.txt'), 'inner')
  await call('plan_config_set', { vaultPath: vault })
  // 读文件
  const f = await call('plan_file_read', { ref: 'note.md', kind: 'file' })
  assert.equal(f.exists, true)
  assert.match(f.content, /hello vault/)
  // 超大文件截断（造一个超过 200KB 的文件）
  const big = 'x'.repeat(300 * 1024)
  await writeFile(join(vault, 'big.md'), big)
  const bf = await call('plan_file_read', { ref: 'big.md', kind: 'file' })
  assert.equal(bf.truncated, true)
  assert.equal(bf.content.length < big.length, true)
  // 列根目录
  const folder = await call('plan_file_read', { ref: '', kind: 'folder' })
  assert.equal(folder.exists, true)
  const names = folder.entries.map((e) => e.name)
  assert.ok(names.includes('note.md'))
  assert.ok(names.includes('sub.txt'))
  // 越界：../ 逃离 vault 根
  await assert.rejects(
    () => call('plan_file_read', { ref: '../escape.md', kind: 'file' }),
    /路径越界/,
  )
})

test('plan_file_read 未配置 vault / 文件不存在都返回 exists:false 不中断', async () => {
  await call('plan_config_set', { vaultPath: '' })
  const missingVault = await call('plan_file_read', { ref: 'x.md' })
  assert.equal(missingVault.exists, false)
  const vault = join(dir, 'vault-read-empty')
  await mkdir(vault, { recursive: true })
  await call('plan_config_set', { vaultPath: vault })
  const noFile = await call('plan_file_read', { ref: 'ghost.md' })
  assert.equal(noFile.exists, false)
})

test('/config-set 与 /file-read 数据面：配置 vault、读文件、错误转 JSON', async () => {
  const vault = join(dir, 'vault-route')
  await mkdir(vault, { recursive: true })
  await writeFile(join(vault, 'doc.md'), 'route read')
  const set = await post('/config-set', { sessionId: SESSION_ID, vaultPath: vault })
  assert.equal(set.payload.ok, true)
  assert.equal(set.payload.vaultPath, vault)
  const read = await post('/file-read', { sessionId: SESSION_ID, ref: 'doc.md', kind: 'file' })
  assert.equal(read.payload.ok, true)
  assert.match(read.payload.content, /route read/)
  // 不存在的路径不 500，返回 exists:false
  const miss = await post('/file-read', { sessionId: SESSION_ID, ref: 'nope.md' })
  assert.equal(miss.payload.ok, true)
  assert.equal(miss.payload.exists, false)
  // 错误路径（越界）返回 ok:false 而不是崩溃
  const bad = await post('/file-read', { sessionId: SESSION_ID, ref: '../x.md' })
  assert.equal(bad.payload.ok, false)
  assert.match(bad.payload.error, /路径越界/)
  // 错误的 vault 路径返回 ok:false 而不是崩溃
  const badSet = await post('/config-set', { sessionId: SESSION_ID, vaultPath: join(dir, 'nope') })
  assert.equal(badSet.payload.ok, false)
  assert.match(badSet.payload.error, /vault 路径不存在/)
})

// ---------------------------------------------------------------- 详情编辑页的数据面

test('HTTP /node-set 能写负责人 / 周期 / 截止 / 量化指标', async () => {
  const made = await call('plan_node_add', { title: '全字段计划', type: 'plan' })
  const id = made.node.id
  const { payload } = await post('/node-set', {
    sessionId: SESSION_ID, node: id,
    owner: '我', start: '2026-01-01', end: '2026-12-31',
    metric: { target: 12, current: 3, unit: '个' },
  })
  assert.equal(payload.ok, true)
  const plan = await readPlan()
  const got = dig(plan.nodes, id)
  assert.equal(got.owner, '我')
  assert.equal(got.start, '2026-01-01')
  assert.equal(got.end, '2026-12-31')
  assert.deepEqual(got.metric, { target: 12, current: 3, unit: '个' })
})

test('HTTP /node-set 的 clear 能清掉字段（表单「留空 = 清空」的落点）', async () => {
  const made = await call('plan_node_add', { title: '待清空的计划', type: 'plan' })
  const id = made.node.id
  await post('/node-set', { sessionId: SESSION_ID, node: id, owner: '我', note: '备注', metric: { target: 4 } })
  const before = dig((await readPlan()).nodes, id)
  assert.equal(before.owner, '我')
  assert.ok(before.metric !== undefined)

  const { payload } = await post('/node-set', {
    sessionId: SESSION_ID, node: id, clear: ['owner', 'note', 'metric', 'not-a-field'],
  })
  assert.equal(payload.ok, true)
  const got = dig((await readPlan()).nodes, id)
  assert.equal('owner' in got, false, '空串写不进去，只有 clear 能清掉')
  assert.equal('note' in got, false)
  assert.equal('metric' in got, false)
  assert.equal(got.title, '待清空的计划', '没点名清的字段不动')
})

test('HTTP /node-set 能删证据（evidenceRemove），也能照旧追加', async () => {
  const made = await call('plan_node_add', { title: '带证据的待办', type: 'todo' })
  const id = made.node.id
  await post('/node-set', { sessionId: SESSION_ID, node: id, evidenceKind: 'file', evidenceRef: 'a.md' })
  await post('/node-set', { sessionId: SESSION_ID, node: id, evidenceKind: 'note', evidenceRef: '口头确认过' })
  assert.equal(dig((await readPlan()).nodes, id).evidence.length, 2)

  const gone = await post('/node-set', {
    sessionId: SESSION_ID, node: id, evidenceRemove: 'a.md', evidenceKind: 'file',
  })
  assert.equal(gone.payload.ok, true)
  const got = dig((await readPlan()).nodes, id)
  assert.deepEqual(got.evidence.map((e) => e.ref), ['口头确认过'])

  // 删最后一条要连空数组一起收掉，而不是留一个 evidence: [] 在 diff 里晃。
  await post('/node-set', { sessionId: SESSION_ID, node: id, evidenceRemove: '口头确认过' })
  assert.equal('evidence' in dig((await readPlan()).nodes, id), false)
})

test('HTTP /node-set 只改期望完成时间时，已接受的回执不被打回待接受', async () => {
  const made = await call('plan_node_add', { title: '委派出去的活', type: 'todo' })
  const id = made.node.id
  await post('/node-set', { sessionId: SESSION_ID, node: id, to: '小李', expectAt: '2026-09-01' })
  await post('/node-set', { sessionId: SESSION_ID, node: id, receipt: 'accepted' })
  const mid = dig((await readPlan()).nodes, id)
  assert.equal(mid.delegate.status, 'accepted')

  // 表单每次保存都会把 to 原样提交一遍，若不分情况就会把回执重置成 pending。
  const { payload } = await post('/node-set', {
    sessionId: SESSION_ID, node: id, to: '小李', expectAt: '2026-10-01',
  })
  assert.equal(payload.ok, true)
  const got = dig((await readPlan()).nodes, id)
  assert.equal(got.delegate.expectAt, '2026-10-01')
  assert.equal(got.delegate.status, 'accepted', '同一个人只是挪时间，回执不该作废')

  // 换人才是真的重新委派：回执回到待接受。
  await post('/node-set', { sessionId: SESSION_ID, node: id, to: '小王' })
  const re = dig((await readPlan()).nodes, id)
  assert.equal(re.delegate.to, '小王')
  assert.equal(re.delegate.status, 'pending', '换人 = 上一轮回执作废')
})

test('HTTP /node-add 能一次带上负责人 / 周期 / 指标（新建表单走这条）', async () => {
  const { payload } = await post('/node-add', {
    sessionId: SESSION_ID,
    title: '带全字段的计划', type: 'plan',
    owner: '我', start: '2026-01-01', end: '2026-12-31',
    priority: 'high', note: '备注', metric: { target: 10, current: 0, unit: '篇' },
  })
  assert.equal(payload.ok, true)
  const got = dig((await readPlan()).nodes, payload.node.id)
  assert.equal(got.owner, '我')
  assert.equal(got.end, '2026-12-31')
  assert.equal(got.priority, 'high')
  assert.equal(got.note, '备注')
  assert.deepEqual(got.metric, { target: 10, current: 0, unit: '篇' })
})
