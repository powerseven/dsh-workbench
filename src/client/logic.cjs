/**
 * dsh-workbench —— 客户端纯逻辑（无 React / 无 DOM / 无 IO）。
 *
 * 该文件同时以两种方式使用：
 *   1. node:test 单元测试直接 require（本文件是 .cjs，不受 package.json
 *      "type": "module" 影响）；
 *   2. scripts/build.mjs 把它整体内联进 C6 bundle 工厂闭包，
 *      位于 src/client/index.js 之前，后者直接引用这里定义的函数。
 *
 * 底部条件导出只在 Node（测试）环境生效：bundle 里存在 window，
 * 导出被跳过，不影响工厂返回值。
 */

/** 0..1 → 百分比整数文案。 */
function pct(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '0%'
  var v = Math.round(n * 100)
  if (v < 0) v = 0
  if (v > 100) v = 100
  return v + '%'
}

/** 0..1 → 进度条宽度（CSS 百分比）。 */
function barWidth(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '0%'
  var v = Math.round(n * 100)
  if (v < 0) v = 0
  if (v > 100) v = 100
  return v + '%'
}

/** 任务状态 → 中文标签。未知状态按待办处理，不让脏数据把面板弄崩。 */
function statusLabel(status) {
  if (status === 'doing') return '进行中'
  if (status === 'done') return '已完成'
  if (status === 'dropped') return '已放弃'
  return '待办'
}

/**
 * 把一个任务列表按「未完成在前、已完成/放弃沉底」排序，同组内保持原顺序。
 * 返回新数组，不改动入参。
 */
function sortTasks(tasks) {
  var list = Array.isArray(tasks) ? tasks.slice() : []
  var open = []
  var closed = []
  for (var i = 0; i < list.length; i++) {
    var t = list[i]
    if (t !== null && typeof t === 'object' && (t.status === 'done' || t.status === 'dropped')) closed.push(t)
    else open.push(t)
  }
  return open.concat(closed)
}

/**
 * 计划概览统计。用于面板头部、tab 角标与筛选条。
 * 进度优先采用服务端算好的 `progress`；缺失时退回按任务完成比例估算。
 *
 * 收件箱里的游离待办计入 tasks/open/done——它们也是「待办」，
 * 不显示出来就等于记了没人看（这正是「收不进来」的另一种形态）。
 */
function summarize(plan) {
  var out = {
    goals: 0, krs: 0, tasks: 0, done: 0, open: 0, progress: 0, hasPlan: false,
    inbox: 0, inboxOpen: 0, warnings: 0, filters: {}
  }
  if (plan === null || plan === undefined || typeof plan !== 'object') return out
  var inbox = Array.isArray(plan.inbox) ? plan.inbox : []
  out.inbox = inbox.length
  for (var n = 0; n < inbox.length; n++) {
    if (Array.isArray(inbox[n].warnings) && inbox[n].warnings.length > 0) out.warnings++
    if (inbox[n].status === 'done') out.done++
    else if (inbox[n].status !== 'dropped') { out.open++; out.inboxOpen++ }
  }
  var goals = Array.isArray(plan.goals) ? plan.goals : []
  out.goals = goals.length
  out.hasPlan = goals.length > 0 || inbox.length > 0
  for (var i = 0; i < goals.length; i++) {
    if (Array.isArray(goals[i].warnings) && goals[i].warnings.length > 0) out.warnings++
    var krs = Array.isArray(goals[i].krs) ? goals[i].krs : []
    out.krs += krs.length
    for (var j = 0; j < krs.length; j++) {
      if (Array.isArray(krs[j].warnings) && krs[j].warnings.length > 0) out.warnings++
      var tasks = Array.isArray(krs[j].tasks) ? krs[j].tasks : []
      out.tasks += tasks.length
      for (var k = 0; k < tasks.length; k++) {
        if (Array.isArray(tasks[k].warnings) && tasks[k].warnings.length > 0) out.warnings++
        if (tasks[k].status === 'done') out.done++
        else if (tasks[k].status !== 'dropped') out.open++
      }
    }
  }
  if (typeof plan.progress === 'number' && isFinite(plan.progress)) {
    out.progress = plan.progress
  } else if (out.tasks > 0) {
    out.progress = out.done / out.tasks
  }
  out.filters = filterCounts(plan)
  return out
}

