/**
 * 客户端纯逻辑单元测试（node:test）。
 * logic.cjs 是 CommonJS，用 createRequire 直接加载——它刻意不依赖
 * React/DOM，所以可以在 Node 里测。
 *
 * 其中两条是**跨半身约定**测试：客户端与 host 是 ESM / CJS 两套模块系统，
 * 无法共享实现，只能靠断言把「必须一致的语义」钉住。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  pct, barWidth, statusLabel, sortNodes, summarize, toggleStatus, isOpen, todayStr,
  nodeType, childrenOf, planNodes, inboxOf, topPlans, typeLabel, progressOf,
  priorityLabel, priorityRank, nextPriority, delegateLabel, delegateText,
  flattenNodes, FILTERS, focusList, filterCounts, moveTargets, boardColumns,
  EVIDENCE_KINDS, evidenceLabel, evidenceList, unverifiedOf, paceText,
  COLLAPSE_KEY, parseCollapsed, serializeCollapsed, descendantCount, isDescendantOf, dropTarget,
  bytesToBase64, pickImages, AI_MAX_IMAGES,
} = require('../src/client/logic.cjs')

test('pct 四舍五入并夹取到 0..100', () => {
  assert.equal(pct(0), '0%')
  assert.equal(pct(0.256), '26%')
  assert.equal(pct(1), '100%')
  assert.equal(pct(1.5), '100%')
  assert.equal(pct(-1), '0%')
})

test('pct 对脏数据不抛错', () => {
  assert.equal(pct(undefined), '0%')
  assert.equal(pct(null), '0%')
  assert.equal(pct(NaN), '0%')
  assert.equal(pct('0.5'), '0%')
})

test('barWidth 与 pct 同源', () => {
  assert.equal(barWidth(0.5), '50%')
  assert.equal(barWidth(undefined), '0%')
})

test('statusLabel 覆盖待办四种状态与计划的 active，且对未知值兜底', () => {
  assert.equal(statusLabel('todo'), '待办')
  assert.equal(statusLabel('doing'), '进行中')
  assert.equal(statusLabel('done'), '已完成')
  assert.equal(statusLabel('dropped'), '已放弃')
  assert.equal(statusLabel('active'), '进行中')
  assert.equal(statusLabel('乱写'), '待办')
  assert.equal(statusLabel(undefined), '待办')
})

// ---------------------------------------------------------------- 树的读取

test('nodeType 缺省当待办，与 host 的 typeOf 完全一致（跨半身约定）', async () => {
  const host = await import('../src/store.js')
  for (const node of [{ type: 'plan' }, { type: 'todo' }, {}, { type: 'x' }, null, undefined]) {
    assert.equal(nodeType(node), host.typeOf(node), JSON.stringify(node))
  }
})

test('childrenOf / planNodes 对脏数据安全', () => {
  assert.deepEqual(childrenOf(null), [])
  assert.deepEqual(childrenOf({ children: 'x' }), [])
  assert.deepEqual(planNodes(null), [])
  assert.deepEqual(planNodes({ nodes: 'x' }), [])
})

test('inboxOf 只取顶层待办，topPlans 只取顶层计划', () => {
  const plan = annotatedPlan()
  assert.deepEqual(inboxOf(plan).map((n) => n.id), ['t9'])
  assert.deepEqual(topPlans(plan).map((n) => n.id), ['g1'])
})

test('typeLabel 把节点类型转成中文', () => {
  assert.equal(typeLabel('plan'), '计划')
  assert.equal(typeLabel('todo'), '待办')
  assert.equal(typeLabel('乱写'), '待办')
})

test('progressOf 优先读服务端算好的 progress', () => {
  assert.equal(progressOf({ type: 'plan', progress: 0.42, children: [{ type: 'todo', status: 'done' }] }), 0.42)
})

test('progressOf 与 host 的 nodeProgress 完全一致（跨半身约定）', async () => {
  const host = await import('../src/store.js')
  const cases = [
    { type: 'todo', status: 'done' },
    { type: 'todo', status: 'todo' },
    { type: 'todo', status: 'dropped' },
    { type: 'plan', metric: { target: 4, current: 1 } },
    { type: 'plan', metric: { target: 2, current: 5 }, children: [{ type: 'todo', status: 'done' }] },
    { type: 'plan', children: [{ type: 'todo', status: 'done' }, { type: 'todo', status: 'todo' }] },
    { type: 'plan', children: [{ type: 'plan', metric: { target: 2, current: 1 } }, { type: 'todo', status: 'done' }] },
    { type: 'plan', children: [] },
  ]
  for (const node of cases) {
    assert.equal(progressOf(node), host.nodeProgress(node), JSON.stringify(node))
  }
  assert.equal(progressOf(null), 0)
})

test('sortNodes 把未完成排在前、已完成沉底，且不改动入参', () => {
  const nodes = [
    { id: 'a', status: 'done' },
    { id: 'b', status: 'todo' },
    { id: 'c', status: 'dropped' },
    { id: 'd', status: 'doing' },
    { id: 'e', status: 'active' },
  ]
  assert.deepEqual(sortNodes(nodes).map((t) => t.id), ['b', 'd', 'e', 'a', 'c'])
  assert.deepEqual(nodes.map((t) => t.id), ['a', 'b', 'c', 'd', 'e'])
  assert.deepEqual(sortNodes(undefined), [])
  assert.deepEqual(sortNodes(null), [])
})

test('toggleStatus 在待办与已完成之间切换', () => {
  assert.equal(toggleStatus('todo'), 'done')
  assert.equal(toggleStatus('done'), 'todo')
  assert.equal(toggleStatus('doing'), 'done')
  assert.equal(toggleStatus(undefined), 'done')
})

test('isOpen 把已完成与已放弃都算作结束', () => {
  assert.equal(isOpen({ status: 'todo' }), true)
  assert.equal(isOpen({ status: 'active' }), true)
  assert.equal(isOpen({ status: 'done' }), false)
  assert.equal(isOpen({ status: 'dropped' }), false)
  assert.equal(isOpen(null), false)
})

// ---------------------------------------------------------------- 统计

test('summarize 递归统计计划与待办（任意深度都算进来）', () => {
  const s = summarize(annotatedPlan())
  assert.equal(s.plans, 2, 'g1 + k1')
  assert.equal(s.todos, 5, 't1..t4 + 收件箱的 t9')
  assert.equal(s.done, 1)
  assert.equal(s.open, 3, 't1/t2 未完成 + 收件箱 t9（t3 完成、t4 放弃）')
  assert.equal(s.inbox, 1)
  assert.equal(s.inboxOpen, 1)
  assert.equal(s.warnings, 1, '收件箱那条带 warnings')
  assert.equal(s.hasPlan, true)
  assert.equal(s.progress, 0.25)
})

test('summarize 记录最大深度（面板据此判断要不要展开）', () => {
  assert.equal(summarize(annotatedPlan()).depth, 3)
})

test('summarize 在缺 progress 时按待办完成比例兜底', () => {
  const plan = {
    nodes: [{ id: 'n1', type: 'plan', children: [{ id: 'n2', type: 'todo', status: 'done' }, { id: 'n3', type: 'todo', status: 'todo' }] }],
  }
  assert.equal(summarize(plan).progress, 0.5)
})

test('summarize 对空计划与脏数据安全', () => {
  assert.equal(summarize(null).hasPlan, false)
  assert.equal(summarize(null).plans, 0)
  assert.equal(summarize({}).hasPlan, false)
  assert.equal(summarize({ nodes: 'nope' }).plans, 0)
  assert.equal(summarize({ nodes: [{}] }).plans, 0, '脏节点按待办计')
})

test('summarize 只有收件箱时也算「有内容」', () => {
  const s = summarize({ nodes: [{ id: 't1', type: 'todo', title: 'x', status: 'todo' }] })
  assert.equal(s.hasPlan, true)
  assert.equal(s.plans, 0)
  assert.equal(s.open, 1)
})

// ------------------------------------------------------ 重要程度与委派显示

test('priorityLabel 把英文枚举转成中文，缺省按「中」', () => {
  assert.equal(priorityLabel('high'), '高')
  assert.equal(priorityLabel('normal'), '中')
  assert.equal(priorityLabel('low'), '低')
  assert.equal(priorityLabel(undefined), '中')
  assert.equal(priorityLabel('乱写'), '中')
})

test('priorityRank 把高排前面', () => {
  assert.ok(priorityRank('high') < priorityRank('normal'))
  assert.ok(priorityRank('normal') < priorityRank('low'))
  assert.equal(priorityRank(undefined), priorityRank('normal'))
})

test('nextPriority 三段循环，与 host 的实现完全一致（跨半身约定）', async () => {
  const host = await import('../src/store.js')
  assert.equal(nextPriority('high'), 'normal')
  assert.equal(nextPriority('normal'), 'low')
  assert.equal(nextPriority('low'), 'high')
  assert.equal(nextPriority(undefined), 'low', '缺省/脏值按「中」处理')
  for (const p of ['high', 'normal', 'low', undefined, '乱写']) {
    assert.equal(nextPriority(p), host.nextPriority(p), 'priority=' + String(p))
  }
})

test('delegateLabel 覆盖四种回执状态并兜底为待接受', () => {
  assert.equal(delegateLabel('pending'), '待接受')
  assert.equal(delegateLabel('accepted'), '已接受')
  assert.equal(delegateLabel('declined'), '已拒绝')
  assert.equal(delegateLabel('returned'), '已交回')
  assert.equal(delegateLabel('乱写'), '待接受')
})

test('delegateText 读服务端算好的 delegateState', () => {
  const node = { delegateState: { to: '张三', status: 'pending', expectAt: '2026-09-20' } }
  const text = delegateText(node)
  assert.match(text, /张三 · 待接受/)
  assert.match(text, /09-20/, '期望日期只显示月-日，窄侧栏放得下')
})

test('delegateText 在没有委派时返回 null（面板据此不渲染标记）', () => {
  assert.equal(delegateText({}), null)
  assert.equal(delegateText({ delegateState: null }), null)
  assert.equal(delegateText(null), null)
})

// ---------------------------------------------------------------- 摊平与筛选

/** 一份带完整服务端标注的样例计划（面板收到的就是这种形态）。 */
function annotatedPlan() {
  return {
    progress: 0.25,
    nodes: [
      {
        id: 'g1',
        type: 'plan',
        title: 'Q4 计划',
        status: 'active',
        priority: 'normal',
        progress: 0.25,
        warnings: [],
        overdue: false,
        dueSoon: false,
        children: [
          {
            id: 'k1',
            type: 'plan',
            title: '子计划',
            status: 'active',
            priority: 'normal',
            progress: 0.25,
            warnings: [],
            overdue: false,
            dueSoon: false,
            children: [
              { id: 't1', type: 'todo', title: '逾期的', status: 'todo', priority: 'normal', overdue: true, dueSoon: false },
              {
                id: 't2',
                type: 'todo',
                title: '委派出去的',
                status: 'doing',
                priority: 'high',
                overdue: false,
                dueSoon: true,
                delegateState: { to: '张三', status: 'pending', expectAt: '2026-09-18' },
              },
              { id: 't3', type: 'todo', title: '已完成', status: 'done', priority: 'high', overdue: false, dueSoon: true },
              { id: 't4', type: 'todo', title: '放弃的', status: 'dropped', priority: 'high', overdue: true, dueSoon: false },
            ],
          },
        ],
      },
      { id: 't9', type: 'todo', title: '游离待办', status: 'todo', priority: 'high', overdue: false, dueSoon: false, warnings: ['x'] },
    ],
  }
}

