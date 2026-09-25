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

/**
 * 相对今天的日期。**别把「未来」写死在日历上**：`expectAt: '2026-09-20'` 这种常量
 * 过了那天就自动变成过去，于是「新建的委派不算逾期」这条断言会在某天早上突然变红，
 * 而它跟当天任何改动都无关——排查时最容易被带偏的那种红。这里统一按「今天 + N 天」算。
 */
function dayFromToday(offset) {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return d.getFullYear() + '-' + mm + '-' + dd
}
/** 委派用例用的两个日子：还早 / 更早之后（同一个人，只挪时间）。 */
const FUTURE_DAY = dayFromToday(7)
const LATER_DAY = dayFromToday(14)

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
      yield { type: 'finish', reason: opts.finish === undefined ? { kind: 'stop' } : opts.finish }
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
  // /ai-parse 是 AI 入口（问答 + 录入，只出草稿、不写入）；写操作仍走 node-* / todo-set。
  // /persona 与 /persona-set 读写助手人设（plan/agents.md）。
  assert.deepEqual(
    [...routes.keys()].sort(),
    ['/api/workbench/ai-parse', '/api/workbench/config-set', '/api/workbench/file-read',
      '/api/workbench/get', '/api/workbench/history',
      '/api/workbench/init', '/api/workbench/node-add', '/api/workbench/node-move',
      '/api/workbench/node-remove', '/api/workbench/node-set', '/api/workbench/snapshot',
      '/api/workbench/todo-set', '/api/workbench/persona', '/api/workbench/persona-set'].sort(),
  )
})

test('会话没有 cwd 时报可读错误，而不是写到别处', async () => {
  await assert.rejects(
    () => tools.get('plan_show').execute({}, { agent: { session: { header: {} } } }),
    /没有工作区目录/,
  )
})

// ------------------------------------------------------------------ 建树

test('plan_node_add 建树：挂上子项的节点自动成为计划', async () => {
  const g = await call('plan_node_add', { title: '完成低电压治理攻坚', owner: '张三', start: '2026-10-01', end: '2026-12-31' })
  assert.equal(g.ok, true)
  // 新建的都是待办（叶子）；挂上子项后类型自动变成计划。
  const k = await call('plan_node_add', { title: '建立治理台账', parent: '完成低电压治理攻坚' })
  assert.equal(k.ok, true)
  // 子计划下再挂待办
  const t = await call('plan_node_add', { title: '收集基础数据', parent: k.node.id, due: '2026-11-01' })
  assert.equal(t.ok, true)
  assert.equal(t.node.children, undefined, '新建的待办是叶子')

  const plan = await readPlan()
  assert.equal(plan.schema, 2)
  assert.equal(plan.nodes.length, 1)
  const root = plan.nodes[0]
  assert.equal('type' in root, false, 'type 不落盘')
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
  assert.equal(top.children, undefined)

  const shown = await call('plan_show')
  assert.equal(shown.plan.control.inboxOpen, 1)
})

test('plan_node_add 拒绝空标题；挂到待办下会把那个待办变成计划', async () => {
  await assert.rejects(() => call('plan_node_add', { title: '   ' }), /标题不能为空/)
  const r = await call('plan_node_add', { title: '拆出来的子项', parent: '开会时记的一条' })
  assert.equal(r.ok, true)
  const plan = await readPlan()
  const holder = plan.nodes.find((n) => n.title === '开会时记的一条')
  assert.equal(holder.children.length, 1, '子项挂上了')
  assert.equal(holder.status, 'active', '挂上子项的待办自动变成计划（todo 归一成 active）')
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
  const made = await call('plan_node_add', { title: '收件箱待勾的一条' })
  const r = await call('plan_todo_set', { todo: made.node.id, status: 'done' })
  assert.equal(r.ok, true)

  const plan = await readPlan()
  assert.equal(dig(plan.nodes, made.node.id).status, 'done')
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
  // 任何节点都能当父（挂上子项它就是计划），待归位的待办也可以有子项。
})