/** 下一个任务状态：点击复选框时在 待办 ↔ 已完成 之间切换。 */
function toggleStatus(status) {
  return status === 'done' ? 'todo' : 'done'
}

// ------------------------------------------------- 重要程度 / 委派 / 筛选

/** 重要程度 → 中文标签。缺省或脏值一律按「中」——与服务端 priorityOf 同语义。 */
function priorityLabel(priority) {
  if (priority === 'high') return '高'
  if (priority === 'low') return '低'
  return '中'
}

/** 重要程度排序权重：高在前。用于把「该管的」顶到列表上方。 */
function priorityRank(priority) {
  if (priority === 'high') return 0
  if (priority === 'low') return 2
  return 1
}

/**
 * 徽章点击时的循环顺序：高 → 中 → 低 → 高。
 * 必须与服务端 `store.js` 的 nextPriority 完全一致（缺省/脏值都按「中」处理）——
 * 两侧代码跨模块系统无法共享，靠 test/logic.test.mjs 的一条断言钉住这个约定。
 */
function nextPriority(priority) {
  if (priority === 'high') return 'normal'
  if (priority === 'low') return 'high'
  return 'low'
}

/** 回执状态 → 中文标签。 */
function delegateLabel(status) {
  if (status === 'accepted') return '已接受'
  if (status === 'declined') return '已拒绝'
  if (status === 'returned') return '已交回'
  return '待接受'
}

/**
 * 一个节点的委派展示文案，如「张三 · 待接受（期望 09-20）」。
 * 读服务端算好的 `delegateState`（逾期标记也在里面，不在这里重算一遍——
 * 逾期语义只有一处实现，见 src/store.js 的 delegateState）。
 */
function delegateText(node) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  var d = node.delegateState
  if (d === null || d === undefined || typeof d !== 'object') return null
  var out = String(d.to) + ' · ' + delegateLabel(d.status)
  if (typeof d.expectAt === 'string' && d.expectAt !== '') out += '（期望 ' + d.expectAt.slice(5) + '）'
  return out
}

/** 节点是否还没结束（未完成、未放弃）。 */
function isOpen(node) {
  if (node === null || node === undefined || typeof node !== 'object') return false
  return node.status !== 'done' && node.status !== 'dropped'
}

/**
 * 兜底逾期判定：只在服务端没给 `overdue` 标注时用。
 * 正常路径读服务端标注——逾期语义的唯一实现是 src/store.js 的 isOverdue。
 */
function overdueFallback(node, today) {
  var anchor = null
  if (typeof node.due === 'string' && node.due !== '') anchor = node.due
  else if (typeof node.end === 'string' && node.end !== '') anchor = node.end
  else if (typeof node.start === 'string' && node.start !== '') anchor = node.start
  return anchor !== null && anchor < today
}

/** 本地日期字符串，用于兜底判定与「本周」窗口。 */
function todayStr() {
  var d = new Date()
  var m = String(d.getMonth() + 1).padStart(2, '0')
  var day = String(d.getDate()).padStart(2, '0')
  return d.getFullYear() + '-' + m + '-' + day
}

/**
 * 把整棵树摊平成一维，带层级路径（如「g1 / k1」），供聚焦列表显示上下文。
 * 摊平是「筛选」视图的基础——筛选结果通常跨层级，树形结构反而不好读。
 */
