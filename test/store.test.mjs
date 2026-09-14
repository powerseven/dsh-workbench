/**
 * 计划数据层单元测试（node:test，无外部依赖）。
 * 运行：npm test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DELEGATE_STATUS,
  PlanStore,
  PRIORITY,
  applyStatus,
  collectNodes,
  controlSummary,
  delegateState,
  delegatedList,
  emptyPlan,
  goalProgress,
  isDueWithin,
  isOverdue,
  krProgress,
  nextId,
  nextPriority,
  nodeWarnings,
  normalizePlan,
  planProgress,
  priorityOf,
  renderMarkdown,
  resolveAny,
  resolveRef,
  setDelegate,
  setPriority,
  setReceipt,
  taskCounts,
  todayStr,
} from '../src/store.js'

/** 一个可用的样例计划。 */
function samplePlan() {
  const plan = emptyPlan('测试计划')
  plan.goals.push({
    id: 'g1',
    title: '完成低电压治理攻坚',
    status: 'active',
    owner: '张三',
    start: '2026-10-01',
    end: '2026-12-31',
    krs: [
      {
        id: 'k1',
        title: '完成 12 个台区改造',
        status: 'active',
        target: 12,
        current: 3,
        unit: '个',
        tasks: [],
      },
      {
        id: 'k2',
        title: '建立治理台账',
        status: 'active',
        tasks: [
          { id: 't1', title: '收集基础数据', status: 'done' },
          { id: 't2', title: '录入系统', status: 'doing', due: '2026-11-01' },
          { id: 't3', title: '复核', status: 'todo' },
        ],
      },
    ],
  })
  return plan
}

async function withTemp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wb-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- 进度计算

test('量化 KR 按 current/target 计算', () => {
  assert.equal(krProgress({ target: 12, current: 3 }), 0.25)
  // 超额完成夹取到 1
  assert.equal(krProgress({ target: 2, current: 5 }), 1)
})

test('清单 KR 按任务完成比例计算', () => {
  const kr = { tasks: [{ status: 'done' }, { status: 'todo' }, { status: 'todo' }, { status: 'done' }] }
  assert.equal(krProgress(kr), 0.5)
})

test('清单 KR 里 dropped 任务不计入完成数', () => {
  const kr = { tasks: [{ status: 'done' }, { status: 'dropped' }] }
  assert.equal(krProgress(kr), 0.5)
})

test('空 KR 按自身状态给 0 或 1', () => {
  assert.equal(krProgress({ tasks: [] }), 0)
  assert.equal(krProgress({ tasks: [], status: 'done' }), 1)
})

test('量化优先于任务清单', () => {
  const kr = { target: 10, current: 1, tasks: [{ status: 'done' }] }
  assert.equal(krProgress(kr), 0.1)
})

test('目标完成度是各 KR 的平均', () => {
  const plan = samplePlan()
  // k1 = 3/12 = 0.25；k2 = 1/3 ≈ 0.3333…
  const expected = (0.25 + 1 / 3) / 2
  assert.ok(Math.abs(goalProgress(plan.goals[0]) - expected) < 1e-9)
})

test('全计划完成度是各目标的平均；无目标时为 0', () => {
  const plan = samplePlan()
  assert.ok(Math.abs(planProgress(plan) - goalProgress(plan.goals[0])) < 1e-9)
  assert.equal(planProgress(emptyPlan()), 0)
})

// -------------------------------------------------------------------- 计数

test('taskCounts 统计四种状态并给出总数', () => {
  const plan = samplePlan()
  const c = taskCounts(plan)
  assert.equal(c.total, 3)
  assert.equal(c.done, 1)
  assert.equal(c.doing, 1)
  assert.equal(c.todo, 1)
  assert.equal(c.dropped, 0)
})

test('taskCounts 把非法状态按 todo 计', () => {
  const plan = emptyPlan()
  plan.goals.push({ id: 'g1', title: 'x', krs: [{ id: 'k1', title: 'y', tasks: [{ id: 't1', title: 'z', status: '乱写' }] }] })
  assert.equal(taskCounts(plan).todo, 1)
})

// -------------------------------------------------------------------- id

test('nextId 跳过已用编号，不受层级影响', () => {
  const plan = samplePlan()
  assert.equal(nextId(plan, 'g'), 'g2')
  // k1/k2 已用
  assert.equal(nextId(plan, 'k'), 'k3')
  // t1/t2/t3 已用（嵌套在 KR 内也要扫到）
  assert.equal(nextId(plan, 't'), 't4')
})

