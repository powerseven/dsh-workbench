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
 *
 * 数据形态与 host 半身的 store.js 一致（schema 2 递归树）：顶层 nodes[]，
 * 每个节点 type=plan | todo，plan 可挂 children。这里刻意**不做**类型判断的
 * 「智能」推断——服务端算好的标注（progress / warnings / delegateState /
 * overdue / dueSoon / pace / behind / unverified）优先，本地只在缺失时兜底，
 * 避免两边算出不同的答案。
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

// ------------------------------------------------------------ 树的读取

/**
 * 节点类型。缺省按「待办」兜底——与服务端 typeOf 同语义。
 * 跨模块系统无法共享实现，靠 test/logic.test.mjs 的断言钉住一致性。
 */
// 类型由结构派生（与 store.js 的 typeOf 同一份口径，两边各写一份是硬约束，
// 由测试钉住）：有子项 = 计划（容器），无子项 = 待办（叶子）。
function nodeType(node) {
  return node !== null && node !== undefined && typeof node === 'object'
    && Array.isArray(node.children) && node.children.length > 0 ? 'plan' : 'todo'
}

/** 子节点数组（保证存在，便于无条件遍历）。 */
function childrenOf(node) {
  if (node === null || node === undefined || typeof node !== 'object') return []
  return Array.isArray(node.children) ? node.children : []
}

/** 顶层节点数组（保证存在）。 */
function planNodes(plan) {
  if (plan === null || plan === undefined || typeof plan !== 'object') return []
  return Array.isArray(plan.nodes) ? plan.nodes : []
}

/** 已「纳入工作计划」（filed）——只在顶层待办上有意义，口径必须与 store.js 一致。 */
function filedOf(node) {
  return node !== null && node !== undefined && typeof node === 'object' && node.filed === true
}

/** 收件箱：还没归位、也还没纳入工作计划的顶层待办。 */
function inboxOf(plan) {
  var out = []
  var roots = planNodes(plan)
  for (var i = 0; i < roots.length; i++) {
    if (nodeType(roots[i]) === 'todo' && !filedOf(roots[i])) out.push(roots[i])
  }
  return out
}

/** 「工作计划」栏：顶层计划 + 已纳入工作计划的顶层待办（与收件箱互补）。 */
function workPlans(plan) {
  var out = []
  var roots = planNodes(plan)
  for (var i = 0; i < roots.length; i++) {
    if (nodeType(roots[i]) === 'plan' || filedOf(roots[i])) out.push(roots[i])
  }
  return out
}

/** 顶层计划（进度只看它们，收件箱不参与）。 */
function topPlans(plan) {
  var out = []
  var roots = planNodes(plan)
  for (var i = 0; i < roots.length; i++) {
    if (nodeType(roots[i]) === 'plan') out.push(roots[i])
  }
  return out
}

/** 类型 → 中文标签。 */
function typeLabel(type) {
  return type === 'plan' ? '计划' : '待办'
}

/**
 * 节点完成度的兜底算法（递归）。正常路径读服务端算好的 `progress`——
 * 完成度语义只有一处实现（src/store.js 的 nodeProgress），这里只是为了
 * 面板拿到未标注数据（如老缓存）时不至于显示空白。
 */
function progressOf(node) {
  if (node === null || node === undefined || typeof node !== 'object') return 0
  if (typeof node.progress === 'number' && isFinite(node.progress)) return node.progress
  var m = node.metric
  if (m !== null && m !== undefined && typeof m === 'object'
    && typeof m.target === 'number' && m.target > 0) {
    var v = (Number(m.current) || 0) / m.target
    return v < 0 ? 0 : (v > 1 ? 1 : v)
  }
  var kids = childrenOf(node)
  if (kids.length === 0) return node.status === 'done' ? 1 : 0
  var sum = 0
  for (var i = 0; i < kids.length; i++) sum += progressOf(kids[i])
  return sum / kids.length
}

/** 把一个节点列表按「未完成在前、已完成/放弃沉底」排序，同组内保持原顺序。 */
function sortNodes(nodes) {
  var list = Array.isArray(nodes) ? nodes.slice() : []
  var open = []
  var closed = []
  for (var i = 0; i < list.length; i++) {
    var t = list[i]
    if (t !== null && typeof t === 'object' && (t.status === 'done' || t.status === 'dropped')) closed.push(t)
    else open.push(t)
  }
  return open.concat(closed)
}

/** 节点状态 → 中文标签。未知状态按待办处理，不让脏数据把面板弄崩。 */
function statusLabel(status) {
  if (status === 'doing') return '进行中'
  if (status === 'done') return '已完成'
  if (status === 'dropped') return '已放弃'
  if (status === 'active') return '进行中'
  return '待办'
}

/** 下一个待办状态：点击复选框时在 待办 ↔ 已完成 之间切换。 */
function toggleStatus(status) {
  return status === 'done' ? 'todo' : 'done'
}

/** 节点是否还没结束（未完成、未放弃）。 */
function isOpen(node) {
  if (node === null || node === undefined || typeof node !== 'object') return false
  return node.status !== 'done' && node.status !== 'dropped'
}

/** 本地日期字符串，用于兜底判定与「本周」窗口。 */
function todayStr() {
  var d = new Date()
  var m = String(d.getMonth() + 1).padStart(2, '0')
  var day = String(d.getDate()).padStart(2, '0')
  return d.getFullYear() + '-' + m + '-' + day
}

/** 兜底逾期判定：只在服务端没给 `overdue` 标注时用。 */
function overdueFallback(node, today) {
  var anchor = null
  if (typeof node.due === 'string' && node.due !== '') anchor = node.due
  else if (typeof node.end === 'string' && node.end !== '') anchor = node.end
  else if (typeof node.start === 'string' && node.start !== '') anchor = node.start
  return anchor !== null && anchor < today
}

/**
 * 计划概览统计（递归）。用于面板头部、tab 角标与筛选条。
 *
 * 收件箱里的游离待办计入 todos/open——它们也是待办，不显示出来就等于
 * 记了没人看（这正是「收不进来」的另一种形态）。
 */
