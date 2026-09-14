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
 * 三个横切概念全部是**可选字段**（缺省行为与加之前完全一致）：
 *
 *   priority   重要程度 high | normal | low —— 决定这个节点要走多少流程
 *   delegate   委派 { to, at, expectAt, status } —— 带回执，不是一次性指派
 *   doneAt     完成时间戳 —— 所有「本周做了什么」类统计的上游
 *
 * 进度是**派生量、不落盘**（NFR-2）：只要磁盘上有一份数据，进度就只有一个
 * 算法能算出来，不会出现「面板显示的和服务端算的不一致」。
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
/** 委派回执状态：pending=待接受, accepted=已接受, declined=已拒绝, returned=已交回。 */
export const DELEGATE_STATUS = ['pending', 'accepted', 'declined', 'returned']
/** 中文标签，只用于「给人看的文本」（PLAN.md、工具输出文案），不参与程序判断。 */
export const PRIORITY_LABEL = { high: '高', normal: '中', low: '低' }
export const DELEGATE_LABEL = { pending: '待接受', accepted: '已接受', declined: '已拒绝', returned: '已交回' }
export const TYPE_LABEL = { plan: '计划', todo: '待办' }

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
  } else if (p === 'normal' && period === undefined) {
    out.push(leaf ? '重要度为「中」，建议补一个截止日期' : '重要度为「中」，建议补一个结束日期')
  }
  const d = delegateState(node)
  if (d !== null && d.overdueReceipt) out.push('委派给 ' + d.to + ' 已逾期未回执')
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
  if (m !== undefined) node.metric = m
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
  for (const key of ['owner', 'start', 'end', 'note', 'priority', 'delegate', 'doneAt', 'startedAt']) {
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
  if (ctrl.warnings > 0) lines.push('- 管控缺口：' + String(ctrl.warnings) + ' 处待补（见各节点标注）')
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