test('nextId 在不同前缀之间互不干扰', () => {
  const plan = emptyPlan()
  plan.goals.push({ id: 'g1', title: 'a', krs: [{ id: 'k1', title: 'b', tasks: [{ id: 't1', title: 'c', status: 'todo' }] }] })
  assert.equal(nextId(plan, 'g'), 'g2')
  assert.equal(nextId(plan, 't'), 't2')
})

// ------------------------------------------------------------------ resolve

test('resolveRef 支持按 id 定位', () => {
  const plan = samplePlan()
  assert.equal(resolveRef(plan, 'g1', 'goal').node.id, 'g1')
  assert.equal(resolveRef(plan, 'k2', 'kr').node.id, 'k2')
  assert.equal(resolveRef(plan, 't2', 'task').node.id, 't2')
})

test('resolveRef 支持按完整标题定位', () => {
  const plan = samplePlan()
  assert.equal(resolveRef(plan, '建立治理台账', 'kr').node.id, 'k2')
})

test('resolveRef 支持唯一包含匹配', () => {
  const plan = samplePlan()
  assert.equal(resolveRef(plan, '复核', 'task').node.id, 't3')
})

test('resolveRef 在有歧义时报错而不是随便挑一个', () => {
  const plan = emptyPlan()
  plan.goals.push({ id: 'g1', title: '目标A', krs: [{ id: 'k1', title: '改造台区', tasks: [] }] })
  plan.goals.push({ id: 'g2', title: '目标B', krs: [{ id: 'k2', title: '改造线路', tasks: [] }] })
  assert.throws(() => resolveRef(plan, '改造', 'kr'), /模糊匹配到多个/)
})

test('resolveRef 找不到时报错', () => {
  assert.throws(() => resolveRef(samplePlan(), '不存在的目标', 'goal'), /找不到 goal/)
})

test('resolveRef 空引用报错', () => {
  assert.throws(() => resolveRef(samplePlan(), '  ', 'goal'), /需要/)
})

// ---------------------------------------------------------------- Markdown