test('flattenNodes 摊平整棵递归树并给出层级路径', () => {
  const nodes = flattenNodes(annotatedPlan())
  assert.deepEqual(nodes.map((x) => x.node.id), ['g1', 'k1', 't1', 't2', 't3', 't4', 't9'])
  assert.deepEqual(nodes.map((x) => x.type), ['plan', 'plan', 'todo', 'todo', 'todo', 'todo', 'todo'])
  assert.deepEqual(nodes.map((x) => x.depth), [0, 1, 2, 2, 2, 2, 0])
  assert.equal(nodes[0].path, 'g1')
  assert.equal(nodes[1].path, 'g1 / k1')
  assert.equal(nodes[2].path, 'g1 / k1 / t1')
  assert.equal(nodes[6].path, 't9', '顶层待办的路径就是自己')
})

test('flattenNodes 对空计划与脏数据安全', () => {
  assert.deepEqual(flattenNodes(null), [])
  assert.deepEqual(flattenNodes({}), [])
  assert.equal(flattenNodes({ nodes: [{ children: 'nope' }] }).length, 1)
})

test('FILTERS 提供七个筛选项（顺序即界面上的顺序）', () => {
  assert.deepEqual(
    FILTERS.map((f) => f.id),
    ['all', 'high', 'delegated', 'week', 'overdue', 'behind', 'unverified'],
  )
})

