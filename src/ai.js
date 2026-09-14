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

import { PRIORITY, collectNodes, suggestParent, todayStr } from './store.js'

/** 一次最多解析出多少条。多了用户也不会逐条看，还会把面板撑长。 */
export const MAX_TASKS = 20

/** 一次最多带几张图。图片按 base64 走请求体，多了既慢又贵。 */
export const MAX_IMAGES = 4

/** 归一：去空白与标点，便于「模型复述的标题」与「库里的标题」做包含比较。 */
function norm(text) {
  return String(text === null || text === undefined ? '' : text).replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase()
}

const isStr = (v) => typeof v === 'string' && v.trim() !== ''

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
 * 解析用的系统提示词。要求**只回一个 JSON 对象**，并且把「没有把握就留空」
 * 写成明确指令——否则模型为了显得有用，会给每条都硬塞一个计划名和一个日期。
 */
export function aiSystemPrompt(outline, today = todayStr()) {
  return [
    '你是工作计划的录入助手。用户会给你一段口述转写文字、会议纪要，或一张截图（白板 / 清单 / 聊天记录）。',
    '把它拆成一条条**待办**，并为每条判断该归到哪个计划下。',
    '',
    '今天是 ' + today + '。',
    outline === ''
      ? '这个工作区目前还没有任何计划。'
      : '现有计划如下（「父计划 / 子计划」表示层级）：\n' + outline,
    '',
    '只输出一个 JSON 对象，不要任何解释、不要 Markdown 代码围栏。格式：',
    '{"tasks":[{"title":"待办标题","due":"YYYY-MM-DD 或留空","priority":"high|normal|low 或留空","note":"备注或留空","plan":"计划名或留空"}]}',
    '',
    '规则：',
    '1. title 必填，一句话说清要做什么，不要带序号、不要带「完成」这类状态词。',
    '2. due 只有**明确说了时间**才填（「下周三」「9月20日前」都要换算成具体日期）；没说就留空字符串，不要猜。',
    '3. priority 只有明确说了「重要/紧急/必须」才填 high，明确说了「有空再做」才填 low，其余留空。',
    '4. plan 从上面现有计划里**原样抄一个标题**；如果确实都不合适，就填一个新计划的名字（要新建时用）；判断不了就留空。',
    '5. 一条口述里含多件事就拆成多条；同一件事的补充说明合并进 note，不要单独成条。',
    '6. 最多 ' + MAX_TASKS + ' 条，按原文顺序。',
  ].join('\n')
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

/**
 * 解析模型回复，得到一组**字段已收敛**的待办。
 * 返回 { tasks, error }：一条都捞不出来时 error 是一句人话，由路由原样抛给面板。
 */
export function parseAiReply(raw) {
  const parsed = extractJson(raw)
  if (parsed === null) return { tasks: [], error: '模型没有给出能解析的 JSON：' + clip(String(raw ?? '')) }
  const list = Array.isArray(parsed) ? parsed
    : (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.tasks) ? parsed.tasks : null)
  if (list === null) return { tasks: [], error: '模型给出的 JSON 里没有 tasks 数组' }

  const tasks = []
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    // 模型偶尔把整条塞进 { task: {...} } 或给 value/title 之外的键名，这里一并认。
    const src = (item.task !== null && typeof item.task === 'object') ? item.task : item
    const title = isStr(src.title) ? String(src.title).trim()
      : (isStr(src.name) ? String(src.name).trim() : '')
    if (title === '') continue
    tasks.push({
      title: title.slice(0, 200),
      due: normDue(src.due),
      priority: normPriority(src.priority),
      note: isStr(src.note) ? String(src.note).trim().slice(0, 500) : '',
      // 模型点名的计划（名字，不是 id）——交给 matchPlan 去比对。
      plan: isStr(src.plan) ? String(src.plan).trim().slice(0, 100) : '',
    })
    if (tasks.length >= MAX_TASKS) break
  }
  if (tasks.length === 0) return { tasks: [], error: '模型没有给出任何待办标题' }
  return { tasks, error: '' }
}

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
    candidates.push({ kind: 'inbox', title: '收件箱', why: '先记下来，之后再归位' })
    // ④ 模型点名了但对不上任何现有计划 → 它想说的是「新建一个」。
    //    没点名也给这个候选（名字留空），因为「新建计划」是用户明确要的选项，
    //    不能因为模型没说就不给。
    candidates.push({
      kind: 'new',
      title: named === null ? task.plan : '',
      why: named === null && task.plan !== '' ? '模型建议新建一个计划' : '新建一个计划再放进去',
    })
    out.push(Object.assign({}, task, { candidates }))
  }
  return out
}

/**
 * 把一次流式调用收成一段文本。
 *
 * 只取 text-delta，不看 reasoning-delta（思考过程不是给用户的答案）。
 * finish 的三种坏结局都要变成**看得懂的错误**——「error / aborted / max-tokens」
 * 在界面上都长一样的话，用户只会以为「AI 坏了」。
 */
export async function collectText(llm, options) {
  let text = ''
  let finish = null
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
    if (finish.kind === 'max-tokens') throw new Error('模型回复被长度上限截断，素材可能太长，少说一点再试')
  }
  return text
}