function summarize(plan) {
  var out = {
    plans: 0, todos: 0, done: 0, open: 0, progress: 0, hasPlan: false,
    inbox: 0, inboxOpen: 0, warnings: 0, depth: 0, filters: {}
  }
  if (plan === null || plan === undefined || typeof plan !== 'object') return out

  var count = function (node, depth) {
    if (nodeType(node) === 'plan') out.plans++
    else {
      out.todos++
      if (node.status === 'done') out.done++
      else if (node.status !== 'dropped') out.open++
    }
    if (Array.isArray(node.warnings) && node.warnings.length > 0) out.warnings++
    if (depth > out.depth) out.depth = depth
    var kids = childrenOf(node)
    for (var i = 0; i < kids.length; i++) count(kids[i], depth + 1)
  }

  var roots = planNodes(plan)
  out.hasPlan = roots.length > 0
  for (var i = 0; i < roots.length; i++) count(roots[i], 1)

  var inbox = inboxOf(plan)
  out.inbox = inbox.length
  for (var j = 0; j < inbox.length; j++) {
    if (isOpen(inbox[j])) out.inboxOpen++
  }

  if (typeof plan.progress === 'number' && isFinite(plan.progress)) {
    out.progress = plan.progress
  } else if (out.todos > 0) {
    out.progress = out.done / out.todos
  }
  out.filters = filterCounts(plan)
  return out
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
  var label = delegateLabel(d.status)
  // 待验收 = 已交回但事情还没完成。这是纯状态判断（不含日期 / 阈值运算），
  // 允许客户端兜底（坑 #12）；要动日期的判定依然只读服务端标注。
  if (d.status === 'returned' && node.status !== 'done' && node.status !== 'dropped') {
    label += '·待验收'
  }
  var out = String(d.to) + ' · ' + label
  if (typeof d.expectAt === 'string' && d.expectAt !== '') out += '（期望 ' + d.expectAt.slice(5) + '）'
  return out
}

// -------------------------------------------------------- 完成证据 / 落后

/**
 * 完成证据类型。必须与服务端 store.js 的 EVIDENCE_KIND 完全一致（顺序也一致）——
 * 两个半身跨模块系统无法共享实现，靠 test/logic.test.mjs 的一条断言钉住。
 */
var EVIDENCE_KINDS = ['file', 'session', 'command', 'link', 'note']

/** 证据类型 → 中文标签（悬停提示里用）。未知类型按「说明」兜底。 */
function evidenceLabel(kind) {
  if (kind === 'file') return '文件'
  if (kind === 'session') return '会话'
  if (kind === 'command') return '命令'
  if (kind === 'link') return '链接'
  return '说明'
}

/** 读证据列表（永远返回数组）。 */
function evidenceList(node) {
  if (node === null || node === undefined || typeof node !== 'object') return []
  return Array.isArray(node.evidence) ? node.evidence : []
}

// -------------------------------------------------------- 文件库关联（Obsidian）

/**
 * 文件关联类型。必须与服务端 store.js 的 FILE_KIND 完全一致（顺序也一致）——
 * 两个半身跨模块系统无法共享实现，靠 test/logic.test.mjs 的一条断言钉住。
 * 文件夹也算关联——节点上记的是「做这件事要看的资料」，资料可以是整本笔记本。
 */
var FILE_KINDS = ['file', 'folder']

/** 关联类型 → 中文标签。未知类型按「文件」兜底。 */
function fileLabel(kind) {
  if (kind === 'folder') return '文件夹'
  return '文件'
}

/** 读关联列表（永远返回数组）。 */
function filesList(node) {
  if (node === null || node === undefined || typeof node !== 'object') return []
  return Array.isArray(node.files) ? node.files : []
}

/**
 * 生成一条 obsidian:// 打开链接（深度对接 v1）。vault 名从 vaultPath 末段取，
 * 路径按 vault 根相对编码。vaultPath 缺失时返回 null（面板据此只显示路径文本，
 * 不渲染可点的链接）。链接形如 obsidian://open?vault=<名>&path=<相对路径>。
 */
function obsidianLink(vaultPath, ref) {
  if (!vaultPath || typeof ref !== 'string' || ref === '') return null
  var seg = vaultPath.split(/[\\/]/).filter(function (s) { return s !== '' })
  var vault = seg.length > 0 ? seg[seg.length - 1] : ''
  if (vault === '') return null
  var p = ref
  if (p.charAt(0) === '/') p = p.slice(1)
  return 'obsidian://open?vault=' + encodeURIComponent(vault) + '&path=' + encodeURIComponent(p)
}

// ---------------------------------------------------------------- 详情表单

/**
 * 状态选项（按类型）。与 `store.js` 的 `statusListOf` 是同一份口径——两边各写
 * 一份是硬约束（host 是 ESM、client 是 CJS 不能共享模块），所以由测试钉住。
 */
var STATUS_LIST = { plan: ['active', 'done', 'dropped'], todo: ['todo', 'doing', 'done', 'dropped'] }
var PRIORITIES = ['high', 'normal', 'low']

function statusListOf(type) {
  return type === 'plan' ? STATUS_LIST.plan.slice() : STATUS_LIST.todo.slice()
}

/** 表单草稿：把节点摊平成一屏可编辑的标量。 */
function formDraftOf(node) {
  var n = node !== null && node !== undefined && typeof node === 'object' ? node : {}
  var m = n.metric !== null && n.metric !== undefined && typeof n.metric === 'object' ? n.metric : {}
  var d = n.delegate !== null && n.delegate !== undefined && typeof n.delegate === 'object' ? n.delegate : {}
  var t = nodeType(n) === 'plan' ? 'plan' : 'todo'
  var status = typeof n.status === 'string' ? n.status : ''
  var pri = typeof n.priority === 'string' ? n.priority : ''
  return {
    title: typeof n.title === 'string' ? n.title : '',
    type: t,
    // 脏数据兜底：非法状态不让它进表单（选不中就会静默写回一个非法值），
    // 直接落在该类型的第一个合法状态上。
    status: statusListOf(t).indexOf(status) >= 0 ? status : statusListOf(t)[0],
    priority: PRIORITIES.indexOf(pri) >= 0 ? pri : 'normal',
    owner: typeof n.owner === 'string' ? n.owner : '',
    start: typeof n.start === 'string' ? n.start : '',
    end: typeof n.end === 'string' ? n.end : '',
    due: typeof n.due === 'string' ? n.due : '',
    target: typeof m.target === 'number' ? String(m.target) : '',
    current: typeof m.current === 'number' ? String(m.current) : '',
    unit: typeof m.unit === 'string' ? m.unit : '',
    note: typeof n.note === 'string' ? n.note : '',
    to: typeof d.to === 'string' ? d.to : '',
    expectAt: typeof d.expectAt === 'string' ? d.expectAt : '',
    parent: '',
  }
}

