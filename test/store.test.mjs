/**
 * 计划数据层单元测试（node:test，无外部依赖）。
 * 运行：npm test
 *
 * 覆盖三块：递归树的纯逻辑、schema 1 → 2 的迁移、以及 PlanStore 的落盘行为。
 * 迁移那一组是本次改造的护栏——它是共享仓库里唯一会「读别人写的老文件」的
 * 地方，错了会让老用户的计划静默变形。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DELEGATE_STATUS,
  EVIDENCE_KIND,
  PACE_THRESHOLD,
  PlanStore,
  SCHEMA,
  PRIORITY,
  addEvidence,
  addFile,
  appendChild,
  applyFields,
  applyStatus,
  behindList,
  childrenOf,
  clearFields,
  collectNodes,
  controlSummary,
  delegateState,
  delegatedList,
  emptyPlan,
  evidenceOf,
  evidenceWarnings,
  inboxOf,
  isDescendantOf,
  isDueWithin,
  isOverdue,
  isPlan,
  isTodo,
  isUnverified,
  locate,
  makeNode,
  migratePlan,
  moveNode,
  nextId,
  nextPriority,
  nodeProgress,
  nodeStats,
  nodeWarnings,
  normalizePlan,
  paceOf,
  planProgress,
  priorityOf,
  removeNode,
  removeFile,
  removeEvidence,
  renderMarkdown,
  resolveAny,
  resolveNode,
  addBlockedBy,
  blockedListOf,
  blockers,
  removeBlockedBy,
  RECUR_KIND,
  assertManualDoneAllowed,
  autoCompleteAncestors,
  parentOf,
  reopenAncestors,
  setDelegate,
  setDelegateExpectAt,
  setPriority,
  setNodeType,
  setRecur,
  setReceipt,
  setStar,
  setStatus,
  spawnRecurring,
  suggestParent,
  todoCounts,
  todayStr,
  topPlans,
  typeOf,
  unverifiedList,
  filesOf,
  fileWarnings,
} from '../src/store.js'

/** 一份 schema 2 的样例计划：计划 → 两个子计划 → 待办（含一条量化子计划）。 */
function samplePlan() {
  const plan = emptyPlan('测试计划')
  plan.nodes.push({
    id: 'g1',
    type: 'plan',
    title: '完成低电压治理攻坚',
    status: 'active',
    owner: '张三',
    start: '2026-10-01',
    end: '2026-12-31',
    children: [
      {
        id: 'k1',
        type: 'plan',
        title: '完成 12 个台区改造',
        status: 'active',
        metric: { target: 12, current: 3, unit: '个' },
        children: [],
      },
      {
        id: 'k2',
        type: 'plan',
        title: '建立治理台账',
        status: 'active',
        children: [
          { id: 't1', type: 'todo', title: '收集基础数据', status: 'done' },
          { id: 't2', type: 'todo', title: '录入系统', status: 'doing', due: '2026-11-01' },
          { id: 't3', type: 'todo', title: '复核', status: 'todo' },
        ],
      },
    ],
  })
  return plan
}

/** 一份 schema 1 的老计划（改造前磁盘上的形态）。 */
function legacyPlan() {
  return {
    version: 7,
    title: '老计划',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    lastReason: 'task-done',
    goals: [
      {
        id: 'g1',
        title: '老目标',
        status: 'active',
        owner: '张三',
        start: '2026-10-01',
        end: '2026-12-31',
        priority: 'high',
        krs: [
          {
            id: 'k1',
            title: '老量化 KR',
            status: 'active',
            target: 12,
            current: 3,
            unit: '个',
            note: '备注',
            tasks: [],
          },
          {
            id: 'k2',
            title: '老清单 KR',
            status: 'active',
            tasks: [
              { id: 't1', title: '已完成的老任务', status: 'done', doneAt: '2026-09-10T10:00:00.000Z' },
              { id: 't2', title: '进行中的', status: 'doing', due: '2026-11-01', startedAt: '2026-09-01T10:00:00.000Z' },
            ],
          },
        ],
      },
    ],
    inbox: [
      { id: 't9', title: '游离待办', status: 'todo', priority: 'high' },
    ],
  }
}

async function withTemp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wb-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- 类型判断

test('typeOf 缺省当待办（叶子是更宽松的默认）', () => {
  assert.equal(typeOf({ type: 'plan' }), 'plan')
  assert.equal(typeOf({ type: 'todo' }), 'todo')
  assert.equal(typeOf({}), 'todo')
  assert.equal(typeOf(null), 'todo')
  assert.equal(isPlan({ type: 'plan' }), true)
  assert.equal(isTodo({}), true)
})

// ---------------------------------------------------------------- 进度计算

test('量化节点按 metric 的 current/target 计算', () => {
  assert.equal(nodeProgress({ type: 'plan', metric: { target: 12, current: 3 } }), 0.25)
  // 超额完成夹取到 1
  assert.equal(nodeProgress({ type: 'plan', metric: { target: 2, current: 5 } }), 1)
})

test('汇总节点按子节点完成度的平均计算', () => {
  const node = {
    type: 'plan',
    children: [
      { type: 'todo', status: 'done' },
      { type: 'todo', status: 'todo' },
      { type: 'todo', status: 'todo' },
      { type: 'todo', status: 'done' },
    ],
  }
  assert.equal(nodeProgress(node), 0.5)
})

test('叶子待办按状态给 0 或 1，dropped 不算完成', () => {
  assert.equal(nodeProgress({ type: 'todo', status: 'done' }), 1)
  assert.equal(nodeProgress({ type: 'todo', status: 'todo' }), 0)
  assert.equal(nodeProgress({ type: 'todo', status: 'dropped' }), 0)
})

test('量化优先于子节点（两种度量不会互相干扰）', () => {
  const node = {
    type: 'plan',
    metric: { target: 10, current: 1 },
    children: [{ type: 'todo', status: 'done' }],
  }
  assert.equal(nodeProgress(node), 0.1)
})

test('递归：三层嵌套的完成度逐层汇总', () => {
  const plan = emptyPlan()
  plan.nodes.push({
    type: 'plan',
    id: 'n1',
    title: '年',
    children: [{
      type: 'plan',
      id: 'n2',
      title: '季',
      children: [
        { type: 'todo', id: 'n3', title: 'a', status: 'done' },
        { type: 'todo', id: 'n4', title: 'b', status: 'todo' },
      ],
    }],
  })
  assert.equal(nodeProgress(plan.nodes[0]), 0.5)
  assert.equal(planProgress(plan), 0.5)
})

test('planProgress 只算顶层计划；收件箱不参与', () => {
  const plan = samplePlan()
  // k1 = 3/12 = 0.25；k2 = 1/3 ≈ 0.3333…；g1 = 两者平均
  const expected = (0.25 + 1 / 3) / 2
  assert.ok(Math.abs(nodeProgress(plan.nodes[0]) - expected) < 1e-9)
  assert.ok(Math.abs(planProgress(plan) - expected) < 1e-9)

  // 加一条顶层待办（收件箱项）不该改变整体完成度
  plan.nodes.push({ id: 't9', type: 'todo', title: '游离', status: 'todo' })
  assert.ok(Math.abs(planProgress(plan) - expected) < 1e-9)
})

test('planProgress 在没有计划时是 0（只有收件箱也算 0）', () => {
  assert.equal(planProgress(emptyPlan()), 0)
  const onlyInbox = emptyPlan()
  onlyInbox.nodes.push({ id: 't1', type: 'todo', title: 'x', status: 'todo' })
  assert.equal(planProgress(onlyInbox), 0)
  assert.equal(planProgress(null), 0)
})

// -------------------------------------------------------------------- 遍历

test('collectNodes 递归整棵树，带深度与路径', () => {
  const plan = samplePlan()
  const all = collectNodes(plan, 'any')
  assert.equal(all.length, 6, '1 计划 + 2 子计划 + 3 待办')
  assert.equal(all[0].depth, 0)
  assert.equal(all[0].path, 'g1')
  assert.equal(all[1].depth, 1)
  assert.equal(all[1].path, 'g1 / k1')
  assert.equal(all[3].depth, 2, '待办在第三层')
  assert.equal(all[3].path, 'g1 / k2 / t1')
  assert.equal(all[3].parent.id, 'k2')
})

test('collectNodes 的类型过滤不限制深度（任意层级的待办都能取到）', () => {
  const plan = samplePlan()
  assert.equal(collectNodes(plan, 'plan').length, 3)
  assert.equal(collectNodes(plan, 'todo').length, 3)
  // 待办挂在任意深度都要能找到
  const deep = emptyPlan()
  deep.nodes.push({ id: 'n1', type: 'plan', title: 'a', children: [{ id: 'n2', type: 'plan', title: 'b', children: [{ id: 'n3', type: 'todo', title: 'c', status: 'todo' }] }] })
  assert.equal(collectNodes(deep, 'todo').length, 1)
  assert.equal(collectNodes(deep, 'todo')[0].path, 'n1 / n2 / n3')
})

test('inboxOf 只取顶层待办；topPlans 只取顶层计划', () => {
  const plan = samplePlan()
  plan.nodes.push({ id: 't9', type: 'todo', title: '游离', status: 'todo' })
  assert.deepEqual(inboxOf(plan).map((n) => n.id), ['t9'])
  assert.deepEqual(topPlans(plan).map((n) => n.id), ['g1'])
})

