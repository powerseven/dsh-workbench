/**
 * dsh-workbench —— 计划数据层（Host 半身，纯 ESM，无外部依赖）。
 *
 * 存储布局（全部位于「当前会话的工作区根目录」之下）：
 *
 *   <workspace>/plan/plan.json      结构化真相（唯一可写源）
 *   <workspace>/plan/PLAN.md        由 plan.json 生成的只读视图（给人看 / 进 git diff）
 *   <workspace>/plan/.versions/     每次变更前的快照（版本留档）
 *
 * 为什么是「JSON 为真相 + Markdown 为视图」而不是直接编辑 Markdown：
 * 计划是一棵需要被程序增删改查的树（进度汇总、按 id 定位、版本回滚）。
 * 直接解析 Markdown 需要一套稳健的解析器，而任何格式漂移都会静默丢数据；
 * 反过来只存 JSON 又失去了人可读、可 diff、可被 agent 直接读懂的好处。
 * 双表示各取所长：写入永远走结构化路径（有校验），阅读与 git diff 走 Markdown。
 *
 * 版本留档独立于 git：即使这个目录没被 commit、或用户根本不用 git，
 * 每次变更前的快照依然留在 .versions/ 里，可回滚。
 *
 * 关于「待办 / 计划 / 子计划 / 委派」四条主线（见 docs/PRD.md）：
 * 本文件是它们的**唯一写入路径**——面板（HTTP 面）与 agent 工具都调用这里
 * 的函数，不各自再写一套。三个新增概念全部是**可选字段**：
 *
 *   priority   重要程度 high | normal | low —— 决定这个节点要走多少流程
 *   delegate   委派 { to, at, expectAt, status } —— 带回执，不是一次性指派
 *   doneAt     完成时间戳 —— 所有「本周做了什么」类统计的上游
 *   inbox      收件箱：不挂任何计划的根级待办
 *
 * 缺省行为与加字段之前完全一致：没写 priority 就当 normal，没写 delegate
 * 就当没委派，没有 inbox 就当空数组。老 plan.json 不需要迁移。
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const PLAN_DIR = 'plan'
export const PLAN_FILE = 'plan.json'
export const VIEW_FILE = 'PLAN.md'
export const VERSIONS_DIR = '.versions'

/** 任务状态取值。todo=待办, doing=进行中, done=已完成, dropped=已放弃。 */
export const TASK_STATUS = ['todo', 'doing', 'done', 'dropped']
/** 目标/关键结果状态取值。 */
export const NODE_STATUS = ['active', 'done', 'dropped']
/**
 * 重要程度取值（存英文枚举、界面显示中文，程序判断才稳定）。
 * 它不是彩色标签，而是**管控强度开关**：
 *   high   必须有周期与负责人；进度要更新；落后要预警；完成要证据
 *   normal 要有截止；到期提醒
 *   low    只记录，不催
 * 默认 normal——如果默认 high，人人都标 high，管控机制立刻失效。
 */
export const PRIORITY = ['high', 'normal', 'low']
export const DEFAULT_PRIORITY = 'normal'
/** 委派回执状态：pending=待接受, accepted=已接受, declined=已拒绝, returned=已交回。 */
export const DELEGATE_STATUS = ['pending', 'accepted', 'declined', 'returned']
/** 节点种类：goal=计划（顶层）、kr=子计划、task=计划下的待办、inbox=不挂计划的待办。 */
export const NODE_KIND = ['goal', 'kr', 'task', 'inbox']
/** 中文标签，只用于「给人看的文本」（PLAN.md、工具输出文案），不参与程序判断。 */
export const PRIORITY_LABEL = { high: '高', normal: '中', low: '低' }
export const DELEGATE_LABEL = { pending: '待接受', accepted: '已接受', declined: '已拒绝', returned: '已交回' }
export const KIND_LABEL = { goal: '计划', kr: '子计划', task: '待办', inbox: '收件箱待办' }

