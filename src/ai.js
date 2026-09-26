/**
 * dsh-workbench —— AI 入口的「解析」半边（Host 侧）。
 *
 * 职责边界：把一段语音转写文本或一张图片交给模型，换回一组**结构化待办**，
 * 再用已有规则补上「该归到哪个计划」的建议。**不写入任何数据**——采纳哪条、
 * 建在哪儿，由用户点了之后走原有的 /node-add。
 *
 * 为什么单独一个文件：host 半身原来只有 index.js（工具 + 路由）和 store.js
 * （数据层），这块的职责是**与模型打交道**——提示词长什么样、回复怎么解析、
 * 模型输出怎么收敛成合法字段。除了真正发起调用的那个循环，其余全是纯函数，
 * 放在这里可以逐条写进 test/ai.test.mjs，改提示词或解析规则时能立刻看见行为变化。
 *
 * 三个刻意的取舍：
 *
 *   1. **归位建议不交给模型**。模型只回答「这条待办属于哪个计划（用名字说）」，
 *      真正的候选列表由 `suggestParent`（store.js 里那个纯函数）算出来。
 *      理由与「语音记待办」那次一致：建议必须**可解释**、且**面板与 agent 同一份**。
 *      让模型直接给 id，它编一个不存在的 id 我们无从校验，而给名字的话
 *      `matchPlan` 还能兜底匹配、匹配不上就退化成「新建计划」。
 *   2. **回复解析要能扛住模型的坏习惯**。代码围栏、前后寒暄、把 JSON 写成单引号，
 *      这些都不是「异常情况」，是常态。所以 `parseAiReply` 做的是「尽力捞出一个
 *      JSON」，捞不到才报错，而不是 `JSON.parse(raw)` 一把梭。
 *   3. **字段一律可选、缺省即旧行为**。模型没给 due 就不给，没给 priority 就是
 *      中——不要替它编一个值出来（编出来的截止日期会直接进到逾期统计里）。
 */

import {
  PRIORITY,
  collectNodes,
  delegatedList,
  evidenceOf,
  filesOf,
  historyHints,
  isDueWithin,
  isOverdue,
  nodeProgress,
  priorityOf,
  suggestParent,
  todayStr,
  typeOf,
  unverifiedList,
} from './store.js'

/** 取非空字符串（store 的 opt 没导出，这里只用它这一种形态）。 */
function s(v) {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : ''
}

const pct = (n) => String(Math.round((Number(n) || 0) * 100)) + '%'

/** 一次最多解析出多少条。多了用户也不会逐条看，还会把面板撑长。 */
export const MAX_TASKS = 20

/**
 * 一次调用最多让模型输出多少 token。
 *
 * **这个数必须放得下提示词自己要的东西**：系统提示让模型给「最多 MAX_TASKS 条」，
 * 每条带 title / due / priority / note / plan / advice，再加 2–3 个 options
 * （每个都有 label + why + patch），外面还有一段 4~6 行的 reply。
 * 20 条 × 约 180 token ≈ 3600，加上 reply 与 JSON 骨架，2048 是**装不下的**——
 * 而原来的 2048 就是这么来的：提示词与额度各写各的，谁也没跟谁对齐。
 *
 * 症状很好认：**拍照 → 拆待办**这条路最容易撞上，因为一张清单照片会让模型
 * 老老实实吐十几条；一撞上就是 finish=max-tokens，面板上什么内容都没有，
 * 只挂一句「被长度上限截断」。
 */
export const MAX_OUTPUT_TOKENS = 8192

/** 一次最多带几张图。图片按 base64 走请求体，多了既慢又贵。 */
export const MAX_IMAGES = 4

/** 归一：去空白与标点，便于「模型复述的标题」与「库里的标题」做包含比较。 */
function norm(text) {
  return String(text === null || text === undefined ? '' : text).replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase()
}

const isStr = (v) => typeof v === 'string' && v.trim() !== ''

/**
 * 默认人设。它会被写进 `plan/agents.md`，之后由人在这份文件上持续改。
 *
 * 为什么人设要放在文件里而不是写死在提示词里：助手的「性格与专业」是**这个
 * 工作区的事**——有人要它冷峻只报事实，有人要它像个催促进度的搭档。写死在
 * 代码里，改一句话就得发一版；放在工作区文件里，改完立刻生效。
 */
export const DEFAULT_PERSONA = [
  '# 内置 AI 助手的人设',
  '',
  '## 性格',
  '- 直接、简短：先给结论，再给理由。不寒暄、不复述用户的话。',
  '- 有判断就直说：发现重复、依赖、明显排不动，要指出来，不要为了不得罪人而含糊。',
  '- 不确定就说不确定；绝不编造日期、进度，或引用不存在的文件。',
  '',
  '## 专业',
  '- 你是工作计划管理专家：熟悉目标拆解、周期与截止的设定、优先级取舍、委派与回执、',
  '  完成证据与复盘。用这套专业视角审视每一条新任务。',
  '- 输出意见时必须交代**依据**：引用当前任务 / 历史相似任务 / 关联资料里的具体名字。',
  '',
  '## 边界',
  '- 只建议、不擅自改数据：所有新增与修改都要由人点确认（插件本身也保证了这点）。',
  '- 日期只在用户明确说了时间时才填；优先级只在明确说了重要 / 紧急时才填高。',
  '',
  '## 记住的事',
  '- （在这里补充你的偏好，例如：周报只看三个方向、周五下午不排新活。）',
].join('\n')

/**
 * 给模型看的**全量上下文**：不只是计划大纲，而是「当前 + 归纳」的全部信息。
 *
 * 为什么要单独构造一份：模型要能回答「我现在该做什么」「哪些逾期了」这类问题，
 * 光给一个计划标题列表答不了；但把整个 plan.json 塞进去又太长、且全是 id 噪音。
 * 所以按**人读得懂的方式**压成几段：方向 / 手上的活 / 逾期与本周 / 委派 /
 * 最近完成 / 待核验 / 关联资料。
 *
 * **只给标题与状态，不给 id**：与 `planOutline` 同一个理由——模型看到 id 就会
 * 复述 id，而我们无法校验它编的 id；需要定位时由 `matchPlan` 按标题反查。
 */
