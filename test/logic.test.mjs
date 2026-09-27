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
  pct, barWidth, statusLabel, sortNodes, summarize, toggleStatus, isOpen, todayStr, dayOfLocal,
  nodeType, childrenOf, planNodes, inboxOf, topPlans, typeLabel, progressOf,
  priorityLabel, priorityRank, nextPriority, delegateLabel, delegateText,
  flattenNodes, FILTERS, focusList, filterCounts, upcomingByDay, dayLabel, deferDate, moveTargets, reportOf, reportMarkdown,
  duplicateGroupsOf,
  EVIDENCE_KINDS, evidenceLabel, evidenceList, unverifiedOf, paceText,
  COLLAPSE_KEY, parseCollapsed, serializeCollapsed, descendantCount, isDescendantOf, dropTarget,
  bytesToBase64, pickImages, AI_MAX_IMAGES,
  FILE_KINDS, fileLabel, filesList, obsidianLink,
  STATUS_LIST, PRIORITIES, statusListOf, formDraftOf, emptyDraft, formRequest, formErrors,
  planByName, blockersOf, todoList, matchTaskTitles, loadViews, saveViews, viewItems, VIEWS_KEY,
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

test('nodeType 由结构派生，与 host 的 typeOf 完全一致（跨半身约定）', async () => {
  const host = await import('../src/store.js')
  for (const node of [
    { children: [{ title: 'x' }] },
    { children: [] },
    {},
    { type: 'plan' },
    { type: 'x' },
    null,
    undefined,
  ]) {
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

test('FILE_KINDS 与 host 的 FILE_KIND 完全一致（跨半身约定）', async () => {
  const host = await import('../src/store.js')
  assert.deepEqual(FILE_KINDS, host.FILE_KIND)
})

test('fileLabel 覆盖两种关联类型，未知值按「文件」兜底', () => {
  assert.equal(fileLabel('file'), '文件')
  assert.equal(fileLabel('folder'), '文件夹')
  assert.equal(fileLabel('乱写'), '文件')
  assert.equal(fileLabel(undefined), '文件')
})

test('filesList 永远返回数组，对脏数据安全', () => {
  assert.deepEqual(filesList({ files: [{ kind: 'file', ref: 'a.md' }] }).length, 1)
  assert.deepEqual(filesList({ files: 'nope' }), [])
  assert.deepEqual(filesList({}), [])
  assert.deepEqual(filesList(null), [])
})

test('obsidianLink 用 vault 末段作 vault 名，路径按 vault 根相对编码', () => {
  // 没配 vault → 不渲染链接（面板据此只显示路径文本）。
  assert.equal(obsidianLink('', 'a/b.md'), null)
  assert.equal(obsidianLink('/Users/me/vault', ''), null)
  // 绝对路径 ref 仍以末段 vault 名生成链接，并去掉前导斜杠。
  const link = obsidianLink('/Users/me/vault', '项目A/需求.md')
  assert.equal(link, 'obsidian://open?vault=vault&path=' + encodeURIComponent('项目A/需求.md'))
  assert.match(link, /^obsidian:\/\/open\?vault=vault&path=/)
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

// ------------------------------------------------------------ 日报 / 周报

/**
 * 报告的固定 fixture。日期钉死：2026-09-17 是**周四**，于是「本周」
 * = 09-14（周一）… 09-20（周日）——跨周、跨月的边界都测得到。
 *
 * 每条节点都故意踩一个边界，测试名里写着它防的是哪种错。
 */
function reportPlan() {
  return {
    nodes: [
      {
        id: 'p1',
        title: '工作主线',
        status: 'active',
        children: [
          // ── 已结束：只有落在完成窗口里的才算「本期完成」
          { id: 'a1', title: '周一做完的', status: 'done', doneAt: '2026-09-14T10:00:00.000Z' },
          // 取 UTC 中午：报告窗口按**本地日期**比（见 dayOfLocal），晚一些的时刻在东八区
          // 会滚到第二天、被 `day <= 今天` 判出窗口。UTC 正午在 -12..+11 的偏移下都是同一天。
          { id: 'a2', title: '今天做完的', status: 'done', doneAt: '2026-09-17T12:00:00.000Z' },
          { id: 'a3', title: '上周做完的', status: 'done', doneAt: '2026-09-10T09:00:00.000Z' },
          { id: 'a4', title: '做完了但没记时间', status: 'done' },
          { id: 'a5', title: '放弃的', status: 'dropped', doneAt: '2026-09-16T09:00:00.000Z' },
          // ── 未结束：四段互斥，优先级 逾期 > 落后 > 到期 > 进行中
          { id: 'a6', title: '欠着的', status: 'todo', due: '2026-09-01', overdue: true },
          { id: 'a7', title: '落后的', status: 'doing', behind: true, pace: { gap: 0.4 } },
          { id: 'a8', title: '周日到期', status: 'todo', due: '2026-09-20' },
          { id: 'a9', title: '下周一到期', status: 'todo', due: '2026-09-21' },
          { id: 'a10', title: '手上在做的', status: 'doing' },
        ],
      },
      { id: 'i1', title: '收件箱一条', status: 'todo', due: '2026-09-17' },
    ],
  }
}
const REPORT_TODAY = '2026-09-17'   // 周四
const idsOf = (arr) => arr.map((x) => x.node.id).sort()

test('reportOf 周报：完成窗口是「本周一 → 今天」，到期窗口是「今天 → 本周日」', () => {
  const rep = reportOf(reportPlan(), REPORT_TODAY, 'week')
  // 完成：a1(周一) 与 a2(今天) 在窗口内；a3(上周) 与 a4(没记时间) 不算
  assert.deepEqual(idsOf(rep.done), ['a1', 'a2'])
  // 到期：a8(周日) 与 i1(今天) 在窗口内；a9(下周一) 还没到，a6 已归逾期段
  assert.deepEqual(idsOf(rep.due), ['a8', 'i1'])
  assert.equal(rep.mode, 'week')
  assert.ok(rep.title.indexOf('9月14日') >= 0 && rep.title.indexOf('9月20日') >= 0, rep.title)
})

test('reportOf 日报：只看今天（完成与到期都收窄到今天）', () => {
  const rep = reportOf(reportPlan(), REPORT_TODAY, 'day')
  assert.deepEqual(idsOf(rep.done), ['a2'], '周一的 a1 不算今天的')
  assert.deepEqual(idsOf(rep.due), ['i1'], '周日的 a8 不算今天的')
  assert.equal(rep.mode, 'day')
  assert.equal(rep.title, '9月17日 周四')
})

test('reportOf 四段互斥：表头那几个数不重复计同一条', () => {
  const rep = reportOf(reportPlan(), REPORT_TODAY, 'week')
  // a7 同时是 doing 与 behind：只该落进更急的「落后」段，两段都收它就重复计数了
  assert.deepEqual(idsOf(rep.behind), ['a7'])
  assert.ok(!idsOf(rep.doing).includes('a7'), '落后的事不该又在进行中里出现一次')
  // a6 逾期且早就过期：不能同时出现在到期段
  assert.deepEqual(idsOf(rep.overdue), ['a6'])
  assert.ok(!idsOf(rep.due).includes('a6'))
  // 互斥的机械验算
  const seen = [...rep.overdue, ...rep.behind, ...rep.due, ...rep.doing].map((x) => x.node.id)
  assert.equal(new Set(seen).size, seen.length, '同一条被数进了两段')
  // a9（下周一到期）**故意不在任何一段里**：报告讲的是「这一期」，下周一的事不属于
  // 这一期。它也不该被塞进「进行中」——那个段读作「手上的事，且不欠账」。
  assert.equal(seen.length, 5, 'a6 逾期 / a7 落后 / a8 i1 到期 / a10 进行中 —— 各归一段')
  assert.ok(!seen.includes('a9'), '下周一到期不属于这一期（今天是周四、本周日 09-20）')
})

test('reportOf 没有 doneAt 的已完成**不算**本期完成（「完成」≠「本期完成」）', () => {
  const rep = reportOf(reportPlan(), REPORT_TODAY, 'week')
  assert.ok(!idsOf(rep.done).includes('a4'), 'a4 是 done 但没有完成时间，不知道是哪天做的')
})

test('reportOf 放弃的只进计数，不进任何一段（放弃不是完成，也不是欠账）', () => {
  const rep = reportOf(reportPlan(), REPORT_TODAY, 'week')
  assert.equal(rep.dropped, 1)
  const all = [...rep.done, ...rep.doing, ...rep.overdue, ...rep.behind, ...rep.due]
  assert.ok(!all.some((x) => x.node.id === 'a5'), '放弃的那条不该出现在任何一段里')
})

test('reportOf 完成段按完成时间倒序（刚做完的最先看见）', () => {
  const rep = reportOf(reportPlan(), REPORT_TODAY, 'week')
  assert.deepEqual(rep.done.map((x) => x.node.id), ['a2', 'a1'])
})

test('reportOf 逾期与落后只读服务端标注：标了 false 就不重算', () => {
  // 服务端明确说没逾期时，即使 due 早就过了也不判它逾期——口径只有 store.isOverdue
  // 一处，客户端另算一套就会出现「面板说没逾期、简报说逾期」而没人知道哪个对。
  const plan = { nodes: [{ id: 'x', title: '服务端说没逾期', status: 'todo', due: '2020-01-01', overdue: false }] }
  assert.equal(reportOf(plan, REPORT_TODAY, 'week').overdue.length, 0, 'overdue:false 是服务端的判断')
  // 落后同理：没有 behind 标注就不进落后段
  const plan2 = { nodes: [{ id: 'y', title: '没标落后', status: 'doing' }] }
  assert.equal(reportOf(plan2, REPORT_TODAY, 'week').behind.length, 0)
  // 服务端标了才进
  const plan3 = { nodes: [{ id: 'z', title: '标了的', status: 'doing', behind: true }] }
  assert.equal(reportOf(plan3, REPORT_TODAY, 'week').behind.length, 1)
})

test('reportOf 服务端**没给**标注时才走客户端兜底（与 focusList 同一把尺）', () => {
  // 这是刻意保留的降级路径：宿主太老、没下发 overdue 字段时，节点上就没有这个键。
  // focusList 与 upcomingByDay 都是 `=== true || (=== undefined && 兜底)`，
  // 三处必须同判，否则同一个节点在筛选器与报告里会被判出两种结果。
  const plan = { nodes: [{ id: 'x', title: '没标注但确实过期', status: 'todo', due: '2020-01-01' }] }
  assert.equal(reportOf(plan, REPORT_TODAY, 'week').overdue.length, 1, '缺标注才兜底')
  const list = require('../src/client/logic.cjs')
  assert.equal(list.focusList(plan, 'overdue', REPORT_TODAY).length, 1, 'focusList 同判')
})

test('reportOf 上下文路径报的是**标题**链，且去掉自己那段', () => {
  const rep = reportOf(reportPlan(), REPORT_TODAY, 'week')
  assert.equal(rep.overdue[0].path, '工作主线', 'a6 在 p1 下，路径是父级标题，不含自己')
  assert.equal(rep.due.find((x) => x.node.id === 'i1').path, '', '顶层待办没有父级上下文')
})

test('reportOf 容器到期用 end 兜底（与 upcomingByDay 同一把尺，不引 start）', () => {
  const plan = {
    nodes: [
      { id: 'c1', title: '有 end 的计划', status: 'active', children: [{ id: 'c1a', title: '子', status: 'todo' }], end: '2026-09-19' },
      { id: 'c2', title: '只有 start 的计划', status: 'active', children: [{ id: 'c2a', title: '子', status: 'todo' }], start: '2026-09-19' },
    ],
  }
  const rep = reportOf(plan, REPORT_TODAY, 'week')
  assert.ok(idsOf(rep.due).includes('c1'), 'end 在窗口内 → 算本期到期')
  assert.ok(!idsOf(rep.due).includes('c2'), 'start 不是锚点（与 upcomingByDay 同一把尺）')
})

test('reportOf 对空计划与脏数据安全，且 empty 标记正确', () => {
  for (const bad of [null, undefined, {}, { nodes: 'nope' }]) {
    const rep = reportOf(bad, REPORT_TODAY, 'week')
    assert.equal(rep.empty, true, JSON.stringify(bad))
    for (const k of ['done', 'doing', 'overdue', 'behind', 'due']) {
      assert.deepEqual(rep[k], [], k + ' 必须是空数组（渲染期直接 .length / .map）')
    }
    assert.equal(rep.dropped, 0)
  }
  // 非法 today 也不抛
  const rep = reportOf(reportPlan(), '不是日期', 'week')
  assert.ok(Array.isArray(rep.due) && Array.isArray(rep.done))
})

test('reportOf 没传 today 时退回今天（不因少一个参数就崩在窗口计算上）', () => {
  const rep = reportOf(reportPlan(), undefined, 'week')
  assert.equal(rep.mode, 'week')
  assert.ok(Array.isArray(rep.done))
})

test('reportOf 本周一为一周之始：周日回退 6 天，其余回退 (getDay-1) 天', () => {
  // 2026-09-20 是周日 → 本周一 09-14（不是 09-21，那会跑到下周、于是本周一条完成都没有）
  const sun = reportOf(reportPlan(), '2026-09-20', 'week')
  assert.ok(sun.title.indexOf('9月14日') >= 0, sun.title)
  // 2026-09-14 是周一 → 回到自己
  const mon = reportOf(reportPlan(), '2026-09-14', 'week')
  assert.ok(mon.title.indexOf('9月14日') >= 0, mon.title)
  // 跨月：2026-10-01 是周四 → 本周一 2026-09-28
  const cross = reportOf(reportPlan(), '2026-10-01', 'week')
  assert.ok(cross.title.indexOf('9月28日') >= 0, cross.title)
})

test('dayOfLocal 把 ISO 时间戳换算成本地日期（直接截前 10 位会差一天）', () => {
  // 这是整条时间链的锚点：报告窗口、PLAN.md 的「完成于」、服务端的 todayStr
  // 都必须是同一把**本地**尺。toISOString() 写的是 UTC，东八区凌晨时段截前 10 位
  // 拿到的是昨天的日期。
  assert.equal(dayOfLocal(new Date().toISOString()), todayStr(), '同一刻的两种取法必须一致')
  // 纯日期串原样返回——不按 UTC 午夜重新解释，否则负偏移时区会把 09-17 退回 09-16
  assert.equal(dayOfLocal('2026-09-17'), '2026-09-17')
  assert.equal(dayOfLocal(''), '')
  assert.equal(dayOfLocal(undefined), '')
  assert.equal(dayOfLocal(null), '')
  assert.equal(dayOfLocal('不是日期'), '不是日期'.slice(0, 10))
})

test('今天刚做完的进「本期完成」：周一早上不会因为它掉进上周而看不见', () => {
  // 复现真实故障：doneAt 是 UTC ISO，周一凌晨截前 10 位得到上周日的日期，
  // `day >= 本周一` 判假——今天做完的事一条都不报，报告里「完成 0」，
  // 而读者明明刚在面板上勾了勾。
  // 「今天」由**同一个时刻**推出，不让测试本身跨零点和实现抢时钟。
  const now = new Date()
  const t = dayOfLocal(now.toISOString())
  const plan = { nodes: [{ id: 'n1', title: '刚做完', status: 'done', doneAt: now.toISOString() }] }
  assert.deepEqual(idsOf(reportOf(plan, t, 'week').done), ['n1'], '本周窗口')
  assert.deepEqual(idsOf(reportOf(plan, t, 'day').done), ['n1'], '日窗口')
  assert.equal(reportOf(plan, t, 'week').empty, false)
})

// ---------------------------------------------------------------- 报告导出（Markdown）

test('reportMarkdown 周报：标题、摘要、段序与面板逐字一致', () => {
  const md = reportMarkdown(reportOf(reportPlan(), REPORT_TODAY, 'week'))
  // 标题：周报 + 期间（周一 → 周日）
  assert.ok(md.indexOf('# 周报 · ') === 0, md.split('\n')[0])
  assert.ok(md.indexOf('9月14日') >= 0, '期间起点是本周一')
  // 摘要行：完成 / 进行中 / 该做没做 / 落后于周期 / 本期到期 / 放弃 都在
  assert.ok(md.indexOf('- 完成 ') >= 0, md)
  assert.ok(md.indexOf(' · 进行中 ') >= 0, md)
  assert.ok(md.indexOf(' · 该做没做 ') >= 0, md)
  assert.ok(md.indexOf(' · 落后于周期 ') >= 0, md)
  assert.ok(md.indexOf(' · 本期到期 ') >= 0, md)
  assert.ok(md.indexOf(' · 放弃 ') >= 0, md)
  // 段序：完成 → 该做没做 → 落后 → 到期 → 进行中
  const idxOf = (s) => md.indexOf(s)
  assert.ok(idxOf('## 本期完成') < idxOf('## 该做没做'), '完成在前')
  assert.ok(idxOf('## 该做没做') < idxOf('## 落后于周期'), '逾期在落后之前')
  assert.ok(idxOf('## 落后于周期') < idxOf('## 本期到期'), '落后在到期之前')
  assert.ok(idxOf('## 本期到期') < idxOf('## 进行中'), '到期在进行中之前')
})

test('reportMarkdown 空段不写、段名与 UI 一致', () => {
  // 造一个只有完成段的报告——其余段必须完全不出现，而不是「## xx（0）」占一行。
  const rep = reportOf(reportPlan(), REPORT_TODAY, 'week')
  const onlyDone = Object.assign({}, rep, {
    overdue: [], behind: [], due: [], doing: [], dropped: 0,
  })
  const md = reportMarkdown(onlyDone)
  assert.ok(md.indexOf('## 本期完成') >= 0, '有数据的段要出现')
  assert.ok(md.indexOf('## 该做没做') < 0, '空段不该占行')
  assert.ok(md.indexOf('## 落后于周期') < 0, md)
  assert.ok(md.indexOf('## 本期到期') < 0, md)
  assert.ok(md.indexOf('## 进行中') < 0, md)
})

test('reportMarkdown 完成的行打勾、未完成的留空（读者一看就懂）', () => {
  const md = reportMarkdown(reportOf(reportPlan(), REPORT_TODAY, 'week'))
  assert.ok(md.indexOf('- [x] a2 · 今天做完的') >= 0, '完成的是 [x]')
  assert.ok(md.indexOf('- [ ] a6 · 欠着的') >= 0, '未完成的是 [ ]')
  assert.ok(md.indexOf('- [ ] a7 · 落后的') >= 0, '进行中的也是 [ ]')
})

test('reportMarkdown 把上下文路径、日期与委派一起写出来', () => {
  const md = reportMarkdown(reportOf(reportPlan(), REPORT_TODAY, 'week'))
  // 上下文路径是**标题链**（不是 id 链），去掉自己那段——与 UI 的 path 显示同源。
  assert.ok(md.indexOf('工作主线') >= 0, '父计划标题出现在行内')
  // 到期日期用 dayLabel 渲染（月日 周X）
  assert.ok(md.indexOf('9月20日') >= 0, '周日到期那条带日期')
})

test('reportMarkdown 落后段用百分比而不是原始小数（读者看得懂）', () => {
  // fixture 里 a7 的 pace.gap = 0.4 → 「落后 40%」
  const md = reportMarkdown(reportOf(reportPlan(), REPORT_TODAY, 'week'))
  assert.ok(md.indexOf('落后 40%') >= 0, md)
  assert.ok(md.indexOf('0.4') < 0, '不该出现原始小数')
})

test('reportMarkdown 带委派信息的条目把「委派给 X」写进行内', () => {
  const plan = {
    nodes: [{
      id: 'p1', title: '主计划', status: 'active',
      children: [{
        id: 'a1', title: '等小王接', status: 'todo', due: '2026-09-01', overdue: true,
        delegate: { to: '小王', status: 'accepted' },
      }],
    }],
  }
  const md = reportMarkdown(reportOf(plan, REPORT_TODAY, 'week'))
  assert.ok(md.indexOf('委派给 小王（已接受）') >= 0, md)
})

test('reportMarkdown 空报告也给出摘要（不是一份空文件）', () => {
  const md = reportMarkdown(reportOf({ nodes: [] }, REPORT_TODAY, 'week'))
  assert.ok(md.indexOf('# 周报 · ') === 0, md)
  assert.ok(md.indexOf('完成 0') >= 0, md)
})

test('reportMarkdown 对脏数据安全（null / 缺字段都不崩）', () => {
  assert.equal(reportMarkdown(null), '', 'null 直接返回空串')
  const md = reportMarkdown({ title: 'x', done: null, overdue: {}, doing: 'bad' })
  assert.ok(typeof md === 'string' && md.length > 0, '形状不对也要出文本')
  // 备注参数只在真的给了才追加——避免报告末尾多一条空分隔线。
  assert.ok(reportMarkdown({ title: 'x' }).indexOf('---') < 0, '没传 note 不加分隔线')
  assert.ok(reportMarkdown({ title: 'x' }, '这周重点做 A').indexOf('这周重点做 A') >= 0, '传了 note 会追加')
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

// ---------------------------------------------------------------- 详情表单

test('statusListOf 与 store.js 的口径一致（跨半身一致性）', () => {
  // host 是 ESM、client 是 CJS，两份状态清单只能各写一份。不一致的表现是
  // 「表单里选得到的状态，服务端说非法」——保存直接失败且看不懂为什么。
  assert.deepEqual(statusListOf('plan'), ['active', 'done', 'dropped'])
  assert.deepEqual(statusListOf('todo'), ['todo', 'doing', 'done', 'dropped'])
  assert.deepEqual(STATUS_LIST.plan, ['active', 'done', 'dropped'])
  assert.deepEqual(STATUS_LIST.todo, ['todo', 'doing', 'done', 'dropped'])
  assert.deepEqual(PRIORITIES, ['high', 'normal', 'low'])
})

test('formDraftOf 把节点摊平成标量，脏数据落回合法值', () => {
  const d = formDraftOf({
    id: 'n1', title: '主线', status: 'active', priority: 'high',
    owner: '我', start: '2026-01-01', end: '2026-12-31',
    metric: { target: 12, current: 3, unit: '个' },
    delegate: { to: '小李', expectAt: '2026-09-01' },
    children: [{ title: '子项', status: 'todo' }],
  })
  assert.equal(d.title, '主线')
  assert.equal(d.type, 'plan', '有子项 → 计划')
  assert.equal(d.status, 'active')
  assert.equal(d.owner, '我')
  assert.equal(d.target, '12')
  assert.equal(d.current, '3')
  assert.equal(d.unit, '个')
  assert.equal(d.to, '小李')
  assert.equal(d.expectAt, '2026-09-01')

  // 非法状态 / 缺省档位：不让它以原样进表单，否则保存时会被服务端拒绝。
  const bad = formDraftOf({ status: 'active' })
  assert.equal(bad.status, 'todo', '叶子（无子项）的 active 非法，落回 todo')
  assert.equal(bad.priority, 'normal', '缺 priority 按中档')
  assert.equal(formDraftOf({}).type, 'todo')
  assert.equal(formDraftOf(null).title, '')
})

test('formRequest：编辑时留空 = 清空（clear），新建时不产生 clear', () => {
  const original = {
    id: 'n1', type: 'todo', title: '旧标题', status: 'done', priority: 'high',
    owner: '我', due: '2026-06-01', note: '备注',
    metric: { target: 5, current: 1, unit: '个' },
    delegate: { to: '小李', status: 'pending' },
  }
  const draft = Object.assign(formDraftOf(original), {
    title: '新标题', owner: '', note: '', target: '', current: '', unit: '', to: '',
  })
  const req = formRequest(draft, original)
  assert.equal(req.method, 'node-set')
  assert.equal(req.body.node, 'n1')
  assert.equal(req.body.title, '新标题')
  // 周期与截止一并进 clear：写入不按类型分叉（计划用周期、待办用截止只是渲染
  // 与警告的口径），清空的空转由服务端 clearFields 按「本来就是空的」跳过。
  assert.deepEqual(req.body.clear.sort(), ['delegate', 'end', 'metric', 'note', 'owner', 'start'])
  assert.equal(req.body.due, '2026-06-01', '没清掉的照旧写入')
  assert.equal('owner' in req.body, false, '清空的字段不出现在写入里，只出现在 clear 里')

  // 没改状态的「已完成」不能被顺手改掉：状态每次都由表单显式提交。
  assert.equal(req.body.status, 'done')

  const fresh = formRequest(Object.assign(formDraftOf({ type: 'todo' }), { title: '新的' }), null)
  assert.equal(fresh.method, 'node-add')
  assert.equal(fresh.body.type, 'todo')
  assert.equal(fresh.body.title, '新的')
  assert.equal('clear' in fresh.body, false, '新建没什么可清的')
  assert.equal('node' in fresh.body, false)
})

test('formRequest：指标部分填写也要能提交（target/current/unit 各自独立）', () => {
  const original = { id: 'n1', type: 'todo', title: 't', status: 'todo', metric: { target: 10, current: 2, unit: '个' } }
  const draft = Object.assign(formDraftOf(original), { target: '20', current: '', unit: '篇' })
  const req = formRequest(draft, original)
  assert.deepEqual(req.body.metric, { target: 20, unit: '篇' }, '只传填了的，不传空串')
  assert.ok(!(req.body.clear || []).includes('metric'))
})

test('formErrors 只拦「写下去一定是错的」那几种', () => {
  assert.deepEqual(formErrors({ title: '有标题', start: '2026-01-01', end: '2026-12-31' }), [])
  assert.deepEqual(formErrors({ title: '   ' }), ['标题不能为空'])
  assert.deepEqual(formErrors({ title: 'x', start: '2026-06-01', end: '2026-01-01' }), ['结束日期早于开始日期'])
  // 缺负责人 / 缺截止这类是**建议**，不是错误——硬拦会让人干脆不记。
  assert.deepEqual(formErrors({ title: 'x', owner: '', due: '' }), [])
})

test('emptyDraft 一律新建叶子（待办），带父节点', () => {
  assert.equal(emptyDraft('todo', 'p1').parent, 'p1')
  assert.equal(emptyDraft().type, 'todo', '新建没有「计划」选项：挂上子项它自然成为计划')
  assert.equal(emptyDraft('plan').type, 'todo', 'type 参数被忽略')
  assert.equal(emptyDraft('plan').parent, '')
})

// ---------------------------------------------------------------- 执行清单（MLO TODO 视图）

const todoFixture = () => ({
  schema: 2, version: 1, nodes: [
    {
      id: 'p1', type: 'plan', title: '主线', status: 'active', children: [
        { id: 'a', type: 'todo', title: '普通活', status: 'todo', due: '2026-09-20' },
        { id: 'b', type: 'todo', title: '高优活', status: 'todo', priority: 'high', due: '2026-09-25' },
        { id: 'c', type: 'todo', title: '逾期活', status: 'todo', due: '2026-09-01' },
        { id: 'd', type: 'todo', title: '星标活', status: 'todo', due: '2026-09-30', starred: true },
        { id: 'e', type: 'todo', title: '被挡的', status: 'todo', blockedBy: ['a'] },
        { id: 'f', type: 'todo', title: '做完的', status: 'done' },
      ],
    },
    { id: 'g', type: 'todo', title: '收件箱的一条', status: 'todo' },
  ],
})

test('todoList：跨分支聚合「现在能做的」，星标 > 高优 > 逾期', () => {
  const { open, blocked } = todoList(todoFixture(), '2026-09-15')
  const titles = open.map((x) => x.node.title)
  // 星标永远最前；同组内高优先于普通；逾期按 band 排在最前面的一组里。
  assert.deepEqual(titles, ['星标活', '高优活', '逾期活', '普通活', '收件箱的一条'])
  // 做完的不出现；被挡的不在「现在能做」里。
  assert.equal(titles.includes('做完的'), false)
  assert.equal(blocked.length, 1)
  assert.equal(blocked[0].node.title, '被挡的')
  assert.deepEqual(blocked[0].blockers, ['普通活'], '被谁挡要说得出名字（不是 id）')
})

test('blockersOf 与 store 的口径一致：完成解锁、撤回重挡', () => {
  const plan = todoFixture()
  const e = plan.nodes[0].children.find((n) => n.id === 'e')
  assert.deepEqual(blockersOf(plan, e).map((n) => n.title), ['普通活'])
  plan.nodes[0].children.find((n) => n.id === 'a').status = 'done'
  assert.equal(blockersOf(plan, e).length, 0)
})

test('matchTaskTitles：AI 给的标题能反查任务，对不上的标 ok:false', () => {
  const plan = todoFixture()
  const r = matchTaskTitles(plan, ['高优活', '高优', '不存在的活'])
  assert.equal(r[0].ok, true)
  assert.equal(r[0].id, 'b')
  assert.equal(r[1].ok, true, '互相包含也算命中')
  assert.equal(r[1].id, 'b', '取最长的那条，避免「活」命中一堆')
  assert.equal(r[2].ok, false, '对不上的要让人看得见，而不是悄悄丢掉')
  assert.equal(r[2].id, null)
})

test('自定义视图：存取走 localStorage（本机偏好），viewItems 剔除做完的', () => {
  const store = new Map()
  globalThis.window = { localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)) },
  } }
  try {
    assert.deepEqual(loadViews(), [])
    saveViews([{ name: '明天在家', ids: ['b', 'f', 'zz'] }])
    const views = loadViews()
    assert.equal(views.length, 1)
    assert.deepEqual(views[0].ids, ['b', 'f', 'zz'])

    const items = viewItems(todoFixture(), views[0].ids)
    assert.deepEqual(items.map((n) => n.id), ['b'], '做完的（f）与不存在的（zz）自动剔除')

    // 存不下（隐私模式）不抛：视图是锦上添花，不值得为它弄崩面板。
    globalThis.window.localStorage.setItem = () => { throw new Error('quota') }
    saveViews([{ name: 'x', ids: [] }])
    assert.equal(loadViews().length, 1)
  } finally {
    delete globalThis.window
  }
})

// -------------------------------------------------- 未来日程（Things 3 式 Upcoming）

/** 一份带服务端标注（overdue / dueSoon）的日程 fixture：逾期 + 三天 + 一条已完成。 */
function schedulePlan() {
  return {
    nodes: [
      {
        id: 'p1', type: 'plan', status: 'active', overdue: false, dueSoon: false,
        children: [
          { id: 'a', type: 'todo', title: '拖了很久的', status: 'todo', due: '2026-09-10', overdue: true, dueSoon: false },
          { id: 'b', type: 'todo', title: '今天的事', status: 'todo', due: '2026-09-17', overdue: false, dueSoon: true },
          { id: 'c', type: 'todo', title: '高优先的', status: 'todo', priority: 'high', due: '2026-09-19', overdue: false, dueSoon: true },
          { id: 'd', type: 'todo', title: '星标的', status: 'todo', starred: true, due: '2026-09-19', overdue: false, dueSoon: true },
          { id: 'e', type: 'todo', title: '下周的', status: 'todo', due: '2026-09-23', overdue: false, dueSoon: true },
          { id: 'f', type: 'todo', title: '已完成的', status: 'done', due: '2026-09-18', overdue: false, dueSoon: true },
          { id: 'g', type: 'todo', title: '还早的', status: 'todo', due: '2026-10-30', overdue: false, dueSoon: false },
        ],
      },
    ],
  }
}

test('upcomingByDay：逾期滚入「今天」组，其余按天分组，只含有事项的天', () => {
  const r = upcomingByDay(schedulePlan(), '2026-09-17')
  // 逾期项 'a' 不再单独成段，而是滚进今天组，与今天到期 'b' 同组；逾期 o=0 排最前。
  assert.deepEqual(r.days.map((d) => d.date), ['2026-09-17', '2026-09-19', '2026-09-23'],
    '空天不占一行（9-18 已完成的被排除后就是空的）')
  assert.equal(r.days[0].label, '9月17日 周四')
  assert.deepEqual(r.days[0].items.map((x) => x.node.id), ['a', 'b'],
    '逾期滚入今日组（a），与今天到期（b）同组；逾期排最前')
  assert.deepEqual(r.days[1].items.map((x) => x.node.id), ['d', 'c'], '天内：星标 > 高优先')
  // 已完成的不进来：这是「未来要做的」，不是账本。
  assert.ok(!JSON.stringify(r.days).includes('已完成的'))
  // 10-30 超出 7 天窗口（服务端 dueSoon 为 false）。
  assert.ok(!JSON.stringify(r).includes('还早的'))
})

test('upcomingByDay：容器用 end 当日期；没有任何标注时本地兜底判逾期并滚入今日', () => {
  const plan = {
    nodes: [
      { id: 'c1', type: 'plan', status: 'active', end: '2026-09-20', dueSoon: true, overdue: false, children: [{ id: 'k', type: 'todo', title: 'x' }] },
      { id: 'x1', type: 'todo', title: '没标注但确实过期了', status: 'todo', due: '2026-09-01' },
    ],
  }
  const r = upcomingByDay(plan, '2026-09-17')
  assert.deepEqual(r.days[0].items.map((x) => x.node.id), ['x1'],
    '服务端没给 overdue 时按 due 兜底，且滚入今日组（不再有 r.overdue 段）')
  assert.equal(r.days[1].date, '2026-09-20')
  assert.deepEqual(r.days[1].items.map((x) => x.node.id), ['c1'])
})

test('deferDate：明天 +1；下周=下一个周一（周一则 +7，绝不回到今天）；非法返回空', () => {
  // 锚点：2026-09-21 是周一，2026-09-17 是周四，2026-09-20 是周日。
  assert.equal(deferDate('2026-09-17', 'tomorrow'), '2026-09-18', '明天 = base+1')
  assert.equal(deferDate('2026-09-17', 'nextweek'), '2026-09-21', '周四 → 下一个周一（+4）')
  assert.equal(deferDate('2026-09-20', 'nextweek'), '2026-09-21', '周日 → 周一（+1）')
  assert.equal(deferDate('2026-09-21', 'nextweek'), '2026-09-28', '周一本身 → 顺延 7 天，绝不回到今天')
  assert.equal(deferDate('2026-09-19', 'nextweek'), '2026-09-21', '周六 → 周一（+2）')
  assert.equal(deferDate('格式不对', 'tomorrow'), '', '非法 base 返回空')
  assert.equal(deferDate('2026-09-17', 'bogus'), '', '未知 kind 返回空')
})

test('dayLabel 按日格式化成「几月几日 周几」，脏日期原样返回', () => {
  assert.equal(dayLabel('2026-09-17'), '9月17日 周四')
  assert.equal(dayLabel('2026-01-04'), '1月4日 周日')
  assert.equal(dayLabel('乱七八糟'), '乱七八糟')
})

test('duplicateGroupsOf：只报标题完全一样的，忽略大小写与标点，done/dropped 不参与', () => {
  // 用户截图里那两条「去长安应急指挥中心进行验收」就是它要抓的东西。
  // 判据必须**严格**（去掉空白标点后完全相等）：模糊匹配会把沾边的两条并到一起，
  // 那是猜不是判，而猜错了会让人把两件不同的事合成一件。
  const plan = {
    nodes: [
      { id: 'a', type: 'todo', title: '去长安应急指挥中心进行验收', status: 'todo', due: '2026-09-22' },
      { id: 'b', type: 'todo', title: '去长安应急指挥中心 进行验收。', status: 'todo' },
      { id: 'c', type: 'todo', title: '  去长安应急指挥中心进行验收  ', status: 'todo', due: '2026-09-25' },
      { id: 'd', type: 'todo', title: '去东北局验收', status: 'todo' },
      { id: 'e', type: 'todo', title: '去东北局验收', status: 'done' },
    ],
  }
  const groups = duplicateGroupsOf(plan)
  assert.equal(groups.length, 1, '只有第一组算重复（e 已完成，不参与）')
  const g = groups[0]
  assert.equal(g.folds.length, 2, '三条里留一条、并两条')
  assert.equal(g.keepId, 'a', '留信息多的那条（有截止）')
  assert.equal(g.local, true, '这是客户端本地查出来的')
  assert.equal(g.patch.due, undefined, '保留那条自己有截止，就不该被别人的覆盖')
})

test('duplicateGroupsOf：保留那条缺的字段从重复项里补上，别在合并时静默丢掉', () => {
  // 「只有另一条填了截止」这种情况，合并只搬子项/证据的话会把截止弄没——
  // 而界面上没有任何迹象。所以缺什么补什么。
  const plan = {
    nodes: [
      { id: 'a', type: 'todo', title: '同一件事', status: 'todo' },
      { id: 'b', type: 'todo', title: '同一件事', status: 'todo', due: '2026-10-01', priority: 'high', note: '打电话' },
    ],
  }
  const g = duplicateGroupsOf(plan)[0]
  assert.equal(g.keepId, 'b', '信息多的那条被留下')
  assert.deepEqual(g.folds, [{ id: 'a', title: '同一件事' }])
  assert.deepEqual(g.patch, {}, '留下的那条什么都不缺')

  const reversed = duplicateGroupsOf({
    nodes: [
      { id: 'a', type: 'todo', title: '同一件事', status: 'todo', due: '2026-10-01' },
      { id: 'b', type: 'todo', title: '同一件事', status: 'todo' },
    ],
  })[0]
  assert.equal(reversed.keepId, 'a')
  assert.deepEqual(reversed.patch, {})
})

test('duplicateGroupsOf：标题空、单条、跨层级都不误报', () => {
  const plan = {
    nodes: [
      { id: 'p', type: 'plan', title: '计划甲', status: 'active', children: [
        { id: 'x', type: 'todo', title: '子任务', status: 'todo' },
      ] },
      { id: 'y', type: 'todo', title: '子任务', status: 'todo' },
      { id: 'z', type: 'todo', title: '   ', status: 'todo' },
      { id: 'w', type: 'todo', title: '', status: 'todo' },
    ],
  }
  const groups = duplicateGroupsOf(plan)
  assert.equal(groups.length, 1, '跨层级的同名也算重复（它们确实是同一件事记了两遍）')
  assert.equal(groups[0].keepId, 'x', '有子项的那条（score 高）被留下')
})