test('focusList 的 all 返回空数组（全部视图走树形渲染）', () => {
  assert.deepEqual(focusList(annotatedPlan(), 'all'), [])
  assert.deepEqual(focusList(annotatedPlan(), ''), [])
})

test('focusList 按重要度高筛选，且排除已结束的节点', () => {
  const ids = focusList(annotatedPlan(), 'high').map((x) => x.node.id)
  assert.deepEqual(ids, ['t2', 't9'], 't3 已完成、t4 已放弃，都不该出现')
})

test('focusList 按「我委派出去的」筛选，并带上路径', () => {
  const items = focusList(annotatedPlan(), 'delegated')
  assert.deepEqual(items.map((x) => x.node.id), ['t2'])
  assert.equal(items[0].path, 'g1 / k1 / t2')
})

test('focusList 按本周到期与逾期筛选', () => {
  assert.deepEqual(focusList(annotatedPlan(), 'week').map((x) => x.node.id), ['t2'])
  assert.deepEqual(focusList(annotatedPlan(), 'overdue').map((x) => x.node.id), ['t1'])
})

test('focusList 排序：逾期 → 重要度高 → 快到期的在前', () => {
  const plan = {
    nodes: [{
      id: 'g1', type: 'plan', status: 'active', children: [
        { id: 'a', type: 'todo', title: '普通', status: 'todo', priority: 'normal' },
        { id: 'b', type: 'todo', title: '高', status: 'todo', priority: 'high' },
        { id: 'c', type: 'todo', title: '逾期', status: 'todo', priority: 'low', overdue: true },
        { id: 'd', type: 'todo', title: '快到期的', status: 'todo', priority: 'normal', dueSoon: true },
      ],
    }],
  }
  assert.deepEqual(focusList(plan, 'high').map((x) => x.node.id), ['b'])
  assert.deepEqual(focusList(plan, 'overdue').map((x) => x.node.id), ['c'])
})