export function aiContext(plan, today = todayStr(), options = {}) {
  const limit = Number(options.limit) > 0 ? Number(options.limit) : CONTEXT_LIMIT
  const all = collectNodes(plan, 'any')
  const open = all.filter((x) => x.node.status !== 'done' && x.node.status !== 'dropped')
  const out = []

  // ① 方向：顶层计划就是方向（不为此新增一个概念）。带进度与负责人，
  //    模型回答「哪个方向没动」时才有依据。
  const roots = planNodesOf(plan)
  if (roots.length > 0) {
    out.push('【方向 / 顶层计划】')
    for (const n of roots.slice(0, limit)) {
      if (typeOf(n) !== 'plan') continue
      const bits = ['- ' + String(n.title ?? ''), '进度 ' + pct(nodeProgress(n))]
      const owner = s(n.owner)
      if (owner !== '') bits.push('负责人 ' + owner)
      const period = [s(n.start), s(n.end)].filter((x) => x !== '').join('~')
      if (period !== '') bits.push('周期 ' + period)
      if (n.status === 'done') bits.push('已完成')
      else if (n.status === 'dropped') bits.push('已放弃')
      out.push(bits.join('，'))
    }
  }

  // ② 手上的活：未完成的待办（叶子），带截止与重要程度。
  const todos = open.filter((x) => typeOf(x.node) === 'todo')
  if (todos.length > 0) {
    out.push('')
    out.push('【手上未完成的待办（共 ' + todos.length + ' 条）】')
    for (const x of todos.slice(0, limit)) {
      const bits = ['- ' + String(x.node.title ?? '')]
      const due = s(x.node.due)
      if (due !== '') bits.push('截止 ' + due)
      if (priorityOf(x.node) === 'high') bits.push('重要度高')
      if (x.node.status === 'doing') bits.push('进行中')
      const parent = parentTitleOf(plan, x.node)
      if (parent !== '') bits.push('属 ' + parent)
      out.push(bits.join('，'))
    }
    if (todos.length > limit) out.push('- ……还有 ' + (todos.length - limit) + ' 条')
  }

  // ③ 逾期 / 本周到期：这两类是要被**主动提醒**的，单独成段才不会被淹没。
  const overdue = open.filter((x) => isOverdue(x.node, today))
  const week = open.filter((x) => isDueWithin(x.node, 7, today))
  if (overdue.length > 0 || week.length > 0) {
    out.push('')
    if (overdue.length > 0) {
      out.push('【已逾期（' + overdue.length + '）】')
      for (const x of overdue.slice(0, limit)) out.push('- ' + String(x.node.title ?? ''))
    }
    if (week.length > 0) {
      out.push('【本周内到期（' + week.length + '）】')
      for (const x of week.slice(0, limit)) out.push('- ' + String(x.node.title ?? ''))
    }
  }

  // ④ 委派：等别人交活也是「手上的事」，且「问一句」与「催进度」是两种动作。
  const deleg = delegatedList(plan, today)
  if (deleg.length > 0) {
    out.push('')
    out.push('【委派出去的】')
    for (const d of deleg.slice(0, limit)) {
      const bits = ['- ' + String(d.title ?? ''), '给 ' + String(d.to ?? '')]
      if (d.overdueReceipt) bits.push('已逾期未回执')
      else if (d.overdueWork) bits.push('已逾期未完成')
      else bits.push(d.status === 'pending' ? '待接受' : '已接受')
      out.push(bits.join('，'))
    }
  }

  // ⑤ 最近完成：回答「最近在做什么」「上周干了啥」要靠它，也是「历史」的来源。
  const done = all
    .filter((x) => x.node.status === 'done' && s(x.node.doneAt) !== '')
    .sort((a, b) => String(b.node.doneAt).localeCompare(String(a.node.doneAt)))
  if (done.length > 0) {
    out.push('')
    out.push('【最近完成】')
    for (const x of done.slice(0, limit)) {
      const bits = ['- ' + String(x.node.title ?? ''), String(x.node.doneAt).slice(0, 10)]
      if (evidenceOf(x.node).length > 0) bits.push('附了证据')
      out.push(bits.join('，'))
    }
  }

  // ⑥ 完成但没证据：本插件独有的审查线，助手该主动提。
  const unver = unverifiedList(plan)
  if (unver.length > 0) {
    out.push('')
    out.push('【已完成但没有证据（' + unver.length + '）】')
    for (const u of unver.slice(0, limit)) out.push('- ' + String(u.title ?? ''))
  }

  // ⑦ 关联资料：告诉模型「这个计划挂了哪些文件」，它才说得出「去翻一下周会纪要」。
  const withFiles = all.filter((x) => filesOf(x.node).length > 0)
  if (withFiles.length > 0) {
    out.push('')
    out.push('【关联资料（Obsidian）】')
    for (const x of withFiles.slice(0, limit)) {
      const refs = filesOf(x.node).map((f) => String(f.ref ?? '')).join('、')
      out.push('- ' + String(x.node.title ?? '') + '：' + refs)
    }
  }

  return out.join('\n')
}

/** 上下文每段最多列多少条：再多 token 吃不消，也超过人能消化的量。 */
export const CONTEXT_LIMIT = 20

function planNodesOf(plan) {
  return Array.isArray(plan?.nodes) ? plan.nodes : []
}

/** 找一个节点的父计划标题（拿不到就算了——它只是上下文里的补充信息）。 */
function parentTitleOf(plan, node) {
  for (const hit of collectNodes(plan, 'plan')) {
    if (Array.isArray(hit.node.children) && hit.node.children.includes(node)) return String(hit.node.title ?? '')
  }
  return ''
}

/**
 * 「历史上做过的类似的事」的文本形态。给 capture 用：新增一条任务时，
 * AI 要能说「上次那条拖了 12 天」——没有这一段它只能凭空猜。
 */
export function historyText(plan, title, limit = 3) {
  const hints = historyHints(plan, title, limit)
  if (hints.length === 0) return ''
  const lines = []
  for (const h of hints) {
    const bits = ['- ' + h.title, h.status === 'done' ? '已完成' : '已放弃']
    if (h.doneAt !== null) bits.push(String(h.doneAt).slice(0, 10))
    if (h.days !== null) bits.push('从开工到完成 ' + h.days + ' 天')
    if (h.evidence > 0) bits.push('附了 ' + h.evidence + ' 条证据')
    lines.push(bits.join('，') + '（' + h.why + '）')
  }
  return lines.join('\n')
}