test('childrenOf 对脏数据返回空数组', () => {
  assert.deepEqual(childrenOf(null), [])
  assert.deepEqual(childrenOf({}), [])
  assert.deepEqual(childrenOf({ children: 'x' }), [])
})

test('nodeStats 统计整棵子树（删除前的提示要用）', () => {
  const plan = samplePlan()
  assert.deepEqual(nodeStats(plan.nodes[0]), { plans: 3, todos: 3, total: 6 })
  assert.deepEqual(nodeStats(plan.nodes[0].children[1]), { plans: 1, todos: 3, total: 4 })
})

// -------------------------------------------------------------------- id

test('nextId 扫描整棵树，不受层级影响', () => {
  const plan = samplePlan()
  // 老 id（g1/k1/k2/t1/t2/t3）都不是 n 前缀，所以 n1 可用
  assert.equal(nextId(plan), 'n1')
  plan.nodes.push({ id: 'n1', type: 'todo', title: 'x', status: 'todo' })
  plan.nodes[0].children[1].children.push({ id: 'n2', type: 'todo', title: 'y', status: 'todo' })
  assert.equal(nextId(plan), 'n3', '深层的 n2 也要扫到，否则会重号')
})

test('nextId 支持自定义前缀（老格式迁移期仍可用）', () => {
  const plan = samplePlan()
  assert.equal(nextId(plan, 't'), 't4')
  assert.equal(nextId(plan, 'g'), 'g2')
})

// ------------------------------------------------------------------ resolve

test('resolveNode 支持按 id / 完整标题 / 唯一包含匹配定位', () => {
  const plan = samplePlan()
  assert.equal(resolveNode(plan, 'g1', 'plan').node.id, 'g1')
  assert.equal(resolveNode(plan, '建立治理台账').node.id, 'k2')
  assert.equal(resolveNode(plan, '复核', 'todo').node.id, 't3')
})

test('resolveNode 限定类型时不会串到另一种节点上', () => {
  const plan = samplePlan()
  assert.throws(() => resolveNode(plan, 'g1', 'todo'), /找不到 待办/)
  assert.throws(() => resolveNode(plan, 't1', 'plan'), /找不到 计划/)
  assert.equal(resolveAny(plan, 'g1').node.id, 'g1')
})

test('resolveNode 在有歧义或找不到时报错，而不是随便挑一个', () => {
  const plan = emptyPlan()
  plan.nodes.push({ id: 'n1', type: 'plan', title: '改造台区', children: [] })
  plan.nodes.push({ id: 'n2', type: 'plan', title: '改造线路', children: [] })
  assert.throws(() => resolveNode(plan, '改造'), /模糊匹配到多个/)
  assert.throws(() => resolveNode(plan, '不存在的'), /找不到 节点/)
  assert.throws(() => resolveNode(plan, '  '), /需要/)
})

// ------------------------------------------------------------- 增 / 移 / 删

test('makeNode 默认造待办，可造计划（计划自动带 children）', () => {
  const plan = emptyPlan()
  const todo = makeNode(plan, { title: '待办' })
  assert.equal(todo.type, 'todo')
  assert.equal(todo.status, 'todo')
  assert.equal(todo.children, undefined, '待办是叶子，不该有 children')
  assert.equal(todo.id, 'n1')

  const sub = makeNode(plan, { title: '子计划', type: 'plan' })
  assert.equal(sub.status, 'active')
  assert.deepEqual(sub.children, [])
})

test('makeNode 校验类型与标题', () => {
  const plan = emptyPlan()
  assert.throws(() => makeNode(plan, { title: 'x', type: 'goal' }), /type 必须是 plan \/ todo/)
  assert.throws(() => makeNode(plan, { title: '   ' }), /标题不能为空/)
})

test('makeNode 接受重要程度、量化字段与时间字段', () => {
  const plan = emptyPlan()
  const node = makeNode(plan, {
    title: 'x', type: 'plan', priority: 'high', target: 12, current: 3, unit: '个',
    owner: '张三', start: '2026-10-01', end: '2026-12-31', note: '备注',
  })
  assert.equal(node.priority, 'high')
  assert.deepEqual(node.metric, { target: 12, current: 3, unit: '个' })
  assert.equal(node.owner, '张三')
  assert.equal(node.end, '2026-12-31')
  assert.equal(node.note, '备注')
})

test('applyFields 只更新量化进度的一部分时，不把 target / unit 抹掉', () => {
  const plan = emptyPlan()
  const node = makeNode(plan, { title: 'x', type: 'plan', target: 12, current: 3, unit: '个' })
  applyFields(node, { current: 7 })
  assert.deepEqual(node.metric, { target: 12, current: 7, unit: '个' }, '只传 current 不该丢 target')
  assert.equal(nodeProgress(node), 7 / 12, '进度按合并后的 metric 算')
})

test('applyFields 对没有 metric 的节点也能只写 current', () => {
  const node = { id: 'n1', type: 'plan', title: 'x', status: 'active' }
  applyFields(node, { current: 5 })
  assert.deepEqual(node.metric, { current: 5 })
})

test('appendChild 不传 parent 就放到顶层', () => {
  const plan = emptyPlan()
  const a = makeNode(plan, { title: '顶层待办' })
  appendChild(plan, a, null)
  assert.equal(plan.nodes.length, 1)
  assert.deepEqual(inboxOf(plan).map((n) => n.id), [a.id])
})

test('appendChild 只接受计划作为父节点（待办是叶子）', () => {
  const plan = samplePlan()
  const node = makeNode(plan, { title: '新待办' })
  assert.throws(() => appendChild(plan, node, 't1'), /是待办，不能往里放子项/)
  appendChild(plan, node, 'k2')
  assert.equal(plan.nodes[0].children[1].children.length, 4)
})

test('locate 给出父节点、兄弟数组与下标', () => {
  const plan = samplePlan()
  const at = locate(plan, 't2')
  assert.equal(at.parent.id, 'k2')
  assert.equal(at.index, 1)
  assert.equal(at.siblings.length, 3)
  const root = locate(plan, 'g1')
  assert.equal(root.parent, null)
  assert.equal(root.siblings, plan.nodes)
})

test('moveNode 把顶层待办归位到计划下（收件箱归位）', () => {
  const plan = samplePlan()
  plan.nodes.push({ id: 't9', type: 'todo', title: '游离待办', status: 'todo' })
  const r = moveNode(plan, 't9', 'k2')
  assert.equal(r.from, null)
  assert.equal(r.to, 'k2')
  assert.equal(plan.nodes.length, 1, '顶层只剩那个计划')
  assert.equal(plan.nodes[0].children[1].children.length, 4)
  assert.equal(plan.nodes[0].children[1].children[3].id, 't9', '默认追加到末尾')
})

test('moveNode 支持移回顶层，并可按下标落位', () => {
  const plan = samplePlan()
  plan.nodes.push({ id: 't9', type: 'todo', title: '游离', status: 'todo' })
  moveNode(plan, 't9', 'k2', 0)
  let kids = plan.nodes[0].children[1].children
  assert.equal(kids[0].id, 't9')

  moveNode(plan, 't9', null)
  assert.deepEqual(inboxOf(plan).map((n) => n.id), ['t9'])

  moveNode(plan, 't9', 'k2', 1)
  kids = plan.nodes[0].children[1].children
  assert.equal(kids[1].id, 't9')
})

test('moveNode 能在同一层里重排顺序', () => {
  const plan = samplePlan()
  const r = moveNode(plan, 't3', 'k2', 0)
  assert.equal(r.from, 'k2')
  assert.equal(r.to, 'k2')
  assert.deepEqual(plan.nodes[0].children[1].children.map((n) => n.id), ['t3', 't1', 't2'])
})

test('moveNode 拒绝把节点移到它自己或它的子孙下面（否则成环）', () => {
  const plan = samplePlan()
  assert.throws(() => moveNode(plan, 'k2', 'k2'), /不能把一个节点移到它自己下面/)
  assert.throws(() => moveNode(plan, 'k2', 't1'), /是待办，不能作为父节点/)
  // k2 不能移到 k2 的后代下——这里用「把 g1 移到 k2 下面」验证祖先检查方向
  assert.equal(isDescendantOf(plan, plan.nodes[0].children[1], plan.nodes[0]), true)
  const plan2 = samplePlan()
  const deep = makeNode(plan2, { title: '深层子计划', type: 'plan' })
  appendChild(plan2, deep, 'k2')
  assert.throws(() => moveNode(plan2, 'k2', deep.id), /不能把一个节点移到它自己的子孙下面/)
})

test('removeNode 删计划会连带整棵子树，并报告删了多少', () => {
  const plan = samplePlan()
  const r = removeNode(plan, 'g1')
  assert.equal(plan.nodes.length, 0)
  assert.equal(r.removed.total, 6)
  assert.equal(r.removed.plans, 3)
  assert.equal(r.removed.todos, 3)
})

test('removeNode 删单条待办只影响它自己', () => {
  const plan = samplePlan()
  const r = removeNode(plan, 't2')
  assert.equal(r.removed.total, 1)
  assert.deepEqual(plan.nodes[0].children[1].children.map((n) => n.id), ['t1', 't3'])
})

// ------------------------------------------------------------------- 迁移