test('focusList 在服务端没给 overdue 标注时本地兜底判定', () => {
  const plan = {
    nodes: [{
      id: 'g1', type: 'plan', status: 'active', children: [
        { id: 'a', type: 'todo', title: '没有标注但已过期', status: 'todo', due: '2000-01-01' },
        { id: 'b', type: 'todo', title: '没有标注也没过期', status: 'todo', due: '2999-01-01' },
      ],
    }],
  }
  assert.deepEqual(focusList(plan, 'overdue', '2026-09-14').map((x) => x.node.id), ['a'])
})

test('filterCounts 给出各筛选器的角标数（不含 all）', () => {
  const counts = filterCounts(annotatedPlan())
  assert.deepEqual(Object.keys(counts).sort(), ['behind', 'delegated', 'high', 'overdue', 'unverified', 'week'])
  assert.equal(counts.high, 2)
  assert.equal(counts.delegated, 1)
  assert.equal(counts.overdue, 1)
  assert.equal(counts.week, 1)
  assert.equal(counts.behind, 0, '没有 behind 标注的节点不计入')
  assert.equal(counts.unverified, 1, 't3 是已完成且无证据的唯一一条')
})

// ------------------------------------------------- 完成证据 / 落后（新增筛选）

/** 一个带「落后」与「有/无证据」标注的样例（服务端标注过的形态）。 */
function annotatedPacePlan() {
  return {
    nodes: [
      {
        id: 'g1',
        type: 'plan',
        title: 'Q4 计划',
        status: 'active',
        priority: 'high',
        start: '2026-09-01',
        end: '2026-09-30',
        behind: true,
        pace: { expected: 0.5, actual: 0.2, gap: 0.3, behind: true },
        children: [
          { id: 'a', type: 'todo', title: '落后且在做的', status: 'doing', priority: 'normal', behind: true, pace: { expected: 0.5, actual: 0.2, gap: 0.3, behind: true } },
          { id: 'b', type: 'todo', title: '正常', status: 'todo', priority: 'normal', behind: false, pace: { expected: 0.5, actual: 0.8, gap: -0.3, behind: false } },
          // 有证据的完成项：不该出现在「无证据」清单里
          { id: 'c', type: 'todo', title: '有证据的完成项', status: 'done', priority: 'normal', doneAt: '2026-09-10T02:00:00.000Z', evidence: [{ kind: 'file', ref: 'out/a.md', at: '2026-09-10T02:00:00.000Z' }] },
          // 无证据的完成项：出现在「无证据」清单里
          { id: 'd', type: 'todo', title: '无证据的完成项', status: 'done', priority: 'normal', doneAt: '2026-09-12T02:00:00.000Z' },
        ],
      },
    ],
  }
}

test('EVIDENCE_KINDS 与 host 的 EVIDENCE_KIND 完全一致（跨半身约定）', async () => {
  const host = await import('../src/store.js')
  assert.deepEqual(EVIDENCE_KINDS, host.EVIDENCE_KIND)
})

test('evidenceLabel 覆盖五种证据类型，未知值按「说明」兜底', () => {
  assert.equal(evidenceLabel('file'), '文件')
  assert.equal(evidenceLabel('session'), '会话')
  assert.equal(evidenceLabel('command'), '命令')
  assert.equal(evidenceLabel('link'), '链接')
  assert.equal(evidenceLabel('note'), '说明')
  assert.equal(evidenceLabel('乱写'), '说明')
  assert.equal(evidenceLabel(undefined), '说明')
})

test('evidenceList 永远返回数组，对脏数据安全', () => {
  assert.deepEqual(evidenceList({ evidence: [{ kind: 'note', ref: 'x' }] }).length, 1)
  assert.deepEqual(evidenceList({ evidence: 'nope' }), [])
  assert.deepEqual(evidenceList({}), [])
  assert.deepEqual(evidenceList(null), [])
})

test('unverifiedOf 优先读服务端标注，缺失时按「done 且无证据」兜底', () => {
  assert.equal(unverifiedOf({ status: 'done' }), true)
  assert.equal(unverifiedOf({ status: 'done', evidence: [] }), true)
  assert.equal(unverifiedOf({ status: 'done', evidence: [{ kind: 'note', ref: 'x' }] }), false)
  assert.equal(unverifiedOf({ status: 'todo' }), false)
  assert.equal(unverifiedOf({ status: 'dropped' }), false)
  // 服务端已经判过时以其为准（标注是权威，本地不覆盖它）
  assert.equal(unverifiedOf({ status: 'done', evidence: [{ kind: 'note', ref: 'x' }], unverified: true }), true)
  assert.equal(unverifiedOf(null), false)
})