/**
 * 空草稿（新建用）。类型默认待办——「随手记一条」是最高频的入口，
 * 建计划是次一级的动作，不该让第一条路径多一次选择。
 */
function emptyDraft(type, parent) {
  var d = formDraftOf({ type: type === 'plan' ? 'plan' : 'todo' })
  d.title = ''
  d.parent = parent === null || parent === undefined ? '' : parent
  return d
}

/**
 * 表单草稿 → 写入请求。**新建与编辑共用一份字段清单**，否则迟早出现
 * 「新建支持某字段、编辑不支持」（反过来也一样）。
 *
 * 表单是「所见即所得」语义：留空 = 清掉这个字段，所以要额外产出 `clear`
 * 数组交给服务端（`store.applyFields` 是「不传就不动」的增量语义，
 * 光靠它清不掉任何东西）。新建时没有可清的，直接不传。
 */
function formRequest(draft, original) {
  var isNew = original === null || original === undefined
  var type = draft.type === 'plan' ? 'plan' : 'todo'
  var body = isNew
    ? { type: type, title: String(draft.title || '').trim() }
    : { node: original.id, type: type, title: String(draft.title || '').trim(), status: draft.status }
  body.priority = draft.priority
  var clear = []
  var fields = ['owner', 'start', 'end', 'due', 'note']
  for (var i = 0; i < fields.length; i++) {
    var v = String(draft[fields[i]] === undefined || draft[fields[i]] === null ? '' : draft[fields[i]]).trim()
    if (v !== '') body[fields[i]] = v
    else if (!isNew) clear.push(fields[i])
  }
  var metric = {}
  var t = Number(draft.target)
  var c = Number(draft.current)
  if (String(draft.target || '').trim() !== '' && isFinite(t)) metric.target = t
  if (String(draft.current || '').trim() !== '' && isFinite(c)) metric.current = c
  if (String(draft.unit || '').trim() !== '') metric.unit = String(draft.unit).trim()
  if (Object.keys(metric).length > 0) body.metric = metric
  else if (!isNew) clear.push('metric')
  if (String(draft.to || '').trim() !== '') {
    body.to = String(draft.to).trim()
    if (String(draft.expectAt || '').trim() !== '') body.expectAt = String(draft.expectAt).trim()
  } else if (!isNew) {
    clear.push('delegate')
  }
  if (clear.length > 0) body.clear = clear
  if (isNew && draft.parent !== '' && draft.parent !== null && draft.parent !== undefined) body.parent = draft.parent
  return { method: isNew ? 'node-add' : 'node-set', body: body }
}

/**
 * 表单校验。只拦「写下去一定是错的」那几种（标题空、周期倒挂），
 * 其余一律不拦——缺负责人、缺截止这类是**建议**不是错误，
 * 由 ⚠ 与筛选去催，硬拦只会让人干脆不记（见 DESIGN.md「不硬拦」）。
 */
function formErrors(draft) {
  var out = []
  if (String(draft.title || '').trim() === '') out.push('标题不能为空')
  var s = String(draft.start || '')
  var e = String(draft.end || '')
  if (s !== '' && e !== '' && e < s) out.push('结束日期早于开始日期')
  return out
}

/**
 * 按名字找一个计划（模型与 AI 选项给的也是**名字**而不是 id——与 host 同一条
 * 纪律：模型复述的 id 无从校验，名字可以）。匹配不到返回 null，由调用方决定
 * 退化成什么。三级：标题完全相等 → 互相包含（取最长的那个，避免「数据」命中一堆）。
 */
function planByName(plan, name) {
  var want = normTitle(name)
  if (want === '') return null
  var flat = flattenNodes(plan).filter(function (it) { return it.type === 'plan' })
  var i
  for (i = 0; i < flat.length; i++) {
    if (normTitle(flat[i].node.title) === want) return flat[i].node
  }
  var best = null
  var bestLen = 0
  for (i = 0; i < flat.length; i++) {
    var t = normTitle(flat[i].node.title)
    if (t === '') continue
    if ((t.indexOf(want) >= 0 || want.indexOf(t) >= 0) && t.length > bestLen) {
      best = flat[i].node
      bestLen = t.length
    }
  }
  return best
}

function normTitle(v) {
  return String(v === null || v === undefined ? '' : v).replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase()
}

// ---------------------------------------------------------------- 执行清单（MLO 的 TODO 视图）

/**
 * 谁挡着它：blockedBy 里还没做完的（与 store.js 的 `blockers` 同一份口径，
 * 两边各写一份是硬约束，由测试钉住）。
 */
function blockersOf(plan, node) {
  var list = node === null || node === undefined || typeof node !== 'object' ? undefined : node.blockedBy
  if (!Array.isArray(list)) return []
  var out = []
  for (var i = 0; i < list.length; i++) {
    var b = nodeByIdIn(plan, list[i])
    if (b !== null && b.status !== 'done' && b.status !== 'dropped') out.push(b)
  }
  return out
}

function nodeByIdIn(plan, id) {
  var want = String(id === null || id === undefined ? '' : id)
  if (want === '') return null
  var flat = flattenNodes(plan)
  for (var i = 0; i < flat.length; i++) {
    if (String(flat[i].node.id) === want) return flat[i].node
  }
  return null
}