/**
 * 给模型看的计划大纲：只列**计划**（不列待办，待办是叶子、不是容器），
 * 用「祖先 / 父 / 自己」这种缩进路径表达层级。
 *
 * 不给 id：模型看到 id 就会倾向于复述 id，而它复述的 id 我们无法校验真假；
 * 给**标题路径**则天然可校验——`matchPlan` 拿它去比对，对不上就当「新建计划」。
 */
/**
 * 一次算出全部计划的「标题路径」（父 / 子）。
 * 与 planOutline 用的是同一套写法，所以模型复述的路径能反过来被 matchPlan 认出来。
 * collectNodes 是深度优先前序，父节点一定先于子节点出现，所以边走边查表是安全的。
 */
function planTitlePaths(plan) {
  const byId = new Map()
  const out = []
  for (const hit of collectNodes(plan, 'plan')) {
    const id = String(hit.node.id ?? '')
    const title = String(hit.node.title ?? '')
    byId.set(id, title)
    const parts = String(hit.path ?? '').split('/').map((p) => byId.get(p.trim()) ?? '').filter((p) => p !== '')
    out.push({ node: hit.node, path: parts.length > 0 ? parts.join(' / ') : title })
  }
  return out
}

export function planOutline(plan, limit = 40) {
  const lines = []
  for (const item of planTitlePaths(plan)) {
    if (lines.length >= limit) break
    const owner = typeof item.node.owner === 'string' && item.node.owner.trim() !== ''
      ? '（负责人 ' + item.node.owner.trim() + '）' : ''
    lines.push('- ' + item.path + owner)
  }
  return lines.join('\n')
}

/**
 * 系统提示词。**一个模型、两种职责**：既能回答关于计划的问题，也能把说的事
 * 拆成待办——用户一句话里常常两者都有（「把这三件事加进去，顺便告诉我哪些逾期」）。
 *
 * 关键取舍：
 *   - **上下文给「当前 + 归纳」**（`aiContext`）而不是只给计划大纲，否则
 *     「我现在该做什么」「哪个方向没动」这类问题根本答不了。
 *   - **历史相似任务单独一段**：新增任务时要能说「上次那条拖了 12 天」，
 *     没有这一段模型只能凭空猜。
 *   - **专家意见与选项要带依据**：`advice` 必须引用上下文里的具体名字，
 *     否则它会生成一段放之四海皆准的正确废话。
 *   - **人设来自工作区文件**（`plan/agents.md`），不在代码里写死。
 */