test('plan_node_remove 删计划会连带子树，并报告删了多少', async () => {
  const added = await call('plan_node_add', { title: '待删除的子计划', parent: '建立治理台账' })
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
  const q4 = await call('plan_node_add', { title: 'Q4 数据治理专项', priority: 'high' })
  // 先挂个子项让它成为计划（类型由结构派生）。
  await call('plan_node_add', { title: '专项下的活', parent: q4.node.id })
  const r = await call('plan_node_set', { node: q4.node.id, priority: 'high' })
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

test('plan_node_set 按形态校验状态取值（叶子=待办、容器=计划）', async () => {
  await assert.rejects(() => call('plan_node_set', { node: '中等的没有截止', status: 'active' }), /待办的状态必须是/)
  // Q4 已经挂了子项，是计划：doing 对它非法。
  await assert.rejects(() => call('plan_node_set', { node: 'Q4 数据治理专项', status: 'doing' }), /计划的状态必须是/)
})

test('待办直接往下挂子项：不需要先「提升」，结构决定形态', async () => {
  // 场景：开会时随手记了一条，事后发现这事得拆开做——直接挂，它自己变成计划。
  const made = await call('plan_node_add', { title: '事后发现要拆的一条' })
  assert.equal(made.node.children, undefined)

  const kid = await call('plan_node_add', { title: '拆出来的第一步', parent: made.node.id })
  assert.equal(kid.ok, true)
  const plan = await readPlan()
  const holder = dig(plan.nodes, made.node.id)
  assert.equal(holder.children.length, 1)
  assert.equal(holder.status, 'active', 'todo 挂子后归一成 active')

  // 删光子项又自动变回待办（active 归一成 todo）。
  await call('plan_node_remove', { node: kid.node.id })
  const after = dig((await readPlan()).nodes, made.node.id)
  assert.equal(after.children, undefined)
  assert.equal(after.status, 'todo')

  // 收拾干净——后面的用例依赖树里的节点数量与委派/计数，别留残留。
  await call('plan_node_remove', { node: made.node.id })
})

// ---------------------------------------------------------------------- 委派

test('建立委派：回执初始为待接受', async () => {
  await call('plan_node_add', { title: '给张三的活' })
  const r = await call('plan_delegate_set', {
    node: '给张三的活',
    to: '张三',
    expectAt: FUTURE_DAY,
  })
  assert.equal(r.delegate.status, 'pending')
  assert.equal(r.delegate.to, '张三')
  assert.equal(r.delegate.overdueReceipt, false)
})

test('plan_delegated 列出委派出去的事项（含类型与期望时间）', async () => {
  const r = await call('plan_delegated')
  assert.equal(r.ok, true)
  assert.equal(r.items.length, 1)
  assert.equal(r.items[0].delegate.expectAt, FUTURE_DAY)
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
  const before = await call('plan_delegate_set', { node: '给张三的活', to: '张三', expectAt: FUTURE_DAY })
  await call('plan_delegate_receipt', { node: '给张三的活', status: 'accepted' })
  const after = await call('plan_delegate_set', { node: '给张三的活', to: '王五', expectAt: LATER_DAY })
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

test('叶子经 plan_node_set 标完成也记 doneAt（完成语义一体化）', async () => {
  const made = await call('plan_node_add', { title: '叶子完成记录时间' })
  const r = await call('plan_node_set', { node: made.node.id, status: 'done' })
  assert.equal(r.ok, true)
  assert.ok(r.node.doneAt, '完成时间写上了')

  // 从 done 挪回 todo 时要清掉——否则周报会重复统计
  const back = await call('plan_node_set', { node: made.node.id, status: 'todo' })
  assert.equal('doneAt' in back.node, false)
})
// -------------------------------------------------- HTTP 面板写入路径

test('HTTP /node-add 记一条到收件箱', async () => {
  const { status, payload } = await post('/node-add', { sessionId: SESSION_ID, title: '面板记的一条' })
  assert.equal(status, 200)
  assert.equal(payload.ok, true)
  const plan = await readPlan()
  assert.ok(plan.nodes.some((t) => t.title === '面板记的一条'))
})

test('HTTP /node-add 能在指定节点下加子项（挂上子项的那个节点自动成为计划）', async () => {
  const { payload } = await post('/node-add', {
    sessionId: SESSION_ID, title: '面板加的子计划', parent: '建立治理台账',
  })
  assert.equal(payload.ok, true)
  const plan = await readPlan()
  const holder = plan.nodes[0].children[0].children.find((x) => x.title === '面板加的子计划')
  assert.ok(holder !== undefined)
  // 面板加的子计划本身是叶子；「建立治理台账」因为有它这个子项而是计划。
  assert.equal(holder.children, undefined)
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
  const made = await call('plan_node_add', { title: '改名测试计划', parent: '建立治理台账' })
  const { payload } = await post('/node-set', { sessionId: SESSION_ID, node: made.node.id, title: '改过名字的计划' })
  assert.equal(payload.ok, true)
  const plan = await readPlan()
  assert.equal(dig(plan.nodes, made.node.id).title, '改过名字的计划')
  // 改名不该顺手改动别的字段——双击改名是最高频的就地编辑，误伤代价最大。
  assert.equal(dig(plan.nodes, made.node.id).children, undefined, '还是叶子（children 未动）')
  assert.equal(dig(plan.nodes, made.node.id).status, 'todo')
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

test('HTTP /node-set 忽略 type（类型由结构派生，不再可换型）', async () => {
  const added = await post('/node-add', { sessionId: SESSION_ID, title: '面板上的一条' })
  const id = added.payload.node.id

  // 直接往下挂子项：它自动变成计划，不需要也不允许「换型」这一步。
  await post('/node-add', { sessionId: SESSION_ID, title: '面板上拆的子项', parent: id })
  const plan = await readPlan()
  assert.ok(Array.isArray(dig(plan.nodes, id).children), '挂上子项即是计划')

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
  // 有子项才是计划（类型由结构派生）：给子计划挂个占位子项。
  await call('plan_node_add', { title: 'AI解析占位子项', parent: 'AI解析用子计划' })
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

test('/ai-parse 的改动与合并：标题匹配回真实节点，对不上的照样带回去', async () => {
  // 模型只能给**标题**（与 plan 字段、清单 items 同一条纪律：它复述的 id 无从校验）。
  // 所以「匹配回节点」是 host 的活，而且**匹配不上要让人看得见**——悄悄丢掉的话，
  // 用户只会看到一张不执行的卡片，还以为是自己没说清。
  // ⚠️ 标题必须**全文件唯一**：这个 fixture 是整份测试共用的，用了别的用例也在用的
  // 名字（比如「补台账」），后面那条按标题匹配的用例就会命中我这里建的那条——
  // 表现是它拿到的 id 对不上（我第一版就是这么红的）。
  await call('plan_node_add', { title: 'AI改动用计划', type: 'plan' })
  await call('plan_node_add', { title: 'AI改动用任务', parent: 'AI改动用计划' })
  await call('plan_node_add', { title: 'AI改动用旧清单', parent: 'AI改动用计划' })
  fakeDefaultModel = { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) }
  fakeLlm = llmReturning([
    '```json',
    JSON.stringify({
      reply: '照你说的改了',
      edits: [
        { target: 'AI改动用任务', patch: { due: '2026-10-12' }, why: '你说改到周五' },
        { target: '不存在的任务', patch: { due: '2026-10-12' } },
      ],
      merges: [
        { keep: 'AI改动用任务', fold: ['AI改动用旧清单'], title: 'AI改动用任务（含旧清单）', why: '是一件事' },
        { keep: 'AI改动用任务', fold: ['没这条'], title: '' },
      ],
    }),
    '```',
  ].join('\n'))

  const before = await snapshotOfAiFixture()
  const r = await post('/ai-parse', { sessionId: SESSION_ID, text: '把补台账改到周五，旧清单整理并进去' })
  const after = await snapshotOfAiFixture()

  assert.equal(r.status, 200)
  assert.equal(r.payload.edits.length, 2)
  const [hit, miss] = r.payload.edits
  assert.equal(hit.ok, true, '标题对得上就该带 id')
  assert.equal(typeof hit.id, 'string')
  assert.equal(hit.patch.due, '2026-10-12')
  assert.equal(miss.ok, false, '对不上的 ok=false')
  assert.equal(miss.id, null)
  assert.equal(miss.target, '不存在的任务', '原样带回去，面板才能显示「没对上：X」')

  assert.equal(r.payload.merges.length, 2)
  const [ok, bad] = r.payload.merges
  assert.equal(ok.ok, true)
  assert.equal(ok.keepTitle, 'AI改动用任务')
  assert.equal(ok.folds.length, 1)
  assert.equal(ok.folds[0].title, 'AI改动用旧清单')
  assert.equal(ok.title, 'AI改动用任务（含旧清单）')
  assert.equal(bad.ok, false, 'fold 里有一条对不上，整组就不能执行')
  assert.deepEqual(bad.missing, ['没这条'], '哪一条没对上要说出来')

  assert.equal(after.plan, before.plan, '解析仍然只读——一个字都不该写进计划')
  assert.equal(after.versions, before.versions, '也不该留版本快照')
})

test('/ai-parse 的归组合并：mode=children 原样下发，挪不动的剔出来并说清原因', async () => {
  // 用户原话：「我要的就是要把一些任务进行合并，然后作为计划，然后其他的作为它的子计划。」
  // 这一组测的是 host 这一层的三件事：mode 透传、成环的剔掉、已经在下面的不重复挪。
  // 剔的时候必须把原因带回去（skipped）——静默丢一条，用户回头看计划只会以为
  // 是自己记错了，而真正的原因（挪进去会成环）没人知道。
  await call('plan_node_add', { title: '归组用总任务' })
  await call('plan_node_add', { title: '归组用甲' })
  await call('plan_node_add', { title: '归组用乙' })
  await call('plan_node_add', { title: '归组用上级' })
  await call('plan_node_add', { title: '归组用下级', parent: '归组用上级' })
  fakeDefaultModel = { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) }
  fakeLlm = llmReturning(JSON.stringify({
    reply: '归到一个计划下面',
    merges: [
      { keep: '归组用总任务', fold: ['归组用甲', '归组用乙'], mode: 'children', title: '归组用总计划', why: '都是同一批调研' },
      // keep 在 fold 底下：把上级挪进自己的子孙 = 成环，store 会直接拒绝。
      { keep: '归组用下级', fold: ['归组用上级'], mode: 'children' },
      // 已经是 keep 的直接子项：不用再挪一次。
      { keep: '归组用上级', fold: ['归组用下级'], mode: 'children' },
    ],
  }))

  const before = await snapshotOfAiFixture()
  const r = await post('/ai-parse', { sessionId: SESSION_ID, text: '把这几条合并成一个计划，其他的作为子任务' })
  const after = await snapshotOfAiFixture()

  assert.equal(r.status, 200)
  assert.equal(r.payload.merges.length, 3)
  const [group, cycle, already] = r.payload.merges
  assert.equal(group.mode, 'children')
  assert.equal(group.ok, true)
  assert.deepEqual(group.folds.map((f) => f.title), ['归组用甲', '归组用乙'], '两条都要保留为子任务')
  assert.equal(group.title, '归组用总计划', 'keep 那一版可以改成总标题')
  assert.equal(group.keepKids, 0, '卡片上要能说出它下面现在有 0 个子项')

  assert.equal(cycle.ok, false, '唯一一条 fold 被剔掉后整组不能执行')
  assert.equal(cycle.folds.length, 0)
  assert.equal(cycle.skipped[0].title, '归组用上级')
  assert.match(cycle.skipped[0].why, /成环/)

  assert.equal(already.ok, false, '本来就在下面的那条不必再挪，整组因此无需执行')
  assert.match(already.skipped[0].why, /已经在/)

  assert.equal(after.plan, before.plan, '解析仍然只读——一个字节都不该写进计划')
  assert.equal(after.versions, before.versions, '也不该留版本快照')
})

test('/ai-parse 把「同名草稿」转成改动，不当新建下发（否则一点就多一条重复的）', async () => {
  // 用户原话：「我本来就有两条任务是已经存在的了，你现在做的是要进行一些合并删减，
  // 而不是说让我确认再加任务」。模型经常一边在 reply 里写「这两条本来就在手上，
  // 别当新任务再建一遍」，一边照样塞进 tasks——那是格式上的错，提示词治不干净，
  // 所以在 host 这一层拦住：**标题完全相等**的，转成 edits、tasks 里不再下发。
  await call('plan_node_add', { title: '重复判定用计划', type: 'plan' })
  await call('plan_node_add', { title: '重复判定用任务', parent: '重复判定用计划' })
  fakeDefaultModel = { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) }
  fakeLlm = llmReturning(JSON.stringify({
    reply: '这两条本来就在手上',
    tasks: [
      { title: '重复判定用任务', due: '2026-10-08', priority: 'high', plan: '重复判定用计划', advice: '已经在计划里了' },
      { title: '重复判定用新任务', due: '2026-10-09' },
    ],
  }))

  const r = await post('/ai-parse', { sessionId: SESSION_ID, text: '把重复判定用任务排一下' })
  assert.equal(r.payload.tasks.length, 1, '同名的那条不该再作为「新建」下发')
  assert.equal(r.payload.tasks[0].title, '重复判定用新任务', '新任务照常留着')

  const moved = r.payload.edits.find((e) => e.exists === true)
  assert.ok(moved !== undefined, '同名的那条要转成改动')
  assert.equal(moved.target, '重复判定用任务')
  assert.equal(moved.ok, true)
  assert.equal(typeof moved.id, 'string')
  assert.equal(moved.patch.due, '2026-10-08', '模型给的字段要带过去')
  assert.equal(moved.patch.priority, 'high')
  assert.equal(moved.patch.plan, '重复判定用计划')
  assert.equal(moved.why, '已经在计划里了', '理由也带过去，卡片上要显示')
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

test('/ai-parse 撞上输出长度上限：交出已经拿到的那部分，并说明被截断', async () => {
  fakeDefaultModel = { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-vl' }) }
  // 真机形态：拍照 → 模型老实吐十几条 → 输出额度用尽，JSON 断在第三条中间。
  fakeLlm = llmReturning(
    '{"reply":"· 图里是件杂事，拆成 3 条","tasks":[{"title":"甲"},{"title":"乙"},{"title":"丙（半',
    { finish: { kind: 'max-tokens' } },
  )
  fakeAttachments = attachmentsReturning()
  const r = await post('/ai-parse', {
    sessionId: SESSION_ID,
    text: '把照片里的都记下来',
    images: [{ mediaType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' }],
  })
  assert.equal(r.payload.ok, true, '截断不是失败——被丢掉的往往已经能用')
  assert.deepEqual(r.payload.tasks.map((t) => t.title), ['甲', '乙'], '完整的那两条要留下来')
  assert.match(r.payload.reply, /拆成 3 条/)
  assert.match(r.payload.reply, /被长度上限截断/, '少拿了东西必须说出来，不能悄悄少几条')
})

test('/ai-parse 的输出额度必须放得下它自己要求的输出（否则拍照拆待办必撞上限）', async () => {
  fakeDefaultModel = { currentSelection: () => ({ provider: 'deepseek', model: 'm' }) }
  fakeLlm = llmReturning('{"tasks":[]}')
  fakeAttachments = attachmentsReturning()
  await post('/ai-parse', { sessionId: SESSION_ID, text: '记一条' })
  // 系统提示让模型最多给 20 条、每条带 advice + 2~3 个 options。2048 装不下，
  // 这里钉住它别再被改回一个小数字。
  assert.ok(fakeLlm.calls[0].maxTokens >= 8192, '实际下发 ' + fakeLlm.calls[0].maxTokens)
})

test('/ai-parse 连一段完整的 JSON 前缀都凑不出来时，才报截断错误', async () => {
  fakeDefaultModel = { currentSelection: () => ({ provider: 'deepseek', model: 'm' }) }
  fakeLlm = llmReturning('{"reply":"说到一半', { finish: { kind: 'max-tokens' } })
  fakeAttachments = attachmentsReturning()
  const r = await post('/ai-parse', { sessionId: SESSION_ID, text: '记一条' })
  assert.equal(r.payload.ok, false)
  assert.match(r.payload.error, /被长度上限截断|没有给出能解析的 JSON/)
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

// ---------------------------------------------------------------- AI 助手（问答 + 人设）

test('/ai-parse 支持只提问：有 reply 就算成功，不必产出待办', async () => {
  fakeDefaultModel = { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) }
  fakeLlm = llmReturning('{"reply":"目前有 1 件逾期：补台账。","tasks":[]}')
  const r = await post('/ai-parse', { sessionId: SESSION_ID, text: '我现在该做什么？' })
  assert.equal(r.payload.ok, true)
  assert.match(r.payload.reply, /逾期/)
  assert.equal(r.payload.tasks.length, 0)
})

test('/ai-parse 把「当前 + 归纳」的全貌放进系统提示词', async () => {
  fakeDefaultModel = { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) }
  fakeLlm = llmReturning('{"reply":"好"}')
  await post('/ai-parse', { sessionId: SESSION_ID, text: '总结一下' })
  const sys = fakeLlm.calls[0].system
  // 光有大纲答不了「我现在该做什么」，必须有全貌：方向、手上的活、逾期、最近完成。
  assert.ok(sys.includes('【当前全貌】'), '要有全貌段落')
  assert.ok(sys.includes('【可归入的计划】'), '归位仍要靠计划大纲（标题路径可被反查）')
  assert.ok(sys.includes('内置工作计划助手'))
  assert.ok(sys.includes('## 性格'), '没配人设时用默认人设')
})

test('/ai-parse 带上会话内的前几轮（接着聊），但限制轮数与长度', async () => {
  fakeDefaultModel = { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) }
  fakeLlm = llmReturning('{"reply":"接着说"}')
  const history = [
    { role: 'user', text: '哪些逾期了' },
    { role: 'assistant', text: '补台账' },
    { role: 'user', text: '它的截止呢' },
  ]
  const r = await post('/ai-parse', { sessionId: SESSION_ID, text: '那推到下周', history })
  assert.equal(r.payload.ok, true)
  assert.equal(r.payload.turns, 3, '回带了几轮要报出来（面板据此知道上下文接上了）')
  const msgs = fakeLlm.calls[0].messages
  assert.equal(msgs.length, 4, '三轮历史 + 当前这一轮')
  assert.equal(msgs[0].role, 'user')
  assert.equal(msgs[1].role, 'assistant')
  assert.equal(msgs[3].content.some((b) => b.text.includes('那推到下周')), true)

  // 上限：给 20 轮也只回带最近几轮，否则 token 全被历史吃掉。
  const many = []
  for (let i = 0; i < 20; i++) many.push({ role: 'user', text: '第' + i + '轮' })
  const r2 = await post('/ai-parse', { sessionId: SESSION_ID, text: '现在呢', history: many })
  assert.ok(r2.payload.turns <= 6, '历史最多回带 6 轮')
})

test('/ai-parse 问题里点到关联文件时，才把文件内容读进上下文', async () => {
  await post('/config-set', { sessionId: SESSION_ID, vaultPath: dir })
  await writeFile(join(dir, '周会.md'), '本周决定：周五前把台账补完。')
  await call('plan_node_add', { title: '带资料的计划', type: 'plan' })
  const shown = await post('/get', { sessionId: SESSION_ID })
  const node = shown.payload.plan.nodes.find((n) => n.title === '带资料的计划')
  await post('/node-set', { sessionId: SESSION_ID, node: node.id, fileRef: '周会.md', fileKind: 'file' })

  fakeDefaultModel = { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) }
  fakeLlm = llmReturning('{"reply":"周会里说周五前补完"}')
  const hit = await post('/ai-parse', { sessionId: SESSION_ID, text: '周会里说了什么？' })
  assert.equal(hit.payload.ok, true)
  assert.deepEqual(hit.payload.read, ['周会.md'], '读过的文件要报出来（面板据此告诉用户「它翻了哪些」）')
  assert.ok(fakeLlm.calls[0].system.includes('周五前把台账补完'), '内容要真的进提示词')

  // 没点到的文件不读：vault 里可能有几百篇，全读一遍既慢又撑爆上下文。
  fakeLlm = llmReturning('{"reply":"好"}')
  const miss = await post('/ai-parse', { sessionId: SESSION_ID, text: '今天天气不错' })
  assert.deepEqual(miss.payload.read, [])
  await post('/config-set', { sessionId: SESSION_ID, vaultPath: '' })
})

test('/persona 没配过就给默认人设；写入后能读回', async () => {
  const first = await post('/persona', { sessionId: SESSION_ID })
  assert.equal(first.payload.ok, true)
  assert.match(first.payload.text, /## 性格/, '没配过 ≠ 没有性格')
  assert.ok(first.payload.path.endsWith('agents.md'), '人设与 plan.json 同目录')

  const written = await post('/persona-set', { sessionId: SESSION_ID, text: '## 性格\n- 只报事实' })
  assert.equal(written.payload.ok, true)
  const again = await post('/persona', { sessionId: SESSION_ID })
  assert.equal(again.payload.text, '## 性格\n- 只报事实')
})

test('/persona-set 的 append 只往「记住的事」一节末尾加一条', async () => {
  await post('/persona-set', { sessionId: SESSION_ID, text: '## 性格\n- 简短\n\n## 记住的事\n- 第一条\n' })
  const r = await post('/persona-set', { sessionId: SESSION_ID, append: '记住：周五下午不排新活' })
  const lines = r.payload.text.split('\n')
  const at = lines.findIndex((l) => /^##\s*记住的事/.test(l))
  assert.equal(lines[at + 1], '- 第一条', '原有内容保持不动')
  assert.equal(lines[at + 2], '- 周五下午不排新活')
  // 追加不能把「性格」一节改掉。
  assert.ok(r.payload.text.includes('## 性格\n- 简短'))
})

// ---------------------------------------------------------------- MLO 核心：依赖 / 星标 / 重复 / AI 清单

test('plan_node_set 能加依赖（按 id）、标星、配重复；环会被拦', async () => {
  const a = await call('plan_node_add', { title: '前置任务', type: 'todo' })
  const b = await call('plan_node_add', { title: '后续任务', type: 'todo' })
  const r = await call('plan_node_set', { node: b.node.id, blockedAdd: a.node.id, star: true, recur: 'week' })
  assert.equal(r.ok, true)
  const plan = await readPlan()
  const got = dig(plan.nodes, b.node.id)
  assert.deepEqual(got.blockedBy, [String(a.node.id)], '依赖按 id 记')
  assert.equal(got.starred, true)
  assert.deepEqual(got.recur, { kind: 'week' })
  // 环：前置任务反过来等后续任务。
  await assert.rejects(
    () => call('plan_node_set', { node: a.node.id, blockedAdd: b.node.id }),
    /不能成环/,
  )
  // payload 里给的是标题不是 id（agent 要能读懂「被谁挡住」）。
  const shown = await call('plan_show')
  const annotated = dig(shown.plan.nodes, b.node.id)
  assert.deepEqual(annotated.blocked, ['前置任务'])
})

test('完成带 recur 的待办会自动克隆下一条并顺推截止；重复保存不再刷克隆', async () => {
  const made = await call('plan_node_add', { title: '每周交周报', type: 'todo', due: '2026-09-15' })
  const id = made.node.id
  await call('plan_node_set', { node: id, recur: 'week' })

  const r1 = await call('plan_todo_set', { todo: id, status: 'done' })
  assert.ok(r1.spawned !== undefined, '完成时重生下一条')
  assert.equal(r1.spawned.title, '每周交周报')
  assert.equal(r1.spawned.due, '2026-09-22', '顺推一周')
  assert.equal(r1.spawned.id !== id, true)

  // 已经是 done 再保存一次，不该再克隆。
  const before = dig((await readPlan()).nodes, undefined) && (await readPlan())
  const count1 = countTitles(await readPlan(), '每周交周报')
  await call('plan_todo_set', { todo: id, status: 'done', note: '补充记录' })
  const count2 = countTitles(await readPlan(), '每周交周报')
  assert.equal(count2, count1, '重复保存不刷克隆')
})

function countTitles(plan, title) {
  let n = 0
  const walk = (nodes) => {
    for (const x of nodes) {
      if (x.title === title) n++
      if (Array.isArray(x.children)) walk(x.children)
    }
  }
  walk(plan.nodes)
  return n
}

test('HTTP /node-set 也接受 star / blockedAdd / recur（详情页的即时写走这里）', async () => {
  const a = await post('/node-add', { sessionId: SESSION_ID, title: 'HTTP 前置', type: 'todo' })
  const b = await post('/node-add', { sessionId: SESSION_ID, title: 'HTTP 后续', type: 'todo' })
  const r = await post('/node-set', {
    sessionId: SESSION_ID, node: b.payload.node.id,
    blockedAdd: a.payload.node.id, star: true, recur: 'month',
  })
  assert.equal(r.payload.ok, true)
  const got = dig((await readPlan()).nodes, b.payload.node.id)
  assert.deepEqual(got.blockedBy, [String(a.payload.node.id)])
  assert.equal(got.starred, true)
  assert.deepEqual(got.recur, { kind: 'month' })
  const rm = await post('/node-set', { sessionId: SESSION_ID, node: b.payload.node.id, blockedRemove: a.payload.node.id, star: false })
  const got2 = dig((await readPlan()).nodes, b.payload.node.id)
  assert.equal('blockedBy' in got2, false, '依赖删空后收掉数组')
  assert.equal('starred' in got2, false)
  assert.ok(rm.payload.ok)
})

test('/ai-parse 能回 AI 动态清单：标题匹配回真实节点，对不上的 ok:false', async () => {
  const made = await call('plan_node_add', { title: '补台账', type: 'todo' })
  fakeDefaultModel = { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) }
  fakeLlm = llmReturning(JSON.stringify({
    reply: '按依赖顺序，先做这三件',
    tasks: [],
    list: { title: '今天先做', items: ['补台账', '不存在的活'] },
  }))

  const r = await post('/ai-parse', { sessionId: SESSION_ID, text: '我该先做哪几件' })
  assert.equal(r.payload.ok, true)
  assert.equal(r.payload.list.title, '今天先做')
  assert.equal(r.payload.list.items.length, 2)
  assert.equal(r.payload.list.items[0].ok, true)
  assert.equal(r.payload.list.items[0].id, made.node.id)
  assert.equal(r.payload.list.items[1].ok, false, 'AI 指错了要让人看见')
  assert.equal(r.payload.list.items[1].id, null)
})

// ---------------------------------------------------------------- 完成语义一体化

test('完成最后一个子项：父计划自动完成（级联），reason 记 auto-done', async () => {
  const plan = await call('plan_node_add', { title: '级联主线', type: 'plan' })
  const sub = await call('plan_node_add', { title: '级联子计划', type: 'plan', parent: plan.node.id })
  const a = await call('plan_node_add', { title: '级联甲', type: 'todo', parent: sub.node.id })
  const b = await call('plan_node_add', { title: '级联乙', type: 'todo', parent: sub.node.id })
  await call('plan_todo_set', { todo: a.node.id, status: 'done' })
  const mid = dig((await readPlan()).nodes, sub.node.id)
  assert.equal(mid.status, 'active', '还差一个，父不完成')

  // 工具返回体不带 reason（它在版本留档标签里），级联用计划状态本身断言。
  await call('plan_todo_set', { todo: b.node.id, status: 'done' })
  const planAfter = await readPlan()
  assert.equal(dig(planAfter.nodes, sub.node.id).status, 'done', '子计划自动完成')
  assert.equal(dig(planAfter.nodes, plan.node.id).status, 'done', '祖父也级联完成')
})

test('撤回子项：自动完成的父链重新打开', async () => {
  const shown = await post('/get', { sessionId: SESSION_ID })
  const main = shown.payload.plan.nodes.find((n) => n.title === '级联主线')
  const sub = main.children.find((n) => n.title === '级联子计划')
  const b = sub.children.find((n) => n.title === '级联乙')
  // 上一条用例把乙标成 done 了；撤回它。
  await call('plan_todo_set', { todo: b.id, status: 'todo' })
  const plan = await readPlan()
  assert.equal(dig(plan.nodes, sub.id).status, 'active', '子计划重新打开')
  assert.equal(dig(plan.nodes, main.id).status, 'active', '祖父也重新打开')
})

test('有未完成子项的计划：手动标 done 被拒（工具与 HTTP 同一规则）', async () => {
  const plan = await call('plan_node_add', { title: '拦截测试计划', type: 'plan' })
  await call('plan_node_add', { title: '没做完的子项', type: 'todo', parent: plan.node.id })
  await assert.rejects(
    () => call('plan_node_set', { node: plan.node.id, status: 'done' }),
    /不能直接完成/,
  )
  const http = await post('/node-set', { sessionId: SESSION_ID, node: plan.node.id, status: 'done' })
  assert.equal(http.status, 500)
  assert.match(http.payload.error, /不能直接完成/)

  // dropped（放弃）不受影响：放弃整个分支是合法动作。
  const drop = await call('plan_node_set', { node: plan.node.id, status: 'dropped' })
  assert.equal(drop.ok, true)
})

test('叶子计划可以手动完成（面板勾选走的就是这条通路）', async () => {
  const made = await call('plan_node_add', { title: '空计划也能完成', type: 'plan' })
  const r = await call('plan_node_set', { node: made.node.id, status: 'done' })
  assert.equal(r.ok, true)
  assert.equal(dig((await readPlan()).nodes, made.node.id).status, 'done')
})

test('filed 已废弃：老调用被安全忽略，不报错、不生效、不落盘', async () => {
  // 顶层不再分「收件箱 / 工作计划」两栏，「纳入工作计划」这个动作随字段一起删除。
  // 但 agent 可能还按老习惯传 filed——所以这条测试钉住**兼容行为**：
  // 传了不报错（不会把一个已无意义的历史参数变成硬失败），也不改变任何东西。
  const made = await call('plan_node_add', { title: '独立事项' })
  const id = made.node.id
  const before = (await call('plan_show')).plan.counts

  // agent 侧：plan_node_set 带 filed —— 应被忽略。
  await call('plan_node_set', { node: id, filed: true })
  const after = (await call('plan_show')).plan
  assert.equal(after.counts.inbox, before.inbox, 'filed 不再改变任何计数')
  assert.equal('filed' in after.nodes.find((n) => n.id === id), false,
    '磁盘/payload 上都不该长出这个键')

  // 面板侧：同一条通路（/node-set）单传 filed 会得到**说清楚的**提示，
  // 而不是「没有要改的属性」——后者会让 agent 以为自己参数名写错了然后反复试。
  const { payload } = await post('/node-set', { sessionId: SESSION_ID, node: id, filed: false })
  assert.equal(payload.ok, false)
  assert.match(String(payload.error), /filed 已废弃/, '要明说这个字段废弃了')
  assert.match(String(payload.error), /加子项/, '并告诉它现在该怎么做（加子项）')
})