/**
 * **执行清单**（MLO 的王牌视图）：跨所有分支，把「现在能做的」汇成一张平的清单。
 *
 * 「现在能做」= 未完成 + 未被依赖挡住。分两组返回：`open`（能做的，按
 * 星标 > 重要度 > 逾期/本周 > 截止 > 树序排）与 `blocked`（被挡的，单独折叠——
 * 它们不是没做，是**做不了**，混在一起会让人误以为拖延了）。
 */
function todoList(plan, today) {
  var all = []
  var flat = flattenNodes(plan)
  for (var i = 0; i < flat.length; i++) {
    var it = flat[i]
    if (it.type !== 'todo') continue
    var n = it.node
    if (n.status === 'done' || n.status === 'dropped') continue
    all.push({
      node: n,
      path: it.path,
      depth: it.depth,
      starred: n.starred === true,
      blockers: blockersOf(plan, n).map(function (b) { return String(b.title ?? '') }),
      doneAt: null,
      due: typeof n.due === 'string' ? n.due : '',
      pri: priorityRank(n.priority),
    })
  }
  var open = all.filter(function (x) { return x.blockers.length === 0 })
  var blocked = all.filter(function (x) { return x.blockers.length > 0 })
  var band = function (x) {
    if (overdueFallback(x.node, today)) return 0
    if (dueWithin(x.node, 7, today)) return 1
    return 2
  }
  open.sort(function (a, b) {
    return (b.starred - a.starred)
      || (a.pri - b.pri)
      || (band(a) - band(b))
      || String(a.due).localeCompare(String(b.due))
  })
  return { open: open, blocked: blocked }
}

/** 日期 +days（YYYY-MM-DD 字符串）。 */
function addDaysStr(dateStr, days) {
  var d = new Date(String(dateStr) + 'T00:00:00Z')
  if (isNaN(d.getTime())) return null
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** 是否在 [今天, 今天+days] 内到期（与 store 的 isDueWithin 同口径的本地简化版）。 */
function dueWithin(node, days, today) {
  var a = typeof node.due === 'string' && node.due !== '' ? node.due
    : (typeof node.end === 'string' && node.end !== '' ? node.end : null)
  if (a === null) return false
  var limit = addDaysStr(today, days)
  if (limit === null) return false
  return a >= today && a <= limit
}

/**
 * 把一串**任务标题**匹配回节点（AI 清单卡用）。与 `planByName` 同一条纪律：
 * 模型给的是名字不是 id，名字可以反查、id 没法校验。
 * 返回 [{ id, title, ok }]——匹配不上的 ok=false，原样带回去让用户知道 AI 指错了。
 */
function matchTaskTitles(plan, titles) {
  var out = []
  var titlesArr = Array.isArray(titles) ? titles : []
  for (var i = 0; i < titlesArr.length; i++) {
    var want = normTitle(titlesArr[i])
    var hit = null
    if (want !== '') {
      var flat = flattenNodes(plan)
      var best = null
      var bestLen = 0
      for (var j = 0; j < flat.length; j++) {
        var t = normTitle(flat[j].node.title)
        if (t === '') continue
        if (t === want) { best = flat[j].node; bestLen = t.length; break }
        if ((t.indexOf(want) >= 0 || want.indexOf(t) >= 0) && t.length > bestLen) {
          best = flat[j].node
          bestLen = t.length
        }
      }
      hit = best
    }
    out.push({
      title: String(titlesArr[i] ?? ''),
      id: hit === null ? null : String(hit.id),
      ok: hit !== null,
    })
  }
  return out
}

// ------------------------------------------------- 自定义视图（AI 生成的清单存下来）

var VIEWS_KEY = 'dsh-workbench:views'

/** 已保存的自定义视图：[{ name, ids:[] }]。只活在这台浏览器上（与折叠同类）。 */
function loadViews() {
  try {
    var raw = window.localStorage.getItem(VIEWS_KEY)
    var arr = raw === null || raw === undefined || raw === '' ? [] : JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter(function (v) {
      return v !== null && typeof v === 'object' && typeof v.name === 'string' && Array.isArray(v.ids)
    }) : []
  } catch (e) { return [] }
}

function saveViews(views) {
  try { window.localStorage.setItem(VIEWS_KEY, JSON.stringify(views)) } catch (e) { /* 存不下就当没存 */ }
}

/** 清单 ids → 视图用的条目（按给定顺序，丢了 id 的任务自动剔除）。 */
function viewItems(plan, ids) {
  var out = []
  var arr = Array.isArray(ids) ? ids : []
  for (var i = 0; i < arr.length; i++) {
    var n = nodeByIdIn(plan, arr[i])
    if (n === null || n.status === 'done' || n.status === 'dropped') continue
    out.push(n)
  }
  return out
}

/**
 * 已完成但没有证据。优先读服务端标注；缺失时本地兜底——这条兜底不含任何
 * 阈值或日期运算，与服务端 `isUnverified` 逐字等价，所以不存在
 * 「两边算出不同答案」的风险（配速那种要算日期的就绝不在本地兜底）。
 */
function unverifiedOf(node) {
  if (node === null || node === undefined || typeof node !== 'object') return false
  if (node.unverified === true) return true
  return node.status === 'done' && evidenceList(node).length === 0
}

/** 一个节点的配速文案，如「应到 60% / 实际 35%」。服务端没给就不显示。 */
function paceText(node) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  var p = node.pace
  if (p === null || p === undefined || typeof p !== 'object') return null
  if (typeof p.expected !== 'number' || typeof p.actual !== 'number') return null
  return '应到 ' + pct(p.expected) + ' / 实际 ' + pct(p.actual)
}

/**
 * 把整棵树摊平成一维，带层级路径（如「n1 / n2」），供聚焦列表显示上下文。
 * 摊平是「筛选」视图的基础——筛选结果通常跨层级，树形结构反而不好读。
 */
function flattenNodes(plan) {
  var out = []
  var visit = function (node, depth, parentPath) {
    if (node === null || node === undefined) return
    var id = node.id === undefined || node.id === null ? '' : String(node.id)
    var path = parentPath === '' ? id : parentPath + ' / ' + id
    out.push({ type: nodeType(node), node: node, depth: depth, path: path })
    var kids = childrenOf(node)
    for (var i = 0; i < kids.length; i++) visit(kids[i], depth + 1, path)
  }
  var roots = planNodes(plan)
  for (var i = 0; i < roots.length; i++) visit(roots[i], 0, '')
  return out
}

