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
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises'
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

// ------------------------------------------------------------------ 注册面

test('注册了完整的工具集（含新增的重要程度与委派工具）', () => {
  const expected = [
    'plan_show', 'plan_goal_add', 'plan_kr_add', 'plan_task_add', 'plan_todo_add',
    'plan_task_set', 'plan_kr_set', 'plan_goal_set', 'plan_priority_set',
    'plan_delegate_set', 'plan_delegate_receipt', 'plan_delegated',
    'plan_snapshot', 'plan_history', 'plan_restore',
  ]
  assert.deepEqual([...tools.keys()].sort(), expected.slice().sort())
})

test('注册了 HTTP 数据面路由', () => {
  assert.deepEqual(
    [...routes.keys()].sort(),
    ['/api/workbench/get', '/api/workbench/history', '/api/workbench/init',
      '/api/workbench/node-set', '/api/workbench/snapshot', '/api/workbench/task-set',
      '/api/workbench/todo-add'].sort(),
  )
})

test('会话没有 cwd 时报可读错误，而不是写到别处', async () => {
  await assert.rejects(
    () => tools.get('plan_show').execute({}, { agent: { session: { header: {} } } }),
    /没有工作区目录/,
  )
})

// -------------------------------------------------------------------- 收件箱

test('plan_todo_add 记进收件箱，不挂任何计划', async () => {
  const r = await call('plan_todo_add', { title: '找张三要上周的数据', due: '2026-09-18' })
  assert.equal(r.ok, true)
  assert.equal(r.todo.status, 'todo')

  const plan = await readPlan()
  assert.equal(plan.inbox.length, 1)
  assert.equal(plan.goals.length, 0)
  assert.equal(plan.inbox[0].title, '找张三要上周的数据')
})

test('plan_show 能看到收件箱与管控汇总', async () => {
  const r = await call('plan_show')
  assert.equal(r.plan.inbox.length, 1)
  assert.ok(r.plan.control, '应该带管控汇总')
  assert.equal(r.plan.control.inboxOpen, 1)
})

test('收件箱里的待办也能勾完成（工具与面板共用一条写入路径）', async () => {
  const id = (await call('plan_show')).plan.inbox[0].id
  const r = await call('plan_task_set', { task: id, status: 'done' })
  assert.equal(r.ok, true)
  assert.ok(r.task.doneAt, '完成时应该写入 doneAt')
  const plan = await readPlan()
  assert.equal(plan.inbox[0].status, 'done')
  assert.ok(plan.inbox[0].doneAt)
})

test('HTTP /todo-add 也能记一条到收件箱', async () => {
  const { status, payload } = await post('/todo-add', { sessionId: SESSION_ID, title: '面板记的一条' })
  assert.equal(status, 200)
  assert.equal(payload.ok, true)
  const plan = await readPlan()
  assert.ok(plan.inbox.some((t) => t.title === '面板记的一条'))
})

// ------------------------------------------------------- 重要程度与管控警告

test('高重要度的计划缺周期与负责人时给出警告（而不是拦下）', async () => {
  const r = await call('plan_goal_add', { title: 'Q4 数据治理专项', priority: 'high' })
  assert.equal(r.ok, true)
  assert.equal(r.goal.priority, 'high')
  assert.equal(r.warnings.length, 2, '应同时缺周期与负责人：' + JSON.stringify(r.warnings))
  assert.match(r.warnings.join('；'), /周期/)
  assert.match(r.warnings.join('；'), /负责人/)
})

test('补齐周期与负责人后警告消失', async () => {
  const r = await call('plan_goal_set', {
    goal: 'Q4 数据治理专项',
    owner: '张三',
    start: '2026-10-01',
    end: '2026-12-31',
  })
  assert.equal(r.warnings.length, 0)
})

test('中重要度的待办缺截止时提示，低重要度不打扰', async () => {
  const mid = await call('plan_todo_add', { title: '中等的没有截止' })
  assert.match(mid.warnings.join('；'), /截止/)
  const low = await call('plan_todo_add', { title: '低等的没有截止', priority: 'low' })
  assert.deepEqual(low.warnings, [])
})

test('plan_priority_set 对任意节点生效，并能按标题定位', async () => {
  const r = await call('plan_priority_set', { node: '中等的没有截止', priority: 'high' })
  assert.equal(r.node.priority, 'high')
  assert.match(r.warnings.join('；'), /截止/)
  const plan = await readPlan()
  assert.equal(plan.inbox.find((t) => t.title === '中等的没有截止').priority, 'high')
})

test('非法的 priority 被拒绝', async () => {
  await assert.rejects(() => call('plan_priority_set', { node: '中等的没有截止', priority: 'urgent' }), /priority 必须是/)
})

// ---------------------------------------------------------------------- 委派

