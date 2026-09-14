/**
 * 客户端纯逻辑单元测试（node:test）。
 * logic.cjs 是 CommonJS，用 createRequire 直接加载——它刻意不依赖
 * React/DOM，所以可以在 Node 里测。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  pct, barWidth, statusLabel, sortTasks, summarize, toggleStatus,
  priorityLabel, priorityRank, nextPriority, delegateLabel, delegateText,
  isOpen, flattenNodes, FILTERS, focusList, filterCounts, todayStr,
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

test('statusLabel 覆盖四种状态且对未知值兜底', () => {
  assert.equal(statusLabel('todo'), '待办')
  assert.equal(statusLabel('doing'), '进行中')
  assert.equal(statusLabel('done'), '已完成')
  assert.equal(statusLabel('dropped'), '已放弃')
  assert.equal(statusLabel('乱写'), '待办')
  assert.equal(statusLabel(undefined), '待办')
})

test('sortTasks 把未完成排在前、已完成沉底', () => {
  const tasks = [
    { id: 't1', status: 'done' },
    { id: 't2', status: 'todo' },
    { id: 't3', status: 'dropped' },
    { id: 't4', status: 'doing' },
  ]
  assert.deepEqual(sortTasks(tasks).map((t) => t.id), ['t2', 't4', 't1', 't3'])
})

test('sortTasks 不改动入参', () => {
  const tasks = [{ id: 't1', status: 'done' }, { id: 't2', status: 'todo' }]
  const before = tasks.map((t) => t.id)
  sortTasks(tasks)
  assert.deepEqual(tasks.map((t) => t.id), before)
})

test('sortTasks 容忍非数组', () => {
  assert.deepEqual(sortTasks(undefined), [])
  assert.deepEqual(sortTasks(null), [])
})

test('summarize 统计目标/KR/任务与完成数', () => {
  const plan = {
    goals: [{
      krs: [
        { tasks: [{ status: 'done' }, { status: 'todo' }] },
        { tasks: [{ status: 'doing' }] },
      ],
    }],
  }
  const s = summarize(plan)
  assert.equal(s.goals, 1)
  assert.equal(s.krs, 2)
  assert.equal(s.tasks, 3)
  assert.equal(s.done, 1)
  assert.equal(s.open, 2, 'dropped 之外的未完成都算 open')
  assert.equal(s.hasPlan, true)
})

test('summarize 不计 dropped 为 open', () => {
  const plan = { goals: [{ krs: [{ tasks: [{ status: 'dropped' }, { status: 'todo' }] }] }] }
  assert.equal(summarize(plan).open, 1)
})

test('summarize 优先用服务端算好的 progress', () => {
  const plan = { progress: 0.42, goals: [{ krs: [{ tasks: [{ status: 'done' }] }] }] }
  assert.equal(summarize(plan).progress, 0.42)
})

test('summarize 在缺 progress 时按任务比例兜底', () => {
  const plan = { goals: [{ krs: [{ tasks: [{ status: 'done' }, { status: 'todo' }] }] }] }
  assert.equal(summarize(plan).progress, 0.5)
})

test('summarize 对空计划与脏数据安全', () => {
  assert.equal(summarize(null).hasPlan, false)
  assert.equal(summarize(null).goals, 0)
  assert.equal(summarize({}).hasPlan, false)
  assert.equal(summarize({ goals: 'nope' }).goals, 0)
  assert.equal(summarize({ goals: [{}] }).krs, 0)
})

test('toggleStatus 在待办与已完成之间切换', () => {
  assert.equal(toggleStatus('todo'), 'done')
  assert.equal(toggleStatus('done'), 'todo')
  assert.equal(toggleStatus('doing'), 'done')
  assert.equal(toggleStatus(undefined), 'done')
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

test('nextPriority 三段循环，与徽章点击顺序一致', () => {
  assert.equal(nextPriority('high'), 'normal')
  assert.equal(nextPriority('normal'), 'low')
  assert.equal(nextPriority('low'), 'high')
  assert.equal(nextPriority(undefined), 'low', '缺省/脏值按「中」处理，与服务端一致')
})

test('nextPriority 与 host 半身 store.js 的实现完全一致（跨半身约定）', async () => {
  const host = await import('../src/store.js')
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

test('isOpen 把已完成与已放弃都算作结束', () => {
  assert.equal(isOpen({ status: 'todo' }), true)
  assert.equal(isOpen({ status: 'doing' }), true)
  assert.equal(isOpen({ status: 'done' }), false)
  assert.equal(isOpen({ status: 'dropped' }), false)
  assert.equal(isOpen(null), false)
})

// ---------------------------------------------------------------- 摊平与筛选

/** 一份带完整服务端标注的样例计划（面板收到的就是这种形态）。 */
function annotatedPlan() {
  return {
    progress: 0.25,
    inbox: [
      { id: 't9', title: '游离待办', status: 'todo', priority: 'high', overdue: false, dueSoon: false, warnings: ['x'] },
    ],
    goals: [{
      id: 'g1',
      title: 'Q4 计划',
      status: 'active',
      priority: 'normal',
      warnings: [],
      overdue: false,
      dueSoon: false,
      krs: [
        {
          id: 'k1',
          title: '子计划',
          status: 'active',
          priority: 'normal',
          warnings: [],
          overdue: false,
          dueSoon: false,
          tasks: [
            { id: 't1', title: '逾期的', status: 'todo', priority: 'normal', overdue: true, dueSoon: false },
            {
              id: 't2',
              title: '委派出去的',
              status: 'doing',
              priority: 'high',
              overdue: false,
              dueSoon: true,
              delegateState: { to: '张三', status: 'pending', expectAt: '2026-09-18' },
            },
            { id: 't3', title: '已完成', status: 'done', priority: 'high', overdue: false, dueSoon: true },
            { id: 't4', title: '放弃的', status: 'dropped', priority: 'high', overdue: true, dueSoon: false },
          ],
        },
      ],
    }],
  }
}