test('renderMarkdown 含标题、版本、进度与三级结构', () => {
  const md = renderMarkdown(samplePlan())
  assert.match(md, /# 测试计划/)
  assert.match(md, /## g1 · 完成低电压治理攻坚/)
  assert.match(md, /### k1 · 完成 12 个台区改造/)
  assert.match(md, /3\/12 个/)
  assert.match(md, /- \[x\] t1 · 收集基础数据/)
  assert.match(md, /- \[ \] t2 · 录入系统/)
  assert.match(md, /截止 2026-11-01/)
  assert.match(md, /负责人：张三/)
})

test('renderMarkdown 标注 doing 与 dropped', () => {
  const plan = emptyPlan()
  plan.goals.push({
    id: 'g1', title: 'G', krs: [{
      id: 'k1', title: 'K', tasks: [
        { id: 't1', title: '进行中的', status: 'doing' },
        { id: 't2', title: '放弃的', status: 'dropped' },
      ],
    }],
  })
  const md = renderMarkdown(plan)
  assert.match(md, /进行中/)
  assert.match(md, /已放弃/)
})

// ------------------------------------------------------------------- Store

test('load 在文件不存在时返回空计划', async () => {
  await withTemp(async (dir) => {
    const store = new PlanStore(dir)
    const plan = await store.load()
    assert.deepEqual(plan.goals, [])
    assert.equal(plan.version, 0)
  })
})

test('save 落盘 plan.json 与 PLAN.md，并自增版本号', async () => {
  await withTemp(async (dir) => {
    const store = new PlanStore(dir)
    const plan = await store.load()
    plan.goals.push({ id: 'g1', title: '目标', status: 'active', krs: [] })

    await store.save(plan, { reason: 'test' })
    assert.equal(plan.version, 1)

    const json = JSON.parse(await readFile(store.file, 'utf8'))
    assert.equal(json.version, 1)
    assert.equal(json.goals.length, 1)

    const md = await readFile(store.view, 'utf8')
    assert.match(md, /# 个人工作计划/)

    await store.save(plan, { reason: 'test2' })
    assert.equal(plan.version, 2)
  })
})

test('每次 save 前的版本被归档，history 最新在前', async () => {
  await withTemp(async (dir) => {
    const store = new PlanStore(dir)
    const plan = await store.load()
    plan.goals.push({ id: 'g1', title: 'v1 的目标', status: 'active', krs: [] })
    await store.save(plan, { reason: 'first' })

    plan.goals.push({ id: 'g2', title: 'v2 的目标', status: 'active', krs: [] })
    await store.save(plan, { reason: 'second' })

    const history = await store.history(10)
    assert.equal(history.length, 1, '第一次 save 时磁盘还没有文件，没有可归档的版本')
    assert.equal(history[0].reason, 'first')
  })
})

test('restore 回滚到历史版本，且回滚本身可撤销', async () => {
  await withTemp(async (dir) => {
    const store = new PlanStore(dir)
    const plan = await store.load()
    plan.goals.push({ id: 'g1', title: '原始目标', status: 'active', krs: [] })
    await store.save(plan, { reason: 'first' })

    plan.goals.push({ id: 'g2', title: '后来加的', status: 'active', krs: [] })
    await store.save(plan, { reason: 'second' })

    const history = await store.history(10)
    const first = history.find((v) => v.reason === 'first')
    assert.ok(first, '应该有 first 版本的归档')

    const restored = await store.restore(first.file)
    assert.equal(restored.goals.length, 1)
    assert.equal(restored.goals[0].title, '原始目标')

    // 回滚后磁盘上的计划也变了
    const onDisk = JSON.parse(await readFile(store.file, 'utf8'))
    assert.equal(onDisk.goals.length, 1)

    // 回滚前又归档了一次，所以现在 history 里多了 before-restore
    const after = await store.history(10)
    assert.ok(after.some((v) => v.reason === 'before-restore'))
  })
})

test('restore 拒绝路径穿越', async () => {
  await withTemp(async (dir) => {
    const store = new PlanStore(dir)
    await assert.rejects(() => store.restore('../../etc/passwd'), /非法的版本文件名/)
    await assert.rejects(() => store.restore('a/b.json'), /非法的版本文件名/)
  })
})

test('restore 对不存在的版本报错', async () => {
  await withTemp(async (dir) => {
    const store = new PlanStore(dir)
    await assert.rejects(() => store.restore('nope.json'), /版本不存在/)
  })
})

test('snapshot 在没有计划时报错', async () => {
  await withTemp(async (dir) => {
    const store = new PlanStore(dir)
    await assert.rejects(() => store.snapshot('x'), /还没有计划可归档/)
  })
})

test('snapshot 可以重复打点', async () => {
  await withTemp(async (dir) => {
    const store = new PlanStore(dir)
    const plan = await store.load()
    await store.save(plan, { reason: 'init' })
    await store.snapshot('阶段收尾')
    const history = await store.history(10)
    assert.ok(history.some((v) => v.reason === '阶段收尾'))
  })
})

test('load 对非法 JSON 报可读错误', async () => {
  await withTemp(async (dir) => {
    const store = new PlanStore(dir)
    await store.save(emptyPlan(), { reason: 'init' })
    await writeFile(store.file, '{ 这不是 JSON', 'utf8')
    await assert.rejects(() => store.load(), /不是合法 JSON/)
  })
})

test('load 对结构不合法的 JSON 报错', async () => {
  await withTemp(async (dir) => {
    const store = new PlanStore(dir)
    await store.save(emptyPlan(), { reason: 'init' })
    await writeFile(store.file, JSON.stringify({ title: 'x' }), 'utf8')
    await assert.rejects(() => store.load(), /缺少 goals 数组/)
  })
})

test('PlanStore 拒绝空根目录', () => {
  assert.throws(() => new PlanStore(''), /需要一个工作区根目录/)
})

test('计划落在 <root>/plan 下，不污染工作区根目录', async () => {
  await withTemp(async (dir) => {
    const store = new PlanStore(dir)
    assert.equal(store.dir, join(dir, 'plan'))
    await store.save(emptyPlan(), { reason: 'init' })
    assert.ok(existsSync(join(dir, 'plan', 'plan.json')))
    assert.ok(existsSync(join(dir, 'plan', 'PLAN.md')))
  })
})

// ------------------------------------------------------------- 重要程度

test('priorityOf 对缺失与脏值一律按 normal，老数据零迁移', () => {
  assert.deepEqual(PRIORITY, ['high', 'normal', 'low'])
  assert.equal(priorityOf({}), 'normal')
  assert.equal(priorityOf({ priority: 'urgent' }), 'normal')
  assert.equal(priorityOf(null), 'normal')
  assert.equal(priorityOf({ priority: 'high' }), 'high')
})

test('setPriority 校验取值并写入', () => {
  const node = {}
  setPriority(node, 'high')
  assert.equal(node.priority, 'high')
  assert.throws(() => setPriority(node, '很高'), /priority 必须是 high \/ normal \/ low/)
  assert.throws(() => setPriority(node, '  '), /priority 必须是/)
})

test('nextPriority 在高/中/低之间循环', () => {
  assert.equal(nextPriority('high'), 'normal')
  assert.equal(nextPriority('normal'), 'low')
  assert.equal(nextPriority('low'), 'high')
  assert.equal(nextPriority(undefined), 'low', '缺省视为 normal，循环到 low')
})

test('高重要度的计划缺周期与负责人时给出警告', () => {
  const w = nodeWarnings({ priority: 'high' }, 'goal')
  assert.equal(w.length, 2)
  assert.match(w.join('；'), /需要周期/)
  assert.match(w.join('；'), /需要负责人/)
  assert.deepEqual(nodeWarnings({ priority: 'high', start: '2026-01-01', owner: '张三' }, 'goal'), [])
})

test('待办不要求负责人（默认自己负责），否则警告会失去意义', () => {
  assert.deepEqual(nodeWarnings({ priority: 'high', due: '2026-01-01' }, 'task'), [])
  assert.match(nodeWarnings({ priority: 'high' }, 'task').join('；'), /需要截止日期/)
})

test('中重要度缺截止时提示，低重要度完全不打扰', () => {
  assert.match(nodeWarnings({}, 'task').join('；'), /建议补一个截止日期/)
  assert.deepEqual(nodeWarnings({ priority: 'low' }, 'task'), [])
  assert.deepEqual(nodeWarnings({ priority: 'normal', due: '2026-01-01' }, 'task'), [])
})

// ---------------------------------------------------------------- 时间戳

test('applyStatus 在完成时记 doneAt，离开 done 时清掉', () => {
  const task = { status: 'todo' }
  applyStatus(task, 'done', new Date('2026-09-14T10:00:00Z'))
  assert.equal(task.doneAt, '2026-09-14T10:00:00.000Z')
  // 重复标记完成不刷新时间——否则「什么时候完成的」会被改写成「刚刚」
  applyStatus(task, 'done', new Date('2026-09-15T10:00:00Z'))
  assert.equal(task.doneAt, '2026-09-14T10:00:00.000Z')
  applyStatus(task, 'todo')
  assert.equal(task.doneAt, undefined, '离开 done 要清掉，否则周报会重复统计')
})

test('applyStatus 只在首次进入 doing 时记 startedAt', () => {
  const task = { status: 'todo' }
  applyStatus(task, 'doing', new Date('2026-09-14T10:00:00Z'))
  assert.equal(task.startedAt, '2026-09-14T10:00:00.000Z')
  applyStatus(task, 'todo')
  applyStatus(task, 'doing', new Date('2026-09-20T10:00:00Z'))
  assert.equal(task.startedAt, '2026-09-14T10:00:00.000Z')
})

test('applyStatus 对计划节点同样适用（计划也能有完成时间）', () => {
  const goal = { status: 'active' }
  applyStatus(goal, 'done', new Date('2026-09-14T10:00:00Z'))
  assert.ok(goal.doneAt)
})

// ------------------------------------------------------------------- 委派

test('setDelegate 记录对象、委派时间与期望时间，回执初始待接受', () => {
  const task = { status: 'todo' }
  setDelegate(task, { to: ' 张三 ', expectAt: '2026-09-20' }, new Date('2026-09-14T10:00:00Z'))
  assert.deepEqual(task.delegate, {
    to: '张三',
    at: '2026-09-14T10:00:00.000Z',
    status: 'pending',
    expectAt: '2026-09-20',
  })
})

test('setDelegate 必须有对象', () => {
  assert.throws(() => setDelegate({}, { to: '  ' }), /委派对象不能为空/)
})

test('重新委派会重置回执状态（换人意味着上一轮回执作废）', () => {
  const task = { status: 'todo' }
  setDelegate(task, { to: '张三' })
  setReceipt(task, 'accepted')
  assert.equal(task.delegate.status, 'accepted')
  setDelegate(task, { to: '李四' })
  assert.equal(task.delegate.to, '李四')
  assert.equal(task.delegate.status, 'pending')
})

test('setReceipt 校验取值，并要求已有委派记录', () => {
  assert.deepEqual(DELEGATE_STATUS, ['pending', 'accepted', 'declined', 'returned'])
  assert.throws(() => setReceipt({}, 'accepted'), /还没有委派记录/)
  const task = { status: 'todo' }
  setDelegate(task, { to: '张三' })
  assert.throws(() => setReceipt(task, '已接受'), /回执状态必须是/)
  setReceipt(task, 'declined', { note: '忙不过来' })
  assert.equal(task.delegate.status, 'declined')
  assert.equal(task.delegate.note, '忙不过来')
  assert.ok(task.delegate.receiptAt)
})

test('委派逾期的两种标记分开算（该去问 vs 该去催）', () => {
  const task = { status: 'todo' }
  setDelegate(task, { to: '张三', expectAt: '2000-01-01' })
  let d = delegateState(task, '2026-09-14')
  assert.equal(d.overdueReceipt, true, '未回执且过期 → 该去问一句')
  assert.equal(d.overdueWork, true)

  setReceipt(task, 'accepted')
  d = delegateState(task, '2026-09-14')
  assert.equal(d.overdueReceipt, false, '已回执就不再算逾期未回执')
  assert.equal(d.overdueWork, true, '活没做完，仍然是逾期')

  task.status = 'done'
  d = delegateState(task, '2026-09-14')
  assert.equal(d.overdueWork, false, '做完了就不该在逾期列表里')
})

test('没有委派时 delegateState 返回 null', () => {
  assert.equal(delegateState({}), null)
  assert.equal(delegateState({ delegate: { at: '2026-01-01' } }), null)
})

test('逾期未回执会出现在节点警告里', () => {
  const task = { status: 'todo', priority: 'low' }
  setDelegate(task, { to: '李四', expectAt: '2000-01-01' })
  assert.match(nodeWarnings(task, 'task').join('；'), /委派给 李四 已逾期未回执/)
})

test('delegatedList 把逾期的排前面，并带上种类与父节点', () => {
  const plan = samplePlan()
  const t2 = plan.goals[0].krs[1].tasks[1]
  const t3 = plan.goals[0].krs[1].tasks[2]
  setDelegate(t2, { to: '张三', expectAt: '2026-12-01' })
  setDelegate(t3, { to: '李四', expectAt: '2000-01-01' })
  const list = delegatedList(plan, '2026-09-14')
  assert.equal(list.length, 2)
  assert.equal(list[0].id, 't3', '逾期的排前面')
  assert.equal(list[0].kind, 'task')
  assert.equal(list[0].parent, 'k2')
  assert.equal(list[1].delegate.to, '张三')
})

// ------------------------------------------------------- 收件箱与整树定位

test('normalizePlan 给老计划补上空收件箱（只在内存里补）', () => {
  const plan = normalizePlan({ goals: [] })
  assert.deepEqual(plan.inbox, [])
  assert.throws(() => normalizePlan({}), /缺少 goals 数组/)
})

test('nextId 必须连收件箱一起扫，否则会重号', () => {
  const plan = emptyPlan()
  plan.inbox.push({ id: 't1', title: '游离待办', status: 'todo' })
  assert.equal(nextId(plan, 't'), 't2')
})

test('collectNodes 覆盖收件箱并标出种类', () => {
  const plan = samplePlan()
  plan.inbox.push({ id: 't9', title: '游离', status: 'todo' })
  const kinds = collectNodes(plan, 'any').map((x) => x.kind)
  assert.deepEqual(kinds.filter((k) => k === 'inbox').length, 1)
  assert.equal(collectNodes(plan, 'goal').length, 1)
  assert.equal(collectNodes(plan, 'kr').length, 2)
  assert.equal(collectNodes(plan, 'task').length, 3)
  assert.equal(collectNodes(plan, 'inbox').length, 1)
})

test('resolveAny 能跨种类定位（委派要作用在任意节点上）', () => {
  const plan = samplePlan()
  plan.inbox.push({ id: 't9', title: '游离待办', status: 'todo' })
  assert.equal(resolveAny(plan, 'g1').kind, 'goal')
  assert.equal(resolveAny(plan, 'k2').kind, 'kr')
  assert.equal(resolveAny(plan, '录入系统').kind, 'task')
  assert.equal(resolveAny(plan, '游离待办').kind, 'inbox')
  assert.throws(() => resolveAny(plan, '不存在的东西'), /找不到 节点/)
})

test('resolveAny 遇到重名时报错而不是随便挑', () => {
  const plan = samplePlan()
  plan.inbox.push({ id: 't9', title: '复核', status: 'todo' })
  assert.throws(() => resolveAny(plan, '复核'), /匹配到多个 节点/)
})

test('taskCounts 把收件箱算进待办，并单独给出未归位数', () => {
  const plan = samplePlan()
  plan.inbox.push({ id: 't9', title: '游离', status: 'todo' })
  plan.inbox.push({ id: 't10', title: '已做完的游离', status: 'done' })
  const c = taskCounts(plan)
  assert.equal(c.inbox, 2)
  assert.equal(c.inboxOpen, 1)
  assert.equal(c.total, 5, '3 个任务 + 2 条收件箱')
  assert.equal(c.done, 2)
})

test('controlSummary 给出筛选条要的角标数', () => {
  const plan = samplePlan()
  plan.goals[0].priority = 'high'
  plan.goals[0].krs[1].tasks[2].priority = 'high'
  setDelegate(plan.goals[0].krs[1].tasks[1], { to: '张三', expectAt: '2000-01-01' })
  plan.inbox.push({ id: 't9', title: '游离', status: 'todo', due: '2026-09-16' })
  const s = controlSummary(plan, '2026-09-14')
  assert.equal(s.high, 2)
  assert.equal(s.delegated, 1)
  assert.equal(s.overdue, 1, '过期的委派算逾期')
  assert.equal(s.week, 1, '9-16 在 7 天窗口内')
  assert.equal(s.inboxOpen, 1)
})

test('isOverdue 与 isDueWithin 只看未结束的节点', () => {
  assert.equal(isOverdue({ status: 'todo', due: '2000-01-01' }, '2026-09-14'), true)
  assert.equal(isOverdue({ status: 'done', due: '2000-01-01' }, '2026-09-14'), false)
  assert.equal(isOverdue({ status: 'dropped', due: '2000-01-01' }, '2026-09-14'), false)
  assert.equal(isOverdue({ status: 'todo', due: '2030-01-01' }, '2026-09-14'), false)
  assert.equal(isDueWithin({ status: 'todo', due: '2026-09-18' }, 7, '2026-09-14'), true)
  assert.equal(isDueWithin({ status: 'todo', due: '2026-09-14' }, 7, '2026-09-14'), true)
  assert.equal(isDueWithin({ status: 'todo', due: '2026-10-01' }, 7, '2026-09-14'), false)
  assert.equal(isDueWithin({ status: 'todo' }, 7, '2026-09-14'), false)
})

test('计划的锚点日期取 end（退一步 start）', () => {
  assert.equal(isDueWithin({ status: 'active', end: '2026-09-20' }, 7, '2026-09-14'), true)
  assert.equal(isOverdue({ status: 'active', end: '2000-01-01' }, '2026-09-14'), true)
})

test('todayStr 输出本地时区的 YYYY-MM-DD', () => {
  assert.match(todayStr(), /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(todayStr(new Date(2026, 8, 14, 23, 0, 0)), '2026-09-14')
})

// ------------------------------------------------------- Markdown 视图

test('renderMarkdown 渲染收件箱，并标注重要度与委派', () => {
  const plan = emptyPlan('测试计划')
  plan.inbox.push({ id: 't1', title: '找张三要数据', status: 'todo', priority: 'high', due: '2026-09-18' })
  const md = renderMarkdown(plan)
  assert.match(md, /## 收件箱 · 未归类待办  1 条/)
  assert.match(md, /- \[ \] t1 · 找张三要数据/)
  assert.match(md, /重要度高/)
  assert.match(md, /截止 2026-09-18/)
})

test('renderMarkdown 标注委派、完成时间与管控概览', () => {
  const plan = samplePlan()
  const task = plan.goals[0].krs[1].tasks[1]
  setDelegate(task, { to: '张三', expectAt: '2000-01-01' })
  applyStatus(plan.goals[0].krs[1].tasks[0], 'done', new Date('2026-09-10T10:00:00Z'))
  const md = renderMarkdown(plan)
  assert.match(md, /委派 张三（待接受；期望 2000-01-01）/)
  assert.match(md, /完成于 2026-09-10/)
  assert.match(md, /- 管控：/)
})

test('renderMarkdown 对没有收件箱的老计划不产生空段', () => {
  const md = renderMarkdown(samplePlan())
  assert.doesNotMatch(md, /收件箱/)
})