test('paceText 由服务端 pace 生成，缺标注时不显示', () => {
  assert.equal(paceText({ pace: { expected: 0.5, actual: 0.2, gap: 0.3, behind: true } }), '应到 50% / 实际 20%')
  assert.equal(paceText({ pace: null }), null)
  assert.equal(paceText({}), null)
  assert.equal(paceText(null), null)
})

test('focusList 的「落后」筛选只看未结束且标注落后的节点', () => {
  const ids = focusList(annotatedPacePlan(), 'behind').map((x) => x.node.id)
  assert.deepEqual(ids, ['g1', 'a'], 'g1 与 a 落后；b 没落后，c/d 已结束')
})

test('focusList 的「无证据的完成项」筛出已完成的节点（其余筛选器都只看未结束）', () => {
  const items = focusList(annotatedPacePlan(), 'unverified')
  assert.deepEqual(items.map((x) => x.node.id), ['d'], 'c 附了证据，不在里面')
  assert.equal(items[0].path, 'g1 / d')
  // 反向确认：别的筛选器不会把已完成的捞出来
  assert.deepEqual(focusList(annotatedPacePlan(), 'behind').map((x) => x.node.id).includes('c'), false)
})

test('focusList 的「无证据的完成项」按完成时间倒序（最近的先审）', () => {
  const plan = {
    nodes: [
      { id: 'old', type: 'todo', title: '上周完成的', status: 'done', doneAt: '2026-09-01T00:00:00.000Z' },
      { id: 'new', type: 'todo', title: '刚完成的', status: 'done', doneAt: '2026-09-13T00:00:00.000Z' },
      { id: 'none', type: 'todo', title: '没有时间戳的', status: 'done' },
    ],
  }
  assert.deepEqual(focusList(plan, 'unverified').map((x) => x.node.id), ['new', 'old', 'none'])
})

test('filterCounts 把新增的两个筛选器也算进去', () => {
  const counts = filterCounts(annotatedPacePlan())
  assert.equal(counts.behind, 2)
  assert.equal(counts.unverified, 1)
})

test('summarize 带上筛选角标', () => {
  const s = summarize(annotatedPlan())
  assert.equal(s.filters.high, 2)
  assert.equal(s.filters.overdue, 1)
})

// ---------------------------------------------------------------- 看板分列

test('boardColumns 按顶层计划分列，收件箱单列，列头带进度与计数', () => {
  const cols = boardColumns(annotatedPlan(), 'all', '2026-09-14')
  // annotatedPlan: g1(计划) > k1(子计划) > t1..t4 ；t9 顶层待办(收件箱)
  assert.deepEqual(cols.map((c) => c.kind), ['plan', 'inbox'])
  assert.equal(cols[0].title, 'Q4 计划')
  assert.equal(cols[0].progress, 0.25)
  // g1 名下共 4 张待办（t1..t4 都在 g1 子树里）；open = t1、t2（t3 完成、t4 放弃）
  assert.equal(cols[0].total, 4)
  assert.equal(cols[0].open, 2)
  // 收件箱列把顶层待办归到一起，而不是每条顶层待办占一列
  assert.equal(cols[1].kind, 'inbox')
  assert.equal(cols[1].title, '收件箱')
  assert.equal(cols[1].total, 1)
})

test('boardColumns 卡片带「所属子计划」上下文路径（列只代表顶层计划）', () => {
  const cols = boardColumns(annotatedPlan(), 'all', '2026-09-14')
  const t2 = cols[0].cards.find((c) => c.node.id === 't2')
  assert.equal(t2.path, '子计划', 't2 在子计划 k1 下，路径应显示子计划标题')
  // 顶层计划直接名下的待办（若有）路径应为空
  const direct = boardColumns(annotatedPlan(), 'all', '2026-09-14')
  const inboxCard = direct[1].cards[0]
  assert.equal(inboxCard.path, '', '收件箱待办没有父级上下文')
})

test('boardColumns 全量态把已完成的沉到列底', () => {
  const cols = boardColumns(annotatedPlan(), 'all', '2026-09-14')
  const ids = cols[0].cards.map((c) => c.node.id)
  // t1、t2 未完成排在前，t3(完成)、t4(放弃) 沉底
  assert.deepEqual(ids, ['t1', 't2', 't3', 't4'])
})