export function aiSystemPrompt(outline, today = todayStr(), options = {}) {
  const persona = typeof options.persona === 'string' && options.persona.trim() !== ''
    ? options.persona.trim() : DEFAULT_PERSONA
  const context = typeof options.context === 'string' ? options.context : ''
  const history = typeof options.history === 'string' ? options.history : ''
  return [
    '你是这个工作区的**内置工作计划助手**。你能做两件事，用户一句话里可能同时包含：',
    '  1) 回答关于工作计划的问题（随时可问：进展 / 逾期 / 该做什么 / 某个计划有哪些资料）；',
    '  2) 把用户说的事拆成待办（录入）。',
    '',
    '【你的人设（来自工作区 plan/agents.md）】',
    persona,
    '',
    '今天是 ' + today + '。',
    '',
    // 答题靠 context，归位靠 outline：两者都要给，前者是「知道什么」、
    // 后者是「能放到哪」的合法集合（标题路径，可被 matchPlan 反查）。
    context === ''
      ? '【当前全貌】这个工作区还没有任何计划与待办。'
      : '【当前全貌】\n' + context,
    '',
    outline === ''
      ? '【可归入的计划】目前没有任何计划（新建的待办就先待在顶层，之后可以给它加子项、变成计划）。'
      : '【可归入的计划】（「父计划 / 子计划」表示层级，plan 字段要原样抄其中一个标题）\n' + outline,
    history === '' ? '' : '\n【历史相似任务】（判断这次要多久、能不能排得动）\n' + history + '\n',
    '',
    '只输出一个 JSON 对象，不要任何解释、不要 Markdown 代码围栏。格式：',
    '{"reply":"给人看的回答（分行分点，不要写成一大段）","tasks":[{"title":"待办标题","due":"YYYY-MM-DD 或留空",',
    '"priority":"high|normal|low 或留空","note":"备注或留空","plan":"计划名或留空",',
    '"advice":"计划专家意见或留空","options":[{"label":"选项名","why":"为什么",',
    '"patch":{"due":"...","priority":"...","plan":"...","note":"..."}}]}],',
    '"list":{"title":"清单名","items":["任务标题","任务标题"]},',
    '"edits":[{"target":"已有任务的标题","patch":{"due":"...","priority":"...","plan":"...","note":"...","title":"..."},',
    '"why":"为什么这么改"}],',
    '"merges":[{"keep":"留下的那条标题","fold":["其余那些的标题"],"mode":"merge 或 children",',
    '"title":"合并后的标题或留空","why":"为什么"}],',
    '"deletes":[{"target":"要删掉的那条标题","why":"为什么该删"}]}',
    '',
    '规则：',
    '1. reply **必填**：回答用户的问题。**分行写**——一行一个点（以「· 」开头），最多 4~6 行，',
    '   每行短一点；**不要写成一大段**（面板是按行渲染的，长段落很难读）。',
    '   报事时说明拆出了什么，并指出最值得注意的一条风险（重复 / 依赖 / 排不动 / 与某个逾期项撞车）。',
    '1a. 当用户想要一份**清单或视图**（「明天在家能做的」「半小时以内能干完的」「按顺序该先做哪三件」），',
    '   给出 list：title 是清单名，items 从【当前全貌】里**原样抄**符合条件的任务标题；',
    '   清单要排好序（先做谁在后做谁），数量尊重用户说的（说三件就给三件）。',
    '2. title 必填（仅当有要记的事）：一句话说清要做什么，不带序号、不带「完成」这类状态词。',
    '3. due 只有**明确说了时间**才填（「下周三」「9月20日前」都要换算成具体日期）；没说就留空。',
    '4. priority 只有明确说了「重要/紧急/必须」才填 high，「有空再做」才填 low，其余留空。',
    '5. plan 从上面【可归入的计划】里**原样抄一个标题**；都不合适就填一个新计划名；',
    '   判断不了就留空（先待在顶层，之后可以再归位）。',
    '6. advice：**以计划专家的身份**给一条意见，必须引用【当前全貌】或【历史相似任务】里的',
    '   具体名字（例如「与手上的「补台账」几乎重复」「历史上「台区排查」从开工到完成用了 12 天」）。',
    '   没有依据就留空——不要写正确的废话。',
    // ── 核心定位：你是助手，不是菜单 ────────────────────────────────────
    //
    // 用户原话：「你的建议要很综合，要了解了之后究竟要做什么，提出个最佳的建议，
    // 而不是什么东西都提出来。还有可以选这么多东西，正常来说说一句话就选一个就好了，
    // 你还选这么多东西吗？」以及「你的定位是智能工作计划助手，你要了解人家说什么，
    // 然后本来有什么，然后你就提出一个合理的选择给他就好了」。
    //
    // 这条纪律比「选项要合法」重要得多：一个把 5 条建议 × 每条 3 个选项全摊出来的
    // 助手，等于把决策整个推回给用户——那不是智能，那是把菜单印出来。
    '6a. **你是助手，不是菜单——给判断，别给一堆可能性。** 用户说一件事，你要：',
    '   ① 先看清他**真正要做什么**（「明天去踢球」是「加一条明天的待办」，不是「问明天有什么」）；',
    '   ② 再对照【当前全貌】**已有的东西**（那天是不是已经排满了？是不是已经有一条几乎一样的？',
    '   它该挂到哪个计划下？）；',
    '   ③ 然后给出**一个你认为最合理的结果**——tasks 里那一条就带着 due / priority / plan 填好，',
    '   那**就是**你的建议。不要为了「让用户自己选」而把字段留空。',
    '   **留空是「我判断不了」的意思，不是「请你选」**：判断得了就填上，判断不了才留空。',
    '6b. **options 不是必填项，而且最多 2 个。** 它只在「这件事确实有两个都合理的做法、',
    '   而且代价明显不同」时给（例如「今天赶完」vs「排到下周一」）。',
    '   同一件事的两种说法、或只是换个措辞的选项，**一律不要给**。',
    '   大部分时候它应该是空的——空着表示「我说的那个就是我的建议，你确认就行」。',
    '6c. **一条建议 = 一件要办的事，条数跟着素材走，不要人为多也不要人为少。**',
    '   · **一张清单照片 / 一段会议纪要**：里面本来就是十几条事，那就拆十几条——',
    '     逐条成 tasks，这正是用户拍那张照片要的东西。',
    '   · **语音说一句**（「明天去踢球」）：**就一条**。不要把它扩写成「新建 + 改期 + 归位」',
    '     好几条建议——那是一件小事被拆成三道手续。',
    '   · 判断标准是**用户素材里有几件独立的事**，不是「我想给几个建议」。',
    '   **不要把一件事拆成多条建议**（新建 + 改动 + 合并塞进同一轮）：那是把一个决定',
    '   拆成三道手续，用户还得逐条点。同一件事的补充说明并进 note。',
    '7. options：**最多 2 个**可选动作（可以没有），每个都要有 label 与 why；',
    '   patch 只可含 due / priority / plan / note 四个键，值要合法（due 是 YYYY-MM-DD，',
    '   priority 是 high|normal|low）。**给之前先自问：这两个真的都合理吗？**',
    '   如果其中一个明显更好，就把它填进 tasks 的字段里，options 留空。',
    '8. 一条口述含多件事就拆成多条；同一件事的补充说明合并进 note，不要单独成条。',
    '9. 最多 ' + MAX_TASKS + ' 条，按原文顺序。',
    '9z. **【当前全貌】里已经有的任务，绝不要再给一条 tasks。** 用户说的那件事要是',
    '   已经存在（标题一样或就是一回事），那是「要改它 / 要挪它 / 要并它」，不是',
    '   「再建一条」——走 edits 或 merges。同名再建一条等于制造重复，用户还得自己删。',
    '9a. **改动已有任务**（「把 X 的截止改到周五」「X 挪到某计划下」「X 加一句备注」）：放进 edits。',
    '   target **必须是从【当前全貌】里原样抄下来的标题**，一个字都不要改写、不要自己起名字；',
    '   patch 只可含 due / priority / plan / note / title 五个键，只放**要改的那几个**——',
    '   没提到的键不要出现在 patch 里（那表示「不改」，不是「清空」）。',
    '   只改已有的东西时**不要**再给一条同名 tasks：那是「新建一条」的意思，会变成两条。',
    '9b. **合并任务**（「A 和 B 其实是一件事」「把这两条并起来」「把这几条归到一个计划下面」）：放进 merges。',
    '   keep 是**留下的那条**、fold 是**其余那些**（都必须是原样标题）；fold 至少一条、不能含 keep 自己。',
    '   **mode 有两种，按用户的意思选——不要一律当成删除**：',
    '   · mode="merge"：**并进去、然后删掉**（同一件事的重复条目）。子项、证据、关联先并进 keep，再删 fold。',
    '   · mode="children"：**保留为子任务**。keep 变成一个计划，fold 里的每一条都**挪到 keep 下面**当它的子项，',
    '     **一条都不删**。用户原话：「我要的就是要把一些任务进行合并，然后作为计划，然后其他的作为它的子计划。」',
    '   判据：说「重复 / 是一件事 / 并进去」→ merge；说「作为子任务 / 子计划 / 归到一个计划下面 / 归到一起 /',
    '   收成一个计划 / 归到一起做」→ children。',
    '   **不要因为「你只能给标题」就反过来要用户把完整清单列出来**——能从【当前全貌】里挑出该挑的',
    '   就直接挑（挑不准就在 why 里说明你挑了哪些），最终由用户在卡片上确认。',
    '   **确认只有两种结果：全部并进去，或整条丢掉**（面板上没有逐条勾选）。所以**不要在 reply 里',
    '   承诺「可以只选其中几条」**——说了兑现不了，用户点下去才发现，比一开始说清更伤信任。',
    '   哪几条看着不该并，就**点名写进 why**（如「store.js、NAS 传输层像是另一个项目」），',
    '   让他自己在面板上把它们挪走。',
    '   留哪条挑**子项多的、在推进的那条**；title 留空表示沿用 keep 的标题，要改就写合并后的',
    '   （例如「A（含 B）」，或者一个能盖住这批事的总标题）。',
    '9c. **删除任务**（「把那条删掉」「这条不用了」）：放进 deletes。',
    '   target 必须是从【当前全貌】里原样抄下来的标题（与 edits 同一条纪律）；',
    '   why 写清**为什么该删**（重复 / 已作废 / 记错了）——它是删除卡上唯一的判断依据，',
    '   空着等于让用户盲删。**删一条能合并的就走 merges，不要用 deletes**：',
    '   合并留下的是「这件事」，删除丢的是「可能还有用的信息」。',
    '   删除是**不可逆**的，所以它只会变成一张卡，用户点确认才真的删——',
    '   不要因为「不能直接执行」就拒绝给这条建议，那不是你该管的事。',
    '10. 不要编造：上下文里没有的日期、文件、完成记录一律当作不存在。',
  ].filter((x) => x !== '' && x !== undefined).join('\n')
}

