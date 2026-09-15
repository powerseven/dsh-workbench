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
 * ===========================================================================
 * 数据结构（schema 2）：一棵递归树
 * ===========================================================================
 *
 *   plan.nodes[]                 顶层节点。其中 type=todo 的就是「收件箱」——
 *                                还没归位到任何计划下的待办（见 docs/SCOPE.md）。
 *   node.type   'plan' | 'todo'  plan 可挂 children（深度不限），todo 是叶子。
 *   node.children[]              只有 plan 有。子计划 = plan 嵌 plan。
 *
 * **为什么从「固定三层」改成「递归树」**：三层表达不了「年度 → 季度 → 月度 →
 * 周」这类链条，也放不下「子计划里再分子计划」——这正是用户要的「可以分级」。
 * 递归树是同一个模型的自然表达，进度、定位、留档的算法反而退化成同一个递归，
 * 特例更少。待办与计划共用一套字段（重要程度、委派、备注），只是各自的
 * 时间字段与状态取值不同。
 *
 * **老数据怎么办**：schema 1（goals/krs/tasks + inbox）在**读取时**自动迁移，
 * 写入时落成新格式，用户不需要手工跑任何迁移脚本，也不会有一刻看到坏数据。
 * 迁移是**无损**的——老 id（g1 / k1 / t1）原样保留，因为历史会话消息与
 * .versions/ 里的快照都还在引用它们。新节点统一用 `n` 前缀，与老 id 不冲突。
 *
 * 横切概念全部是**可选字段**（缺省行为与加之前完全一致）：
 *
 *   priority   重要程度 high | normal | low —— 决定这个节点要走多少流程
 *   delegate   委派 { to, at, expectAt, status } —— 带回执，不是一次性指派
 *   doneAt     完成时间戳 —— 所有「本周做了什么」类统计的上游
 *   evidence[] 完成证据 { kind, ref, note?, at } —— 追加式，可核验的交付凭据
 *   metric     { target, current, unit } —— 可计数的节点按它算进度
 *
 * 派生量**不落盘**（NFR-2）：只要磁盘上有一份数据，派生量就只有一个算法能
 * 算出来，不会出现「面板显示的和服务端算的不一致」。
 *   progress   递归算出的完成度
 *   pace       配速（期望进度 vs 实际进度）与落后标记
 *   unverified 已完成但没有证据 —— 「AI 说它干完了」能不能被审查
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const PLAN_DIR = 'plan'
export const PLAN_FILE = 'plan.json'
export const VIEW_FILE = 'PLAN.md'
export const VERSIONS_DIR = '.versions'

/** 数据结构版本：1 = 老的三层树（goals/krs/tasks + inbox），2 = 递归树（nodes）。 */
export const SCHEMA = 2

/** 节点类型：plan=计划（可挂子项）、todo=待办（叶子）。 */
export const NODE_TYPE = ['plan', 'todo']
/** 计划的状态取值。 */
export const PLAN_STATUS = ['active', 'done', 'dropped']
/** 待办的状态取值。 */
export const TODO_STATUS = ['todo', 'doing', 'done', 'dropped']
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
/**
 * 落后阈值：期望进度领先实际进度这么多（15 个百分点）才算「落后」。
 *
 * 为什么不取「任何落后都报」：刚开工时（时间过了 5%、进度 0%）是正常状态，
 * 报出来人就会开始忽略这个标记——**被忽略的标记比没有标记更糟**，因为它
 * 同时消耗了「有标记 = 要处理」这个信任。15% 的含义是「时间过了一大半、
 * 进度还不到一半」这类真的需要调整的偏离。
 */
export const PACE_THRESHOLD = 0.15
/**
 * 完成证据的类型。**固定五种，不做「智能推断」**：
 * 推断会猜错（一个路径既可能是文件也可能是命令），而猜错比不猜更糟——
 * 上限是「记录」，下限是「记错」。agent 自己清楚产出的是文件还是命令，
 * 这类区分跟「这算 goal 还是 kr」那种人为区分是两回事。
 * 验证方式：只有 file 能机器判真假（查文件是否存在），其余四种只记录、
 * 不假装能核验（见 evidenceWarnings）。
 */
export const EVIDENCE_KIND = ['file', 'session', 'command', 'link', 'note']
/** 委派回执状态：pending=待接受, accepted=已接受, declined=已拒绝, returned=已交回。 */
export const DELEGATE_STATUS = ['pending', 'accepted', 'declined', 'returned']
/** 中文标签，只用于「给人看的文本」（PLAN.md、工具输出文案），不参与程序判断。 */
export const PRIORITY_LABEL = { high: '高', normal: '中', low: '低' }
export const DELEGATE_LABEL = { pending: '待接受', accepted: '已接受', declined: '已拒绝', returned: '已交回' }
export const TYPE_LABEL = { plan: '计划', todo: '待办' }
export const EVIDENCE_LABEL = { file: '文件', session: '会话', command: '命令', link: '链接', note: '说明' }

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

/** 节点类型。缺省当「待办」——叶子是更宽松的默认（计划会被要求周期与负责人）。 */
export function typeOf(node) {
  return node !== null && node !== undefined && node.type === 'plan' ? 'plan' : 'todo'
}

export function isPlan(node) {
  return typeOf(node) === 'plan'
}

export function isTodo(node) {
  return typeOf(node) === 'todo'
}

/** 一个类型的合法状态列表。 */
export function statusListOf(type) {
  return type === 'plan' ? PLAN_STATUS : TODO_STATUS
}

/** 一个 plan 节点的子节点数组（保证存在，便于无条件遍历）。 */
export function childrenOf(node) {
  if (node === null || node === undefined || typeof node !== 'object') return []
  return Array.isArray(node.children) ? node.children : []
}

// ---------------------------------------------------------------- 树的遍历

/**
 * 深度优先摊平整棵树。`type` 传 'any' 表示全都要。
 * 返回项带类型、父节点、深度与 id 路径——定位、渲染、统计都靠它，
 * 免得每处各写一遍递归（各写一遍就会出现「有的地方能跨层找、有的不能」）。
 */
export function collectNodes(plan, type = 'any') {
  const out = []
  const visit = (node, parent, depth, parentPath) => {
    const t = typeOf(node)
    const id = node === null || node === undefined ? '' : String(node.id ?? '')
    const path = parentPath === '' ? id : parentPath + ' / ' + id
    if (type === 'any' || type === t) out.push({ node, type: t, parent, depth, path })
    // 即便当前节点不匹配也要继续向下——待办既能挂在顶层，也能挂在任意深度的计划下。
    for (const child of childrenOf(node)) visit(child, node, depth + 1, path)
  }
  for (const node of planNodes(plan)) visit(node, null, 0, '')
  return out
}

/** 顶层节点数组（保证存在）。 */
export function planNodes(plan) {
  if (plan === null || plan === undefined || typeof plan !== 'object') return []
  return Array.isArray(plan.nodes) ? plan.nodes : []
}

/** 收件箱：还没归位到任何计划下的顶层待办。 */
export function inboxOf(plan) {
  return planNodes(plan).filter((node) => isTodo(node))
}

/** 顶层计划（进度只看它们——收件箱不参与完成度，见 docs/DESIGN.md）。 */
export function topPlans(plan) {
  return planNodes(plan).filter((node) => isPlan(node))
}