test('boardColumns 尊重筛选器：只放命中筛选的待办进列', () => {
  // 重要度高：t2、t9 命中（t3 已完成、t4 已放弃被排除）。
  const cols = boardColumns(annotatedPlan(), 'high', '2026-09-14')
  const g1 = cols.find((c) => c.kind === 'plan')
  assert.deepEqual(g1.cards.map((c) => c.node.id), ['t2'])
  const inbox = cols.find((c) => c.kind === 'inbox')
  assert.deepEqual(inbox.cards.map((c) => c.node.id), ['t9'])
})

test('boardColumns 没有任何待办的计划列被丢弃，纯空计划整棵看板为空', () => {
  const plan = { nodes: [{ id: 'g1', type: 'plan', title: '空计划', status: 'active', children: [] }] }
  assert.deepEqual(boardColumns(plan, 'all'), [], '只有计划、没有任务时看板应为空')
})

test('boardColumns 对空计划与脏数据安全', () => {
  assert.deepEqual(boardColumns(null), [])
  assert.deepEqual(boardColumns({}), [])
  assert.deepEqual(boardColumns({ nodes: 'nope' }), [])
})

test('boardColumns 多个顶层待办要并回收件箱一列，而不是各占一列', () => {
  const plan = {
    nodes: [
      { id: 'g1', type: 'plan', title: 'P', status: 'active', children: [{ id: 'a', type: 'todo', title: '甲', status: 'todo' }] },
      { id: 'i1', type: 'todo', title: '游离一', status: 'todo' },
      { id: 'i2', type: 'todo', title: '游离二', status: 'todo' },
    ],
  }
  const cols = boardColumns(plan, 'all')
  assert.deepEqual(cols.map((c) => c.kind), ['plan', 'inbox'])
  assert.equal(cols[1].total, 2, '两条顶层待办应并回收件箱一列')
})

// ---------------------------------------------------------------- 归位候选

test('moveTargets 列出所有计划节点，并排除当前所在的那个', () => {
  const plan = annotatedPlan()
  // t9 在顶层，可以移到 g1（或它下面的 k1）
  const forT9 = moveTargets(plan, plan.nodes[1])
  assert.deepEqual(forT9.map((t) => t.id), ['g1', 'k1'])
  assert.equal(forT9[0].depth, 0)
  assert.equal(forT9[1].depth, 1)
})

test('moveTargets 排除节点自己（计划不能被移到自己下面）', () => {
  const plan = annotatedPlan()
  const forG1 = moveTargets(plan, plan.nodes[0])
  assert.deepEqual(forG1.map((t) => t.id), ['k1'], 'g1 自己不在候选里')
})

test('moveTargets 对空计划与脏数据安全', () => {
  assert.deepEqual(moveTargets({ nodes: [] }, { id: 'x' }), [])
  assert.deepEqual(moveTargets(null, null), [])
})

test('todayStr 输出本地日期', () => {
  assert.match(todayStr(), /^\d{4}-\d{2}-\d{2}$/)
})

// ---------------------------------------------------- 折叠状态（本机显示偏好）

test('parseCollapsed 解析正常数据，并丢掉非字符串项', () => {
  assert.deepEqual(parseCollapsed('["n1","n2"]'), ['n1', 'n2'])
  assert.deepEqual(parseCollapsed('["n1",3,null,"n2",""]'), ['n1', 'n2'])
})

test('parseCollapsed 对脏数据一律退化成「没折叠过」', () => {
  // localStorage 里那个键可能被手改、被旧版本写过、被别的插件占了；
  // 显示偏好解析失败不该把整个面板打崩。
  assert.deepEqual(parseCollapsed('不是 JSON'), [])
  assert.deepEqual(parseCollapsed('{"n1":true}'), [], '对象不是列表')
  assert.deepEqual(parseCollapsed('null'), [])
  assert.deepEqual(parseCollapsed(''), [])
  assert.deepEqual(parseCollapsed(undefined), [])
  assert.deepEqual(parseCollapsed(42), [])
})

test('serializeCollapsed 排序后写出，且与 parseCollapsed 往返一致', () => {
  assert.equal(serializeCollapsed(['n3', 'n1', 'n2']), '["n1","n2","n3"]')
  assert.deepEqual(parseCollapsed(serializeCollapsed(['n2', 'n1'])), ['n1', 'n2'])
  assert.equal(serializeCollapsed(null), '[]')
})

test('COLLAPSE_KEY 是带插件前缀的独立键（不撞别人的 localStorage）', () => {
  assert.equal(COLLAPSE_KEY, 'dsh-workbench:collapsed')
})

// ------------------------------------------------------------ 折叠与拖拽辅助

test('descendantCount 递归数出所有后代，与 host 的 nodeStats 对得上（跨半身约定）', async () => {
  const host = await import('../src/store.js')
  const plan = dropFixture()
  const flat = []
  const walk = (list) => { for (const n of list) { flat.push(n); walk(childrenOf(n)) } }
  walk(plan.nodes)
  for (const node of flat) {
    const mine = descendantCount(node)
    // nodeStats 把节点自己也数进去，所以这里减 1 —— 两边口径因此能对上。
    assert.equal(mine, host.nodeStats(node).total - 1, node.id + ' 的后代数')
  }
})