/** 筛选器定义。id 传给 focusList，label 上芯片。 */
var FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'high', label: '重要度高' },
  { id: 'delegated', label: '我委派出去的' },
  { id: 'week', label: '未来 7 天' },
  { id: 'overdue', label: '逾期' },
  { id: 'behind', label: '落后' },
  { id: 'unverified', label: '无证据的完成项' }
]

/**
 * 聚焦列表：按筛选器挑出节点，并排序（逾期 → 重要度高 → 快到期的在前）。
 * `all` 返回空数组——全部视图走树形渲染，不走扁平列表。
 */
function focusList(plan, filterId, today) {
  if (typeof filterId !== 'string' || filterId === '' || filterId === 'all') return []
  var t = typeof today === 'string' && today !== '' ? today : todayStr()
  // 「无证据的完成项」按定义就是**已完成**的节点，必须绕开「只看未结束」
  // 这条默认规则——其余筛选器找的都是「待处理」，只有这个找的是「已处理但
  // 没凭据」，它要审的恰恰是那些已经沉底的东西。
  var includesClosed = filterId === 'unverified'
  var out = []
  var nodes = flattenNodes(plan)
  for (var i = 0; i < nodes.length; i++) {
    var x = nodes[i]
    var n = x.node
    if (!includesClosed && !isOpen(n)) continue
    if (filterId === 'high' && n.priority !== 'high') continue
    if (filterId === 'delegated' && (n.delegateState === null || n.delegateState === undefined)) continue
    if (filterId === 'week' && n.dueSoon !== true) continue
    if (filterId === 'overdue' && !(n.overdue === true || (n.overdue === undefined && overdueFallback(n, t)))) continue
    if (filterId === 'behind' && n.behind !== true) continue
    if (filterId === 'unverified' && !unverifiedOf(n)) continue
    out.push(x)
  }
  if (filterId === 'unverified') {
    // 最近完成的排前面——审查刚打完的勾，比翻一周前的旧账有用。
    out.sort(function (a, b) {
      return String(b.node.doneAt || '').localeCompare(String(a.node.doneAt || ''))
    })
    return out
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

// ------------------------------------------------------------ 未来日程（Upcoming）

/** 「9月17日 周三」——按天分组时每段的标题。日期串来自节点自己的 due/end。 */
function dayLabel(dateStr) {
  var d = new Date(String(dateStr) + 'T00:00:00Z')
  if (isNaN(d.getTime())) return String(dateStr)
  var week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getUTCDay()]
  return (d.getUTCMonth() + 1) + '月' + d.getUTCDate() + '日 ' + week
}

/**
 * 收尾复盘用的「顺延到哪天」：相对 base（YYYY-MM-DD）算出目标日期。
 * - `tomorrow`：base + 1 天
 * - `nextweek`：下一个周一（base 本身是周一则顺延 7 天，绝不回到今天）
 * 纯函数、不碰时区口径（和 dayLabel 同用 UTC 零点），便于单测。
 */
function deferDate(base, kind) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof base === 'string' ? base : '')
  if (m === null) return ''
  var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  var ymd = function () {
    var y = d.getFullYear()
    var mo = d.getMonth() + 1
    var da = d.getDate()
    return y + '-' + (mo < 10 ? '0' + mo : '' + mo) + '-' + (da < 10 ? '0' + da : '' + da)
  }
  if (kind === 'tomorrow') { d.setDate(d.getDate() + 1); return ymd() }
  if (kind === 'nextweek') {
    var dow = d.getDay()
    var toMon = (8 - dow) % 7
    if (toMon === 0) toMon = 7
    d.setDate(d.getDate() + toMon)
    return ymd()
  }
  return ''
}

/**
 * **未来日程**（对齐 Things 3 的 Upcoming）：把「本周到期」从一句数字变成
 * 可逐日展开的清单，回答的是「下周三我有什么事」。
 *
 * 三条纪律：
 *   1. **判定读服务端标注**（`overdue` / `dueSoon`），客户端只拿节点自身的
 *      `due`（或容器的 `end`）**分组**——日期口径只有在 `store.isDueWithin`
 *      一处实现，重算就会出现「面板与服务端算出不同答案」而没人知道哪个对。
 *      窗口因此与 `dueSoon` 一致（7 天），不开放 `days` 参数：开放了就等于
 *      逼客户端重算。
 *   2. **逾期滚入「今天」组，不单独置顶成段**（TeuxDeux 式顺延）：逾期（该做没做）
 *      与今天到期（正要做）都是「今天该出现的」，混在今日组里更符合「滚到下一天」
 *      的心智；两者的区分交给 `node.overdue` 的红标，而非分两段——分段反而让人
 *      把逾期当成「另册」，忘了它也是今天要清的。
 *   3. 已结束（done / dropped）的不进来：这是「未来要做的」，不是账本。
 *
 * 返回 `{ days: [{ date, label, items }] }`；`days` 只含有事项
 * 的那些天（空天不占一行——窄屏空间很贵，空白列表只会让真正有事的那些天更难找）。
 */