/** 用户素材的包装：用显式分隔符把原文框起来，避免原文里的引号/括号破坏结构。 */
export function aiUserText(text) {
  return '下面是原始素材，请按系统提示拆成待办：\n<<<\n' + String(text ?? '') + '\n>>>'
}

/**
 * 从模型回复里捞 JSON。
 *
 * 模型几乎一定会包 ```json 围栏，有时还会在前后加一句「好的，如下」。所以：
 *   ① 去掉围栏；② 从第一个 `{` 或 `[` 开始，按括号配平截断到与之匹配的那个右括号；
 *   ③ 再 JSON.parse。这样即使前后有寒暄也能捞出来。
 *   ④ 括号配平走到底也没闭上（= 回复被输出长度上限截断）时，**退回「补括号」那条路**。
 */
export function extractJson(raw) {
  let s = String(raw ?? '')
  // 围栏：```json ... ``` 或 ``` ... ```
  const fenced = s.match(/```(?:json|JSON)?\s*([\s\S]*?)```/)
  if (fenced !== null && fenced[1] !== undefined) s = fenced[1]
  const start = s.search(/[{\[]/)
  if (start < 0) return null
  const open = s[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inStr = false
  let escaped = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; continue }
    if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)) } catch (e) { return null }
      }
    }
  }
  // 没闭上：被截断了，试着重建成「完整的前缀」。
  return repairTruncatedJson(s, start)
}

/**
 * 把一段**被截断的** JSON 补成合法的：从 `end` 往前扫出还没闭合的括号栈，按栈反向补上。
 * 只补括号、不猜内容——所以「截在某个完整对象之后」能救回来，
 * 「截在一个字符串中间」救不回来（那本来就无从猜起）。
 */
/**
 * 把一段**被截断的** JSON 补成合法的：从 `end` 往前扫出还没闭合的括号栈，按栈反向补上。
 *
 * 两种截断都能救：
 *   · 截在括号之间（`{"a":1,"b":[1,2`）——补上缺的右括号即可，本函数一直这么做；
 *   · **截在一个字符串中间**（`{"reply":"· 拆出 1 条：回家过中秋…`）——这是后加的。
 *     真实故障（mimo-v2.6-flash 把一大段分析塞进 reply，输出预算耗尽）就是这种：
 *     原先 `inStr → return null` 让所有落点都被拒，整次调用报「模型没有给出能解析的
 *     JSON」，而**关键信息其实已经在吐出来的那段字里了**（用户看到的正是这个）。
 *     现在改成先闭合那个未终结的字符串，再补括号——捞回「已经说出口的部分」，
 *     而它在语义上就是模型已经给定的答案。
 *
 * 仍然不猜内容：不补任何键值，只负责把引号/括号配平。
 */
function closeJsonAt(s, end) {
  const stack = []
  let inStr = false
  let escaped = false
  for (let i = 0; i <= end; i++) {
    const c = s[i]
    if (inStr) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; continue }
    if (c === '{' || c === '[') stack.push(c)
    else if (c === '}' || c === ']') stack.pop()
  }
  // 尾部若是落单的反斜杠，闭合引号会把它自己转义掉，得先去掉——否则补出来的
  // 字符串永远合不上（`…abc\` + `"` 会被读成 `\"`）。
  let head = s.slice(0, end + 1)
  let tail = ''
  if (inStr) {
    if (escaped) head = head.slice(0, -1)
    tail = '"'
  }
  let out = tail
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i] === '{' ? '}' : ']'
  return head + out
}

/**
 * 回复被输出长度上限截断时的兜底：**把完整的那部分留下来**。
 *
 * 从后往前找「收在一个括号上」的落点，补上缺的右括号再解析，第一个解析得通的就是答案。
 * 于是 `{"reply":"…","tasks":[{…},{…},{半条` 会变成「那句 reply + 前两条」，
 * 而不是一句「截断了」把整次调用丢掉——被丢掉的往往**已经能用**。
 */
function repairTruncatedJson(s, start, maxCandidates = 400) {
  const ends = []
  for (let i = s.length - 1; i > start && ends.length < maxCandidates; i--) {
    if (s[i] === '}' || s[i] === ']') ends.push(i)
  }
  for (const end of ends) {
    const fixed = closeJsonAt(s, end)
    if (fixed === null) continue
    try { return JSON.parse(fixed) } catch (e) { /* 这个落点补不回来，往前再试 */ }
  }
  return null
}

const PRIORITY_ALIAS = { 高: 'high', 中: 'normal', 低: 'low', 紧急: 'high', 重要: 'high' }

/** 收敛重要程度：只认合法取值与中文别名，其余一律退回默认（不替模型猜）。 */
function normPriority(v) {
  if (typeof v === 'number') {
    if (v >= 3) return 'high'
    if (v <= 1) return 'low'
    return 'normal'
  }
  if (typeof v !== 'string') return ''
  const s = v.trim().toLowerCase()
  if (PRIORITY.includes(s)) return s
  const alias = PRIORITY_ALIAS[v.trim()]
  if (alias !== undefined) return alias
  return ''
}

/** 收敛日期：只认 YYYY-MM-DD，其它（含「下周三」这种没换算的）一律丢弃。 */
function normDue(v) {
  if (typeof v !== 'string') return ''
  const s = v.trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ''
}

/** 选项里允许出现的补丁字段（**不能**让它改别的——选项最终会进新建表单）。 */
const PATCH_KEYS = ['due', 'priority', 'plan', 'note']