/** 今天的日期（YYYY-MM-DD，本地时区）。逾期判定统一走它，便于测试注入。 */
export function todayStr(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return d.getFullYear() + '-' + m + '-' + day
}

/** 取一个非空字符串，否则 undefined（避免把空串写进 plan.json）。 */
function opt(v) {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
}

/** 数值夹取到 [0,1]。 */
function clamp01(n) {
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

/** 生成一个带前缀的自增 id（g1/k1/t1…），扫描全树保证不撞。 */
export function nextId(plan, prefix) {
  let max = 0
  const consider = (id) => {
    if (typeof id !== 'string' || !id.startsWith(prefix)) return
    const n = Number(id.slice(prefix.length))
    if (Number.isInteger(n) && n > max) max = n
  }
  // 收件箱里的待办与 KR 下的待办共用 t 前缀，编号必须一起扫——
  // 否则「收件箱有 t1」时新建的任务会重号，按 id 定位就会指错节点。
  for (const todo of plan.inbox ?? []) consider(todo.id)
  for (const goal of plan.goals ?? []) {
    consider(goal.id)
    for (const kr of goal.krs ?? []) {
      consider(kr.id)
      for (const task of kr.tasks ?? []) consider(task.id)
    }
  }
  return prefix + String(max + 1)
}

/** 一份空计划。 */
export function emptyPlan(title = '个人工作计划') {
  return {
    // 从 0 起：第一次 save 自增为 v1。
    version: 0,
    title,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    goals: [],
    inbox: [],
  }
}

/**
 * 把从磁盘读到的计划补齐成完整形态（只在内存里补，不写盘）。
 * 目前只补 `inbox`，这样上层可以无条件 `plan.inbox.forEach`，
 * 而不必到处写 `?? []`。
 */
export function normalizePlan(plan) {
  if (plan === null || typeof plan !== 'object') throw new Error('计划必须是对象')
  if (!Array.isArray(plan.goals)) throw new Error('计划缺少 goals 数组')
  if (!Array.isArray(plan.inbox)) plan.inbox = []
  return plan
}

/**
 * 单个关键结果的完成度：
 *   1. 声明了 target（>0）时按 current/target 计算——这是「量化 KR」；
 *   2. 否则按任务的完成比例计算——这是「清单 KR」；
 *   3. 都没有时，done 记 1，其余记 0。
 */
export function krProgress(kr) {
  if (Number.isFinite(kr.target) && kr.target > 0) {
    return clamp01((Number(kr.current) || 0) / kr.target)
  }
  const tasks = kr.tasks ?? []
  if (tasks.length === 0) return kr.status === 'done' ? 1 : 0
  const done = tasks.filter((t) => t.status === 'done').length
  return done / tasks.length
}

/** 目标完成度 = 其下所有 KR 完成度的算术平均；无 KR 时按自身状态。 */
export function goalProgress(goal) {
  const krs = goal.krs ?? []
  if (krs.length === 0) return goal.status === 'done' ? 1 : 0
  const sum = krs.reduce((acc, kr) => acc + krProgress(kr), 0)
  return sum / krs.length
}

/** 全计划完成度 = 所有目标完成度的平均。 */
export function planProgress(plan) {
  const goals = plan.goals ?? []
  if (goals.length === 0) return 0
  return goals.reduce((acc, g) => acc + goalProgress(g), 0) / goals.length
}

// ------------------------------------------------- 重要程度 / 时间戳 / 委派

/** 读重要程度，缺失或脏值一律当 normal——老数据因此零迁移。 */
export function priorityOf(node) {
  const p = node === null || node === undefined ? undefined : node.priority
  return PRIORITY.includes(p) ? p : DEFAULT_PRIORITY
}

/** 写重要程度（校验取值）。面板的徽章循环、工具参数都走这里。 */
export function setPriority(node, priority) {
  const p = opt(priority)
  if (p === undefined || !PRIORITY.includes(p)) {
    throw new Error('priority 必须是 ' + PRIORITY.join(' / ') + ' 之一，收到：' + String(priority))
  }
  node.priority = p
  return node
}

/** 重要程度徽章点击时的循环顺序：高 → 中 → 低 → 高。 */
export function nextPriority(priority) {
  const list = ['high', 'normal', 'low']
  const i = list.indexOf(priorityOf({ priority }))
  return list[(i + 1) % list.length]
}

/**
 * 改状态，并顺带维护两个时间戳：
 *   - 进入 done 时补 `doneAt`（只在首次写入，重复 save 不会把时间刷新成「刚刚」）；
 *   - 离开 done 时删掉 `doneAt`——否则它会在周报里继续被当成「本周完成」；
 *   - 首次进入 doing 时补 `startedAt`，之后保持第一次的时间。
 * 这两个时间戳是所有时间维度统计的上游（见 docs/PRD.md FR-R2）。
 */
export function applyStatus(node, status, now = new Date()) {
  node.status = status
  const iso = (now instanceof Date ? now : new Date(now)).toISOString()
  if (status === 'done') {
    if (opt(node.doneAt) === undefined) node.doneAt = iso
  } else if (node.doneAt !== undefined) {
    delete node.doneAt
  }
  if (status === 'doing' && opt(node.startedAt) === undefined) node.startedAt = iso
  return node
}

/**
 * 建/改委派。重新委派会把回执状态重置为 pending，并把委派时间刷成现在——
 * 换人意味着上一轮的回执作废，留着旧的 accepted 会让人误以为对方已接单。
 */
export function setDelegate(node, input, now = new Date()) {
  const to = opt(input?.to)
  if (to === undefined) throw new Error('委派对象不能为空（to）')
  const d = {
    to,
    at: (now instanceof Date ? now : new Date(now)).toISOString(),
    status: 'pending',
  }
  const expectAt = opt(input?.expectAt)
  if (expectAt !== undefined) d.expectAt = expectAt
  const note = opt(input?.note)
  if (note !== undefined) d.note = note
  node.delegate = d
  return node
}

/** 记一次回执（对方接受了/拒绝了/交回来了）。没有委派记录时报错，避免写出半截数据。 */
export function setReceipt(node, status, input = {}, now = new Date()) {
  const d = node?.delegate
  if (d === null || d === undefined || typeof d !== 'object' || opt(d.to) === undefined) {
    throw new Error('这个节点还没有委派记录，先建立委派再记回执')
  }
  const s = opt(status)
  if (s === undefined || !DELEGATE_STATUS.includes(s)) {
    throw new Error('回执状态必须是 ' + DELEGATE_STATUS.join(' / ') + ' 之一，收到：' + String(status))
  }
  d.status = s
  d.receiptAt = (now instanceof Date ? now : new Date(now)).toISOString()
  const note = opt(input?.note)
  if (note !== undefined) d.note = note
  const expectAt = opt(input?.expectAt)
  if (expectAt !== undefined) d.expectAt = expectAt
  return node
}

/**
 * 把委派整理成可判断的形态（给面板与 agent 用）。
 * 两个逾期标记分开算，因为它们该触发不同动作：
 *   overdueReceipt 未回执且过了期望时间 → 该去问一句「接不接」；
 *   overdueWork    已逾期且事情没做完   → 该去催进度。
 */
export function delegateState(node, today = todayStr()) {
  const d = node === null || node === undefined ? undefined : node.delegate
  if (d === null || d === undefined || typeof d !== 'object' || opt(d.to) === undefined) return null
  const expectAt = opt(d.expectAt)
  const settled = node.status === 'done' || node.status === 'dropped'
  const late = expectAt !== undefined && expectAt < today
  const status = DELEGATE_STATUS.includes(d.status) ? d.status : 'pending'
  return {
    to: String(d.to),
    status,
    at: opt(d.at) ?? null,
    expectAt: expectAt ?? null,
    overdueReceipt: late && !settled && status === 'pending',
    overdueWork: late && !settled,
  }
}

/**
 * 管控校验：按重要程度检查这个节点是否缺必备信息。
 *
 * 返回**警告而不是拦下**，这是有意的：产品目标是「记下来」的成本趋近于零
 * （见 PRD §2）。在捕获的那一刻就硬拦，会让人干脆不记。所以：先记下来，
 * 面板与 agent 把缺口指出来，再由人补。
 *
 * 「负责人」只对计划节点（goal/kr）要求——待办默认就是自己负责，
 * 若硬要求填负责人，每一条高优先级待办都会报警告，警告随即失去意义。
 */
export function nodeWarnings(node, kind = 'task') {
  const out = []
  const leaf = kind === 'task' || kind === 'inbox'
  const period = leaf ? opt(node?.due) : (opt(node?.end) ?? opt(node?.start))
  const owner = opt(node?.owner) ?? opt(node?.delegate?.to)
  const p = priorityOf(node)
  if (p === 'high') {
    if (period === undefined) out.push(leaf ? '重要度为「高」，需要截止日期' : '重要度为「高」，需要周期（起止）')
    if (!leaf && owner === undefined) out.push('重要度为「高」，需要负责人')
  } else if (p === 'normal' && period === undefined) {
    out.push(leaf ? '重要度为「中」，建议补一个截止日期' : '重要度为「中」，建议补一个结束日期')
  }
  const d = delegateState(node)
  if (d !== null && d.overdueReceipt) out.push('委派给 ' + d.to + ' 已逾期未回执')
  return out
}

/** 收集整棵树的节点（含收件箱），带种类与父节点。kind 传 'any' 表示全都要。 */
export function collectNodes(plan, kind = 'any') {
  const out = []
  if (kind === 'inbox' || kind === 'any') {
    for (const todo of plan.inbox ?? []) out.push({ node: todo, kind: 'inbox', parent: null })
  }
  for (const goal of plan.goals ?? []) {
    if (kind === 'goal' || kind === 'any') out.push({ node: goal, kind: 'goal', parent: null })
    for (const kr of goal.krs ?? []) {
      if (kind === 'kr' || kind === 'any') out.push({ node: kr, kind: 'kr', parent: goal })
      for (const task of kr.tasks ?? []) {
        if (kind === 'task' || kind === 'any') out.push({ node: task, kind: 'task', parent: kr })
      }
    }
  }
  return out
}

/**
 * 在整棵树里按 id / 标题定位一个节点，不限定它是什么种类。
 * 委派与重要程度要作用在「任意节点」上，所以需要它——三个 has* 工具
 * 各自一套定位逻辑的话，迟早会出现「有的工具能按标题找、有的不能」。
 */
export function resolveAny(plan, ref) {
  return resolveIn(collectNodes(plan, 'any'), ref, '节点')
}

/**
 * 「我委派出去的」清单：所有带委派的节点，逾期的排前面。
 * 这是 PRD FR-D4 的数据源——委派如果没有一个统一的视图，
 * 交代出去的事就会真的消失。
 */
export function delegatedList(plan, today = todayStr()) {
  const out = []
  for (const item of collectNodes(plan, 'any')) {
    const d = delegateState(item.node, today)
    if (d === null) continue
    out.push({
      id: item.node.id,
      kind: item.kind,
      title: item.node.title ?? '',
      parent: item.parent === null || item.parent === undefined ? null : item.parent.id,
      status: item.node.status ?? '',
      delegate: d,
    })
  }
  out.sort((a, b) => {
    const al = a.delegate.overdueReceipt || a.delegate.overdueWork ? 0 : 1
    const bl = b.delegate.overdueReceipt || b.delegate.overdueWork ? 0 : 1
    if (al !== bl) return al - bl
    return String(a.delegate.expectAt ?? '9999').localeCompare(String(b.delegate.expectAt ?? '9999'))
  })
  return out
}

/** 全计划任务计数（用于面板角标与进度条文案）。含收件箱里的游离待办。 */
export function taskCounts(plan) {
  const out = { todo: 0, doing: 0, done: 0, dropped: 0, total: 0, inbox: 0, inboxOpen: 0 }
  const count = (node) => {
    const s = TASK_STATUS.includes(node.status) ? node.status : 'todo'
    out[s] += 1
    out.total += 1
    return s
  }
  for (const todo of plan.inbox ?? []) {
    out.inbox += 1
    if (count(todo) !== 'done' && todo.status !== 'dropped') out.inboxOpen += 1
  }
  for (const goal of plan.goals ?? []) {
    for (const kr of goal.krs ?? []) {
      for (const task of kr.tasks ?? []) count(task)
    }
  }
  return out
}

/** 节点的「时间锚点」：待办看 due，计划看 end（退一步 start）。 */
export function anchorDate(node) {
  if (node === null || node === undefined) return undefined
  return opt(node.due) ?? opt(node.end) ?? opt(node.start)
}

/** 在 YYYY-MM-DD 上加天数，返回同格式字符串（用 UTC 运算避开时区夏令时）。 */
function addDays(day, n) {
  const t = Date.parse(day + 'T00:00:00Z')
  if (!Number.isFinite(t)) return undefined
  return new Date(t + n * 86400000).toISOString().slice(0, 10)
}

/**
 * 是否已逾期：未结束、且锚点日期已过，或委派已过期而事情没做完。
 * 已放弃/已完成一律不算逾期——否则「做完了」的项会一直在逾期列表里。
 */
export function isOverdue(node, today = todayStr()) {
  if (node === null || node === undefined || typeof node !== 'object') return false
  if (node.status === 'done' || node.status === 'dropped') return false
  const a = anchorDate(node)
  if (a !== undefined && a < today) return true
  const d = delegateState(node, today)
  return d !== null && d.overdueWork
}

/** 是否在 [今天, 今天+days] 内到期（含今天）。 */
export function isDueWithin(node, days = 7, today = todayStr()) {
  if (node === null || node === undefined || typeof node !== 'object') return false
  if (node.status === 'done' || node.status === 'dropped') return false
  const a = anchorDate(node)
  if (a === undefined) return false
  const limit = addDays(today, days)
  if (limit === undefined) return false
  return a >= today && a <= limit
}

/**
 * 管控视角的汇总（面板筛选条的角标、agent 的预警都用它）：
 *   high       未完成的「高」重要度节点数
 *   delegated  带委派的节点数
 *   overdue    逾期未完成数
 *   week       7 天内到期数
 *   warnings   存在管控缺口的节点数
 *   inboxOpen  收件箱里还没归位的待办数
 */
export function controlSummary(plan, today = todayStr()) {
  const nodes = collectNodes(plan, 'any')
  const open = nodes.filter((x) => x.node.status !== 'done' && x.node.status !== 'dropped')
  const counts = taskCounts(plan)
  return {
    high: open.filter((x) => priorityOf(x.node) === 'high').length,
    delegated: nodes.filter((x) => delegateState(x.node, today) !== null).length,
    overdue: open.filter((x) => isOverdue(x.node, today)).length,
    week: open.filter((x) => isDueWithin(x.node, 7, today)).length,
    warnings: nodes.filter((x) => nodeWarnings(x.node, x.kind).length > 0).length,
    inbox: counts.inbox,
    inboxOpen: counts.inboxOpen,
  }
}

const pct = (n) => String(Math.round(n * 100)) + '%'

/** 把计划渲染成 Markdown 视图。纯函数，便于测试。 */
export function renderMarkdown(plan) {
  /** 一个节点的附加标注（重要度 / 委派 / 完成时间）。 */
  const extraOf = (node) => {
    const out = []
    const p = priorityOf(node)
    if (p !== 'normal') out.push('重要度' + PRIORITY_LABEL[p])
    const d = delegateState(node)
    if (d !== null) {
      let s = '委派 ' + d.to + '（' + DELEGATE_LABEL[d.status] + (d.expectAt !== null ? '；期望 ' + d.expectAt : '') + '）'
      if (d.overdueReceipt) s += ' ⚠ 逾期未回执'
      out.push(s)
    }
    if (typeof node.doneAt === 'string' && node.doneAt !== '') out.push('完成于 ' + node.doneAt.slice(0, 10))
    return out
  }

  const lines = []
  lines.push('# ' + (plan.title || '个人工作计划'))
  lines.push('')
  lines.push('> 本文件由 dsh-workbench 从 `plan.json` 自动生成，请勿手工编辑——改动会在下次写入时被覆盖。')
  lines.push('')
  lines.push('- 计划版本：v' + String(plan.version ?? 1))
  lines.push('- 更新时间：' + String(plan.updatedAt ?? ''))
  lines.push('- 整体完成度：' + pct(planProgress(plan)))
  const c = taskCounts(plan)
  lines.push('- 任务：共 ' + String(c.total) + '，已完成 ' + String(c.done) + '，进行中 ' + String(c.doing) + '，待办 ' + String(c.todo))
  if (c.inbox > 0) {
    lines.push('- 收件箱：' + String(c.inbox) + ' 条（未完成 ' + String(c.inboxOpen) + '）')
  }
  const ctrl = controlSummary(plan)
  lines.push('- 管控：高重要度 ' + String(ctrl.high) + ' · 委派中 ' + String(ctrl.delegated)
    + ' · 逾期 ' + String(ctrl.overdue) + ' · 7 天内到期 ' + String(ctrl.week))
  if (ctrl.warnings > 0) lines.push('- 管控缺口：' + String(ctrl.warnings) + ' 处待补（见各节点标注）')
  lines.push('')

  for (const goal of plan.goals ?? []) {
    lines.push('## ' + goal.id + ' · ' + (goal.title || '(未命名目标)') + '  ' + pct(goalProgress(goal)))
    if (goal.owner) lines.push('- 负责人：' + goal.owner)
    if (goal.start || goal.end) lines.push('- 周期：' + (goal.start || '?') + ' ~ ' + (goal.end || '?'))
    if (goal.status && goal.status !== 'active') lines.push('- 状态：' + goal.status)
    const gExtra = extraOf(goal)
    if (gExtra.length > 0) lines.push('- ' + gExtra.join('；'))
    if (goal.note) lines.push('- 备注：' + goal.note)
    lines.push('')
    for (const kr of goal.krs ?? []) {
      const q = Number.isFinite(kr.target) && kr.target > 0
        ? '  ' + String(kr.current ?? 0) + '/' + String(kr.target) + (kr.unit ? ' ' + kr.unit : '')
        : ''
      lines.push('### ' + kr.id + ' · ' + (kr.title || '(未命名KR)') + '  ' + pct(krProgress(kr)) + q)
      if (kr.owner) lines.push('  - 负责人：' + kr.owner)
      if (kr.start || kr.end) lines.push('  - 周期：' + (kr.start || '?') + ' ~ ' + (kr.end || '?'))
      const kExtra = extraOf(kr)
      if (kExtra.length > 0) lines.push('  - ' + kExtra.join('；'))
      if (kr.note) lines.push('')
      if (kr.note) lines.push('  ' + kr.note)
      lines.push('')
      for (const task of kr.tasks ?? []) {
        const box = task.status === 'done' ? '[x]' : '[ ]'
        const bits = []
        if (task.status === 'doing') bits.push('进行中')
        if (task.status === 'dropped') bits.push('已放弃')
        if (task.due) bits.push('截止 ' + task.due)
        bits.push(...extraOf(task))
        lines.push('- ' + box + ' ' + task.id + ' · ' + (task.title || '(未命名任务)') + (bits.length ? '  _(' + bits.join('；') + ')_' : ''))
        if (task.note) lines.push('  - ' + task.note)
      }
      lines.push('')
    }
  }

  // 收件箱放在最后：先读计划、再读还没归位的东西。
  const inbox = plan.inbox ?? []
  if (inbox.length > 0) {
    lines.push('## 收件箱 · 未归类待办  ' + String(inbox.length) + ' 条')
    lines.push('')
    for (const todo of inbox) {
      const box = todo.status === 'done' ? '[x]' : '[ ]'
      const bits = []
      if (todo.status === 'doing') bits.push('进行中')
      if (todo.status === 'dropped') bits.push('已放弃')
      if (todo.due) bits.push('截止 ' + todo.due)
      bits.push(...extraOf(todo))
      lines.push('- ' + box + ' ' + todo.id + ' · ' + (todo.title || '(未命名待办)') + (bits.length ? '  _(' + bits.join('；') + ')_' : ''))
      if (todo.note) lines.push('  - ' + todo.note)
    }
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * 在给定候选集里按 id / 标题 / 唯一包含匹配定位一个节点。
 * 命中多个时报错而不是随便挑一个——静默挑错会让 agent 改错对象。
 */
function resolveIn(nodes, ref, label) {
  if (typeof ref !== 'string' || ref.trim() === '') {
    throw new Error('需要一个 ' + label + ' 的 id 或标题')
  }
  const needle = ref.trim()
  const lower = needle.toLowerCase()
  const byId = nodes.find((x) => x.node.id === needle)
  if (byId) return byId
  const byTitle = nodes.filter((x) => (x.node.title || '') === needle)
  if (byTitle.length === 1) return byTitle[0]
  if (byTitle.length > 1) throw new Error('标题「' + needle + '」匹配到多个 ' + label + '，请改用 id')
  const byFuzzy = nodes.filter((x) => (x.node.title || '').toLowerCase().includes(lower))
  if (byFuzzy.length === 1) return byFuzzy[0]
  if (byFuzzy.length > 1) throw new Error('「' + needle + '」模糊匹配到多个 ' + label + '，请改用 id')
  throw new Error('找不到 ' + label + '：' + needle)
}

/** 按种类定位节点（goal / kr / task / inbox）。 */
export function resolveRef(plan, ref, kind) {
  return resolveIn(collectNodes(plan, kind), ref, kind)
}

/** 一个计划文件（一个工作区一份）。 */
export class PlanStore {
  /** @param root 工作区根目录（通常来自会话 header 的 cwd）。 */
  constructor(root) {
    if (typeof root !== 'string' || root === '') throw new Error('PlanStore 需要一个工作区根目录')
    this.root = root
    this.dir = join(root, PLAN_DIR)
    this.file = join(this.dir, PLAN_FILE)
    this.view = join(this.dir, VIEW_FILE)
    this.versions = join(this.dir, VERSIONS_DIR)
  }

  /** 读取计划；文件不存在时返回一份空计划（不落盘，首次写入才创建）。 */
  async load() {
    if (!existsSync(this.file)) return emptyPlan()
    const raw = await readFile(this.file, 'utf8')
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      throw new Error('plan.json 不是合法 JSON（' + this.file + '）：' + (e instanceof Error ? e.message : String(e)))
    }
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.goals)) {
      throw new Error('plan.json 结构不合法：缺少 goals 数组（' + this.file + '）')
    }
    // 补 inbox（老文件没有这个键），只在内存里补，不写盘。
    return normalizePlan(parsed)
  }

  /**
   * 落盘：写 plan.json + 生成 PLAN.md。
   * @param plan 计划对象
   * @param opts.archive 是否在写入前归档当前磁盘版本（默认 true）
   * @param opts.reason 本次改动的原因，会记进 plan.lastReason
   */
  async save(plan, opts = {}) {
    const archive = opts.archive !== false
    if (archive && existsSync(this.file)) {
      // 归档标签取「被归档版本自己写入时的原因」（plan.lastReason），
      // 而不是本次改动的原因——否则标签描述的是即将发生的事，
      // 内容却是上一个版本，回溯时会看错。
      let prevReason = 'change'
      try {
        const prev = JSON.parse(await readFile(this.file, 'utf8'))
        if (prev !== null && typeof prev === 'object'
          && typeof prev.lastReason === 'string' && prev.lastReason !== '') {
          prevReason = prev.lastReason
        }
      } catch (e) {
        // 旧文件读不动不该阻断归档：退回通用标签即可。
      }
      await this.#archive(prevReason)
    }
    await mkdir(this.dir, { recursive: true })
    // 版本号在每次落盘时自增：它标识「第几次写入」，与 .versions/ 里的快照一一对应。
    plan.version = (Number.isInteger(plan.version) ? plan.version : 0) + 1
    plan.updatedAt = new Date().toISOString()
    if (typeof opts.reason === 'string' && opts.reason !== '') plan.lastReason = opts.reason
    await writeFile(this.file, JSON.stringify(plan, null, 2) + '\n', 'utf8')
    await writeFile(this.view, renderMarkdown(plan), 'utf8')
    return plan
  }

  /**
   * 把当前磁盘版本复制进 .versions/。文件名含时间戳与原因，天然按时间排序。
   * 同一毫秒内重复归档时追加序号，避免互相覆盖。
   */
  async #archive(reason) {
    await mkdir(this.versions, { recursive: true })
    // 只替换文件系统不安全字符，保留中文——否则中文留档原因会被整段抹成连字符。
    const safe = String(reason)
      .replace(/[/\\:*?"<>|\u0000-\u001f]/g, '-')
      .replace(/^[.\s]+/, '')
      .trim()
      .slice(0, 60) || 'change'
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const content = await readFile(this.file, 'utf8')
    let target = join(this.versions, stamp + '__' + safe + '.json')
    for (let n = 2; existsSync(target); n++) {
      target = join(this.versions, stamp + '__' + safe + '-' + n + '.json')
    }
    await writeFile(target, content, 'utf8')
    return target
  }

  /** 显式打一个快照（agent 或用户要求留档时用）。 */
  async snapshot(reason = 'manual') {
    if (!existsSync(this.file)) throw new Error('还没有计划可归档：' + this.file)
    return await this.#archive(reason)
  }

  /** 版本列表，最新在前。 */
  async history(limit = 50) {
    await mkdir(this.versions, { recursive: true })
    const names = (await readdir(this.versions)).filter((n) => n.endsWith('.json'))
    names.sort()
    names.reverse()
    return names.slice(0, limit).map((name) => {
      const parts = name.replace(/\.json$/, '').split('__')
      return { file: name, at: parts[0] ?? '', reason: parts[1] ?? '' }
    })
  }

  /** 回滚到某个历史版本（把当前版本也归档，所以回滚本身可撤销）。 */
  async restore(fileName) {
    const name = String(fileName)
    if (name.includes('/') || name.includes('\\') || name.includes('..')) {
      throw new Error('非法的版本文件名：' + name)
    }
    const target = join(this.versions, name)
    if (!existsSync(target)) throw new Error('版本不存在：' + name)
    await this.#archive('before-restore')
    const raw = await readFile(target, 'utf8')
    const plan = JSON.parse(raw)
    await mkdir(this.dir, { recursive: true })
    await writeFile(this.file, JSON.stringify(plan, null, 2) + '\n', 'utf8')
    await writeFile(this.view, renderMarkdown(plan), 'utf8')
    return plan
  }
}