function upcomingByDay(plan, today) {
  var t = typeof today === 'string' && today !== '' ? today : todayStr()
  var flat = flattenNodes(plan)
  var byDate = {}
  var order = []
  for (var i = 0; i < flat.length; i++) {
    var x = flat[i]
    var n = x.node
    if (!isOpen(n)) continue
    var isOver = n.overdue === true || (n.overdue === undefined && overdueFallback(n, t))
    // TeuxDeux 顺延：逾期项不单独置顶成段，直接滚入「今天」组——它本就该今天做。
    // 今天组内靠 `node.overdue` 的红标区分「该做没做」与「正要做」，信号不丢。
    // 非逾期项仍按自身 due / end 分组（只有当月窗口内的 dueSoon 才进得来）。
    var date = isOver ? t
      : (typeof n.due === 'string' && n.due !== '' ? n.due
        : (typeof n.end === 'string' && n.end !== '' ? n.end : ''))
    if (!isOver && (n.dueSoon !== true || date === '')) continue
    if (byDate[date] === undefined) { byDate[date] = []; order.push(date) }
    byDate[date].push(x)
  }
  var rank = function (x) {
    var n = x.node
    var o = overdueFallback(n, t) ? 0 : 1
    return [n.starred === true ? 0 : 1, priorityRank(n.priority), o, String(n.due || n.end || '')]
  }
  var cmp = function (a, b) {
    var ra = rank(a)
    var rb = rank(b)
    return (ra[0] - rb[0]) || (ra[1] - rb[1]) || (ra[2] - rb[2]) || ra[3].localeCompare(rb[3])
  }
  order.sort()
  var days = []
  for (var k = 0; k < order.length; k++) {
    var items = byDate[order[k]]
    items.sort(cmp)
    days.push({ date: order[k], label: dayLabel(order[k]), items: items })
  }
  return { days: days }
}

// -------------------------------------------------------------- 看板分列

/**
 * 看板视图的数据：把整棵计划树按**顶层计划**分列，每个顶层计划（或收件箱）占一列，
 * 列里是它名下的全部待办（含嵌套子计划里的），卡片带「属于哪个子计划」的上下文路径。
 *
 * 这是树形之外另一种读法——节点一多，树会越缩越深、越难俯瞰；看板用「横向铺开」
 * 让「每个计划里现在有什么、做完了多少」一眼可见。它**只读** /get 下发的数据，
 * 不新增任何工具或路由（与树形共用同一份 payload）。
 *
 * 筛选器同样作用于看板：filterId 不是 'all' 时，只把命中筛选的待办放进列里
 * （聚焦列表已经帮我们算好了逾期 / 重要度 / 落后等口径，本地不重算）。
 *
 * 列顺序 = 顶层节点顺序，最后接一个收件箱列（所有顶层待办归在一起，而不是每个
 * 顶层待办占一列）。没有任何待办的计划列会被丢弃，保持看板清爽。
 *
 * 纯函数、无 IO，便于在 test/logic.test.mjs 里钉住分组口径。
 */
function boardColumns(plan, filterId, today) {
  if (plan === null || plan === undefined || typeof plan !== 'object') return []
  var t = (typeof today === 'string' && today !== '') ? today : todayStr()
  var useFilter = (typeof filterId === 'string' && filterId !== '' && filterId !== 'all')

  // 待办清单：筛选态走 focusList（口径只在 host 一处），全量态直接摊平后只留待办。
  var flat = useFilter
    ? focusList(plan, filterId, t)
    : flattenNodes(plan).filter(function (x) { return x.type === 'todo' })
  if (flat.length === 0) return []

  // 建 id → 节点 的索引，供卡片的「上下文路径」把 id 翻成标题。
  var index = {}
  var roots = planNodes(plan)
  var planRootIds = []
  var inboxRootIds = []
  for (var r = 0; r < roots.length; r++) {
    var rid = String(roots[r].id)
    index[rid] = roots[r]
    if (nodeType(roots[r]) === 'plan') planRootIds.push(rid)
    else inboxRootIds.push(rid)
    var kids = childrenOf(roots[r])
    for (var w = 0; w < kids.length; w++) {
      var stack = [kids[w]]
      while (stack.length > 0) {
        var cur = stack.pop()
        if (cur === null || cur === undefined || typeof cur !== 'object') continue
        index[String(cur.id)] = cur
        var ck = childrenOf(cur)
        for (var c2 = 0; c2 < ck.length; c2++) stack.push(ck[c2])
      }
    }
  }

  // 列顺序：顶层计划在前，收件箱列（若有顶层待办）垫后。
  var order = planRootIds.slice()
  if (inboxRootIds.length > 0) order.push('__inbox__')
  var meta = {}
  for (var p = 0; p < planRootIds.length; p++) {
    meta[planRootIds[p]] = { kind: 'plan', node: index[planRootIds[p]] }
  }
  meta['__inbox__'] = { kind: 'inbox', node: null }
  var bucket = {}
  for (var o = 0; o < order.length; o++) bucket[order[o]] = []

  for (var f = 0; f < flat.length; f++) {
    var segs = flat[f].path.split(' / ')
    var topId = segs[0]
    if (bucket[topId] !== undefined) bucket[topId].push(flat[f])
    else if (inboxRootIds.indexOf(topId) >= 0) bucket['__inbox__'].push(flat[f])
  }

  var cols = []
  for (var c = 0; c < order.length; c++) {
    var gid = order[c]
    var items = bucket[gid]
    if (items.length === 0) continue
    // 全量态把已完成的沉到列底；筛选态已由 focusList 排好序（逾期→重要度→快到期）。
    if (!useFilter) {
      items = items.slice().sort(function (a, b) {
        var ao = (a.node.status === 'done' || a.node.status === 'dropped') ? 1 : 0
        var bo = (b.node.status === 'done' || b.node.status === 'dropped') ? 1 : 0
        return ao - bo
      })
    }
    var openCount = 0
    for (var n = 0; n < items.length; n++) if (isOpen(items[n].node)) openCount++
    var cards = items.map(function (it) {
      var ids = it.path.split(' / ')
      ids.pop()                                  // 去掉自身
      var ctx = ids.slice(1)                      // 去掉顶层归属（列本身已经代表它）
        .map(function (id) { return index[id] !== undefined ? index[id].title : id })
        .join(' / ')
      return { node: it.node, path: ctx }
    })
    var m = meta[gid]
    cols.push({
      id: gid,
      kind: m.kind,
      title: m.kind === 'inbox' ? '收件箱' : m.node.title,
      progress: m.kind === 'plan' ? progressOf(m.node) : null,
      total: items.length,
      open: openCount,
      cards: cards,
    })
  }
  return cols
}

// -------------------------------------------------------------- 归位候选

/**
 * 「这个待办能移到哪儿去」——面板的归位选择器用它。
 * 候选是所有计划节点（深度不限），带缩进路径便于区分同名计划；
 * 当前所在位置被排除掉（移到原地没有意义）。
 */