test('descendantCount 对叶子是 0，对脏数据安全', () => {
  assert.equal(descendantCount({ type: 'todo' }), 0)
  assert.equal(descendantCount({ type: 'plan', children: [] }), 0)
  assert.equal(descendantCount(null), 0)
})

test('isDescendantOf 与 host 的实现逐对一致（跨半身约定）', async () => {
  const host = await import('../src/store.js')
  const plan = dropFixture()
  const flat = []
  const walk = (list) => { for (const n of list) { flat.push(n); walk(childrenOf(n)) } }
  walk(plan.nodes)
  // 两边实现不同（host 逐层 locate，客户端一趟递归），但必须给出同一个答案——
  // 否则会出现「面板不让拖，服务端却能移」这种没人说得清的错位。
  for (const a of flat) {
    for (const b of flat) {
      assert.equal(isDescendantOf(a, b), host.isDescendantOf(plan, a, b), a.id + ' 是否在 ' + b.id + ' 之下')
    }
  }
})

test('isDescendantOf 不含自己，也不认脏数据', () => {
  const plan = dropFixture()
  const n1 = plan.nodes[0]
  assert.equal(isDescendantOf(n1, n1), false, '自己不是自己的后代')
  assert.equal(isDescendantOf(null, n1), false)
  assert.equal(isDescendantOf({ id: 'x' }, null), false)
  assert.equal(isDescendantOf({}, n1), false, '没有 id 的节点不参与判断')
})

// -------------------------------------------------------------- 拖拽落点

/** 拖拽用例共用的树：
 *    n1 A
 *      n2 a1 / n3 a2
 *      n4 B
 *        n5 b1
 *    n6 i1（顶层待办 = 收件箱）
 *    n7 C（空计划）
 */
function dropFixture() {
  return {
    schema: 2,
    version: 1,
    title: 't',
    nodes: [
      {
        id: 'n1',
        type: 'plan',
        title: 'A',
        status: 'active',
        children: [
          { id: 'n2', type: 'todo', title: 'a1', status: 'todo' },
          { id: 'n3', type: 'todo', title: 'a2', status: 'todo' },
          {
            id: 'n4',
            type: 'plan',
            title: 'B',
            status: 'active',
            children: [{ id: 'n5', type: 'todo', title: 'b1', status: 'todo' }],
          },
        ],
      },
      { id: 'n6', type: 'todo', title: 'i1', status: 'todo' },
      { id: 'n7', type: 'plan', title: 'C', status: 'active', children: [] },
    ],
  }
}

/** 把树压成一行，便于断言移动后的形状，如 `n1(n2,n3);n6`。 */
function shape(plan) {
  const walk = (n) => {
    const kids = Array.isArray(n.children) ? n.children : []
    return n.id + (kids.length > 0 ? '(' + kids.map(walk).join(',') + ')' : '')
  }
  return plan.nodes.map(walk).join(';')
}

test('dropTarget 只管算落点，不改数据', () => {
  const plan = dropFixture()
  const before = shape(plan)
  dropTarget(plan, 'n2', 'n3', 'after')
  assert.equal(shape(plan), before, '纯函数：算落点不该动原树')
})

test('dropTarget 拒绝自身、子孙、非法类型与不存在的节点', () => {
  const plan = dropFixture()
  assert.equal(dropTarget(plan, 'n2', 'n2', 'after'), null, '拖到自己身上')
  assert.equal(dropTarget(plan, 'n1', 'n4', 'inside'), null, '拖进自己的子树会成环')
  assert.equal(dropTarget(plan, 'n1', 'n5', 'before'), null, '子孙的旁边也在子树里')
  assert.equal(dropTarget(plan, 'n2', 'n6', 'inside'), null, '待办是叶子，不能当容器')
  assert.equal(dropTarget(plan, '没这个节点', 'n3', 'after'), null)
  assert.equal(dropTarget(plan, 'n2', '没这个节点', 'after'), null)
  assert.equal(dropTarget(null, 'n2', 'n3', 'after'), null)
  assert.equal(dropTarget(plan, '', 'n3', 'after'), null)
})

test('dropTarget 把「落回原地」判成 null（不产生空写入、不留空版本快照）', () => {
  const plan = dropFixture()
  // n3 已经紧跟在 n2 后面：插到 n2 之后 = 原地
  assert.equal(dropTarget(plan, 'n3', 'n2', 'after'), null)
  // n2 已经在 n3 前面：插到 n3 之前 = 原地
  assert.equal(dropTarget(plan, 'n2', 'n3', 'before'), null)
  // n7 已经是顶层最后一个：落到空白处 = 原地
  assert.equal(dropTarget(plan, 'n7', null, 'after'), null)
  // 但 n6 不是最后一个：落到空白处是真的移动（挪到末尾）
  assert.deepEqual(dropTarget(plan, 'n6', null, 'after'), { node: 'n6', parent: null, index: 2 })
})