function flattenNodes(plan) {
  var out = []
  if (plan === null || plan === undefined || typeof plan !== 'object') return out
  var inbox = Array.isArray(plan.inbox) ? plan.inbox : []
  for (var i = 0; i < inbox.length; i++) {
    out.push({ kind: 'inbox', node: inbox[i], path: '收件箱' })
  }
  var goals = Array.isArray(plan.goals) ? plan.goals : []
  for (var g = 0; g < goals.length; g++) {
    var goal = goals[g]
    out.push({ kind: 'goal', node: goal, path: goal.id })
    var krs = Array.isArray(goal.krs) ? goal.krs : []
    for (var k = 0; k < krs.length; k++) {
      var kr = krs[k]
      out.push({ kind: 'kr', node: kr, path: goal.id + ' / ' + kr.id })
      var tasks = Array.isArray(kr.tasks) ? kr.tasks : []
      for (var t = 0; t < tasks.length; t++) {
        out.push({ kind: 'task', node: tasks[t], path: goal.id + ' / ' + kr.id })
      }
    }
  }
  return out
}

/** 筛选器定义。id 传给 focusList，label 上芯片。 */
var FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'high', label: '重要度高' },
  { id: 'delegated', label: '我委派出去的' },
  { id: 'week', label: '本周到期' },
  { id: 'overdue', label: '逾期' }
]

/**
 * 聚焦列表：按筛选器挑出未结束的节点，并排序（逾期 → 重要度高 → 快到期的在前）。
 * `all` 返回空数组——全部视图走树形渲染，不走扁平列表。
 */
function focusList(plan, filterId, today) {
  if (typeof filterId !== 'string' || filterId === '' || filterId === 'all') return []
  var t = typeof today === 'string' && today !== '' ? today : todayStr()
  var out = []
  var nodes = flattenNodes(plan)
  for (var i = 0; i < nodes.length; i++) {
    var x = nodes[i]
    var n = x.node
    if (!isOpen(n)) continue
    if (filterId === 'high' && n.priority !== 'high') continue
    if (filterId === 'delegated' && (n.delegateState === null || n.delegateState === undefined)) continue
    if (filterId === 'week' && n.dueSoon !== true) continue
    if (filterId === 'overdue' && !(n.overdue === true || (n.overdue === undefined && overdueFallback(n, t)))) continue
    out.push(x)
  }
  var overdueOf = function (n) {
    return n.overdue === true || (n.overdue === undefined && overdueFallback(n, t))
  }
  out.sort(function (a, b) {
    var ao = overdueOf(a.node) ? 0 : 1
    var bo = overdueOf(b.node) ? 0 : 1
    if (ao !== bo) return ao - bo
    var ap = priorityRank(a.node.priority)
    var bp = priorityRank(b.node.priority)
    if (ap !== bp) return ap - bp
    var ad = a.node.dueSoon === true ? 0 : 1
    var bd = b.node.dueSoon === true ? 0 : 1
    return ad - bd
  })
  return out
}

/** 筛选器角标数字（0 不显示）。 */
function filterCounts(plan, today) {
  var out = {}
  for (var i = 0; i < FILTERS.length; i++) {
    var id = FILTERS[i].id
    if (id === 'all') continue
    out[id] = focusList(plan, id, today).length
  }
  return out
}

if (typeof window === 'undefined' && typeof module !== 'undefined' && module.exports) {
  module.exports = {
    pct: pct,
    barWidth: barWidth,
    statusLabel: statusLabel,
    sortTasks: sortTasks,
    summarize: summarize,
    toggleStatus: toggleStatus,
    priorityLabel: priorityLabel,
    priorityRank: priorityRank,
    nextPriority: nextPriority,
    delegateLabel: delegateLabel,
    delegateText: delegateText,
    isOpen: isOpen,
    todayStr: todayStr,
    flattenNodes: flattenNodes,
    FILTERS: FILTERS,
    focusList: focusList,
    filterCounts: filterCounts,
  }
}