function moveTargets(plan, node) {
  var currentParent = null
  if (node !== null && node !== undefined) {
    var flat = flattenNodes(plan)
    for (var i = 0; i < flat.length; i++) {
      if (flat[i].node === node) {
        // 摊平表里节点自身的 path 是「父 / 自己」，去掉最后一段就是父路径。
        var parts = flat[i].path.split(' / ')
        parts.pop()
        currentParent = parts.length > 0 ? parts[parts.length - 1] : null
        break
      }
    }
  }
  var out = []
  var walk = function (n, depth) {
    var kids = childrenOf(n)
    for (var i = 0; i < kids.length; i++) {
      var kid = kids[i]
      if (nodeType(kid) === 'plan' && kid !== node && (currentParent === null || kid.id !== currentParent)) {
        out.push({ id: kid.id, title: kid.title, depth: depth, path: kid.id })
      }
      walk(kid, depth + 1)
    }
  }
  var roots = planNodes(plan)
  for (var i = 0; i < roots.length; i++) {
    if (nodeType(roots[i]) === 'plan' && roots[i] !== node) {
      out.push({ id: roots[i].id, title: roots[i].title, depth: 0, path: roots[i].id })
    }
    walk(roots[i], 1)
  }
  return out
}

// ------------------------------------------------- 就地编辑辅助（折叠 / 拖拽）

/** 折叠状态在 localStorage 里的键。只影响这一台浏览器的显示，不进 plan.json。 */
var COLLAPSE_KEY = 'dsh-workbench:collapsed'

/**
 * 折叠状态：把 localStorage 里那串 JSON 解析成 id 数组。
 *
 * 单独抽出来是因为它要吃掉**脏数据**——用户手改过、旧版本写过、别的插件
 * 占了同一个键，都可能留下解析不了的东西。解析失败一律当「没折叠过」，
 * 绝不让一段坏字符串把整个面板打崩（显示层面的偏好不值得用可用性去换）。
 */
function parseCollapsed(raw) {
  if (typeof raw !== 'string' || raw === '') return []
  var data = null
  try { data = JSON.parse(raw) } catch (e) { return [] }
  if (!Array.isArray(data)) return []
  var out = []
  for (var i = 0; i < data.length; i++) {
    if (typeof data[i] === 'string' && data[i] !== '') out.push(data[i])
  }
  return out
}

/** 折叠状态 → 可写回 localStorage 的字符串（排序后再写，便于人肉对 diff）。 */
function serializeCollapsed(ids) {
  var list = Array.isArray(ids) ? ids.slice() : []
  list.sort()
  return JSON.stringify(list)
}

/** 节点下面一共挂着多少个后代（折叠时提示「藏了几条」）。 */
function descendantCount(node) {
  var kids = childrenOf(node)
  var n = 0
  for (var i = 0; i < kids.length; i++) n += 1 + descendantCount(kids[i])
  return n
}

/**
 * ref 是否落在 ancestor 的子树里（不含 ancestor 自己）。
 *
 * 与 host 半身 store.js 的 `isDescendantOf` **同语义、不同实现**：那边反复
 * 调 locate（每层从上往下找一遍），这边一趟递归下去（拖拽每帧都要问，不能
 * 每次 O(n·深度)）。签名也不同——这边不需要 plan，因为是从 ancestor 往下找。
 * 两边的一致性由 test/logic.test.mjs 在所有节点对上逐一比对来钉住。
 *
 * 比较用 id 而不是对象身份：面板拿到的树是 host annotate() 重新造过的对象图，
 * 身份只在同一份 payload 内成立，而 id 在任何一份拷贝里都成立。
 */
function isDescendantOf(node, ancestor) {
  if (node === null || node === undefined || typeof node !== 'object') return false
  if (ancestor === null || ancestor === undefined || typeof ancestor !== 'object') return false
  if (node.id === undefined || node.id === null) return false
  var id = String(node.id)
  var kids = childrenOf(ancestor)
  for (var i = 0; i < kids.length; i++) {
    var kid = kids[i]
    if (kid === null || kid === undefined || typeof kid !== 'object') continue
    if (kid === node || String(kid.id) === id) return true
    if (isDescendantOf(node, kid)) return true
  }
  return false
}

/**
 * 拖拽落点 → node-move 的参数 `{ node, parent, index }`；落点非法或等于原地时返回 null。
 *
 * 语义分三档，对应行内的三段高度：
 *   before  插到这一行前面（成为它的同级）
 *   after   插到这一行后面（成为它的同级）
 *   inside  放进这一行里面（只有计划能当容器——待办是叶子）
 *
 * **返回 null 而不是「尽力而为」**：调用方据此决定要不要 preventDefault，
 * 浏览器于是自己在非法落点显示禁止光标。服务端还会再拦一次（不变量归数据层），
 * 这里只是为了不让用户白拖一趟。
 *
 * 关于 `index`：/node-move 的解释是「**先把节点摘掉**，再在此下标插入」
 * （见 store.js 的 moveNode），所以这里必须也在摘掉拖拽节点之后的列表里算位置。
 * 不然同层往后拖会稳定差一位——这种错很难一眼看出来，因为多数情况下
 * 看起来只是「顺序没完全对」。
 */