/**
 * 收敛一个选项。label 没有就整条丢掉（没有名字的按钮没法点），
 * patch 里只认四个键、值不合法就丢该键——模型越界给的东西一律不落进表单。
 */
function normOption(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const label = isStr(raw.label) ? String(raw.label).trim().slice(0, 40) : ''
  if (label === '') return null
  const out = { label, why: isStr(raw.why) ? String(raw.why).trim().slice(0, 200) : '' }
  const patch = {}
  const src = (raw.patch !== null && typeof raw.patch === 'object') ? raw.patch : raw
  for (const key of PATCH_KEYS) {
    const v = src[key]
    if (key === 'due') {
      const d = normDue(v)
      if (d !== '') patch.due = d
    } else if (key === 'priority') {
      const p = normPriority(v)
      if (p !== '') patch.priority = p
    } else if (isStr(v)) {
      patch[key] = String(v).trim().slice(0, 200)
    }
  }
  if (Object.keys(patch).length > 0) out.patch = patch
  return out
}

/**
 * 解析模型回复，得到**一句人话 + 一组字段已收敛的待办**。
 *
 * 返回 { reply, tasks, error }。与旧版只回 tasks 不同：现在「只提问不录入」也
 * 是合法结果（tasks 为空、reply 非空），所以**不再**因为一条待办都没有就报错——
 * 那会把「纯提问」判成失败。
 */
export function parseAiReply(raw) {
  const parsed = extractJson(raw)
  if (parsed === null) return emptyParsed('模型没有给出能解析的 JSON：' + clip(String(raw ?? '')))
  if (Array.isArray(parsed)) {
    // 模型偶尔直接给一个数组（旧格式的习惯），按「只有 tasks」处理。
    return Object.assign(emptyParsed(''), { tasks: tasksOf(parsed) })
  }
  if (parsed === null || typeof parsed !== 'object') {
    return emptyParsed('模型给出的不是对象也不是数组')
  }
  const list = Array.isArray(parsed.tasks) ? parsed.tasks : []
  const reply = isStr(parsed.reply) ? String(parsed.reply).trim().slice(0, 2000) : ''
  const tasks = tasksOf(list)
  const edits = normEdits(parsed.edits)
  const merges = normMerges(parsed.merges)
  const deletes = normDeletes(parsed.deletes)
  // **判失败的依据是「一样产出都没有」**：只提问（reply）是合法结果、只给清单是、
  // 只给改动或合并、只提删除也是（「把那条没用的删掉」不需要新任务，也不需要回答）。
  // 这条目录要跟着新产出一块长——漏一个就会把新形态误判成失败（见坑 #25）。
  if (reply === '' && tasks.length === 0 && edits.length === 0 && merges.length === 0
    && deletes.length === 0 && normList(parsed.list) === null) {
    return emptyParsed('模型既没有回答，也没有给出待办或改动')
  }
  return { reply, tasks, edits, merges, deletes, list: normList(parsed.list), error: '' }
}

/** 一份「什么都没解析出来」的骨架——所有产出都用同一个形状，调用方不用判 undefined。 */
function emptyParsed(error) {
  return { reply: '', tasks: [], edits: [], merges: [], deletes: [], list: null, error }
}

/** 一次最多提几条改动 / 几组合并——它们都是「要人一条条过的」，多了人就不看了。 */
export const MAX_EDITS = 10

/**
 * 状态的中文口语 → 合法取值。
 * 「完成」这个词最容易出事：它既可能是状态，也可能是标题的一部分，所以这里只认
 * **整词**（前后没有别的字）；认不出就返回空串，宁可什么都不改。
 */
export function normStatus(v) {
  if (!isStr(v)) return ''
  const t = String(v).trim().toLowerCase()
  const map = {
    done: 'done', '完成': 'done', '已完成': 'done', '做完了': 'done', '已做完': 'done',
    doing: 'doing', '进行中': 'doing', '在做': 'doing', '开始做': 'doing', '开工': 'doing',
    todo: 'todo', '待办': 'todo', '未开始': 'todo', '还没做': 'todo',
    dropped: 'dropped', '放弃': 'dropped', '不做了': 'dropped', '取消': 'dropped', '搁置': 'dropped',
  }
  return map[t] === undefined ? '' : map[t]
}

/**
 * **改动已有任务**：{ target: 已有标题, patch: 只放要改的字段, why }。
 *
 * target 是**标题**不是 id——与 tasks.plan / list.items 同一条纪律：模型复述的 id
 * 无从校验，而标题它抄错时人一眼能看出来（host 还会把匹配不上的标出来）。
 * patch 的键是白名单：多一个键也不认（否则模型会顺手把 note 清空）。
 */
export function normEdits(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const target = isStr(item.target) ? String(item.target).trim().slice(0, 200) : ''
    if (target === '') continue
    const src = (item.patch !== null && typeof item.patch === 'object') ? item.patch : {}
    const patch = {}
    if (src.title !== undefined && isStr(src.title) && String(src.title).trim() !== '') patch.title = String(src.title).trim().slice(0, 200)
    if (src.due !== undefined) { const d = normDue(src.due); if (d !== '') patch.due = d }
    if (src.priority !== undefined) { const p = normPriority(src.priority); if (p !== '') patch.priority = p }
    if (src.note !== undefined && isStr(src.note)) patch.note = String(src.note).trim().slice(0, 500)
    if (src.plan !== undefined && isStr(src.plan) && String(src.plan).trim() !== '') patch.plan = String(src.plan).trim().slice(0, 100)
    // 状态 / 负责人 / 周期：同样是「说一句就能改」的东西（「这条标完成」「归张三」
    // 「下周一开始月底结束」）。白名单放宽的前提是**改动一律先过表单**——人确认那一下
    // 才是安全边界，不是字段个数。
    if (src.status !== undefined) { const st = normStatus(src.status); if (st !== '') patch.status = st }
    if (src.owner !== undefined && isStr(src.owner)) patch.owner = String(src.owner).trim().slice(0, 100)
    if (src.start !== undefined) { const d = normDue(src.start); if (d !== '') patch.start = d }
    if (src.end !== undefined) { const d = normDue(src.end); if (d !== '') patch.end = d }
    // 一个字段都没落到 patch 上 = 这条改动没有内容，丢掉（免得渲染出一张空卡）。
    if (Object.keys(patch).length === 0) continue
    // 可选项：同一件事有几种合理做法时（「改到周五」还是「挪到下周一」），
    // 模型给 2–3 个 label + patch，面板渲染成按钮让人挑——与草稿卡的 options 同构。
    // 注意：options 挂在**这条改动**上，不是挂在 patch 里（`src` 是 patch）——
    // 我第一版写成 src.options，结果永远读到 undefined，按钮一个都不出。
    const options = []
    if (Array.isArray(item.options)) {
      for (const o of item.options) {
        const opt = normOption(o)
        // normOption 在没有合法 patch 时**根本不返回 patch 键**（不是空对象），
        // 直接 Object.keys(opt.patch) 会抛。这种选项点下去什么都不会变，丢掉。
        if (opt !== null && opt.patch !== undefined) options.push(opt)
        if (options.length >= MAX_OPTIONS) break
      }
    }
    out.push({ target, patch, options, why: isStr(item.why) ? String(item.why).trim().slice(0, 500) : '' })
    if (out.length >= MAX_EDITS) break
  }
  return out
}