test('迁移：goal/kr/task 映射成 plan/plan/todo，老 id 原样保留', () => {
  const plan = migratePlan(legacyPlan())
  assert.equal(plan.schema, SCHEMA)
  assert.equal(plan.version, 7, '版本号必须带着走')
  assert.equal(plan.title, '老计划')
  assert.equal(plan.lastReason, 'task-done')

  const g = plan.nodes[0]
  assert.equal(g.id, 'g1', '老 id 保留：历史会话与快照都还在引用它')
  assert.equal(g.type, 'plan')
  assert.equal(g.owner, '张三')
  assert.equal(g.priority, 'high')
  assert.equal(g.children.length, 2)

  const k1 = g.children[0]
  assert.equal(k1.id, 'k1')
  assert.equal(k1.type, 'plan')
  assert.deepEqual(k1.metric, { target: 12, current: 3, unit: '个' }, 'target/current/unit 进 metric')
  assert.equal(k1.note, '备注')

  const k2 = g.children[1]
  assert.equal(k2.metric, undefined, '没有量化字段就不该凭空造一个 metric')
  assert.equal(k2.children.length, 2)

  const t1 = k2.children[0]
  assert.equal(t1.id, 't1')
  assert.equal(t1.type, 'todo')
  assert.equal(t1.status, 'done')
  assert.equal(t1.doneAt, '2026-09-10T10:00:00.000Z', '完成时间戳不能丢——周报靠它')
  assert.equal(k2.children[1].startedAt, '2026-09-01T10:00:00.000Z')
  assert.equal(k2.children[1].due, '2026-11-01')
})

test('迁移：inbox 变成顶层待办（即收件箱），排在计划之后', () => {
  const plan = migratePlan(legacyPlan())
  assert.equal(plan.nodes.length, 2)
  assert.equal(plan.nodes[1].id, 't9')
  assert.equal(plan.nodes[1].type, 'todo')
  assert.equal(plan.nodes[1].priority, 'high')
  assert.deepEqual(inboxOf(plan).map((n) => n.id), ['t9'])
  assert.deepEqual(topPlans(plan).map((n) => n.id), ['g1'])
})

test('迁移后进度与迁移前语义一致（无损的含义）', () => {
  const plan = migratePlan(legacyPlan())
  // 老口径：k1 = 3/12 = 0.25；k2 = 1/2 = 0.5；g1 = 两者平均；全计划 = g1
  const expected = (0.25 + 0.5) / 2
  assert.ok(Math.abs(planProgress(plan) - expected) < 1e-9)
})

test('迁移对空/脏的老数据安全', () => {
  const plan = migratePlan({ version: 3 })
  assert.deepEqual(plan.nodes, [])
  assert.equal(plan.version, 3)
  assert.equal(plan.title, '个人工作计划')
})

test('normalizePlan：新格式原样返回，老格式迁移，非法结构报错', () => {
  const fresh = samplePlan()
  assert.equal(normalizePlan(fresh), fresh)
  const migrated = normalizePlan(legacyPlan())
  assert.equal(migrated.schema, SCHEMA)
  assert.equal(migrated.nodes.length, 2)
  assert.throws(() => normalizePlan({ title: 'x' }), /缺少 nodes 数组/)
  assert.throws(() => normalizePlan(null), /必须是对象/)
})

test('normalizePlan 给缺少 schema 的新格式补上版本号', () => {
  const plan = normalizePlan({ nodes: [], version: 1 })
  assert.equal(plan.schema, SCHEMA)
})

// ---------------------------------------------------------------- Markdown