/** 子树规模统计（删除前提示「会连带删掉多少」）。 */
export function nodeStats(node) {
  let plans = 0
  let todos = 0
  const visit = (n) => {
    if (isPlan(n)) {
      plans += 1
      for (const c of childrenOf(n)) visit(c)
    } else {
      todos += 1
    }
  }
  if (node !== null && node !== undefined) visit(node)
  return { plans, todos, total: plans + todos }
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

/** 按类型定位节点（'plan' / 'todo' / 'any'）。 */
export function resolveNode(plan, ref, type = 'any') {
  const label = type === 'any' ? '节点' : TYPE_LABEL[type]
  return resolveIn(collectNodes(plan, type), ref, label)
}

/** 按 id / 标题在整棵树里定位一个节点，不限定类型。 */
export function resolveAny(plan, ref) {
  return resolveNode(plan, ref, 'any')
}

/** 限定定位到一个「待办」。agent 勾选进度的入口用它，避免误改计划状态。 */
export function resolveTodo(plan, ref) {
  const found = resolveNode(plan, ref, 'todo')
  return found
}

/**
 * 定位一个节点在树里的位置（父节点、兄弟数组、下标）。
 * 移动与删除都要先知道它挂在哪儿——这两件事不能靠「再搜一遍标题」，
 * 因为标题可能重名，而 id 是唯一的。
 */
export function locate(plan, ref) {
  const needle = typeof ref === 'string' ? ref.trim() : ''
  if (needle === '') throw new Error('需要一个节点的 id')
  const roots = planNodes(plan)
  const byId = (list) => list.findIndex((n) => n !== null && n !== undefined && n.id === needle)
  const idx = byId(roots)
  if (idx >= 0) return { node: roots[idx], parent: null, siblings: roots, index: idx }
  // 递归时 parent 必须是「拥有这批 children 的那个节点」——用外层传进来的
  // parent 会把祖父报成父亲（所有三级以下的定位都会错一层）。
  const visit = (list) => {
    for (let i = 0; i < list.length; i++) {
      const node = list[i]
      const kids = childrenOf(node)
      const j = byId(kids)
      if (j >= 0) return { node: kids[j], parent: node, siblings: kids, index: j }
      const deeper = visit(kids)
      if (deeper !== undefined) return deeper
    }
    return undefined
  }
  const found = visit(roots)
  if (found === undefined) throw new Error('找不到节点 id：' + needle)
  return found
}

/** 目标节点是否是自身的祖先（用于阻止「把计划移进自己的子孙里」）。 */
export function isDescendantOf(plan, node, maybeAncestor) {
  let cursor = locate(plan, node.id).parent
  while (cursor !== null && cursor !== undefined) {
    if (cursor.id === maybeAncestor.id) return true
    cursor = locate(plan, cursor.id).parent
  }
  return false
}

// ------------------------------------------------------------------ 进度

/**
 * 单个节点的完成度（递归）：
 *   1. 声明了 metric.target（>0）时按 current/target —— 量化型（如 3/12 个台区）；
 *   2. 否则有子节点时取子节点完成度的算术平均 —— 汇总型；
 *   3. 都没有时，done 记 1，其余记 0。
 * 三种情形原来分散在 krProgress / goalProgress 两个函数里，递归树让它们
 * 变成同一个函数的三条分支——这也是这次改造少掉的真实复杂度。
 */
export function nodeProgress(node) {
  if (node === null || node === undefined || typeof node !== 'object') return 0
  const m = node.metric
  if (m !== null && m !== undefined && typeof m === 'object'
    && Number.isFinite(m.target) && m.target > 0) {
    return clamp01((Number(m.current) || 0) / m.target)
  }
  const children = childrenOf(node)
  if (children.length === 0) return node.status === 'done' ? 1 : 0
  return children.reduce((acc, c) => acc + nodeProgress(c), 0) / children.length
}

/**
 * 全计划完成度 = 各**顶层计划**完成度的平均。
 * 顶层待办（收件箱）不参与：用「可见」驱动整理，而不是用「扣分」——
 * 否则刚记下的一条待办会让完成度凭空掉几个点，人就会开始不记了。
 */
export function planProgress(plan) {
  const plans = topPlans(plan)
  if (plans.length === 0) return 0
  return plans.reduce((acc, n) => acc + nodeProgress(n), 0) / plans.length
}

// ------------------------------------------------------- 待办计数 / 汇总

/** 待办计数（面板角标、进度条文案）。总数只算待办，计划数单列。 */
export function todoCounts(plan) {
  const out = { todo: 0, doing: 0, done: 0, dropped: 0, total: 0, plans: 0, inbox: 0, inboxOpen: 0 }
  // 计划数与待办数都要递归统计——只数顶层的话，任何嵌套计划都会被漏掉。
  for (const x of collectNodes(plan, 'any')) {
    if (x.type === 'plan') {
      out.plans += 1
    } else {
      const s = TODO_STATUS.includes(x.node.status) ? x.node.status : 'todo'
      out[s] += 1
      out.total += 1
    }
  }
  for (const node of planNodes(plan)) {
    if (isTodo(node)) {
      out.inbox += 1
      if (node.status !== 'done' && node.status !== 'dropped') out.inboxOpen += 1
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

// ------------------------------------------------------- 配速 / 落后预警

/** 两个 YYYY-MM-DD 之间的天数（b − a）。任一侧不合法返回 undefined。 */
function daysBetween(a, b) {
  const ta = Date.parse(a + 'T00:00:00Z')
  const tb = Date.parse(b + 'T00:00:00Z')
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return undefined
  return (tb - ta) / 86400000
}

/**
 * 配速：拿「按周期现在应该到哪儿」和「实际到哪儿」比。
 *
 *   期望进度 = (今天 − start) / (end − start)
 *   实际进度 = nodeProgress(node)
 *   落后     = 期望 − 实际 ≥ PACE_THRESHOLD
 *
 * 只在「有完整周期 + 周期正在走」时才算，四种情况一律返回 null：
 *
 *   没填周期         没有基准，就没有「落后」——继续走逾期逻辑
 *   start 还没到     「还没开始」不是「落后」
 *   已经过了 end     这是**逾期**，不是落后。两种信号分开标，才能触发不同动作
 *                     （逾期 = 去问为什么没交付；落后 = 现在就该调整节奏）
 *   已完成 / 已放弃   已经结束的事没有节奏问题
 *
 * 待办没有 start/end，所以**待办不讲配速，待办的落后表现就是逾期**；
 * 计划讲配速、待办讲截止，两条线各管一段。
 *
 * @param progress 可选：调用方已经算过的完成度（省一次递归重算）。
 */
export function paceOf(node, progress, today = todayStr()) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (node.status === 'done' || node.status === 'dropped') return null
  const start = opt(node.start)
  const end = opt(node.end)
  if (start === undefined || end === undefined) return null
  if (end <= start) return null
  if (today < start) return null
  if (today > end) return null
  const span = daysBetween(start, end)
  const elapsed = daysBetween(start, today)
  if (span === undefined || elapsed === undefined) return null
  const expected = clamp01(elapsed / span)
  const actual = clamp01(Number.isFinite(progress) ? progress : nodeProgress(node))
  const gap = expected - actual
  return { expected, actual, gap, behind: gap >= PACE_THRESHOLD }
}

/**
 * 「落后了」清单：带完整周期、周期正在走、且期望进度领先实际进度
 * 超过阈值的节点，差距大的排前面。
 *
 * 它是「兑现重要度高承诺」的那一半——`FR-M2` 承诺了落后预警，数据
 * （start / end / 进度）本来就都在，缺的只是这一步比较。
 */
export function behindList(plan, today = todayStr()) {
  const out = []
  for (const item of collectNodes(plan, 'any')) {
    const progress = nodeProgress(item.node)
    const pace = paceOf(item.node, progress, today)
    if (pace === null || !pace.behind) continue
    out.push({
      id: item.node.id,
      type: item.type,
      title: item.node.title ?? '',
      parent: item.parent === null || item.parent === undefined ? null : item.parent.id,
      path: item.path,
      priority: priorityOf(item.node),
      progress,
      pace,
    })
  }
  out.sort((a, b) => b.pace.gap - a.pace.gap)
  return out
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
 * 注意：本函数只管写入与时间戳，不校验取值——校验在 setStatus。
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

/** 按节点类型校验状态取值，然后交给 applyStatus 写入。 */
export function setStatus(node, status) {
  const t = typeOf(node)
  const allowed = statusListOf(t)
  const s = opt(status)
  if (s === undefined || !allowed.includes(s)) {
    throw new Error(TYPE_LABEL[t] + '的状态必须是 ' + allowed.join(' / ') + ' 之一，收到：' + String(status))
  }
  return applyStatus(node, s)
}

/**
 * 改节点类型（待办 ↔ 计划）。递归树的核心动作之一：随手记的待办后来发现要拆，
 * 提升成计划再往下分；拆完发现没必要，又降回待办。原地换型而不是「新建一个再搬」
 * 是因为后者的语义是「换个容器」，用户想说的是「这就是同一件事」。
 *
 * 两条约束：
 *   - **有待办类型非法状态的节点**：状态是按类型校验的，`active` 只对计划合法、
 *     `todo`/`doing` 只对待办合法。跨类型时重新归一，否则会留下一个对该类型
 *     非法的状态，而非法状态在渲染和统计里都是静默错值（不是报错）。
 *   - **计划降级为待办时若有子节点则拒绝**：待办是叶子，孩子们会变成孤儿，
 *     而「父亲消失」这种结构损伤是不可逆的。要让用户先移走或删掉。
 */
export function setNodeType(node, type) {
  const t = opt(type)
  if (t === undefined || !NODE_TYPE.includes(t)) {
    throw new Error('节点类型必须是 ' + NODE_TYPE.join(' / ') + ' 之一，收到：' + String(type))
  }
  if (typeOf(node) === t) return node
  const kids = childrenOf(node).length
  if (t === 'todo' && kids > 0) {
    throw new Error('「' + String(node.title) + '」下还有 ' + kids + ' 个子节点，'
      + '不能降级为待办（待办是叶子）——先把子节点移走或删掉')
  }
  node.type = t
  const allowed = statusListOf(t)
  if (!allowed.includes(node.status)) node.status = t === 'plan' ? 'active' : 'todo'
  // 让磁盘上的形状与 makeNode 一致：计划恒有 children 数组（上层可无条件遍历），
  // 待办是叶子、不留空的 children 键（否则 PLAN.md 与 JSON diff 里会出现噪音）。
  if (t === 'plan') {
    if (!Array.isArray(node.children)) node.children = []
  } else {
    delete node.children
  }
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

/**
 * 只改委派的期望完成时间，**不动回执状态与委派时间**。
 *
 * 为什么不能复用 `setDelegate`：它会把回执重置成 `pending`（换人意味着上一轮
 * 作废）。但「同一个活、只是期望时间往后挪」不是换人，把已接受的回执打回
 * 待接受是错的。表单保存时必须能区分这两种情况：对象变 → `setDelegate`，
 * 只是时间变 → 这里。
 */
export function setDelegateExpectAt(node, expectAt) {
  const d = node?.delegate
  if (d === null || d === undefined || typeof d !== 'object' || opt(d.to) === undefined) {
    throw new Error('这个节点还没有委派记录，先建立委派再改期望时间')
  }
  const e = opt(expectAt)
  if (e === undefined) delete d.expectAt
  else d.expectAt = e
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
 * 「负责人」只对计划节点要求——待办默认就是自己负责，若硬要求填负责人，
 * 每一条高优先级待办都会报警告，警告随即失去意义。
 *
 * 「完成要证据」只对重要度为「高」的节点要求：这一档才承诺了完整流程。
 * 其余档位缺证据不进这里，但仍会被 `isUnverified` 标出来（见该函数注释）——
 * 两类信号分开，这个 ⚠ 才保得住「有它 = 有缺口要补」的信息量。
 */
export function nodeWarnings(node, type) {
  const out = []
  const t = type ?? typeOf(node)
  const leaf = t === 'todo'
  const period = leaf ? opt(node?.due) : (opt(node?.end) ?? opt(node?.start))
  const owner = opt(node?.owner) ?? opt(node?.delegate?.to)
  const p = priorityOf(node)
  if (p === 'high') {
    if (period === undefined) out.push(leaf ? '重要度为「高」，需要截止日期' : '重要度为「高」，需要周期（起止）')
    if (!leaf && owner === undefined) out.push('重要度为「高」，需要负责人')
    if (node?.status === 'done' && evidenceOf(node).length === 0) {
      out.push('重要度为「高」，完成但没有证据')
    }
  } else if (p === 'normal' && period === undefined) {
    out.push(leaf ? '重要度为「中」，建议补一个截止日期' : '重要度为「中」，建议补一个结束日期')
  }
  const d = delegateState(node)
  if (d !== null && d.overdueReceipt) out.push('委派给 ' + d.to + ' 已逾期未回执')
  return out
}

// ------------------------------------------------------------- 完成证据

/** 读证据列表（永远返回数组，缺省为空）。 */
export function evidenceOf(node) {
  const list = node === null || node === undefined ? undefined : node.evidence
  return Array.isArray(list) ? list : []
}

/**
 * 追加一条完成证据。**追加而不是覆盖**：证据是「这件事是怎么完成的」的
 * 连续记录，覆盖语义会让补第二条时把第一条抹掉。
 *
 * 同 `kind` + 同 `ref` 视为同一条，不重复追加——agent 重试、或人在面板上
 * 又点了一次「附上这个文件」，都不应该产生两条一模一样的证据。
 * （这不算破坏「追加」语义：重复的条目不含任何新信息，只会让审查变糊。）
 *
 * `kind` 缺省 `note`（只记录、不核验）。缺省而不是报错，是为了不让
 * 「忘了一个枚举值」变成一次失败的写入；写错枚举值仍然报错。
 */
export function addEvidence(node, input = {}, now = new Date()) {
  if (node === null || node === undefined || typeof node !== 'object') {
    throw new Error('证据要挂在节点上')
  }
  const kind = opt(input.kind) ?? 'note'
  if (!EVIDENCE_KIND.includes(kind)) {
    throw new Error('证据类型必须是 ' + EVIDENCE_KIND.join(' / ') + ' 之一，收到：' + String(input.kind))
  }
  const ref = opt(input.ref)
  if (ref === undefined) {
    throw new Error('证据需要一个 ref：文件路径 / 会话 id / 命令 / 链接 / 一句话说明')
  }
  const iso = (now instanceof Date ? now : new Date(now)).toISOString()
  if (!Array.isArray(node.evidence)) node.evidence = []
  const dup = node.evidence.find((e) => e !== null && e !== undefined && e.kind === kind && e.ref === ref)
  if (dup !== undefined) {
    dup.at = iso
    const patch = opt(input.note)
    if (patch !== undefined) dup.note = patch
    return dup
  }
  const item = { kind, ref, at: iso }
  const note = opt(input.note)
  if (note !== undefined) item.note = note
  node.evidence.push(item)
  return item
}

/**
 * 已完成但没有证据。**这是本插件独有的议题**：人类工具不需要防自己，
 * 但一个会自己把任务标完成的 agent 需要——否则「AI 帮我标完了」这句话
 * 没有任何可验证性。
 *
 * 与 `nodeWarnings` 分开，是因为它们该触发不同动作：
 *   warning     缺元信息 → 补填即可
 *   unverified  缺凭据   → 需要人去核验（或让 agent 补交证据）
 * 混在一个 ⚠ 里，两个信号都会变糊。
 *
 * 刻意**不再加一个「必须附证据才能标完成」的硬拦**：在打勾那一刻硬拦，
 * 只会激励 agent 顺手编一条假证据——那比没有证据更糟，因为你会以为它是真的。
 * 靠「可一次性审查的清单」而不是「写入时的门槛」来防，才防得住。
 */
export function isUnverified(node) {
  if (node === null || node === undefined || typeof node !== 'object') return false
  return node.status === 'done' && evidenceOf(node).length === 0
}

/**
 * 「已完成但无证据」清单，最近完成的排前面——审查刚打完的勾，
 * 比翻一周前的旧账有用（旧的那些证据已经无从补起）。
 */
export function unverifiedList(plan) {
  const out = []
  for (const item of collectNodes(plan, 'any')) {
    if (!isUnverified(item.node)) continue
    out.push({
      id: item.node.id,
      type: item.type,
      title: item.node.title ?? '',
      parent: item.parent === null || item.parent === undefined ? null : item.parent.id,
      path: item.path,
      priority: priorityOf(item.node),
      doneAt: opt(item.node.doneAt) ?? null,
    })
  }
  out.sort((a, b) => String(b.doneAt ?? '').localeCompare(String(a.doneAt ?? '')))
  return out
}

/**
 * 证据里**能机器判真假的那一条**：`kind: 'file'` 会去查文件是否存在
 * （相对路径按工作区根解析）。其余四种（会话 / 命令 / 链接 / 说明）只记录、
 * 不核验——不假装能验。
 *
 * 文件产出恰好是最常见的形态，所以这唯一的核验点覆盖了多数实际场景；
 * 而它也是唯一不会误报的核验点：「文件在不在」是客观事实，
 * 「这条命令有没有真的跑过」不是。
 */
export function evidenceWarnings(node, root) {
  const out = []
  if (typeof root !== 'string' || root === '') return out
  for (const e of evidenceOf(node)) {
    if (e === null || e === undefined || e.kind !== 'file') continue
    const ref = opt(e.ref)
    if (ref === undefined) continue
    const abs = ref.startsWith('/') ? ref : join(root, ref)
    if (!existsSync(abs)) out.push('证据所指的文件不存在：' + ref)
  }
  return out
}

/**
 * 删一条完成证据（按 ref + 可选 kind 定位）。**幂等**：没找到就什么也不做，
 * 不报错——删一条已经不存在的证据，与「它已经不在了」是同一个结果。
 *
 * 存在的理由：证据只能增、不能删的话，挂错一条就得靠改 plan.json 或让 agent
 * 直接改数据，面板这一侧等于没有纠错能力。
 */
export function removeEvidence(node, ref, kind) {
  const list = evidenceOf(node)
  const target = opt(ref)
  if (target === undefined) return false
  const k = opt(kind)
  const at = list.findIndex((e) => e !== null && e !== undefined
    && e.ref === target && (k === undefined || e.kind === k))
  if (at < 0) return false
  list.splice(at, 1)
  if (list.length === 0) delete node.evidence
  return true
}

// ------------------------------------------------------------- 文件库关联

/**
 * 文件关联的关联类型。
 *   file   单个文件（会议纪要.md、台账.xlsx …）
 *   folder 一整个文件夹（某个项目的资料夹、某个客户的往来目录 …）
 * 与「完成证据」是两种语义：证据是「做完了的凭证」（只认单文件、要核验存在、
 * 还与「无证据完成项」审查线绑定）；文件关联是「做这件事要看的资料」，可挂
 * 文件也可挂文件夹，跟完没完成无关（见 docs/DESIGN.md「文件库关联」章）。
 * 两者刻意分开：把文件夹硬塞进 evidence 会污染那条审查线，也违背它
 * 「只校验单文件」的设计。
 */
export const FILE_KIND = ['file', 'folder']
export const FILE_LABEL = { file: '文件', folder: '文件夹' }

/** 读关联列表（永远返回数组，缺省为空）。 */
export function filesOf(node) {
  const list = node === null || node === undefined ? undefined : node.files
  return Array.isArray(list) ? list : []
}

/**
 * 给节点挂一个文件 / 文件夹关联。追加而不是覆盖（与证据同思路：同一条关联
 * 重试不重复产生）。
 *
 * ref 是**相对 Obsidian vault 根**的路径——这样它和具体机器的绝对路径解耦，
 * plan.json 里只存一份「逻辑路径」，核验 / 生成 obsidian:// 链接时再按配置好的
 * vaultPath 拼成绝对路径。机器相关的绝对路径不进 plan.json，换机器 / 换人时才不
 * 会读到一串对不上的路径。
 *
 * kind 缺省 file（只记录、不核验），写错枚举值仍报错。
 */
export function addFile(node, input = {}, now = new Date()) {
  if (node === null || node === undefined || typeof node !== 'object') {
    throw new Error('文件关联要挂在节点上')
  }
  const kind = opt(input.kind) ?? 'file'
  if (!FILE_KIND.includes(kind)) {
    throw new Error('关联类型必须是 ' + FILE_KIND.join(' / ') + ' 之一，收到：' + String(input.kind))
  }
  const ref = opt(input.ref)
  if (ref === undefined) {
    throw new Error('关联需要一个 ref：vault 内相对路径（文件或文件夹）')
  }
  const iso = (now instanceof Date ? now : new Date(now)).toISOString()
  if (!Array.isArray(node.files)) node.files = []
  const dup = node.files.find((f) => f !== null && f !== undefined && f.kind === kind && f.ref === ref)
  if (dup !== undefined) {
    dup.at = iso
    const patch = opt(input.note)
    if (patch !== undefined) dup.note = patch
    return dup
  }
  const item = { kind, ref, at: iso }
  const note = opt(input.note)
  if (note !== undefined) item.note = note
  node.files.push(item)
  return item
}

/**
 * 从节点摘掉一条关联（按 ref + 可选 kind 定位）。摘掉不存在的 ref 是静默无操作，
 * 不报错——面板点 ✕、agent 解绑都该是「幂等的安全动作」。
 */
export function removeFile(node, ref, kind) {
  if (node === null || node === undefined || typeof node !== 'object') return false
  if (!Array.isArray(node.files)) return false
  const r = opt(ref)
  if (r === undefined) return false
  const before = node.files.length
  node.files = node.files.filter((f) => !(
    f !== null && f !== undefined && f.ref === r && (kind === undefined || f.kind === kind)
  ))
  return node.files.length < before
}

/**
 * 关联的文件 / 文件夹是否存在。相对路径按 vaultPath 解析；vaultPath 没配时
 * 返回空数组（「未配置 vault」由面板另提示，不该污染每个节点的告警）。
 * 与 evidenceWarnings 分开：证据核验走工作区根、只看 file；这里走 vault 根、
 * file 与 folder 都核验。
 */
export function fileWarnings(node, vaultPath) {
  const out = []
  if (typeof vaultPath !== 'string' || vaultPath === '') return out
  for (const f of filesOf(node)) {
    const ref = opt(f.ref)
    if (ref === undefined) continue
    const abs = ref.startsWith('/') ? ref : join(vaultPath, ref)
    if (!existsSync(abs)) out.push((f.kind === 'folder' ? '文件夹' : '文件') + '不存在：' + ref)
  }
  return out
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
      type: item.type,
      title: item.node.title ?? '',
      parent: item.parent === null || item.parent === undefined ? null : item.parent.id,
      path: item.path,
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

/**
 * 管控视角的汇总（面板筛选条的角标、agent 的预警都用它）：
 *   high       未完成的「高」重要度节点数
 *   delegated  带委派的节点数
 *   overdue    逾期未完成数
 *   week       7 天内到期数
 *   warnings   存在管控缺口的节点数
 *   behind     落后于周期（配速）的节点数
 *   unverified 已完成但没有证据的节点数
 *   inbox      收件箱条数（含已完成的）
 *   inboxOpen  收件箱里还没归位的待办数
 */
export function controlSummary(plan, today = todayStr()) {
  const nodes = collectNodes(plan, 'any')
  const open = nodes.filter((x) => x.node.status !== 'done' && x.node.status !== 'dropped')
  const counts = todoCounts(plan)
  return {
    high: open.filter((x) => priorityOf(x.node) === 'high').length,
    delegated: nodes.filter((x) => delegateState(x.node, today) !== null).length,
    overdue: open.filter((x) => isOverdue(x.node, today)).length,
    week: open.filter((x) => isDueWithin(x.node, 7, today)).length,
    warnings: nodes.filter((x) => nodeWarnings(x.node, x.type).length > 0).length,
    behind: open.filter((x) => {
      const pace = paceOf(x.node, nodeProgress(x.node), today)
      return pace !== null && pace.behind
    }).length,
    unverified: nodes.filter((x) => isUnverified(x.node)).length,
    inbox: counts.inbox,
    inboxOpen: counts.inboxOpen,
  }
}

/** 在 YYYY-MM-DD 或 ISO 时间戳上取日期部分。 */
function dayOf(v) {
  const s = opt(v)
  return s === undefined ? undefined : s.slice(0, 10)
}

/**
 * 建一个新节点（不插入，只构造）。id 由调用方给的 plan 现算，保证不撞号。
 * 计划自动带 `children: []`，这样上层可以无条件遍历它的子节点。
 */
export function makeNode(plan, input = {}) {
  const type = opt(input.type) ?? 'todo'
  if (!NODE_TYPE.includes(type)) {
    throw new Error('type 必须是 ' + NODE_TYPE.join(' / ') + ' 之一，收到：' + String(input.type))
  }
  const title = opt(input.title)
  if (title === undefined) throw new Error('标题不能为空')
  const node = {
    id: nextId(plan),
    type,
    title,
    status: type === 'plan' ? 'active' : 'todo',
  }
  if (type === 'plan') node.children = []
  return applyFields(node, input)
}

/**
 * 把一批可选字段写进节点（**不传就不动**）。「新增」与「修改」共用同一份
 * 字段清单——两边各写一份的话，迟早会出现「新增支持某字段、修改不支持」。
 *
 * `metric` 是**合并**而不是整体替换：只传 `current` 时不能把 `target` 抹掉。
 * 「不传的字段保持不动」这条对每个字段都得成立，包括嵌在对象里的那几个——
 * 否则「更新一下当前值」会静默地丢掉目标值，而进度随即从「3/12」变成
 * 「没有指标、按状态算」，看起来只是数字变小了，根本想不到是丢了数据。
 */
export function applyFields(node, input = {}) {
  const set = (key, value) => {
    const v = opt(value)
    if (v !== undefined) node[key] = v
  }
  set('title', input.title)
  set('owner', input.owner)
  set('note', input.note)
  // 计划用周期（start/end），待办用截止（due）。都允许写：分类是渲染与
  // 警告的事，不是写入的事——写的时候不因为「类型不对」而丢数据。
  set('start', input.start)
  set('end', input.end)
  set('due', input.due)
  if (opt(input.priority) !== undefined) setPriority(node, input.priority)
  const m = metricOf(input)
  if (m !== undefined) {
    const prev = node.metric !== null && node.metric !== undefined && typeof node.metric === 'object'
      ? node.metric
      : {}
    node.metric = { ...prev, ...m }
  }
  return node
}

/** 从入参里抽量化字段（兼容顶层的 target/current/unit 与嵌套的 metric）。 */
export function metricOf(input) {
  if (input === null || input === undefined || typeof input !== 'object') return undefined
  const src = input.metric !== null && input.metric !== undefined && typeof input.metric === 'object'
    ? input.metric
    : input
  const target = Number(src.target)
  const current = Number(src.current)
  const unit = opt(src.unit)
  if (!Number.isFinite(target) && !Number.isFinite(current) && unit === undefined) return undefined
  const out = {}
  if (Number.isFinite(target)) out.target = target
  if (Number.isFinite(current)) out.current = current
  if (unit !== undefined) out.unit = unit
  return out
}

/**
 * 可清空的字段白名单。
 *
 * 为什么需要一个独立的「清空」动作：`applyFields` 的语义是「不传就不动」
 * （空串等同于没传，见 `opt`），这对 agent 工具的增量写入是对的，但对
 * **表单**是错的——表单是「所见即所得」，把负责人输入框清空就是要删掉负责人，
 * 而不是「这次不改负责人」。两条语义必须由两条通路表达，不能靠猜：
 * 写入走 `applyFields`，清空走 `clearFields`，由调用方（面板表单）分别传。
 */
export const CLEARABLE = ['owner', 'start', 'end', 'due', 'note', 'metric', 'delegate']

/**
 * 清空一批字段（表单里被清空的那些）。未知字段**静默忽略**而不是报错：
 * 白名单是面板与 store 之间的契约，多传一个名字说明面板升级了、store 没跟上，
 * 为这个让整次保存失败不值得。
 *
 * `metric` 与 `delegate` 是对象字段，整块删掉而不是逐键清——半截的
 * `{ current: 3 }`（没有 target）会让进度静默退化成「按状态算」。
 *
 * 返回**实际清掉的字段数**（0 = 本来就是空的），调用方据此决定要不要记一次
 * 版本留档——没改动却留一版，会让 `.versions/` 里塞满「什么都没改」的快照。
 */
export function clearFields(node, keys = []) {
  // 返回类型恒为「清掉了几条」：一半情况返回数字、另一半返回节点，迟早有人
  // 拿返回值当节点用（或反过来）。
  if (node === null || node === undefined || typeof node !== 'object') return 0
  if (!Array.isArray(keys)) return 0
  let n = 0
  for (const key of keys) {
    if (!CLEARABLE.includes(key)) continue
    if (node[key] === undefined) continue
    delete node[key]
    n += 1
  }
  return n
}

/**
 * 把节点挂到某个父节点下（parent 为空则挂到顶层）。
 * 目标必须是计划——待办是叶子，往里塞子项会让树变成两种语义混在一起。
 */
export function appendChild(plan, node, parentRef) {
  if (parentRef === null || parentRef === undefined || parentRef === '') {
    planNodes(plan).push(node)
    return node
  }
  const { node: parent } = resolveAny(plan, parentRef)
  if (!isPlan(parent)) {
    throw new Error('「' + String(parentRef) + '」是待办，不能往里放子项——目标必须是计划')
  }
  if (!Array.isArray(parent.children)) parent.children = []
  parent.children.push(node)
  return node
}

// ============================================================ 依赖 / 星标 / 重复

/**
 * 任务依赖（**单向阻塞**，MLO 的主干语义）：`node.blockedBy = [id]`——
 * 里面的 id 有任何一个还没做完，这个节点就是「被挡住」的。
 *
 * 为什么不做 MLO 的完整规则（同分支自动顺序等）：那条路每加一条规则，
 * 「这条为什么被挡住 / 为什么没被挡住」就更难解释一层，最后变成黑箱。
 * 单向阻塞只有一句话能解释：「它等的那件事还没做完」。
 *
 * 层级不是依赖：挂在计划下是**归属**，跟做不做得成无关。一个待办可以
 * 同时挂在「工作主线」下、又被另一条待办挡着——两件事互不掺和。
 */
export function blockedListOf(node) {
  const list = node === null || node === undefined || typeof node !== 'object' ? undefined : node.blockedBy
  return Array.isArray(list) ? list : []
}

/** 按 id 找节点（依赖**只按 id**：依赖是精确的工程关系，标题匹配留给建议类功能）。 */
function nodeById(plan, id) {
  const want = String(id ?? '')
  if (want === '') return null
  for (const hit of collectNodes(plan, 'any')) {
    if (String(hit.node.id) === want) return hit.node
  }
  return null
}

/** from 的依赖链（沿 blockedBy 一路走下去）是否到达 target——环检测的内核。 */
function dependsOn(plan, from, target, seen = new Set()) {
  const id = String(from?.id ?? '')
  if (seen.has(id)) return false
  seen.add(id)
  for (const ref of blockedListOf(from)) {
    if (String(ref) === String(target?.id)) return true
    const next = nodeById(plan, ref)
    if (next !== null && dependsOn(plan, next, target, seen)) return true
  }
  return false
}

/**
 * 给 node 加一条依赖：等 ref 做完它才能做。
 *
 * 三条校验都在这一处：目标要存在；不能依赖自己；**不能成环**（A 等 B、
 * B 又等 A，两件都永远做不了）。传 plan 是为了做后两条校验——依赖不是
 * 一个节点自己的事，是图上的边。
 */
export function addBlockedBy(plan, node, ref) {
  if (node === null || node === undefined || typeof node !== 'object') {
    throw new Error('依赖要挂在节点上')
  }
  const target = nodeById(plan, ref)
  if (target === null) throw new Error('要等的任务不存在：' + String(ref))
  if (String(target.id) === String(node.id)) throw new Error('不能依赖自己')
  if (dependsOn(plan, target, node)) {
    throw new Error('不能成环：「' + String(target.title) + '」（直接或间接）已经等看「'
      + String(node.title) + '」，再加就互相等了')
  }
  const id = String(target.id)
  if (!blockedListOf(node).some((x) => String(x) === id)) {
    if (!Array.isArray(node.blockedBy)) node.blockedBy = []
    node.blockedBy.push(id)
  }
  return node
}

/** 摘掉一条依赖。幂等：摘一条不存在的依赖不报错（它已经不在了）。 */
export function removeBlockedBy(node, ref) {
  const list = blockedListOf(node)
  const want = String(ref ?? '')
  const at = list.findIndex((x) => String(x) === want)
  if (at < 0) return false
  list.splice(at, 1)
  if (list.length === 0) delete node.blockedBy
  return true
}

/** 谁挡着它：blockedBy 里**还没做完**的那些。完成不删依赖——留着，重开后还能用。 */
export function blockers(plan, node) {
  const out = []
  for (const ref of blockedListOf(node)) {
    const b = nodeById(plan, ref)
    if (b !== null && b.status !== 'done' && b.status !== 'dropped') out.push(b)
  }
  return out
}

/**
 * 星标：「我正在做 / 接下来做」。它不改变任何数据含义，只影响排序——
 * 执行清单里置顶。故意做成布尔而不是「进行中」状态：进行中已经在
 * `status` 里有（doing），再来一套两套语义就打架了。
 */
export function setStar(node, on) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (on === true) node.starred = true
  else delete node.starred
  return node
}

export const RECUR_KIND = ['week', 'month']

/** 配置重复（week / month；空值 = 取消重复）。只对待办有意义——计划不「做完再来一次」。 */
export function setRecur(node, kind) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  const k = opt(kind)
  if (k === undefined || k === 'none') {
    delete node.recur
    return node
  }
  if (!RECUR_KIND.includes(k)) {
    throw new Error('重复周期必须是 ' + RECUR_KIND.join(' / ') + ' 之一，收到：' + String(kind))
  }
  node.recur = { kind: k }
  return node
}

/** 下一次到期日：有截止就接着往后推，没截止就从今天算起（否则第一次就没有 due）。 */
function nextDue(prev, kind, today) {
  const base = opt(prev) ?? opt(today) ?? todayStr()
  if (kind === 'week') {
    const d = new Date(base + 'T00:00:00Z')
    d.setUTCDate(d.getUTCDate() + 7)
    return d.toISOString().slice(0, 10)
  }
  // month：同日顺推，落进下个月没有的那天（31 号 → 2 月）就取当月最后一天。
  const d = new Date(base + 'T00:00:00Z')
  const day = d.getUTCDate()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() + 1)
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(day, last))
  return d.toISOString().slice(0, 10)
}

/**
 * 重复任务的「重生」：完成一条带 `recur` 的待办时，克隆一条新的挂回原处。
 *
 * 克隆什么、不克隆什么是有意的：标题 / 负责人 / 优先级 / 备注 / 重复规则 / 截止
 * （顺推一期）**要**——那是「这件事每周都要做」的全部含义；完成时间 / 证据 /
 * 关联 / 星标 / 依赖**不要**——那些说的是「上一次」，不是「这一次」。
 *
 * @returns 新节点；没配重复就返回 null（调用方不用分支）。
 */
export function spawnRecurring(plan, node, today = todayStr()) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  const recur = node.recur
  if (recur === null || recur === undefined || typeof recur !== 'object' || !RECUR_KIND.includes(recur.kind)) {
    return null
  }
  const clone = makeNode(plan, {
    type: 'todo',
    title: node.title,
    owner: node.owner,
    priority: node.priority,
    note: node.note,
    due: nextDue(node.due, recur.kind, today),
  })
  clone.recur = { kind: recur.kind }
  const parentRef = (() => {
    for (const hit of collectNodes(plan, 'any')) {
      if (Array.isArray(hit.node.children) && hit.node.children.includes(node)) return hit.parent
    }
    return null
  })()
  appendChild(plan, clone, parentRef === null || parentRef === undefined ? undefined : parentRef.id)
  return clone
}

// ============================================================ 归位建议

/**
 * 把一段文字切成字符二元组。
 *
 * 中文没有词边界，所以不引入分词（那要带词典，还得养一份不断变旧的词表）。
 * 用 bigram 近似「用词」：「数据治理」→ 数据 / 据治 / 治理。两边取交集算重合，
 * 比逐字比对更能反映「说的是同一件事」，又完全不依赖模型或词典。
 * 标点与空白先剔除，免得「，」「、」这类高频符号把相似度虚高。
 */
function bigrams(text) {
  const s = String(text === null || text === undefined ? '' : text).replace(/[\s\p{P}\p{S}]/gu, '')
  const out = new Set()
  if (s.length === 1) out.add(s)
  for (let i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2))
  return out
}

/** 两个集合的交集大小。 */
function overlap(a, b) {
  let n = 0
  for (const x of a) if (b.has(x)) n++
  return n
}

/** 两个 ISO 时间戳之间隔了几天；缺一头就返回 null（不知道就别说 0 天）。 */
function isoDays(from, to) {
  const a = opt(from)
  const b = opt(to)
  if (a === undefined || b === undefined) return null
  const ms = new Date(b).getTime() - new Date(a).getTime()
  if (!Number.isFinite(ms)) return null
  return Math.max(0, Math.round(ms / 86400000))
}

/**
 * 历史上做过的**相似的事**（已完成 / 已放弃），按相似度降序。
 *
 * 「新增一条任务时，历史上类似的活是怎么做的」——AI 给专业意见、面板给提醒，
 * 都靠这一份：它把「以前那条拖了多久、有没有证据、最后是不是放弃了」摆出来，
 * 让人在接新活的时候就知道代价。
 *
 * 相似度复用 `bigrams`（与归位建议同一套字面信号）：不引入模型、不引入词典，
 * 高频小动作等不起一次模型调用，而且结果要能解释（why 里写明重合几处）。
 *
 * 只认 `done` / `dropped`：正在做的事已经在树上了，不算「历史」。
 */
export function historyHints(plan, title, limit = 3) {
  const want = bigrams(title)
  if (want.size === 0) return []
  const out = []
  for (const hit of collectNodes(plan, 'any')) {
    const n = hit.node
    if (n.status !== 'done' && n.status !== 'dropped') continue
    const theirs = bigrams(n.title)
    if (theirs.size === 0) continue
    const shared = overlap(want, theirs)
    if (shared === 0) continue
    // 分母取「较小的那一边」：两条标题长短差很多时不至于把分数压没。
    const ratio = shared / Math.min(want.size, theirs.size)
    if (ratio < 0.25) continue
    out.push({
      id: String(n.id ?? ''),
      title: String(n.title ?? ''),
      status: n.status,
      path: String(hit.path ?? ''),
      doneAt: opt(n.doneAt) ?? null,
      days: isoDays(n.startedAt, n.doneAt),
      note: opt(n.note) ?? '',
      evidence: evidenceOf(n).length,
      score: ratio,
      why: '标题用词重合 ' + shared + ' 处',
    })
  }
  out.sort((a, b) => (b.score - a.score) || String(b.doneAt ?? '').localeCompare(String(a.doneAt ?? '')))
  return out.slice(0, limit > 0 ? limit : 3)
}

/**
 * 给一条「还没归位的顶层待办」推荐该放到哪个计划下，按分数降序。
 *
 * 为什么是**规则打分**而不是让模型判断：
 *   1. 面板要即时给结果，归位是高频小动作，等一次模型调用不划算；
 *   2. **建议必须能解释**——用户要能看懂「为什么推荐这个计划」才敢一键接受，
 *      模型给的理由往往事后编得通、事前对不上；
 *   3. 纯函数，可以逐条写进 store.test.mjs 钉住，改权重时能立刻看见行为变化。
 * 代价是只能抓字面信号，认不出「回填」≈「补数」这类语义类比——这是有意的取舍。
 *
 * 候选集只包含**能把节点合法放进去**的计划（复用 isDescendantOf，与 moveNode
 * 同一处判定，免得两处各写一份、日后只改一边）。
 *
 * 四个信号，每个都带一句人话理由；分数是权重之和，`why` 取权重最高的那条：
 *   字面重合（计划标题 ×3 / 子项标题 ×1）、量化单位命中 ×2、
 *   截止日期落在计划周期内 ×2、提到负责人 ×3。
 */
export function suggestParent(plan, node, today = todayStr(), limit = 3) {
  if (plan === null || plan === undefined || node === null || node === undefined) return []

  const title = bigrams(node.title)
  if (title.size === 0) return []

  const due = opt(node.due)
  const out = []
  // collectNodes 的深度优先顺序就是「树里从上到下」的稳定顺序，用它给同分兜底，
  // 保证同一个计划每次算出来的顺序一样（否则界面上的建议会自己跳位置）。
  for (const hit of collectNodes(plan, 'plan')) {
    const p = hit.node
    if (p.id === node.id) continue
    // 与 moveNode 同一条合法性判定：不能把节点放进自己的子孙里。
    if (isDescendantOf(plan, p, node)) continue

    const signals = []

    // ① 与计划标题的用词重合。权重最高：标题就是人为这个计划起的名字，
    //    最接近「这条待办在说哪件事」。
    const own = overlap(title, bigrams(p.title))
    if (own > 0) signals.push({ score: own * 3, why: '与计划标题用词重合 ' + own + ' 处' })

    // ② 与子项标题的重合。子项多的大计划会靠随机命中累积分数，所以封顶 3。
    const kids = bigrams(childrenOf(p).map((c) => String(c.title ?? '')).join(' '))
    const child = Math.min(overlap(title, kids), 3)
    if (child > 0) signals.push({ score: child, why: '与它的子项用词重合 ' + child + ' 处' })

    // ③ 量化单位命中：计划按「条/个/台区」计数时，待办里出现同一个量词往往就是同一批活。
    const unit = p.metric !== null && p.metric !== undefined && typeof p.metric === 'object'
      ? opt(p.metric.unit) : undefined
    if (unit !== undefined && String(node.title ?? '').includes(unit)) {
      signals.push({ score: 2, why: '提到该计划的量化单位「' + unit + '」' })
    }

    // ④ 截止日期落在计划周期内。周期不完整（只有 start 或只有 end）时不猜。
    const start = opt(p.start)
    const end = opt(p.end)
    if (due !== undefined && start !== undefined && end !== undefined && due >= start && due <= end) {
      signals.push({ score: 2, why: '截止 ' + due + ' 落在计划周期 ' + start + '~' + end + ' 内' })
    }

    // ⑤ 提到负责人。名字是很强的信号，但容易被同名误伤，所以只认完整包含。
    const owner = opt(p.owner)
    if (owner !== undefined && String(node.title ?? '').includes(owner)) {
      signals.push({ score: 3, why: '提到负责人 ' + owner })
    }

    if (signals.length === 0) continue
    let best = signals[0]
    for (const s of signals) if (s.score > best.score) best = s
    out.push({
      id: String(p.id ?? ''),
      title: String(p.title ?? ''),
      path: hit.path,
      score: signals.reduce((sum, s) => sum + s.score, 0),
      why: best.why,
    })
  }

  // 阈值 2：单个「子项用词重合一处」只有 1 分，不足以值得推荐（一条待办总能和
  // 某处碰巧共用一个二字词），而标题重合一处就是 3 分，够格。
  return out
    .filter((s) => s.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

/**
 * 移动一个节点到新的父节点下（parent 为空 = 移到顶层），可指定落位下标。
 * 这是「收件箱归位」的实现：把游离待办拖进某个计划里。
 * 三条硬校验，缺一条都会把树弄坏：
 *   1. 不能移进自己；
 *   2. 不能移进自己的子孙（会形成环，之后遍历直接栈溢出）；
 *   3. 目标必须是计划（待办是叶子）。
 */
export function moveNode(plan, ref, parentRef, index) {
  // 先按 id / 标题定位到节点，再按 id 精确定位它在树里的位置。
  // locate 只认 id（位置必须能被唯一确定），调用方却可能传标题——
  // 少了这一步，「按标题移动」会报「找不到节点 id：xxx」。
  const hit = resolveAny(plan, ref)
  const from = locate(plan, hit.node.id)
  let toParent = null
  if (parentRef !== null && parentRef !== undefined && parentRef !== '') {
    const found = resolveAny(plan, parentRef)
    if (!isPlan(found.node)) {
      throw new Error('「' + String(parentRef) + '」是待办，不能作为父节点——目标必须是计划')
    }
    if (found.node.id === from.node.id) throw new Error('不能把一个节点移到它自己下面')
    if (isDescendantOf(plan, found.node, from.node)) {
      throw new Error('不能把一个节点移到它自己的子孙下面')
    }
    toParent = found.node
  }
  const fromPath = from.parent === null ? null : from.parent.id
  const toPath = toParent === null ? null : toParent.id
  if (fromPath === toPath) {
    // 同一个父节点下重排：先摘再插，注意摘除后下标会前移。
    const list = from.siblings
    const node = list.splice(from.index, 1)[0]
    const raw = Number(index)
    let at = Number.isInteger(raw) ? raw : list.length
    if (at > list.length) at = list.length
    if (at < 0) at = 0
    list.splice(at, 0, node)
    return { node, from: fromPath, to: toPath, index: at }
  }
  const node = from.siblings.splice(from.index, 1)[0]
  const list = toParent === null
    ? planNodes(plan)
    : (Array.isArray(toParent.children) ? toParent.children : (toParent.children = []))
  const raw = Number(index)
  let at = Number.isInteger(raw) ? raw : list.length
  if (at > list.length) at = list.length
  if (at < 0) at = 0
  list.splice(at, 0, node)
  return { node, from: fromPath, to: toPath, index: at }
}

/** 删除一个节点（连带其整棵子树），返回被删的节点与它原来的位置。 */
export function removeNode(plan, ref) {
  const target = resolveAny(plan, ref)
  const found = locate(plan, target.node.id)
  found.siblings.splice(found.index, 1)
  return {
    node: found.node,
    parent: found.parent === null ? null : found.parent.id,
    index: found.index,
    removed: nodeStats(found.node),
  }
}

// ------------------------------------------------------------ 迁移 / 规范化

/**
 * 把 schema 1 的节点（goal / kr / task）共有的可选字段搬到新节点上。
 * 「共有的」是实情：老的三层里每层能带的字段不同，但迁移不该因此丢字段。
 */
function copyCommon(src, dst) {
  for (const key of ['owner', 'start', 'end', 'note', 'priority', 'delegate', 'doneAt', 'startedAt', 'evidence']) {
    if (src === null || src === undefined) continue
    if (src[key] !== undefined && src[key] !== null) dst[key] = src[key]
  }
  return dst
}

/** 从老 KR 上抽量化字段（target/current/unit）进 metric。 */
function metricOfLegacy(kr) {
  const m = metricOf(kr)
  return m === undefined ? undefined : m
}

/**
 * schema 1 → schema 2 的无损迁移。
 *
 * 映射关系（老 id 原样保留，历史会话与 .versions/ 快照里的引用继续有效）：
 *   goal          → plan（顶层）
 *   goal.krs[i]   → plan（子计划）
 *   kr.tasks[j]   → todo
 *   kr.target/current/unit → metric { target, current, unit }
 *   plan.inbox[k] → 顶层 todo（即收件箱）
 *
 * 顺序上：先放各计划，再放收件箱——与 PLAN.md 的阅读顺序一致
 * （先读计划，再读还没归位的东西）。
 */
export function migratePlan(raw) {
  const plan = {
    schema: SCHEMA,
    version: Number.isInteger(raw.version) ? raw.version : 0,
    title: typeof raw.title === 'string' ? raw.title : '个人工作计划',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
    nodes: [],
  }
  if (typeof raw.lastReason === 'string' && raw.lastReason !== '') plan.lastReason = raw.lastReason

  for (const goal of Array.isArray(raw.goals) ? raw.goals : []) {
    const node = {
      id: goal.id,
      type: 'plan',
      title: goal.title,
      status: goal.status === 'done' || goal.status === 'dropped' ? goal.status : 'active',
      children: [],
    }
    copyCommon(goal, node)
    for (const kr of Array.isArray(goal.krs) ? goal.krs : []) {
      const sub = {
        id: kr.id,
        type: 'plan',
        title: kr.title,
        status: kr.status === 'done' || kr.status === 'dropped' ? kr.status : 'active',
        children: [],
      }
      copyCommon(kr, sub)
      const metric = metricOfLegacy(kr)
      if (metric !== undefined) sub.metric = metric
      for (const task of Array.isArray(kr.tasks) ? kr.tasks : []) {
        const todo = {
          id: task.id,
          type: 'todo',
          title: task.title,
          status: TODO_STATUS.includes(task.status) ? task.status : 'todo',
        }
        copyCommon(task, todo)
        const due = opt(task.due)
        if (due !== undefined) todo.due = due
        sub.children.push(todo)
      }
      node.children.push(sub)
    }
    plan.nodes.push(node)
  }

  for (const todo of Array.isArray(raw.inbox) ? raw.inbox : []) {
    const node = {
      id: todo.id,
      type: 'todo',
      title: todo.title,
      status: TODO_STATUS.includes(todo.status) ? todo.status : 'todo',
    }
    copyCommon(todo, node)
    const due = opt(todo.due)
    if (due !== undefined) node.due = due
    plan.nodes.push(node)
  }
  return plan
}

/**
 * 把从磁盘读到的计划补齐成当前 schema（只在内存里补，**不写盘**——
 * load 是只读的，改写盘会让人「只打开看了一眼」也产生一次归档）。
 * 已经是 schema 2 的原样返回；遇到 schema 1 就迁移。
 */
export function normalizePlan(plan) {
  if (plan === null || typeof plan !== 'object') throw new Error('计划必须是对象')
  if (Array.isArray(plan.nodes)) {
    if (plan.schema !== SCHEMA) plan.schema = SCHEMA
    return plan
  }
  if (Array.isArray(plan.goals)) return migratePlan(plan)
  throw new Error('计划缺少 nodes 数组')
}

/** 生成一个自增 id（默认 n 前缀），扫描全树保证不撞号。 */
export function nextId(plan, prefix = 'n') {
  let max = 0
  const consider = (id) => {
    if (typeof id !== 'string' || !id.startsWith(prefix)) return
    const n = Number(id.slice(prefix.length))
    if (Number.isInteger(n) && n > max) max = n
  }
  // 扫描必须覆盖整棵树（含任意深度的子计划与收件箱）——漏掉任一处，
  // 新建节点就可能与已有节点重号，按 id 定位就会指错对象。
  for (const x of collectNodes(plan, 'any')) consider(x.node.id)
  return prefix + String(max + 1)
}

/** 一份空计划。 */
export function emptyPlan(title = '个人工作计划') {
  return {
    schema: SCHEMA,
    // 从 0 起：第一次 save 自增为 v1。
    version: 0,
    title,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nodes: [],
  }
}

// ---------------------------------------------------------------- Markdown

const pct = (n) => String(Math.round(n * 100)) + '%'

/**
 * 把计划渲染成 Markdown 视图。纯函数，便于测试。
 * 标题级别随深度递增（封顶 6 级），所以「年度 → 季度 → 月度」在 Markdown
 * 里也是一眼能看出的层级；待办统一用任务列表语法，便于在 GitHub 上直接勾。
 */
export function renderMarkdown(plan) {
  /** 一个节点的附加标注（重要度 / 委派 / 配速 / 证据 / 完成时间）。 */
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
    const pace = paceOf(node, nodeProgress(node))
    if (pace !== null && pace.behind) {
      out.push('⚠ 落后（应到 ' + pct(pace.expected) + '，实际 ' + pct(pace.actual) + '）')
    }
    const ev = evidenceOf(node)
    if (ev.length > 0) {
      out.push('证据 ' + ev.length + ' 条：' + ev
        .map((e) => EVIDENCE_LABEL[e.kind] ?? e.kind ?? '证据')
        .join('、'))
    } else if (isUnverified(node)) {
      out.push('⚠ 完成但无证据')
    }
    const done = dayOf(node.doneAt)
    if (done !== undefined) out.push('完成于 ' + done)
    return out
  }

  const todoLine = (node, indent) => {
    const box = node.status === 'done' ? '[x]' : '[ ]'
    const bits = []
    if (node.status === 'doing') bits.push('进行中')
    if (node.status === 'dropped') bits.push('已放弃')
    const due = opt(node.due)
    if (due !== undefined) bits.push('截止 ' + due)
    bits.push(...extraOf(node))
    const pad = '  '.repeat(indent)
    return pad + '- ' + box + ' ' + node.id + ' · ' + (node.title || '(未命名待办)')
      + (bits.length ? '  _(' + bits.join('；') + ')_' : '')
  }

  /** 计划节点的标题行（按深度决定 # 的个数）+ 元信息行。 */
  const planHeader = (node, depth) => {
    const level = Math.min(2 + depth, 6)
    const hashes = '#'.repeat(level)
    const q = node.metric !== null && node.metric !== undefined
      && Number.isFinite(node.metric.target) && node.metric.target > 0
      ? '  ' + String(node.metric.current ?? 0) + '/' + String(node.metric.target)
        + (node.metric.unit ? ' ' + node.metric.unit : '')
      : ''
    const lines = [hashes + ' ' + node.id + ' · ' + (node.title || '(未命名计划)')
      + '  ' + pct(nodeProgress(node)) + q]
    const pad = '  '.repeat(Math.max(0, level - 2))
    const owner = opt(node.owner)
    if (owner !== undefined) lines.push(pad + '- 负责人：' + owner)
    const start = opt(node.start)
    const end = opt(node.end)
    if (start !== undefined || end !== undefined) lines.push(pad + '- 周期：' + (start ?? '?') + ' ~ ' + (end ?? '?'))
    if (node.status === 'done' || node.status === 'dropped') lines.push(pad + '- 状态：' + node.status)
    const extra = extraOf(node)
    if (extra.length > 0) lines.push(pad + '- ' + extra.join('；'))
    const note = opt(node.note)
    if (note !== undefined) lines.push(pad + '- 备注：' + note)
    return lines
  }

  /** 递归渲染一个计划节点及其全部后代。 */
  const renderNode = (node, depth, out) => {
    if (isTodo(node)) {
      out.push(todoLine(node, depth))
      const note = opt(node.note)
      if (note !== undefined) out.push('  '.repeat(depth + 1) + '- ' + note)
      return
    }
    out.push('')
    out.push(...planHeader(node, depth))
    for (const child of childrenOf(node)) renderNode(child, depth + 1, out)
    out.push('')
  }

  const lines = []
  lines.push('# ' + (plan.title || '个人工作计划'))
  lines.push('')
  lines.push('> 本文件由 dsh-workbench 从 `plan.json` 自动生成，请勿手工编辑——改动会在下次写入时被覆盖。')
  lines.push('')
  lines.push('- 计划版本：v' + String(plan.version ?? 1))
  lines.push('- 更新时间：' + String(plan.updatedAt ?? ''))
  lines.push('- 整体完成度：' + pct(planProgress(plan)))
  const c = todoCounts(plan)
  lines.push('- 计划：' + String(c.plans) + ' 个；待办：共 ' + String(c.total) + '，已完成 '
    + String(c.done) + '，进行中 ' + String(c.doing) + '，待办 ' + String(c.todo))
  if (c.inbox > 0) {
    lines.push('- 收件箱：' + String(c.inbox) + ' 条（未完成 ' + String(c.inboxOpen) + '）')
  }
  const ctrl = controlSummary(plan)
  lines.push('- 管控：高重要度 ' + String(ctrl.high) + ' · 委派中 ' + String(ctrl.delegated)
    + ' · 逾期 ' + String(ctrl.overdue) + ' · 7 天内到期 ' + String(ctrl.week))
  if (ctrl.behind > 0) lines.push('- 落后于周期：' + String(ctrl.behind) + ' 项（进度没跟上时间）')
  if (ctrl.warnings > 0) lines.push('- 管控缺口：' + String(ctrl.warnings) + ' 处待补（见各节点标注）')
  if (ctrl.unverified > 0) lines.push('- 完成但无证据：' + String(ctrl.unverified) + ' 项待核验')
  lines.push('')

  for (const node of planNodes(plan)) {
    if (isPlan(node)) renderNode(node, 0, lines)
  }

  // 收件箱放在最后：先读计划、再读还没归位的东西。
  const inbox = inboxOf(plan)
  if (inbox.length > 0) {
    lines.push('## 收件箱 · 未归类待办  ' + String(inbox.length) + ' 条')
    lines.push('')
    for (const todo of inbox) {
      lines.push(todoLine(todo, 0))
      const note = opt(todo.note)
      if (note !== undefined) lines.push('  - ' + note)
    }
    lines.push('')
  }
  return lines.join('\n')
}

// -------------------------------------------------------------------- Store

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

  /**
   * 读取计划；文件不存在时返回一份空计划（不落盘，首次写入才创建）。
   * 遇到老 schema 自动迁移（只在内存里，不写盘）。
   */
  async load() {
    if (!existsSync(this.file)) return emptyPlan()
    const raw = await readFile(this.file, 'utf8')
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      throw new Error('plan.json 不是合法 JSON（' + this.file + '）：' + (e instanceof Error ? e.message : String(e)))
    }
    if (parsed === null || typeof parsed !== 'object') {
      throw new Error('plan.json 结构不合法：不是一个对象（' + this.file + '）')
    }
    try {
      return normalizePlan(parsed)
    } catch (e) {
      throw new Error('plan.json 结构不合法：' + (e instanceof Error ? e.message : String(e)) + '（' + this.file + '）')
    }
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
    plan.schema = SCHEMA
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

  /**
   * 回滚到某个历史版本（把当前版本也归档，所以回滚本身可撤销）。
   * 老 schema 的快照会被迁移后落盘：回滚要的是「内容回到那一刻」，
   * 不是「格式回到那一刻」——否则用户会莫名其妙退回老结构。
   */
  async restore(fileName) {
    const name = String(fileName)
    if (name.includes('/') || name.includes('\\') || name.includes('..')) {
      throw new Error('非法的版本文件名：' + name)
    }
    const target = join(this.versions, name)
    if (!existsSync(target)) throw new Error('版本不存在：' + name)
    await this.#archive('before-restore')
    const raw = await readFile(target, 'utf8')
    const plan = normalizePlan(JSON.parse(raw))
    await mkdir(this.dir, { recursive: true })
    await writeFile(this.file, JSON.stringify(plan, null, 2) + '\n', 'utf8')
    await writeFile(this.view, renderMarkdown(plan), 'utf8')
    return plan
  }
}