/**
 * **合并任务**：{ keep: 留下的标题, fold: [其余标题], mode, title: 合并后的标题或空, why }。
 *
 * 两种 mode，差别在**被并的那几条最后去哪**：
 *   · `merge`（默认）——并进去、然后删掉。给「这两条是一件事、重复了」用。
 *   · `children`——**保留为子任务**：keep 变成计划，fold 里的每一条都挪到它下面，一条都不删。
 *     给「把这几条归到一个计划下面」「合并成一个计划，其他作为子任务」用
 *     （用户原话：「我要的就是要把一些任务进行合并，然后作为计划，然后其他的作为它的子计划。」）。
 *
 * 缺省必须是 `merge` 而不是 `children`：判错的方向不一样——把 children 误判成 merge
 * 会**删掉用户的条目**，而把 merge 误判成 children 只是多留几条，改完再删也不迟。
 *
 * keep / fold 都是标题。host 会把两边都匹配回真实节点（匹配不上就标出来），
 * 并且**把「自己并进自己」这种无意义项剔掉**。
 */
/** children 模式一次能收多少条：用户是把**一批**任务归到一个计划下面（真机上是十来条），MAX_EDITS 那点不够用。 */
export const MAX_FOLD_CHILDREN = 30

/** 模型的 mode → 合法取值。认不出来的一律当 merge（保守：宁可多留，不要误删）。 */
export function normMergeMode(v) {
  if (!isStr(v)) return 'merge'
  const t = String(v).trim().toLowerCase()
  if (t === 'children' || t === 'child' || t === 'as-children' || t === 'as-children-tasks'
    || t === '子任务' || t === '子计划' || t === '保留' || t === '保留为子任务') return 'children'
  return 'merge'
}

export function normMerges(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const keep = isStr(item.keep) ? String(item.keep).trim().slice(0, 200) : ''
    if (keep === '') continue
    const mode = normMergeMode(item.mode)
    const fold = (Array.isArray(item.fold) ? item.fold : [])
      .filter((x) => isStr(x))
      .map((x) => String(x).trim().slice(0, 200))
      .filter((x) => x !== '' && x !== keep)
      .slice(0, mode === 'children' ? MAX_FOLD_CHILDREN : MAX_EDITS)
    if (fold.length === 0) continue
    out.push({
      keep,
      fold,
      mode,
      // 空 = 沿用 keep 的标题（模型不必为了「不改标题」编一个）。
      title: isStr(item.title) ? String(item.title).trim().slice(0, 200) : '',
      why: isStr(item.why) ? String(item.why).trim().slice(0, 500) : '',
    })
    if (out.length >= MAX_EDITS) break
  }
  return out
}

/**
 * 收敛「删除已有任务」的意图：{ target, why }[]。
 *
 * 用户原话：「我需要可以删除任务和合并任务，你要增加，在里面增加这个权限。」
 *
 * 背景：在这之前 schema 里**根本没有删除字段**，于是模型被要求删一条时只能回答
 * 「我不能直接执行，需要你在插件里点确认；schema 里也没有删除字段，我不会用改标题
 * 之类的动作伪装成删除」——**它说得对**，那时候确实没有这条路。现在补上。
 *
 * 与 edits / merges 同一条纪律：
 *   · target 必须是从【当前全貌】原样抄下来的标题（不是 id、不是它自己起的名字）；
 *   · **只是「提议」**——客户端渲染成一张卡，用户点确认才真的删。
 *     删除是不可逆的重动作，绝不能由模型一句话直接落库。
 *   · why 要写清「为什么该删」（重复 / 已作废 / 从未开始），空列表里那一行
 *     是用户唯一的判断依据。
 */
export function normDeletes(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const target = isStr(item.target) ? String(item.target).trim().slice(0, 200) : ''
    if (target === '') continue
    out.push({
      target,
      why: isStr(item.why) ? String(item.why).trim().slice(0, 500) : '',
    })
    if (out.length >= MAX_EDITS) break
  }
  return out
}

/**
 * AI **动态生成的清单**：{ title, items:[标题] }。
 *
 * items 里是**任务标题**而不是 id——与 plan 字段同一条纪律。host 侧会把标题
 * 匹配回真实节点，匹配不上的 ok=false 原样带回去，用户能看见 AI 指错了哪条。
 */
export function normList(raw) {
  if (raw === null || raw === undefined || typeof raw !== 'object' || !Array.isArray(raw.items)) return null
  const items = raw.items
    .filter((x) => isStr(x))
    .map((x) => String(x).trim().slice(0, 200))
    .filter((x) => x !== '')
    .slice(0, MAX_TASKS)
  if (items.length === 0) return null
  return {
    title: isStr(raw.title) ? String(raw.title).trim().slice(0, 100) : '',
    items,
  }
}