function dropTarget(plan, dragId, refId, place) {
  if (plan === null || plan === undefined || typeof plan !== 'object') return null
  if (typeof dragId !== 'string' || dragId === '') return null

  // 一趟递归同时建出「按 id 索引的节点 + 父节点 + 同级下标 + 同级数组」，
  // 后面所有判断都查这张表，不再各自遍历。
  var info = {}
  var walk = function (list, parent) {
    for (var i = 0; i < list.length; i++) {
      var n = list[i]
      if (n === null || n === undefined || typeof n !== 'object') continue
      var id = String(n.id)
      info[id] = { node: n, parent: parent, index: i, siblings: list }
      walk(childrenOf(n), n)
    }
  }
  walk(planNodes(plan), null)

  var from = info[dragId]
  if (from === undefined) return null

  var refKey = refId === null || refId === undefined ? '' : String(refId)
  if (refKey === dragId) return null

  var sameParent
  var toParentId
  var at

  if (refKey === '') {
    // 落在空白处 → 移回顶层末尾（收件箱）。这是**拖**着归位的那条路，
    // 与 ↳ 选择器并存：选择器适合跨很远的目标，拖动适合挪到眼前的位置。
    sameParent = from.parent === null
    toParentId = null
    at = sameParent ? from.siblings.length - 1 : planNodes(plan).length
  } else {
    var ref = info[refKey]
    if (ref === undefined) return null
    // 不能拖进自己的子树：那不是排序，是把节点摘出来再塞回自己下面（成环）。
    if (isDescendantOf(ref.node, from.node)) return null

    if (place === 'inside') {
      if (nodeType(ref.node) !== 'plan') return null
      toParentId = refKey
      sameParent = from.parent !== null && String(from.parent.id) === refKey
      // 追加为最后一个子项：下标 = 摘掉自己之后的子节点数。
      at = childrenOf(ref.node).length - (sameParent ? 1 : 0)
    } else {
      toParentId = ref.parent === null ? null : String(ref.parent.id)
      sameParent = ref.parent === null
        ? from.parent === null
        : (from.parent !== null && ref.parent.id === from.parent.id)
      at = ref.index + (place === 'after' ? 1 : 0)
      // 同层时把下标换算到「摘掉自己之后」的坐标系：自己原本在目标之前，
      // 摘掉后后面所有节点前移一位。
      if (sameParent && from.index < at) at -= 1
    }
  }

  // 落点就是原地 → 什么都不做。不判这一条的话，一次「拖回原处」也会写盘
  // 并留下一个版本快照，把版本历史冲淡成噪声。
  if (sameParent && at === from.index) return null

  return { node: dragId, parent: toParentId, index: at }
}

// ------------------------------------------------------- AI 入口：图片编码

var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * 字节数组 → base64。
 *
 * 不用 btoa：它只吃 Latin-1 字符串，要先 String.fromCharCode(...bytes) 展开，
 * 一张 3MiB 的截图会把参数栈直接撑爆（RangeError）。而且这个面板跑在浏览器里，
 * 但**测试跑在 Node 里**——自己实现一份，两边行为一致、也能单测。
 *
 * 图片必须先转成 base64 才能进 JSON 请求体（host 侧的 attachments.saveImages
 * 收的就是「声明类型 + base64」）。
 */
function bytesToBase64(bytes) {
  var out = ''
  var len = bytes === null || bytes === undefined ? 0 : bytes.length
  for (var i = 0; i < len; i += 3) {
    var b0 = bytes[i]
    var b1 = i + 1 < len ? bytes[i + 1] : 0
    var b2 = i + 2 < len ? bytes[i + 2] : 0
    out += B64[b0 >> 2]
    out += B64[((b0 & 3) << 4) | (b1 >> 4)]
    // 不足三字节时补 '='：这是 base64 的定长填充约定，少一个 host 侧就会拒收。
    out += i + 1 < len ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '='
    out += i + 2 < len ? B64[b2 & 63] : '='
  }
  return out
}

/** 一次 AI 解析最多带几张图（与 host 的 MAX_IMAGES 对应，超限由 host 拦）。 */
var AI_MAX_IMAGES = 4

/** 挑出「还能加几张」：超出的直接丢掉，并告诉用户丢了几张。 */
function pickImages(files, existing) {
  var room = AI_MAX_IMAGES - (existing === null || existing === undefined ? 0 : existing.length)
  if (room <= 0) return { picked: [], dropped: (files || []).length }
  var picked = []
  for (var i = 0; i < (files || []).length; i++) {
    if (picked.length >= room) break
    picked.push(files[i])
  }
  return { picked: picked, dropped: (files || []).length - picked.length }
}

if (typeof window === 'undefined' && typeof module !== 'undefined' && module.exports) {
  module.exports = {
    pct: pct,
    barWidth: barWidth,
    nodeType: nodeType,
    childrenOf: childrenOf,
    planNodes: planNodes,
    inboxOf: inboxOf,
    topPlans: topPlans,
    typeLabel: typeLabel,
    progressOf: progressOf,
    sortNodes: sortNodes,
    statusLabel: statusLabel,
    toggleStatus: toggleStatus,
    isOpen: isOpen,
    todayStr: todayStr,
    summarize: summarize,
    priorityLabel: priorityLabel,
    priorityRank: priorityRank,
    nextPriority: nextPriority,
    delegateLabel: delegateLabel,
    delegateText: delegateText,
    EVIDENCE_KINDS: EVIDENCE_KINDS,
    evidenceLabel: evidenceLabel,
    evidenceList: evidenceList,
    FILE_KINDS: FILE_KINDS,
    fileLabel: fileLabel,
    filesList: filesList,
    obsidianLink: obsidianLink,
    STATUS_LIST: STATUS_LIST,
    PRIORITIES: PRIORITIES,
    statusListOf: statusListOf,
    formDraftOf: formDraftOf,
    emptyDraft: emptyDraft,
    formRequest: formRequest,
    formErrors: formErrors,
    planByName: planByName,
    blockersOf: blockersOf,
    todoList: todoList,
    matchTaskTitles: matchTaskTitles,
    loadViews: loadViews,
    saveViews: saveViews,
    viewItems: viewItems,
    VIEWS_KEY: VIEWS_KEY,
    unverifiedOf: unverifiedOf,
    paceText: paceText,
    flattenNodes: flattenNodes,
    FILTERS: FILTERS,
    focusList: focusList,
    filterCounts: filterCounts,
    upcomingByDay: upcomingByDay,
    deferDate: deferDate,
    dayLabel: dayLabel,
    boardColumns: boardColumns,
    moveTargets: moveTargets,
    COLLAPSE_KEY: COLLAPSE_KEY,
    parseCollapsed: parseCollapsed,
    serializeCollapsed: serializeCollapsed,
    descendantCount: descendantCount,
    isDescendantOf: isDescendantOf,
    dropTarget: dropTarget,
    bytesToBase64: bytesToBase64,
    pickImages: pickImages,
    AI_MAX_IMAGES: AI_MAX_IMAGES,
  }
}