test('dropTarget 算出的 index 与 host 的 moveNode 语义完全一致（跨半身约定）', async () => {
  const host = await import('../src/store.js')
  // 这是本次最要紧的一条断言：`/node-move` 的 index 语义是「**先把自己摘掉**
  // 再插入」，客户端必须按同一套坐标系算位。两边只要错一位，表现是
  // 「拖完之后顺序差一格」——很像手滑，非常难查。所以这里不比对数字，
  // 直接把客户端的落点喂给真的 moveNode，看树长成什么样。
  const cases = [
    // [拖谁, 落在谁身上, 哪一档, 期望形状, 说明]
    ['n2', 'n3', 'after', 'n1(n3,n2,n4(n5));n6;n7', '同层往后挪一位'],
    ['n3', 'n2', 'before', 'n1(n3,n2,n4(n5));n6;n7', '同层往前挪一位'],
    ['n2', 'n4', 'inside', 'n1(n3,n4(n5,n2));n6;n7', '放进子计划（追加到末尾）'],
    ['n5', 'n4', 'before', 'n1(n2,n3,n5,n4);n6;n7', '从子计划里提上来，插在子计划前面'],
    ['n5', 'n1', 'inside', 'n1(n2,n3,n4,n5);n6;n7', '提到父计划下当最后一项'],
    ['n2', 'n6', 'before', 'n1(n3,n4(n5));n2;n6;n7', '跨到顶层，插在另一个顶层节点前'],
    ['n5', null, 'after', 'n1(n2,n3,n4);n6;n7;n5', '拖到空白处 = 移回顶层末尾'],
    ['n6', null, 'after', 'n1(n2,n3,n4(n5));n7;n6', '顶层重排：挪到末尾'],
  ]
  for (const [drag, ref, place, expected, why] of cases) {
    const plan = dropFixture()
    const target = dropTarget(plan, drag, ref, place)
    assert.notEqual(target, null, why + '：应当算出落点')
    host.moveNode(plan, target.node, target.parent, target.index)
    assert.equal(shape(plan), expected, why)
  }
})

test('dropTarget 的精确下标与 host 的「不传 index 就追加」落在同一个位置', async () => {
  const host = await import('../src/store.js')
  // 归位选择器（↳）走的是「不给 index」这条路，语义是追加到末尾。
  // 与拖拽给的精确下标必须落在同一个位置，否则同一个目标会有两种结果。
  const a = dropFixture()
  const b = dropFixture()
  const target = dropTarget(a, 'n5', null, 'after')
  assert.deepEqual(target, { node: 'n5', parent: null, index: 3 })
  host.moveNode(a, target.node, target.parent, target.index)
  host.moveNode(b, 'n5', null)
  assert.equal(shape(a), 'n1(n2,n3,n4);n6;n7;n5')
  assert.equal(shape(a), shape(b), '拖到空白处与 ↳ 选「顶层」应当等效')
})


test('bytesToBase64 与 Node 的 Buffer 结果一致（含 1/2 字节的填充边界）', () => {
  // 图片要走 JSON 请求体，只能编码成 base64；编错了 host 侧会直接拒收，
  // 所以拿 Node 自己的实现当对照，把 0..5 字节都过一遍（覆盖 = 与 == 两种填充）。
  const cases = [
    [],
    [0x41],
    [0x41, 0x42],
    [0x41, 0x42, 0x43],
    [0x41, 0x42, 0x43, 0x44],
    [0xff, 0x00, 0x7f, 0x80, 0x01],
  ]
  for (const bytes of cases) {
    assert.equal(bytesToBase64(Uint8Array.from(bytes)), Buffer.from(bytes).toString('base64'))
  }
  assert.equal(bytesToBase64(Uint8Array.from([0x41])), 'QQ==')
  assert.equal(bytesToBase64(Uint8Array.from([0x41, 0x42])), 'QUI=')
  assert.equal(bytesToBase64(null), '', '没有字节就返回空串，不抛')
})

test('pickImages 只挑「还装得下」的几张，并报出丢了几张', () => {
  const files = ['a', 'b', 'c']
  assert.deepEqual(pickImages(files, []), { picked: ['a', 'b', 'c'], dropped: 0 })
  assert.deepEqual(pickImages(files, ['x', 'y', 'z']), { picked: ['a'], dropped: 2 })
  assert.deepEqual(pickImages(files, ['x', 'y', 'z', 'w']), { picked: [], dropped: 3 })
  assert.deepEqual(pickImages([], []), { picked: [], dropped: 0 })
  assert.equal(AI_MAX_IMAGES, 4)
})