/** 把一组原始条目收敛成待办（含专家意见与选项）。 */
function tasksOf(list) {
  const tasks = []
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    // 模型偶尔把整条塞进 { task: {...} }，或给 value/name 之外的键名，这里一并认。
    const src = (item.task !== null && typeof item.task === 'object') ? item.task : item
    const title = isStr(src.title) ? String(src.title).trim()
      : (isStr(src.name) ? String(src.name).trim() : '')
    if (title === '') continue
    const options = []
    if (Array.isArray(src.options)) {
      for (const o of src.options) {
        const opt = normOption(o)
        if (opt !== null) options.push(opt)
        if (options.length >= MAX_OPTIONS) break
      }
    }
    tasks.push({
      title: title.slice(0, 200),
      due: normDue(src.due),
      priority: normPriority(src.priority),
      note: isStr(src.note) ? String(src.note).trim().slice(0, 500) : '',
      // 模型点名的计划（名字，不是 id）——交给 matchPlan 去比对。
      plan: isStr(src.plan) ? String(src.plan).trim().slice(0, 100) : '',
      advice: isStr(src.advice) ? String(src.advice).trim().slice(0, 500) : '',
      options,
    })
    if (tasks.length >= MAX_TASKS) break
  }
  return tasks
}

/** 每条待办最多给几个选项。三个以上就变成菜单了，人反而不看。 */
export const MAX_OPTIONS = 3

function clip(s) {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > 120 ? t.slice(0, 120) + '…' : (t === '' ? '（空回复）' : t)
}

/**
 * 把模型点名的计划名比对到库里的某个计划上。
 *
 * 三级匹配，从严到宽：标题完全相等 → 标题路径以它结尾（模型复述了「父 / 子」）→
 * 互相包含（取最长的那个，避免「数据」命中一堆）。都对不上返回 null，
 * 调用方据此把它的名字当成「要新建的计划名」。
 */
export function matchPlan(plan, hint) {
  const want = norm(hint)
  if (want === '') return null
  const plans = planTitlePaths(plan)
  for (const item of plans) {
    if (norm(item.node.title) === want) return item.node
  }
  for (const item of plans) {
    if (norm(item.path).endsWith(want)) return item.node
  }
  let best = null
  let bestLen = 0
  for (const item of plans) {
    const title = norm(item.node.title)
    if (title === '') continue
    const hit = title.includes(want) || want.includes(title)
    if (hit && title.length > bestLen) { best = item.node; bestLen = title.length }
  }
  return best
}

/**
 * 给每条解析出的待办补上「该放到哪儿」的候选。
 *
 * 候选来源按可信度排序，界面原样按这个顺序渲染：
 *   ① 模型点名且对上了库里的计划 —— 标「模型判断」；
 *   ② `suggestParent` 的规则打分（与收件箱那条待办用的是同一个函数、同一份权重）；
 *   ③ 收件箱（先记下来、之后再归位）——永远给，因为「不归属任何计划」也是合法选择；
 *   ④ 新建计划 —— 模型给了名字但没对上现有计划时，把它的名字作为默认值。
 *
 * 为什么规则打分还要留着：**它是解释得清的那一路**。模型给的判断没有理由，
 * 规则给的每条都带一句「与计划标题用词重合 2 处」。两者并列，用户能自己权衡。
 */
export function attachSuggestions(plan, tasks, today = todayStr()) {
  const out = []
  for (const task of tasks) {
    const candidates = []
    const seen = new Set()
    const named = task.plan === '' ? null : matchPlan(plan, task.plan)
    if (named !== null) {
      seen.add(String(named.id ?? ''))
      candidates.push({
        kind: 'plan',
        id: String(named.id ?? ''),
        title: String(named.title ?? ''),
        why: '模型判断归到这里',
      })
    }
    // suggestParent 吃的是节点，这里用待办的字段造一个临时的：它只看 title / due，
    // 不会写回任何东西。id 给一个不可能撞上的值，避免它把自己排除掉。
    for (const s of suggestParent(plan, { id: '__ai__', type: 'todo', title: task.title, due: task.due }, today, 3)) {
      if (seen.has(String(s.id))) continue
      seen.add(String(s.id))
      candidates.push({ kind: 'plan', id: String(s.id), title: String(s.title ?? ''), why: s.why })
    }
    // 「放着」而不是「收件箱」：顶层不再分栏，这个候选的含义是「先放顶层，
    // 之后再归位」——kind 名保留（面板与测试用它做判别），title 是给人看的。
    candidates.push({ kind: 'inbox', title: '先放着', why: '先放顶层，之后再归位' })
    // ④ 模型点名了但对不上任何现有计划 → 它想说的是「新建一个」。
    //    没点名也给这个候选（名字留空），因为「新建计划」是用户明确要的选项，
    //    不能因为模型没说就不给。
    candidates.push({
      kind: 'new',
      title: named === null ? task.plan : '',
      why: named === null && task.plan !== '' ? '模型建议新建一个计划' : '新建一个计划再放进去',
    })
    // 历史相似任务：面板要拿它显示「上次那条用了 12 天」，光靠模型的 advice 不够
    // ——模型的意见是自然语言，面板没法据此排序或展开。
    out.push(Object.assign({}, task, {
      candidates,
      history: historyHints(plan, task.title, 2),
    }))
  }
  return out
}

/**
 * 把一次流式调用收成 `{ text, truncated }`。
 *
 * 只取 text-delta，不看 reasoning-delta（思考过程不是给用户的答案）。
 *
 * **三种坏结局分开处理**：
 *   · `error` / `aborted` —— 真的失败了，抛「看得懂的错误」；
 *   · `max-tokens` —— **不是失败**：模型把话说完了能说的那部分，只是被额度截断。
 *     这里不再抛错（旧版抛错，等于把一份**往往已经能用的**回复整份丢掉，
 *     用户只看到一句「被截断」，照片里的待办一条也没出来）；改成把
 *     `truncated: true` 交给上层，由上层决定要不要提示、以及能不能从残缺的
 *     JSON 里把完整的那部分捞出来（见 extractJson 的补括号兜底）。
 */
export async function collectText(llm, options) {
  let text = ''
  let finish = null
  let truncated = false
  for await (const chunk of llm.stream(options)) {
    if (chunk === null || chunk === undefined) continue
    if (chunk.type === 'text-delta') text += String(chunk.text ?? '')
    else if (chunk.type === 'finish') finish = chunk.reason ?? null
  }
  if (finish !== null && typeof finish === 'object') {
    if (finish.kind === 'error' || finish.kind === 'aborted') {
      const failure = finish.failure
      const msg = failure !== null && failure !== undefined && typeof failure.message === 'string'
        ? failure.message : finish.kind
      throw new Error('模型调用失败：' + msg)
    }
    if (finish.kind === 'max-tokens') truncated = true
  }
  return { text, truncated }
}
