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

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { apply } from '../src/index.js'

const SESSION_ID = 'session-1'

let dir = ''
let tools = new Map()
let routes = new Map()

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

test('注册了完整的工具集（节点模型：增删改移 + 待办状态 + 委派 + 留档）', () => {
  const expected = [
    'plan_show', 'plan_node_add', 'plan_node_set', 'plan_node_move', 'plan_node_remove',
    'plan_todo_set', 'plan_priority_set',
    'plan_delegate_set', 'plan_delegate_receipt', 'plan_delegated',
    'plan_snapshot', 'plan_history', 'plan_restore',
  ]
  assert.deepEqual([...tools.keys()].sort(), expected.slice().sort())
})

test('注册了 HTTP 数据面路由', () => {
  assert.deepEqual(
    [...routes.keys()].sort(),
    ['/api/workbench/get', '/api/workbench/history', '/api/workbench/init',
      '/api/workbench/node-add', '/api/workbench/node-move', '/api/workbench/node-remove',
      '/api/workbench/node-set', '/api/workbench/snapshot',
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