test('renderMarkdown 用标题级别表达层级（递归树在 Markdown 里也看得出深度）', () => {
  const md = renderMarkdown(samplePlan())
  assert.match(md, /# 测试计划/)
  assert.match(md, /## g1 · 完成低电压治理攻坚/)
  assert.match(md, /### k1 · 完成 12 个台区改造/)
  assert.match(md, /3\/12 个/)
  assert.match(md, /^ {4}- \[x\] t1 · 收集基础数据/m, '待办缩进两层')
  assert.match(md, /截止 2026-11-01/)
  assert.match(md, /负责人：张三/)
  assert.match(md, /- 计划：3 个；待办：共 3/)
})

test('renderMarkdown 标注 doing / dropped 与状态', () => {
  const plan = emptyPlan()
  plan.nodes.push({
    id: 'n1', type: 'plan', title: 'P', status: 'done', children: [
      { id: 'n2', type: 'todo', title: '进行中的', status: 'doing' },
      { id: 'n3', type: 'todo', title: '放弃的', status: 'dropped' },
    ],
  })
  const md = renderMarkdown(plan)
  assert.match(md, /进行中/)
  assert.match(md, /已放弃/)
  assert.match(md, /- 状态：done/)
})

test('renderMarkdown 渲染收件箱，并标注重要度与委派', () => {
  const plan = emptyPlan('测试计划')
  plan.nodes.push({ id: 'n1', type: 'todo', title: '找张三要数据', status: 'todo', priority: 'high', due: '2026-09-18' })
  const md = renderMarkdown(plan)
  assert.match(md, /## 收件箱 · 未归类待办  1 条/)
  assert.match(md, /- \[ \] n1 · 找张三要数据/)
  assert.match(md, /重要度高/)
  assert.match(md, /截止 2026-09-18/)
})

test('renderMarkdown 标注委派、完成时间与管控概览', () => {
  const plan = samplePlan()
  const task = plan.nodes[0].children[1].children[1]
  setDelegate(task, { to: '张三', expectAt: '2000-01-01' })
  applyStatus(plan.nodes[0].children[1].children[0], 'done', new Date('2026-09-10T10:00:00Z'))
  const md = renderMarkdown(plan)
  assert.match(md, /委派 张三（待接受；期望 2000-01-01）/)
  assert.match(md, /完成于 2026-09-10/)
  assert.match(md, /- 管控：/)
})

test('renderMarkdown 对没有收件箱的计划不产生空段', () => {
  assert.doesNotMatch(renderMarkdown(samplePlan()), /收件箱/)
  assert.doesNotMatch(renderMarkdown(emptyPlan()), /收件箱/)
})

// ------------------------------------------------------------------- Store

test('load 在文件不存在时返回空计划（schema 2）', async () => {
  await withTemp(async (dir) => {
    const store = new PlanStore(dir)
    const plan = await store.load()
    assert.deepEqual(plan.nodes, [])
    assert.equal(plan.schema, SCHEMA)
    assert.equal(plan.version, 0)
  })
})

test('save 落盘 plan.json 与 PLAN.md，并自增版本号', async () => {
  await withTemp(async (dir) => {
    const store = new PlanStore(dir)
    const plan = await store.load()
    plan.nodes.push(makeNode(plan, { title: '计划', type: 'plan' }))

    await store.save(plan, { reason: 'test' })
    assert.equal(plan.version, 1)

    const json = JSON.parse(await readFile(store.file, 'utf8'))
    assert.equal(json.version, 1)
    assert.equal(json.schema, SCHEMA)
    assert.equal(json.nodes.length, 1)

    const md = await readFile(store.view, 'utf8')
    assert.match(md, /# 个人工作计划/)

    await store.save(plan, { reason: 'test2' })
    assert.equal(plan.version, 2)
  })
})

test('load 读到 schema 1 的老文件时自动迁移（不写盘，只读）', async () => {
  await withTemp(async (dir) => {
    const store = new PlanStore(dir)
    await store.save(emptyPlan(), { reason: 'init' })
    await writeFile(store.file, JSON.stringify(legacyPlan()), 'utf8')

    const plan = await store.load()
    assert.equal(plan.schema, SCHEMA)
    assert.equal(plan.nodes.length, 2)
    assert.equal(plan.nodes[0].children[0].metric.target, 12)

    // 只 load 不该改写磁盘——否则「看一眼」也会产生一次归档
    const onDisk = JSON.parse(await readFile(store.file, 'utf8'))
    assert.equal(onDisk.goals.length, 1, '磁盘上仍是老格式')
    assert.equal(onDisk.schema, undefined)
  })
})

test('老格式一旦被写入，就落成新格式（用户不用手工迁移）', async () => {
  await withTemp(async (dir) => {
    const store = new PlanStore(dir)
    await store.save(emptyPlan(), { reason: 'init' })
    await writeFile(store.file, JSON.stringify(legacyPlan()), 'utf8')

    const plan = await store.load()
    plan.nodes.push(makeNode(plan, { title: '新加的计划', type: 'plan' }))
    await store.save(plan, { reason: 'add' })

    const onDisk = JSON.parse(await readFile(store.file, 'utf8'))
    assert.equal(onDisk.schema, SCHEMA)
    assert.equal(onDisk.goals, undefined, '老键不该留在新文件里')
    assert.equal(onDisk.inbox, undefined)
    assert.equal(onDisk.nodes.length, 3)
  })
})

test('每次 save 前的版本被归档，history 最新在前', async () => {
  await withTemp(async (dir) => {
    const store = new PlanStore(dir)
    const plan = await store.load()
    plan.nodes.push(makeNode(plan, { title: 'v1', type: 'plan' }))
    await store.save(plan, { reason: 'first' })

    plan.nodes.push(makeNode(plan, { title: 'v2', type: 'plan' }))
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
    plan.nodes.push(makeNode(plan, { title: '原始计划', type: 'plan' }))
    await store.save(plan, { reason: 'first' })

    plan.nodes.push(makeNode(plan, { title: '后来加的', type: 'plan' }))
    await store.save(plan, { reason: 'second' })

    const history = await store.history(10)
    const first = history.find((v) => v.reason === 'first')
    assert.ok(first, '应该有 first 版本的归档')

    const restored = await store.restore(first.file)
    assert.equal(restored.nodes.length, 1)
    assert.equal(restored.nodes[0].title, '原始计划')

    const onDisk = JSON.parse(await readFile(store.file, 'utf8'))
    assert.equal(onDisk.nodes.length, 1)

    const after = await store.history(10)
    assert.ok(after.some((v) => v.reason === 'before-restore'))
  })
})

test('restore 回滚到「老格式」快照时，落盘成新格式（内容回去、格式不回退）', async () => {
  await withTemp(async (dir) => {
    const store = new PlanStore(dir)
    // 手工制造一份老格式的历史快照
    await store.save(emptyPlan(), { reason: 'init' })
    await writeFile(store.file, JSON.stringify(legacyPlan()), 'utf8')
    const snap = await store.snapshot('legacy')
    await store.save(emptyPlan(), { reason: 'wipe' })

    const restored = await store.restore(snap.split('/').pop())
    assert.equal(restored.schema, SCHEMA)
    const onDisk = JSON.parse(await readFile(store.file, 'utf8'))
    assert.equal(onDisk.schema, SCHEMA)
    assert.equal(onDisk.nodes.length, 2, '老内容完整回来了，但结构是新格式')
  })
})

test('restore 拒绝路径穿越 / 不存在的版本', async () => {
  await withTemp(async (dir) => {
    const store = new PlanStore(dir)
    await assert.rejects(() => store.restore('../../etc/passwd'), /非法的版本文件名/)
    await assert.rejects(() => store.restore('a/b.json'), /非法的版本文件名/)
    await assert.rejects(() => store.restore('nope.json'), /版本不存在/)
  })
})

test('snapshot 在没有计划时报错，可以重复打点', async () => {
  await withTemp(async (dir) => {
    const store = new PlanStore(dir)
    await assert.rejects(() => store.snapshot('x'), /还没有计划可归档/)
    const plan = await store.load()
    await store.save(plan, { reason: 'init' })
    await store.snapshot('阶段收尾')
    assert.ok((await store.history(10)).some((v) => v.reason === '阶段收尾'))
  })
})

test('load 对非法 JSON 与非法结构报可读错误', async () => {
  await withTemp(async (dir) => {
    const store = new PlanStore(dir)
    await store.save(emptyPlan(), { reason: 'init' })

    await writeFile(store.file, '{ 这不是 JSON', 'utf8')
    await assert.rejects(() => store.load(), /不是合法 JSON/)

    await writeFile(store.file, JSON.stringify({ title: 'x' }), 'utf8')
    await assert.rejects(() => store.load(), /缺少 nodes 数组/)

    await writeFile(store.file, JSON.stringify('字符串'), 'utf8')
    await assert.rejects(() => store.load(), /不是一个对象/)
  })
})

test('PlanStore 拒绝空根目录；计划落在 <root>/plan 下', async () => {
  assert.throws(() => new PlanStore(''), /需要一个工作区根目录/)
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
  const w = nodeWarnings({ type: 'plan', priority: 'high' }, 'plan')
  assert.equal(w.length, 2)
  assert.match(w.join('；'), /需要周期/)
  assert.match(w.join('；'), /需要负责人/)
  assert.deepEqual(nodeWarnings({ type: 'plan', priority: 'high', start: '2026-01-01', owner: '张三' }, 'plan'), [])
})

test('待办不要求负责人（默认自己负责），否则警告会失去意义', () => {
  assert.deepEqual(nodeWarnings({ type: 'todo', priority: 'high', due: '2026-01-01' }, 'todo'), [])
  assert.match(nodeWarnings({ type: 'todo', priority: 'high' }, 'todo').join('；'), /需要截止日期/)
})

test('nodeWarnings 不传 type 时按节点自身类型判断', () => {
  assert.match(nodeWarnings({ type: 'todo', priority: 'high' }).join('；'), /需要截止日期/)
  assert.match(nodeWarnings({ type: 'plan', priority: 'high' }).join('；'), /需要周期/)
})

test('中重要度缺截止时提示，低重要度完全不打扰', () => {
  assert.match(nodeWarnings({ type: 'todo' }, 'todo').join('；'), /建议补一个截止日期/)
  assert.deepEqual(nodeWarnings({ type: 'todo', priority: 'low' }, 'todo'), [])
  assert.deepEqual(nodeWarnings({ type: 'todo', priority: 'normal', due: '2026-01-01' }, 'todo'), [])
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

test('setStatus 按类型校验取值（计划与待办的状态集合不同）', () => {
  const todo = { type: 'todo' }
  setStatus(todo, 'done')
  assert.equal(todo.status, 'done')
  assert.throws(() => setStatus({ type: 'todo' }, 'active'), /待办的状态必须是 todo \/ doing \/ done \/ dropped/)
  assert.throws(() => setStatus({ type: 'plan' }, 'doing'), /计划的状态必须是 active \/ done \/ dropped/)
  assert.throws(() => setStatus({ type: 'plan' }, '  '), /计划的状态必须是/)
})

test('计划也能记完成时间（计划整体收尾时用）', () => {
  const goal = { type: 'plan', status: 'active' }
  setStatus(goal, 'done', new Date('2026-09-14T10:00:00Z'))
  assert.ok(goal.doneAt)
})

// --------------------------------------------------------------- 节点换型

test('setNodeType 待办 → 计划：原地换型（同一件事开始往下拆）', () => {
  const node = { id: 'n1', type: 'todo', title: '数据治理', status: 'todo' }
  setNodeType(node, 'plan')
  assert.equal(node.type, 'plan')
  assert.equal(typeOf(node), 'plan')
  assert.ok(isPlan(node))
  assert.equal(node.id, 'n1', '换型不换 id——引用它的地方（委派、备注）不该断')
})

test('setNodeType 计划 → 待办：状态跨类型重新归一', () => {
  // active 只对计划合法；留成 active 会让这条待办在渲染与统计里静默错值。
  const node = { type: 'plan', title: '数据治理', status: 'active' }
  setNodeType(node, 'todo')
  assert.equal(node.status, 'todo')
  // done / dropped 两边都合法，不该被动；反向同理（doing 对计划非法 → active）。
  const done = { type: 'plan', status: 'done' }
  setNodeType(done, 'todo')
  assert.equal(done.status, 'done')
  const doing = { type: 'todo', status: 'doing' }
  setNodeType(doing, 'plan')
  assert.equal(doing.status, 'active')
})

test('setNodeType 拒绝把有子节点的计划降级为待办，且不留半改状态', () => {
  const node = {
    id: 'n1',
    type: 'plan',
    title: '数据治理',
    children: [{ id: 'n2', type: 'todo', title: '收集基础数据' }],
  }
  assert.throws(() => setNodeType(node, 'todo'), /还有 1 个子节点，不能降级为待办/)
  assert.equal(node.type, 'plan', '拒绝时必须原样返回，不能已经改了 type')
  assert.equal(node.children.length, 1)
})

test('setNodeType 校验类型取值；同类型调用幂等', () => {
  const node = { type: 'plan', status: 'active' }
  assert.throws(() => setNodeType(node, 'kr'), /节点类型必须是 plan \/ todo/)
  assert.throws(() => setNodeType(node, '  '), /节点类型必须是/)
  setNodeType(node, 'plan')
  assert.equal(node.status, 'active', '同类型时不该动状态')
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

test('setDelegate 必须有对象；重新委派会重置回执', () => {
  assert.throws(() => setDelegate({}, { to: '  ' }), /委派对象不能为空/)
  const task = { status: 'todo' }
  setDelegate(task, { to: '张三' })
  setReceipt(task, 'accepted')
  assert.equal(task.delegate.status, 'accepted')
  setDelegate(task, { to: '李四' })
  assert.equal(task.delegate.to, '李四')
  assert.equal(task.delegate.status, 'pending', '换人意味着上一轮回执作废')
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

test('没有委派时 delegateState 返回 null；逾期未回执进节点警告', () => {
  assert.equal(delegateState({}), null)
  assert.equal(delegateState({ delegate: { at: '2026-01-01' } }), null)
  const task = { type: 'todo', status: 'todo', priority: 'low' }
  setDelegate(task, { to: '李四', expectAt: '2000-01-01' })
  assert.match(nodeWarnings(task, 'todo').join('；'), /委派给 李四 已逾期未回执/)
})

test('delegatedList 把逾期的排前面，并带上类型、父节点与路径', () => {
  const plan = samplePlan()
  const t2 = plan.nodes[0].children[1].children[1]
  const t3 = plan.nodes[0].children[1].children[2]
  setDelegate(t2, { to: '张三', expectAt: '2026-12-01' })
  setDelegate(t3, { to: '李四', expectAt: '2000-01-01' })
  const list = delegatedList(plan, '2026-09-14')
  assert.equal(list.length, 2)
  assert.equal(list[0].id, 't3', '逾期的排前面')
  assert.equal(list[0].type, 'todo')
  assert.equal(list[0].parent, 'k2')
  assert.equal(list[0].path, 'g1 / k2 / t3')
  assert.equal(list[1].delegate.to, '张三')
})

// ------------------------------------------------------- 计数 / 逾期 / 汇总

test('todoCounts 统计待办四种状态，单列计划数与收件箱', () => {
  const plan = samplePlan()
  plan.nodes.push({ id: 't9', type: 'todo', title: '游离', status: 'todo' })
  plan.nodes.push({ id: 't10', type: 'todo', title: '已做完的游离', status: 'done' })
  const c = todoCounts(plan)
  assert.equal(c.plans, 3)
  assert.equal(c.total, 5, '3 个子计划下的待办 + 2 条收件箱')
  assert.equal(c.done, 2)
  assert.equal(c.doing, 1)
  assert.equal(c.todo, 2)
  assert.equal(c.inbox, 2)
  assert.equal(c.inboxOpen, 1)
})

test('todoCounts 把非法状态按 todo 计', () => {
  const plan = emptyPlan()
  plan.nodes.push({ id: 'n1', type: 'todo', title: 'z', status: '乱写' })
  assert.equal(todoCounts(plan).todo, 1)
})

test('controlSummary 给出筛选条要的角标数', () => {
  const plan = samplePlan()
  plan.nodes[0].priority = 'high'
  plan.nodes[0].children[1].children[2].priority = 'high'
  setDelegate(plan.nodes[0].children[1].children[1], { to: '张三', expectAt: '2000-01-01' })
  plan.nodes.push({ id: 't9', type: 'todo', title: '游离', status: 'todo', due: '2026-09-16' })
  const s = controlSummary(plan, '2026-09-14')
  assert.equal(s.high, 2)
  assert.equal(s.delegated, 1)
  assert.equal(s.overdue, 1, '过期的委派算逾期')
  assert.equal(s.week, 1, '9-16 在 7 天窗口内')
  assert.equal(s.inboxOpen, 1)
  // 至少覆盖到这两类缺口：高重要度的计划缺周期/负责人、高重要度的待办缺截止。
  assert.ok(s.warnings >= 2, '应统计出管控缺口，实际 ' + String(s.warnings))
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
  assert.equal(isDueWithin({ type: 'plan', status: 'active', end: '2026-09-20' }, 7, '2026-09-14'), true)
  assert.equal(isOverdue({ type: 'plan', status: 'active', end: '2000-01-01' }, '2026-09-14'), true)
})

test('todayStr 输出本地时区的 YYYY-MM-DD', () => {
  assert.match(todayStr(), /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(todayStr(new Date(2026, 8, 14, 23, 0, 0)), '2026-09-14')
})

// ------------------------------------------------------------------ 配速

test('paceOf 只在「有完整周期 + 周期正在走」时给配速', () => {
  // 2026-09-01 ~ 2026-09-21，今天 9-11 → 20 天里过了 10 天，应到 50%
  const node = { type: 'plan', status: 'active', start: '2026-09-01', end: '2026-09-21' }
  const p = paceOf(node, 0.2, '2026-09-11')
  assert.equal(Math.round(p.expected * 100), 50)
  assert.equal(p.actual, 0.2)
  assert.equal(Math.round(p.gap * 100), 30)
  assert.equal(p.behind, true)
})

test('paceOf 的四种边界：没周期 / 还没开始 / 已过结束日 / 已结束', () => {
  const base = { type: 'plan', status: 'active', start: '2026-09-01', end: '2026-09-21' }
  assert.equal(paceOf({ type: 'plan', status: 'active', end: '2026-09-21' }, 0, '2026-09-11'), null, '缺 start')
  assert.equal(paceOf({ type: 'plan', status: 'active', start: '2026-09-01' }, 0, '2026-09-11'), null, '缺 end')
  assert.equal(paceOf(base, 0, '2026-08-20'), null, 'start 还没到 → 不是落后')
  assert.equal(paceOf(base, 0, '2026-09-30'), null, '已过 end → 那是逾期，交给逾期信号')
  assert.equal(paceOf({ ...base, status: 'done' }, 1, '2026-09-11'), null, '已完成不报配速')
  assert.equal(paceOf({ ...base, status: 'dropped' }, 0, '2026-09-11'), null, '已放弃不报配速')
})

test('paceOf 对脏数据与颠倒的周期安全（不报配速，也不抛错）', () => {
  assert.equal(paceOf({ type: 'plan', status: 'active', start: '2026-09-21', end: '2026-09-01' }, 0, '2026-09-11'), null)
  assert.equal(paceOf({ type: 'plan', status: 'active', start: '2026-09-01', end: '2026-09-01' }, 0, '2026-09-01'), null, '同一天算不出跨度')
  assert.equal(paceOf({ type: 'plan', status: 'active', start: '乱写', end: '2026-09-21' }, 0, '2026-09-11'), null)
  assert.equal(paceOf(null, 0, '2026-09-11'), null)
})

test('paceOf 的阈值是 15 个百分点（刚好 15% 算落后，14% 不算）', () => {
  assert.equal(PACE_THRESHOLD, 0.15)
  // 09-01 ~ 09-21，今天 09-11 → expected = 0.5
  const node = { type: 'plan', status: 'active', start: '2026-09-01', end: '2026-09-21' }
  assert.equal(paceOf(node, 0.35, '2026-09-11').behind, true, '差 15 个百分点 → 报')
  assert.equal(paceOf(node, 0.36, '2026-09-11').behind, false, '差 14 个百分点 → 不报')
  assert.equal(paceOf(node, 0.5, '2026-09-11').behind, false, '刚好跟上 → 不报')
  assert.equal(paceOf(node, 0.9, '2026-09-11').behind, false, '超前 → 不报')
})

test('paceOf 的 actual 夹取到 0..1，不因为脏进度算出负数', () => {
  const node = { type: 'plan', status: 'active', start: '2026-09-01', end: '2026-09-21' }
  assert.equal(paceOf(node, 3, '2026-09-11').actual, 1)
  assert.equal(paceOf(node, -1, '2026-09-11').actual, 0)
})

test('paceOf 不传 progress 时自己算（量化节点按 metric）', () => {
  const node = {
    type: 'plan', status: 'active', start: '2026-09-01', end: '2026-09-21',
    metric: { target: 10, current: 2 },
  }
  assert.equal(paceOf(node, undefined, '2026-09-11').actual, 0.2)
})

test('behindList 只收落后且未结束的节点，差距大的排前面', () => {
  const plan = emptyPlan()
  plan.nodes.push(
    { id: 'g1', type: 'plan', title: '落后很多的', status: 'active', start: '2026-09-01', end: '2026-09-21', children: [] },
    { id: 'g2', type: 'plan', title: '落后一点的', status: 'active', start: '2026-09-01', end: '2026-09-21', metric: { target: 10, current: 3 }, children: [] },
    { id: 'g3', type: 'plan', title: '跟得上的', status: 'active', start: '2026-09-01', end: '2026-09-21', metric: { target: 10, current: 5 }, children: [] },
    { id: 'g4', type: 'plan', title: '没周期的', status: 'active', children: [] },
    { id: 'g5', type: 'plan', title: '已完成但落后过的', status: 'done', start: '2026-09-01', end: '2026-09-21', children: [] },
  )
  const list = behindList(plan, '2026-09-11')
  assert.deepEqual(list.map((x) => x.id), ['g1', 'g2'], '差 50 个百分点的排在差 20 个的前面')
  assert.equal(list[0].pace.behind, true)
  assert.equal(list[0].path, 'g1')
})

test('behindList 的节点进度是递归算的（父计划跟着子节点落后）', () => {
  const plan = emptyPlan()
  plan.nodes.push({
    id: 'g1', type: 'plan', title: '父计划', status: 'active',
    start: '2026-09-01', end: '2026-09-21',
    children: [
      { id: 'n1', type: 'todo', title: '没做的', status: 'todo' },
      { id: 'n2', type: 'todo', title: '也做没的', status: 'todo' },
    ],
  })
  const list = behindList(plan, '2026-09-11')
  assert.deepEqual(list.map((x) => x.id), ['g1'], '待办没有周期，不参与配速')
  assert.equal(list[0].progress, 0)
})

// ------------------------------------------------------------------ 证据

test('addEvidence 追加而不是覆盖，并补上时间戳', () => {
  const node = { id: 't1', type: 'todo', status: 'done' }
  addEvidence(node, { kind: 'file', ref: 'docs/a.md' }, new Date('2026-09-14T02:00:00Z'))
  addEvidence(node, { kind: 'command', ref: 'npm test' }, new Date('2026-09-14T03:00:00Z'))
  assert.equal(node.evidence.length, 2)
  assert.deepEqual(node.evidence[0], { kind: 'file', ref: 'docs/a.md', at: '2026-09-14T02:00:00.000Z' })
  assert.equal(node.evidence[1].kind, 'command')
})

test('addEvidence 的 kind 缺省按 note（不核验），传错枚举才报错', () => {
  const node = {}
  assert.equal(addEvidence(node, { ref: '一句话' }).kind, 'note')
  assert.throws(() => addEvidence(node, { kind: 'filee', ref: 'x' }), /证据类型必须是/)
})

test('addEvidence 必须有 ref，否则报错而不是写半截数据', () => {
  assert.throws(() => addEvidence({}, { kind: 'file' }), /证据需要一个 ref/)
  assert.throws(() => addEvidence({}, { ref: '   ' }), /证据需要一个 ref/)
  assert.throws(() => addEvidence(null, { ref: 'x' }), /证据要挂在节点上/)
})

test('addEvidence 对同 kind + 同 ref 不重复追加（agent 重试不该产生两条一样的证据）', () => {
  const node = {}
  addEvidence(node, { kind: 'file', ref: 'out/a.md' }, new Date('2026-09-10T00:00:00Z'))
  addEvidence(node, { kind: 'file', ref: 'out/a.md' }, new Date('2026-09-14T00:00:00Z'))
  assert.equal(node.evidence.length, 1, '重复的条目不含新信息，只会让审查变糊')
  assert.equal(node.evidence[0].at, '2026-09-14T00:00:00.000Z', '时间刷成最后一次')
  // 同 ref 不同类型算两条：文件与命令是两种凭据
  addEvidence(node, { kind: 'command', ref: 'out/a.md' })
  assert.equal(node.evidence.length, 2)
})

test('addEvidence 可以带一条说明', () => {
  const node = {}
  addEvidence(node, { kind: 'session', ref: 'sess-123', note: '这次会话里改的' })
  assert.equal(node.evidence[0].note, '这次会话里改的')
})

test('evidenceOf 永远返回数组', () => {
  assert.deepEqual(evidenceOf({}), [])
  assert.deepEqual(evidenceOf({ evidence: 'nope' }), [])
  assert.equal(evidenceOf({ evidence: [{ kind: 'note', ref: 'x' }] }).length, 1)
  assert.deepEqual(evidenceOf(null), [])
})

test('isUnverified 只认「已完成且没有任何证据」', () => {
  assert.equal(isUnverified({ status: 'done' }), true)
  assert.equal(isUnverified({ status: 'done', evidence: [] }), true)
  assert.equal(isUnverified({ status: 'done', evidence: [{ kind: 'note', ref: 'x' }] }), false)
  assert.equal(isUnverified({ status: 'todo' }), false)
  assert.equal(isUnverified({ status: 'doing' }), false)
  assert.equal(isUnverified({ status: 'dropped' }), false)
  assert.equal(isUnverified(null), false)
})

test('unverifiedList 收已完成无证据的节点，最近完成的排前面', () => {
  const plan = emptyPlan()
  plan.nodes.push(
    { id: 'a', type: 'todo', title: '上周', status: 'done', doneAt: '2026-09-01T00:00:00.000Z' },
    { id: 'b', type: 'todo', title: '刚做完', status: 'done', doneAt: '2026-09-13T00:00:00.000Z', priority: 'high' },
    { id: 'c', type: 'todo', title: '有证据的', status: 'done', evidence: [{ kind: 'file', ref: 'x', at: '2026-09-13T00:00:00.000Z' }] },
    { id: 'd', type: 'todo', title: '没做完的', status: 'todo' },
  )
  const list = unverifiedList(plan)
  assert.deepEqual(list.map((x) => x.id), ['b', 'a'])
  assert.equal(list[0].priority, 'high')
  assert.equal(list[0].path, 'b')
})

test('evidenceWarnings 只核验 file 类证据（文件在不在是客观事实）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wb-ev-'))
  try {
    await writeFile(join(dir, 'real.md'), '# 真的存在\n')
    const node = {}
    addEvidence(node, { kind: 'file', ref: 'real.md' })
    addEvidence(node, { kind: 'file', ref: 'missing.md' })
    addEvidence(node, { kind: 'command', ref: 'missing.md' }, new Date())
    addEvidence(node, { kind: 'note', ref: '某件只在口头存在的事' })
    const w = evidenceWarnings(node, dir)
    assert.equal(w.length, 1, '只有那个不存在的文件被标出来')
    assert.match(w[0], /证据所指的文件不存在：missing\.md/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('evidenceWarnings 支持绝对路径，且没有工作区根时静默跳过', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wb-ev2-'))
  try {
    const abs = join(dir, 'abs.txt')
    await writeFile(abs, 'x')
    const node = {}
    addEvidence(node, { kind: 'file', ref: abs })
    assert.deepEqual(evidenceWarnings(node, dir), [], '绝对路径直接查，不拼根目录')
    addEvidence(node, { kind: 'file', ref: join(dir, 'nope.txt') })
    assert.equal(evidenceWarnings(node, dir).length, 1)
    assert.deepEqual(evidenceWarnings(node, undefined), [], '没根目录就不假装能核验')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('filesOf 永远返回数组，对脏数据安全', () => {
  assert.deepEqual(filesOf({ files: [{ kind: 'file', ref: 'a.md' }] }).length, 1)
  assert.deepEqual(filesOf({ files: 'nope' }), [])
  assert.deepEqual(filesOf({}), [])
  assert.deepEqual(filesOf(null), [])
})

test('addFile 追加而不是覆盖，并补上时间戳', () => {
  const node = {}
  addFile(node, { kind: 'file', ref: 'docs/a.md' }, new Date('2026-09-14T02:00:00Z'))
  addFile(node, { kind: 'folder', ref: '项目A' }, new Date('2026-09-14T03:00:00Z'))
  assert.equal(node.files.length, 2)
  assert.equal(node.files[0].at, new Date('2026-09-14T02:00:00Z').toISOString())
  assert.equal(node.files[1].kind, 'folder')
})

test('addFile 的 kind 缺省按 file（只记录不核验），传错枚举才报错', () => {
  const node = {}
  assert.equal(addFile(node, { ref: '一句话.md' }).kind, 'file')
  assert.throws(() => addFile(node, { kind: 'filee', ref: 'x' }), /关联类型必须是/)
})

test('addFile 必须有 ref，否则报错而不是写半截数据', () => {
  assert.throws(() => addFile({}, { kind: 'file' }), /关联需要一个 ref/)
  assert.throws(() => addFile({}, { ref: '   ' }), /关联需要一个 ref/)
  assert.throws(() => addFile(null, { ref: 'x' }), /文件关联要挂在节点上/)
})

test('addFile 对同 kind + 同 ref 不重复追加（重试不产两条一样的关联）', () => {
  const node = {}
  addFile(node, { kind: 'file', ref: 'out/a.md' }, new Date('2026-09-10T00:00:00Z'))
  addFile(node, { kind: 'file', ref: 'out/a.md' }, new Date('2026-09-14T00:00:00Z'))
  assert.equal(node.files.length, 1)
  assert.equal(node.files[0].at, new Date('2026-09-14T00:00:00Z').toISOString())
  // 不同 kind 算不同关联（同一路径可以是文件也可以是文件夹视角）。
  addFile(node, { kind: 'folder', ref: 'out/a.md' })
  assert.equal(node.files.length, 2)
})

test('addFile 可以带一条说明，重复关联只更新说明不新增', () => {
  const node = {}
  addFile(node, { kind: 'file', ref: 'x.md', note: '初版' })
  addFile(node, { kind: 'file', ref: 'x.md', note: '终版' })
  assert.equal(node.files.length, 1)
  assert.equal(node.files[0].note, '终版')
})

test('removeFile 按 ref 摘掉，幂等无操作', () => {
  const node = { files: [{ kind: 'file', ref: 'keep.md' }, { kind: 'folder', ref: 'drop' }] }
  assert.equal(removeFile(node, 'drop'), true)
  assert.equal(node.files.length, 1)
  assert.equal(removeFile(node, 'drop'), false, '再删一次是静默无操作')
  assert.equal(removeFile(null, 'x'), false, '空节点也不报错')
  removeFile(node, 'keep.md', 'file')
  assert.equal(node.files.length, 0)
})

test('fileWarnings 按 vaultPath 解析相对路径核验存在，缺 vault 时静默跳过', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wb-fw-'))
  try {
    await writeFile(join(dir, 'real.md'), 'x')
    const node = {}
    addFile(node, { kind: 'file', ref: 'real.md' })
    addFile(node, { kind: 'file', ref: 'missing.md' })
    addFile(node, { kind: 'folder', ref: '缺失目录' })
    // 绝对路径直接查，不拼 vault 根。
    const abs = join(dir, 'abs.md')
    await writeFile(abs, 'x')
    addFile(node, { kind: 'file', ref: abs })
    assert.deepEqual(fileWarnings(node, dir).filter((s) => s.includes('abs.md')), [], '绝对路径直接查，不拼根目录')
    assert.equal(fileWarnings(node, dir).length, 2, 'real.md 与 abs.md 在，missing.md 与 缺失目录 不在')
    assert.deepEqual(fileWarnings(node, undefined), [], '没 vault 根就不假装能核验')
    // vault 根下建一个文件夹，核验通过。
    await writeFile(join(dir, 'present'), 'placeholder')
    addFile(node, { kind: 'folder', ref: 'present' })
    assert.equal(fileWarnings(node, dir).filter((s) => s.includes('present')).length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('高重要度的完成项缺证据会进 warnings，其余档位只进「无证据」清单', () => {
  const high = { type: 'todo', status: 'done', priority: 'high', due: '2026-09-01' }
  assert.match(nodeWarnings(high, 'todo').join('；'), /完成但没有证据/)
  addEvidence(high, { kind: 'file', ref: 'x.md' })
  assert.doesNotMatch(nodeWarnings(high, 'todo').join('；'), /完成但没有证据/)

  const normal = { type: 'todo', status: 'done', priority: 'normal', due: '2026-09-01' }
  assert.doesNotMatch(nodeWarnings(normal, 'todo').join('；'), /证据/)
  assert.equal(isUnverified(normal), true, '不进 ⚠，但照样进无证据清单')
})

test('controlSummary 统计落后与无证据的完成项', () => {
  const plan = emptyPlan()
  plan.nodes.push(
    { id: 'g1', type: 'plan', title: '落后', status: 'active', start: '2026-09-01', end: '2026-09-21', children: [] },
    { id: 'g2', type: 'plan', title: '跟上', status: 'active', start: '2026-09-01', end: '2026-09-21', metric: { target: 10, current: 6 }, children: [] },
    { id: 'a', type: 'todo', title: '无证据完成', status: 'done' },
    { id: 'b', type: 'todo', title: '有证据完成', status: 'done', evidence: [{ kind: 'note', ref: 'x', at: '2026-09-14T00:00:00.000Z' }] },
  )
  const s = controlSummary(plan, '2026-09-11')
  assert.equal(s.behind, 1)
  assert.equal(s.unverified, 1)
})

test('renderMarkdown 标出落后与证据，收件箱里的完成项也算', () => {
  const plan = emptyPlan()
  plan.nodes.push({
    id: 'g1', type: 'plan', title: '落后的计划', status: 'active',
    start: '2026-09-01', end: '2026-09-21', children: [],
  })
  plan.nodes.push({ id: 'a', type: 'todo', title: '无证据完成', status: 'done', evidence: undefined })
  plan.nodes.push({ id: 'b', type: 'todo', title: '有证据', status: 'done', evidence: [{ kind: 'file', ref: 'out/b.md', at: '2026-09-14T00:00:00.000Z' }] })
  const md = renderMarkdown(plan)
  assert.match(md, /完成但无证据/, '无证据的完成项要标出来')
  assert.match(md, /证据 1 条：文件/, '有证据的写出条数与类型')
  assert.match(md, /完成但无证据：1 项待核验/)
})

// ============================================================ 归位建议

/**
 * 一份够用的计划树：顶层一个治理专项（带负责人、周期、量化单位），下面两个子计划，
 * 另有一个完全不相干的攻坚计划（用来验「不会硬凑建议」）。
 */
function suggestFixture() {
  return {
    schema: 2, version: 1, title: 't',
    nodes: [
      {
        id: 'n1', type: 'plan', title: 'Q4 数据治理专项', owner: '张三',
        start: '2026-09-01', end: '2026-09-20',
        metric: { target: 12, current: 3, unit: '条' },
        children: [
          { id: 'n2', type: 'plan', title: '数据资产盘点', children: [
            { id: 'n3', type: 'todo', title: '梳理核心表清单（含负责人与更新频率）' },
          ] },
          { id: 'n5', type: 'plan', title: '质量规则落地', children: [
            { id: 'n6', type: 'todo', title: '接入 12 条校验规则' },
          ] },
        ],
      },
      { id: 'n9', type: 'plan', title: '低电压治理攻坚', start: '2026-10-01', end: '2026-12-31', children: [] },
    ],
  }
}

const suggestFor = (title, extra) => suggestParent(
  suggestFixture(),
  Object.assign({ id: 'x', type: 'todo', title }, extra === undefined ? {} : extra),
  '2026-09-14',
)

test('归位建议：与子项用词重合时推荐那个子计划，理由写清出处', () => {
  const s = suggestFor('补充核心表的负责人与更新频率')
  assert.ok(s.length > 0, '应当给出建议')
  assert.equal(s[0].id, 'n2', '重合的那个子计划是「数据资产盘点」')
  assert.match(s[0].why, /子项用词重合/)
})

test('归位建议：与计划标题重合时权重最高，超过子项', () => {
  const s = suggestFor('接入校验规则的复核')
  assert.equal(s[0].id, 'n5')
  assert.match(s[0].why, /计划标题用词重合/)
})

test('归位建议：命中计划的量化单位', () => {
  // 「再补 8 条」——除了单位「条」之外没有任何字面重合，于是只有 n1 命中。
  const s = suggestFor('再补 8 条')
  assert.equal(s.length, 1)
  assert.equal(s[0].id, 'n1')
  assert.match(s[0].why, /量化单位「条」/)
})

test('归位建议：截止日期落在计划周期内', () => {
  // 标题刻意没有字面重合，只靠周期命中 n1（09-01~09-20），n9 是 10 月之后。
  const s = suggestFor('交一下周报', { due: '2026-09-15' })
  assert.equal(s[0].id, 'n1')
  assert.match(s[0].why, /落在计划周期/)
})

test('归位建议：提到负责人', () => {
  const s = suggestFor('让张三看看这个')
  assert.equal(s[0].id, 'n1')
  assert.match(s[0].why, /负责人 张三/)
})

test('归位建议：没有够格的依据就一个都不给（不硬凑）', () => {
  // 这是最容易做坏的一条：宁可不说，也不要给一个「反正总会共用一个二字词」的随机建议。
  assert.deepEqual(suggestFor('预约体检'), [], '完全不相干 → 无建议')
  // 只和一个「子项」重合一处 = 1 分，低于阈值 2，同样不给。
  assert.deepEqual(suggestFor('接入新机器'), [], '仅碰巧共用一个词 → 无建议')
})

test('归位建议：不会把节点推荐到它自己的子孙下', () => {
  // 建议的候选集必须与 moveNode 用同一条合法性判定，否则会出现「一点就报错」的推荐。
  const plan = suggestFixture()
  plan.nodes[1].title = '数据治理二期' // 让 n9 也有字面重合，于是它成为唯一合法候选
  const s = suggestParent(plan, plan.nodes[0], '2026-09-14')
  const ids = s.map((x) => String(x.id))
  assert.ok(ids.includes('n9'), '合法的候选应当出现')
  assert.ok(!ids.includes('n2') && !ids.includes('n5'), '自己的子孙不能被推荐')
  assert.ok(!ids.includes('n1'), '自己不能被推荐')
})

test('归位建议：最多三条，且同分时的顺序稳定', () => {
  const plan = {
    schema: 2, version: 1, title: 't',
    nodes: ['A', 'B', 'C', 'D'].map((k, i) => ({
      id: 'p' + i, type: 'plan', title: '数据' + k, children: [],
    })),
  }
  const node = { id: 'x', type: 'todo', title: '数据相关的事' }
  const s = suggestParent(plan, node, '2026-09-14')
  assert.equal(s.length, 3, 'limit 默认 3')
  // 分数相同 → 排序必须稳定（stable sort + 树里从上到下的顺序），
  // 否则界面上的建议会自己跳位置。
  assert.deepEqual(s.map((x) => x.id), ['p0', 'p1', 'p2'])
  assert.deepEqual(suggestParent(plan, node, '2026-09-14'), s, '同一个计划每次算出来应当一致')
})

// ---------------------------------------------------------------- 详情表单支撑

test('removeEvidence 按 ref + 可选 kind 删除，幂等且不留空数组', () => {
  const node = { id: 'n1', type: 'todo', title: 't', status: 'done' }
  addEvidence(node, { kind: 'file', ref: 'a.md' })
  addEvidence(node, { kind: 'note', ref: 'a.md' })
  addEvidence(node, { kind: 'link', ref: 'https://x' })
  assert.equal(evidenceOf(node).length, 3)

  assert.equal(removeEvidence(node, 'a.md', 'file'), true)
  assert.deepEqual(evidenceOf(node).map((e) => e.kind), ['note', 'link'], '同 ref 不同 kind 只删指定的那条')

  assert.equal(removeEvidence(node, 'nope'), false, '删不存在的返回 false，不报错')
  assert.equal(removeEvidence(node, ''), false, '空 ref 直接不动')
  assert.equal(removeEvidence(node, null), false)

  removeEvidence(node, 'a.md')
  removeEvidence(node, 'https://x')
  assert.equal('evidence' in node, false, '删空后不留一个空数组')
})

test('clearFields 只清白名单内的字段，返回实际清掉的条数', () => {
  const node = {
    id: 'n1', type: 'plan', title: '别删我', status: 'active', children: [],
    owner: '我', start: '2026-01-01', end: '2026-12-31', due: '2026-06-01',
    note: '备注', metric: { target: 10, current: 3, unit: '个' },
    delegate: { to: '小李', status: 'pending', at: 'x' },
  }
  assert.equal(clearFields(node, ['owner', 'due', 'metric']), 3)
  assert.equal('owner' in node, false)
  assert.equal('due' in node, false)
  assert.equal('metric' in node, false)
  assert.equal(node.title, '别删我', '不在白名单里的字段碰都不碰')
  assert.ok(node.delegate !== undefined)

  assert.equal(clearFields(node, ['owner']), 0, '本来就是空的 → 0 条（据此决定要不要留档）')
  assert.equal(clearFields(node, ['title', 'id', 'unknown']), 0, '白名单外的名字静默忽略')
  assert.equal(clearFields(node, 'not-an-array'), 0)
})

test('clearFields 清 delegate 是整块删掉，不留半截对象', () => {
  const node = { id: 'n1', type: 'todo', title: 't', status: 'todo', delegate: { to: '小李', status: 'accepted' } }
  clearFields(node, ['delegate'])
  assert.equal('delegate' in node, false, '半截的 delegate 会让「已接受」之类的判断读到脏数据')
})

test('setDelegateExpectAt 只挪时间，不动回执状态', () => {
  const node = { id: 'n1', type: 'todo', title: 't', status: 'todo' }
  setDelegate(node, { to: '小李', expectAt: '2026-09-01' })
  node.delegate.status = 'accepted'
  node.delegate.receiptAt = '2026-08-01T00:00:00.000Z'
  setDelegateExpectAt(node, '2026-10-01')
  assert.equal(node.delegate.expectAt, '2026-10-01')
  assert.equal(node.delegate.status, 'accepted', '改期望时间不该把已接受的回执打回待接受')
  assert.equal(node.delegate.receiptAt, '2026-08-01T00:00:00.000Z')
  setDelegateExpectAt(node, '')
  assert.equal('expectAt' in node.delegate, false)
  assert.throws(() => setDelegateExpectAt({ id: 'x' }, '2026-10-01'), /委派记录/)
})

// ---------------------------------------------------------------- 依赖 / 星标 / 重复（MLO 核心）

function depFixture() {
  const plan = emptyPlan()
  const a = makeNode(plan, { type: 'todo', title: '先写周报' })
  appendChild(plan, a)
  const b = makeNode(plan, { type: 'todo', title: '再发周报' })
  appendChild(plan, b)
  return { plan, a, b }
}

test('依赖：blockedBy 记 id，blockers 只列还没做完的', () => {
  const { plan, a, b } = depFixture()
  addBlockedBy(plan, b, a.id)
  assert.deepEqual(blockedListOf(b), [String(a.id)])
  assert.deepEqual(blockers(plan, b).map((n) => n.title), ['先写周报'])

  // 完成不删依赖（重开后还能用），但 blockers 里不再出现。
  setStatus(a, 'done')
  assert.deepEqual(blockedListOf(b), [String(a.id)], '完成不删依赖——留着历史')
  assert.equal(blockers(plan, b).length, 0, '解锁')
  setStatus(a, 'todo')
  assert.equal(blockers(plan, b).length, 1, '撤回完成 = 重新挡住')
})

test('依赖：自依赖、成环、目标不存在都要拦下来', () => {
  const { plan, a, b } = depFixture()
  addBlockedBy(plan, b, a.id)
  assert.throws(() => addBlockedBy(plan, a, b.id), /不能成环/)
  assert.throws(() => addBlockedBy(plan, b, b.id), /不能依赖自己/)
  assert.throws(() => addBlockedBy(plan, a, 'n999'), /不存在/)
  // 间接环也不行：c 等 b（b 等 a），再让 a 等 c 就是三角环。
  const c = makeNode(plan, { type: 'todo', title: '第三件' })
  appendChild(plan, c)
  addBlockedBy(plan, c, b.id)
  assert.throws(() => addBlockedBy(plan, a, c.id), /不能成环/)
  // 重复添加去重，不报错。
  addBlockedBy(plan, b, a.id)
  assert.deepEqual(blockedListOf(b), [String(a.id)])
})

test('依赖：移除是幂等的，删空后不留空数组', () => {
  const { plan, a, b } = depFixture()
  addBlockedBy(plan, b, a.id)
  assert.equal(removeBlockedBy(b, a.id), true)
  assert.equal('blockedBy' in b, false)
  assert.equal(removeBlockedBy(b, a.id), false, '再摘一次不报错')
})

test('星标：布尔开关，关掉就删键（不留 false）', () => {
  const { b } = depFixture()
  setStar(b, true)
  assert.equal(b.starred, true)
  setStar(b, false)
  assert.equal('starred' in b, false, '磁盘上不出现 starred:false 的噪音')
})

test('重复：week 顺推 7 天，month 同日顺推且月末截断', () => {
  assert.deepEqual(RECUR_KIND, ['week', 'month'])
  const { plan, b } = depFixture()
  b.due = '2026-09-15'
  setRecur(b, 'week')
  const c1 = spawnRecurring(plan, b, '2026-09-15')
  assert.equal(c1.due, '2026-09-22')

  b.due = '2026-01-31'
  setRecur(b, 'month')
  const c2 = spawnRecurring(plan, b, '2026-01-31')
  assert.equal(c2.due, '2026-02-28', '31 号的月度任务，2 月落到月末')

  // 没有截止的：从今天起算，否则第一条就没有 due。
  b.due = undefined
  setRecur(b, 'week')
  const c3 = spawnRecurring(plan, b, '2026-09-15')
  assert.equal(c3.due, '2026-09-22')

  setRecur(b, 'none')
  assert.equal('recur' in b, false)
  assert.equal(spawnRecurring(plan, b), null, '没配重复就返回 null，调用方不用分支')
})

test('重复：克隆的是「这件事本身」，不是「上一次」', () => {
  const { plan, b } = depFixture()
  const a = plan.nodes.find((n) => n.title === '先写周报')
  addBlockedBy(plan, b, a.id)
  setStar(b, true)
  setStatus(b, 'doing')
  b.evidence = [{ kind: 'note', ref: '上次记录', at: 'x' }]
  b.owner = '我'
  b.note = '每周五发'
  b.priority = 'high'
  setRecur(b, 'week')

  const c = spawnRecurring(plan, b)
  assert.equal(c.title, '再发周报')
  assert.equal(c.owner, '我')
  assert.equal(c.priority, 'high')
  assert.equal(c.note, '每周五发')
  assert.equal(c.status, 'todo')
  assert.equal('starred' in c, false, '星标说的是「这次」，不继承')
  assert.equal('evidence' in c, false, '证据是上一次的，不继承')
  assert.equal('blockedBy' in c, false, '依赖是上一次的排程，不继承')
  assert.deepEqual(c.recur, { kind: 'week' }, '重复规则跟着走')
})

// ---------------------------------------------------------------- 完成语义一体化

function cascadeFixture() {
  const plan = emptyPlan()
  const p = makeNode(plan, { type: 'plan', title: '主线' })
  appendChild(plan, p)
  const s = makeNode(plan, { type: 'plan', title: '子计划' })
  appendChild(plan, s, p.id)
  const t1 = makeNode(plan, { type: 'todo', title: '甲' })
  appendChild(plan, t1, s.id)
  const t2 = makeNode(plan, { type: 'todo', title: '乙' })
  appendChild(plan, t2, s.id)
  return { plan, p, s, t1, t2 }
}

test('完成向上级联：最后一个子项完成，父与祖父自动完成', () => {
  const { plan, p, s, t1, t2 } = cascadeFixture()
  setStatus(t1, 'done')
  assert.equal(autoCompleteAncestors(plan, t1).length, 0, '还差一个，父不该完成')
  assert.equal(s.status, 'active')
  setStatus(t2, 'done')
  const changed = autoCompleteAncestors(plan, t2)
  assert.equal(changed.length, 2, '子计划与主线一层层点亮')
  assert.equal(s.status, 'done')
  assert.equal(p.status, 'done')
  assert.ok(s.doneAt !== undefined && p.doneAt !== undefined, '自动完成也记完成时间')
})

test('撤回向上重开：撤回一个子项，自动完成的父链回到进行中', () => {
  const { plan, p, s, t1, t2 } = cascadeFixture()
  setStatus(t1, 'done')
  setStatus(t2, 'done')
  autoCompleteAncestors(plan, t2)
  assert.equal(p.status, 'done')
  setStatus(t2, 'todo')
  const changed = reopenAncestors(plan, t2)
  assert.equal(changed.length, 2, '整条链重新打开')
  assert.equal(s.status, 'active')
  assert.equal(p.status, 'active')
  assert.equal('doneAt' in s, false, '重开要清掉完成时间，否则「本周完成」里还有它')
})

test('放弃的父不被顺手复活：dropped 的祖父停住级联，但 active 的父照常完成', () => {
  const { plan, p, s, t1, t2 } = cascadeFixture()
  setStatus(p, 'dropped')
  setStatus(t1, 'done')
  setStatus(t2, 'done')
  const changed = autoCompleteAncestors(plan, t2)
  assert.deepEqual(changed.map((n) => n.title), ['子计划'], 'active 且子项全完成的父照常完成')
  assert.equal(s.status, 'done')
  assert.equal(p.status, 'dropped', '放弃的主线不该被顺手复活')
})

test('顶层待办与叶子计划：级联对它们是无害的空操作', () => {
  const plan = emptyPlan()
  const top = makeNode(plan, { type: 'todo', title: '收件箱的一条' })
  appendChild(plan, top)
  setStatus(top, 'done')
  assert.equal(autoCompleteAncestors(plan, top).length, 0, '顶层节点没有父，无事发生')
  assert.equal(reopenAncestors(plan, top).length, 0)
  // 叶子计划的完成由人手点（面板勾选 / agent 写 status），不归级联管。
  const leaf = makeNode(plan, { type: 'plan', title: '空计划' })
  appendChild(plan, leaf)
  setStatus(leaf, 'done')
  assert.equal(leaf.status, 'done')
  assert.doesNotThrow(() => assertManualDoneAllowed(leaf), '叶子计划可以手动完成')
})

test('assertManualDoneAllowed：有未完成子项的计划不能手动完成', () => {
  const { p, s, t1, t2 } = cascadeFixture()
  assert.throws(() => assertManualDoneAllowed(p), /不能直接完成/)
  assert.throws(() => assertManualDoneAllowed(s), /不能直接完成/)
  // 子项全完成后父已自动 done——拦截只针对「还有未完成子项」的情形。
  setStatus(t1, 'done')
  setStatus(t2, 'done')
  assert.doesNotThrow(() => assertManualDoneAllowed({ type: 'todo', title: '待办', status: 'todo' }))
  assert.doesNotThrow(() => assertManualDoneAllowed({ type: 'plan', title: '空计划', status: 'active', children: [] }))
})