test('flattenNodes 摊平整棵树并给出层级路径', () => {
  const nodes = flattenNodes(annotatedPlan())
  assert.deepEqual(nodes.map((x) => x.kind), ['inbox', 'goal', 'kr', 'task', 'task', 'task', 'task'])
  assert.equal(nodes[0].path, '收件箱')
  assert.equal(nodes[1].path, 'g1')
  assert.equal(nodes[2].path, 'g1 / k1')
  assert.equal(nodes[3].path, 'g1 / k1')
})

test('flattenNodes 对空计划与脏数据安全', () => {
  assert.deepEqual(flattenNodes(null), [])
  assert.deepEqual(flattenNodes({}), [])
  assert.equal(flattenNodes({ goals: [{ krs: 'nope' }] }).length, 1)
})

test('FILTERS 提供五个筛选项', () => {
  assert.deepEqual(FILTERS.map((f) => f.id), ['all', 'high', 'delegated', 'week', 'overdue'])
})

test('focusList 的 all 返回空数组（全部视图走树形渲染）', () => {
  assert.deepEqual(focusList(annotatedPlan(), 'all'), [])
  assert.deepEqual(focusList(annotatedPlan(), ''), [])
})

test('focusList 按重要度高筛选，且排除已结束的节点', () => {
  const ids = focusList(annotatedPlan(), 'high').map((x) => x.node.id)
  assert.deepEqual(ids, ['t2', 't9'], 't3 已完成、t4 已放弃，都不该出现')
})

test('focusList 按「我委派出去的」筛选', () => {
  const items = focusList(annotatedPlan(), 'delegated')
  assert.deepEqual(items.map((x) => x.node.id), ['t2'])
  assert.equal(items[0].path, 'g1 / k1')
})

test('focusList 按本周到期与逾期筛选', () => {
  assert.deepEqual(focusList(annotatedPlan(), 'week').map((x) => x.node.id), ['t2'])
  assert.deepEqual(focusList(annotatedPlan(), 'overdue').map((x) => x.node.id), ['t1'])
})

test('focusList 排序：逾期 → 重要度高 → 快到期的在前', () => {
  const plan = {
    goals: [{
      id: 'g1', status: 'active', krs: [{
        id: 'k1', status: 'active', tasks: [
          { id: 'a', title: '普通', status: 'todo', priority: 'normal' },
          { id: 'b', title: '高', status: 'todo', priority: 'high' },
          { id: 'c', title: '逾期', status: 'todo', priority: 'low', overdue: true },
          { id: 'd', title: '快到期的', status: 'todo', priority: 'normal', dueSoon: true },
        ],
      }],
    }],
  }
  assert.deepEqual(focusList(plan, 'high').map((x) => x.node.id), ['b'])
  const all = focusList(plan, 'overdue')
  assert.deepEqual(all.map((x) => x.node.id), ['c'])
})

test('focusList 在服务端没给 overdue 标注时本地兜底判定', () => {
  const plan = {
    goals: [{
      id: 'g1', status: 'active', krs: [{
        id: 'k1', status: 'active', tasks: [
          { id: 'a', title: '没有标注但已过期', status: 'todo', due: '2000-01-01' },
          { id: 'b', title: '没有标注也没过期', status: 'todo', due: '2999-01-01' },
        ],
      }],
    }],
  }
  assert.deepEqual(focusList(plan, 'overdue', '2026-09-14').map((x) => x.node.id), ['a'])
})

test('filterCounts 给出各筛选器的角标数（不含 all）', () => {
  const counts = filterCounts(annotatedPlan())
  assert.deepEqual(Object.keys(counts).sort(), ['delegated', 'high', 'overdue', 'week'])
  assert.equal(counts.high, 2)
  assert.equal(counts.delegated, 1)
  assert.equal(counts.overdue, 1)
  assert.equal(counts.week, 1)
})

test('todayStr 输出本地日期', () => {
  assert.match(todayStr(), /^\d{4}-\d{2}-\d{2}$/)
})

// ------------------------------------------------------------ summarize 扩展

test('summarize 把收件箱算进待办，并给出未归位数', () => {
  const s = summarize(annotatedPlan())
  assert.equal(s.inbox, 1)
  assert.equal(s.inboxOpen, 1)
  assert.equal(s.tasks, 4, '4 个任务')
  assert.equal(s.open, 3, '1 条收件箱 + t1/t2 未完成（t3 完成、t4 放弃）')
  assert.equal(s.done, 1)
  assert.equal(s.hasPlan, true)
})

test('summarize 统计管控缺口与筛选角标', () => {
  const s = summarize(annotatedPlan())
  assert.equal(s.warnings, 1, '收件箱那条带 warnings')
  assert.equal(s.filters.high, 2)
  assert.equal(s.filters.overdue, 1)
})

test('summarize 只有收件箱时也算「有内容」', () => {
  const s = summarize({ inbox: [{ id: 't1', title: 'x', status: 'todo' }] })
  assert.equal(s.hasPlan, true)
  assert.equal(s.goals, 0)
  assert.equal(s.open, 1)
})
