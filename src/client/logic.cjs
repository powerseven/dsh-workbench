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
function nodeType(node) {
  return node !== null && node !== undefined && node.type === 'plan' ? 'plan' : 'todo'
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

/** 收件箱：还没归位到任何计划下的顶层待办。 */
function inboxOf(plan) {
  var out = []
  var roots = planNodes(plan)
  for (var i = 0; i < roots.length; i++) {
    if (nodeType(roots[i]) === 'todo') out.push(roots[i])
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
  var out = String(d.to) + ' · ' + delegateLabel(d.status)
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
  { id: 'week', label: '本周到期' },
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
    unverifiedOf: unverifiedOf,
    paceText: paceText,
    flattenNodes: flattenNodes,
    FILTERS: FILTERS,
    focusList: focusList,
    filterCounts: filterCounts,
    moveTargets: moveTargets,
    COLLAPSE_KEY: COLLAPSE_KEY,
    parseCollapsed: parseCollapsed,
    serializeCollapsed: serializeCollapsed,
    descendantCount: descendantCount,
    isDescendantOf: isDescendantOf,
    dropTarget: dropTarget,
  }
}
