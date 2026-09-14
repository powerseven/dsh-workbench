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
 * 计划概览统计。用于面板头部与 tab 角标。
 * 进度优先采用服务端算好的 `progress`；缺失时退回按任务完成比例估算。
 */
function summarize(plan) {
  var out = { goals: 0, krs: 0, tasks: 0, done: 0, open: 0, progress: 0, hasPlan: false }
  if (plan === null || plan === undefined || typeof plan !== 'object') return out
  var goals = Array.isArray(plan.goals) ? plan.goals : []
  out.goals = goals.length
  out.hasPlan = goals.length > 0
  for (var i = 0; i < goals.length; i++) {
    var krs = Array.isArray(goals[i].krs) ? goals[i].krs : []
    out.krs += krs.length
    for (var j = 0; j < krs.length; j++) {
      var tasks = Array.isArray(krs[j].tasks) ? krs[j].tasks : []
      out.tasks += tasks.length
      for (var k = 0; k < tasks.length; k++) {
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
  return out
}

/** 下一个任务状态：点击复选框时在 待办 ↔ 已完成 之间切换。 */
function toggleStatus(status) {
  return status === 'done' ? 'todo' : 'done'
}

if (typeof window === 'undefined' && typeof module !== 'undefined' && module.exports) {
  module.exports = { pct: pct, barWidth: barWidth, statusLabel: statusLabel, sortTasks: sortTasks, summarize: summarize, toggleStatus: toggleStatus }
}