test('建立委派：回执初始为待接受', async () => {
  await call('plan_todo_add', { title: '给张三的活' })
  const r = await call('plan_delegate_set', {
    node: '给张三的活',
    to: '张三',
    expectAt: '2026-09-20',
  })
  assert.equal(r.delegate.status, 'pending')
  assert.equal(r.delegate.to, '张三')
  assert.equal(r.delegate.overdueReceipt, false)
})

test('plan_delegated 列出委派出去的事项（含种类与期望时间）', async () => {
  const r = await call('plan_delegated')
  assert.equal(r.ok, true)
  assert.equal(r.items.length, 1)
  assert.equal(r.items[0].delegate.expectAt, '2026-09-20')
  assert.equal(r.items[0].kindLabel, '收件箱待办')
})

test('过期的委派被标成逾期未回执，并出现在节点警告里', async () => {
  await call('plan_todo_add', { title: '给李四的活' })
  await call('plan_delegate_set', { node: '给李四的活', to: '李四', expectAt: '2000-01-01' })
  const r = await call('plan_delegated')
  assert.equal(r.items[0].delegate.overdueReceipt, true, '逾期项应排在前面')

  const got = await call('plan_show')
  const node = got.plan.inbox.find((t) => t.title === '给李四的活')
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

test('plan_task_set 只接受待办，误传计划时给出可读的方向指引', async () => {
  await assert.rejects(
    () => call('plan_task_set', { task: 'Q4 数据治理专项', status: 'done' }),
    /不是待办——改计划\/子计划的状态请用 plan_goal_set \/ plan_kr_set/,
  )
})

// ---------------------------------------------------------------- 时间戳

test('状态流转维护 doneAt / startedAt', async () => {
  const added = await call('plan_todo_add', { title: '带时间戳的待办' })
  const id = added.todo.id

  const doing = await call('plan_task_set', { task: id, status: 'doing' })
  assert.ok(doing.task.startedAt, '进入进行中应记 startedAt')
  const startedAt = doing.task.startedAt

  const done = await call('plan_task_set', { task: id, status: 'done' })
  assert.ok(done.task.doneAt, '完成应记 doneAt')
  assert.equal(done.task.startedAt, startedAt, 'startedAt 只在首次写入')

  const again = await call('plan_task_set', { task: id, status: 'done' })
  assert.equal(again.task.doneAt, done.task.doneAt, '重复标记完成不应刷新时间')

  const back = await call('plan_task_set', { task: id, status: 'todo' })
  assert.equal(back.task.doneAt, undefined, '离开 done 要清掉 doneAt，否则周报会重复统计')
})

test('计划的完成也会写入 doneAt', async () => {
  const r = await call('plan_goal_set', { goal: 'Q4 数据治理专项', status: 'done' })
  assert.ok(r.goal.doneAt)
})

// -------------------------------------------------- HTTP 面板写入路径

test('HTTP /node-set 能改重要程度，写入与工具一致', async () => {
  const plan0 = await readPlan()
  const target = plan0.inbox.find((t) => t.title === '面板记的一条')
  const { payload } = await post('/node-set', { sessionId: SESSION_ID, node: target.id, priority: 'high' })
  assert.equal(payload.ok, true)
  const plan = await readPlan()
  assert.equal(plan.inbox.find((t) => t.id === target.id).priority, 'high')
})

test('HTTP /node-set 也能记委派回执', async () => {
  const plan0 = await readPlan()
  const target = plan0.inbox.find((t) => t.title === '给张三的活')
  const { payload } = await post('/node-set', { sessionId: SESSION_ID, node: target.id, receipt: 'returned' })
  assert.equal(payload.ok, true)
  const plan = await readPlan()
  assert.equal(plan.inbox.find((t) => t.id === target.id).delegate.status, 'returned')
})

test('HTTP /node-set 没给任何属性时报错，不做空写入', async () => {
  const { status, payload } = await post('/node-set', { sessionId: SESSION_ID, node: 't1' })
  assert.equal(status, 500)
  assert.match(payload.error, /没有要改的属性/)
})

test('HTTP 面板接口缺少 sessionId 时报错（不能猜工作区）', async () => {
  const { status, payload } = await post('/get', {})
  assert.equal(status, 500)
  assert.match(payload.error, /缺少 sessionId/)
})

// ------------------------------------------------------------ 版本留档

test('每一次工具写入都留下了快照（面板与 agent 都不绕过归档）', async () => {
  const files = await readdir(join(dir, 'plan', '.versions'))
  const snapshots = files.filter((f) => f.endsWith('.json'))
  assert.ok(snapshots.length >= 10, '写入次数远多于快照数说明有路径绕过了归档：' + snapshots.length)
  assert.ok(snapshots.some((f) => f.includes('todo-add')), '快照标签应记录改动原因')
})

test('回滚能把计划恢复到历史版本', async () => {
  const history = await call('plan_history', { limit: 5 })
  assert.ok(history.versions.length > 0)
  const first = history.versions[history.versions.length - 1]
  const r = await call('plan_restore', { file: first.file })
  assert.equal(r.ok, true)
  assert.equal(r.restoredFrom, first.file)
})
