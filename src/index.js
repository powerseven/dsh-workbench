/**
 * dsh-workbench —— Host 半身。
 *
 * 提供两层接口，共用同一份数据（工作区内的 plan/ 目录）：
 *
 *   1. 模型工具（plan_*）—— 让 agent 直接读计划和回写进度。
 *      这是本插件相对普通待办应用的关键差异：AI 干完活可以自己把
 *      对应待办标记完成，进度不需要人来同步。
 *   2. /api/workbench/* HTTP 数据面 —— 浏览器侧边面板用。
 *
 * 工作区定位：每条工具调用都带着 agent，agent 的会话 header 里有 cwd，
 * plan/ 就建在那个目录下 —— 计划与产出同仓，可 git diff、可回溯。
 *
 * 工具面按「节点」而不是按「层级」组织（见 docs/SCOPE.md 第二步）：
 * 只有 node_add / node_set / node_move / node_remove 四个结构操作，
 * 作用在任意节点上；`type` 决定它是计划还是待办。原来的 goal/kr/task
 * 六件套是固定三层的产物——三套 API 做同一件事，agent 每次都得先想
 * 「这东西算 goal 还是 kr」，而这些区分对人本来就没有意义。
 *
 * 两个横切能力刻意**没有新工具**：落后预警是 `annotate` 算出来的派生量
 * （有 start + end 才有配速），完成证据是 `plan_node_set` / `plan_todo_set`
 * 上的一个可选参数。工具面按节点组织这条线要守住——每冒出一个概念就长一套
 * API，agent 花在「该用哪个」上的注意力迟早超过事情本身。
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  DELEGATE_STATUS,
  EVIDENCE_KIND,
  FILE_KIND,
  NODE_TYPE,
  PRIORITY,
  PlanStore,
  TODO_STATUS,
  TYPE_LABEL,
  addEvidence,
  addFile,
  appendChild,
  applyFields,
  behindList,
  childrenOf,
  controlSummary,
  delegateState,
  delegatedList,
  emptyPlan,
  evidenceOf,
  evidenceWarnings,
  fileWarnings,
  filesOf,
  inboxOf,
  isDescendantOf,
  isDueWithin,
  clearFields,
  collectNodes,
  addBlockedBy,
  assertManualDoneAllowed,
  autoCompleteAncestors,
  blockers,
  reopenAncestors,
  removeBlockedBy,
  setStar,
  setRecur,
  spawnRecurring,
  isOverdue,
  isUnverified,
  makeNode,
  moveNode,
  nodeProgress,
  nodeWarnings,
  paceOf,
  planNodes,
  planProgress,
  priorityOf,
  removeEvidence,
  removeFile,
  removeNode,
  resolveNode,
  setDelegate,
  setDelegateExpectAt,
  setPriority,
  setReceipt,
  setStatus,
  suggestParent,
  todoCounts,
  todayStr,
  typeOf,
  unverifiedList,
} from './store.js'
import {
  DEFAULT_PERSONA,
  MAX_IMAGES,
  MAX_OUTPUT_TOKENS,
  aiContext,
  aiSystemPrompt,
  aiUserText,
  attachSuggestions,
  collectText,
  historyText,
  parseAiReply,
  planOutline,
} from './ai.js'

export const name = 'dsh-workbench'
// 只声明 tools：llm / attachments 是**可选**依赖（宿主没有模型服务时工具照常能
// 用），所以不在 inject 里写死，改成用到的时候 ctx.get 现取、取不到就给一句人话。
export const inject = ['tools']

/** 一个工作区一个 store，按 cwd 缓存（避免每次调用重新建对象）。 */
const stores = new Map()

function storeFor(cwd) {
  if (typeof cwd !== 'string' || cwd === '') {
    throw new Error('无法确定当前工作区目录：这个会话没有 cwd。请在某个工作区里打开会话后重试。')
  }
  let store = stores.get(cwd)
  if (store === undefined) {
    store = new PlanStore(cwd)
    stores.set(cwd, store)
  }
  return store
}

/** 从工具执行上下文里取出当前会话的工作区目录。 */
function cwdOf(exec) {
  const agent = exec === undefined || exec === null ? undefined : exec.agent
  const session = agent === undefined || agent === null ? undefined : agent.session
  const header = session === undefined || session === null ? undefined : session.header
  const cwd = header === undefined || header === null ? undefined : header.cwd
  if (typeof cwd !== 'string' || cwd === '') {
    throw new Error('当前会话没有工作区目录（cwd），无法定位计划文件。')
  }
  return cwd
}

/** 统一的工具输出形态：JSON 值 + 文本渲染。 */
function makeTool(name, description, parameters, execute) {
  return defineTool({
    name,
    description,
    parameters,
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute,
  })
}

/**
 * 给一个节点补上派生字段。这些字段**从不落盘**（NFR-2：派生量不落盘，
 * 免得两个真相源漂移）：
 *   type             节点类型（缺省按待办兜底，前端不必自己判断）
 *   progress         递归算出的完成度
 *   priority         缺省补成 normal
 *   warnings         按重要程度给出的管控缺口提示
 *   delegateState    委派的可判断形态（含两种逾期标记）
 *   overdue          是否逾期（含委派逾期）
 *   dueSoon          7 天内到期
 *   pace / behind    配速与落后（只有完整周期才非空）
 *   unverified       已完成但没有证据
 *   evidenceWarnings 证据里能机器核验的那部分（文件是否存在）
 *   parentSuggestions 该归到哪个计划下的建议（只有顶层待办非空）
 *
 * @param root 工作区根目录——核验 file 类证据要用它解析相对路径。
 * @param parentSuggestions 本节点的归位建议，由 withProgress 统一算好传进来
 *   （打分要看到整棵树，单个节点算不了）。
 */
function annotate(node, today, root, parentSuggestions = [], vaultPath = '', plan = null) {
  const type = typeOf(node)
  const progress = nodeProgress(node)
  const out = {
    ...node,
    type,
    progress,
    priority: priorityOf(node),
    warnings: nodeWarnings(node, type),
    delegateState: delegateState(node, today),
    overdue: isOverdue(node, today),
    dueSoon: isDueWithin(node, 7, today),
    pace: paceOf(node, progress, today),
    unverified: isUnverified(node),
    evidenceWarnings: evidenceWarnings(node, root),
    fileWarnings: fileWarnings(node, vaultPath),
    parentSuggestions,
  }
  // 被谁挡着（blockedBy 里还没做完的）：面板标 🔒、执行清单把它们单独折叠、
  // agent 回答「为什么做不了」都要用。**只给标题不给 id**，理由与 parentSuggestions 同。
  out.blocked = plan === null ? [] : blockers(plan, node).map((b) => String(b.title ?? ''))
  out.behind = out.pace !== null && out.pace.behind === true
  // 子节点递归标注，覆盖掉 `...node` 带上来的原始 children。
  // 建议只给顶层待办算，所以递归时不再往下传。vaultPath 是 plan 级配置，整棵共享。
  if (type === 'plan') {
    out.children = childrenOf(node).map((child) => annotate(child, today, root, [], vaultPath, plan))
  }
  return out
}

/** 给计划补上派生字段（进度、管控汇总、落后与无证据清单），返回给模型/前端时用。 */
function withProgress(plan, root) {
  const today = todayStr()
  // 归位建议统一在这里算：打分要看整棵树，而面板与 agent 读的都是这份 payload，
  // 于是**两边看到的是同一个建议**——agent 想让某条改判归属时不必再开一条通路。
  const suggestions = new Map()
  for (const node of inboxOf(plan)) {
    const list = suggestParent(plan, node, today)
    if (list.length > 0) suggestions.set(String(node.id ?? ''), list)
  }
  return {
    ...plan,
    progress: planProgress(plan),
    counts: todoCounts(plan),
    control: controlSummary(plan, today),
    delegated: delegatedList(plan, today),
    behind: behindList(plan, today),
    unverified: unverifiedList(plan),
    nodes: planNodes(plan).map((node) => annotate(
      node, today, root, suggestions.get(String(node.id ?? '')) ?? [], plan.vaultPath ?? '', plan,
    )),
  }
}

const str = (v) => (typeof v === 'string' ? v.trim() : '')
const optStr = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined)

/**
 * 完成证据的参数组（`plan_node_set` / `plan_todo_set` 共用）。
 *
 * 为什么是三个平铺参数而不是一个对象数组：工具的 JSON Schema 只声明标量
 * 最稳（provider 侧的校验会拒掉意外的形状），而「一次附一条、要附多条就
 * 调多次」正好契合证据的**追加**语义——顺便还省掉了「传数组会不会覆盖」
 * 这个要解释的问题。
 */
const EVIDENCE_PARAMS = {
  evidenceKind: {
    type: 'string',
    description: '可选：证据类型 ' + EVIDENCE_KIND.join(' / ')
      + '（file=文件路径、session=会话 id、command=命令、link=链接、note=说明），不传按 note 记录',
  },
  evidenceRef: {
    type: 'string',
    description: '可选：证据本体（文件路径 / 会话 id / 命令 / 链接 / 一句话说明）。'
      + '给了就在这次调用里追加一条证据；文件路径相对工作区解析，且会被核验是否存在',
  },
  evidenceNote: { type: 'string', description: '可选：这条证据的说明' },
}

/** 从入参里抽一条证据；没给 evidenceRef 就返回 undefined（完全不动现有证据）。 */
function evidenceInputOf(args) {
  const ref = optStr(args?.evidenceRef)
  if (ref === undefined) return undefined
  return { kind: args?.evidenceKind, ref, note: args?.evidenceNote }
}

/**
 * 文件关联的参数组（plan_node_set / plan_todo_set 共用，HTTP 侧的 /node-set
 * /todo-set 也读同样的字段）。
 *
 * 与证据**刻意分开**而不是塞进 evidence：文件关联是「做这件事要看的资料」，
 * 文件夹也支持，且不与「无证据完成项」那条审查线绑定（见 docs/DESIGN.md
 * 「文件库关联」章）。它复用 EVIDENCE_PARAMS 同款「平铺标量」写法——
 * 工具的 JSON Schema 只声明标量最稳，且「一次挂一条、要挂多条就调多次」正好
 * 契合关联的追加语义。
 */
const FILE_PARAMS = {
  fileKind: {
    type: 'string',
    description: '可选：关联类型 ' + FILE_KIND.join(' / ')
      + '（file=文件, folder=文件夹），不传按 file 记录',
  },
  fileRef: {
    type: 'string',
    description: '可选：关联路径，**相对 Obsidian vault 根**（非机器绝对路径）。'
      + '给了就在这次调用里追加一条关联；节点上的 files 存的就是这个相对路径',
  },
  fileNote: { type: 'string', description: '可选：这条关联的说明（如「这是最终版」「草稿先放这」）' },
  fileRemove: { type: 'string', description: '可选：传入要移除的关联 ref（文件或文件夹路径），即从该节点摘掉这条关联' },
}

/**
 * 从入参里抽一条文件关联意图：给了 fileRemove 就摘；否则给了 fileRef 就加。
 * 两个都不给返回 undefined（完全不动现有文件关联）。
 */
function fileInputOf(args) {
  const remove = optStr(args?.fileRemove)
  if (remove !== undefined) return { op: 'remove', ref: remove }
  const ref = optStr(args?.fileRef)
  if (ref === undefined) return undefined
  return { op: 'add', kind: args?.fileKind, ref, note: args?.fileNote }
}

/**
 * 依赖 / 星标 / 重复的参数组（plan_node_set / plan_todo_set 与 HTTP 面共用）。
 * blockedAdd / blockedRemove 按**任务 id**——依赖是精确的工程关系，按标题太含糊
 * （标题匹配留给建议类功能）；star 是布尔；recur 是 week / month / none。
 */
const DEP_PARAMS = {
  blockedAdd: { type: 'string', description: '可选：加一条依赖——node 要等这个任务（任务 id）做完才能做；对方完成后自动解除' },
  blockedRemove: { type: 'string', description: '可选：移除一条依赖（任务 id）' },
  star: { type: 'boolean', description: '可选：星标（我正在做 / 接下来做），执行清单里置顶' },
  filed: { type: 'boolean', description: '可选：纳入工作计划——不作为谁的子项，而是以独立条目出现在「工作计划」栏（true=纳入，false=退回收件箱）。只对顶层待办有意义' },
  recur: { type: 'string', description: '可选：重复周期 week / month（完成时自动克隆下一条并顺推截止），传 none 取消' },
}

/** 从入参里抽出依赖 / 星标 / 重复的写入（都没有就 undefined，不传就不动）。 */
function depInputOf(args) {
  if (args === null || args === undefined || typeof args !== 'object') return undefined
  const out = {}
  const add = optStr(args.blockedAdd)
  if (add !== undefined) out.blockedAdd = add
  const rm = optStr(args.blockedRemove)
  if (rm !== undefined) out.blockedRemove = rm
  if (typeof args.star === 'boolean') out.star = args.star
  // `filed` **不进来**：顶层不再分「收件箱 / 工作计划」两栏，这个字段已废弃。
  // 单独处理它不为「应用」，而是为了在「只传了 filed」时给一句**说清楚的**提示
  // （见下面的 no-change 分支）——否则 agent 会收到「没有要改的属性」，
  // 而它明明传了一个参数，那是最难查的一类反馈。
  const recur = optStr(args.recur)
  if (recur !== undefined) out.recur = recur
  return Object.keys(out).length > 0 ? out : undefined
}

/** 应用依赖 / 星标 / 重复，返回给版本留档用的 reason 片段。 */
function applyDeps(plan, node, dep) {
  const reasons = []
  if (dep === undefined) return reasons
  if (dep.blockedAdd !== undefined) {
    addBlockedBy(plan, node, dep.blockedAdd)
    reasons.push('blocked+')
  }
  if (dep.blockedRemove !== undefined) {
    removeBlockedBy(node, dep.blockedRemove)
    reasons.push('blocked-')
  }
  if (dep.star !== undefined) {
    setStar(node, dep.star)
    reasons.push(dep.star ? 'star' : 'unstar')
  }
  // `filed` 已废弃：顶层不再分「收件箱 / 工作计划」两栏，这个字段不再影响任何判断。
  //
  // 这里**接受但忽略**，而不是拒绝：agent 可能还按老习惯传它（提示词与工具
  // 描述里刚去掉），为这个报错等于把一个已经无意义的历史参数变成硬失败。
  // 传了不生效、也不留痕——磁盘上不会长出这个键（见 store.js 的 normalize）。
  if (dep.recur !== undefined) {
    setRecur(node, dep.recur)
    reasons.push('recur')
  }
  return reasons
}

/**
 * 完成语义一体化的派生处理：完成向上级联（父的子项全完成 → 父自动完成，
 * 一路到顶），撤回向上重开（自动完成的父链回到进行中）。
 * 返回版本留档用的 reason 片段（'' = 祖先没有变化）。
 */
function propagateStatus(plan, node, before, today) {
  const after = node.status
  if (after === 'done' && before !== 'done') {
    const changed = autoCompleteAncestors(plan, node, today)
    return changed.length > 0 ? '+auto-done' : ''
  }
  if (before === 'done' && after !== 'done') {
    const changed = reopenAncestors(plan, node, today)
    return changed.length > 0 ? '+reopen' : ''
  }
  return ''
}

/**
 * 手动把计划标成 done 的守门员：有未完成子项就拒绝（它的完成是派生的，
 * 手动写只会造出「父已完成、子还开着」的矛盾）。面板的勾选框根本不出现、
 * 详情页禁用按钮、agent 的写入在这里拦——三层同一个规则。
 */
function assertStatusAllowed(node, status) {
  if (optStr(status) === 'done') assertManualDoneAllowed(node)
}

/**
 * 完成一条带 recur 的待办时克隆下一条。**只在「非 done → done」这一下触发**：
    * 状态已经是 done 再保存一次不该刷出克隆，否则每存一次多一条。
 */
function spawnIfRecurring(plan, node, before, today) {
  if (before === 'done' || node.status !== 'done') return null
  return spawnRecurring(plan, node, today)
}

/**
 * 把节点上「相对 vault 根」的 ref 解析成绝对路径，并做越界防护。
 * ref 以 sep 开头视为绝对路径，否则 join(vaultPath, ref)；解析后必须落在
 * vaultPath 内（以 resolve(vaultPath) + sep 开头，或正好等于它），不允许
 * ../ 逃逸到 vault 外面去读别的目录。越界直接抛错，不让请求继续。
 */
function resolveRef(vaultPath, ref) {
  const base = resolve(vaultPath)
  const abs = (ref != null && ref.startsWith(sep)) ? resolve(ref) : join(base, ref ?? '')
  if (abs !== base && !abs.startsWith(base + sep)) {
    throw new Error('路径越界：ref 不能跳出 vault 根目录（' + base + '）')
  }
  return abs
}

/**
 * 按需打开关联文件：只有当问题里**点到了**某个文件时才去读。
 *
 * 为什么不全读：vault 里可能有几百篇笔记，全塞进上下文既慢又撑爆 token，
 * 而且绝大多数与这一问无关。命中规则很粗（文件名或路径出现在问题里），
 * 但粗得有价值——用户问「周会纪要里说了什么」时，「周会」两个字必然会命中。
 * 读不到就跳过：文件被挪走了不该让整个提问失败。
 */
function pickVaultFiles(plan, text, limit = 3) {
  const ask = String(text ?? '')
  if (ask.trim() === '') return []
  const refs = new Set()
  for (const hit of collectNodesSafe(plan)) {
    for (const f of filesOf(hit.node)) {
      const ref = String(f?.ref ?? '')
      if (ref !== '') refs.add(ref)
    }
  }
  const out = []
  for (const ref of refs) {
    if (out.length >= limit) break
    const base = ref.split(/[\\/]/).pop() ?? ref
    const stem = base.replace(/\.[^.]+$/, '')
    const hit = (stem !== '' && ask.includes(stem)) || ask.includes(base) || ask.includes(ref)
    if (!hit) continue
    try {
      const got = readVaultEntry(plan, ref, 'file')
      if (got.exists !== true || typeof got.content !== 'string' || got.content === '') continue
      // 单文件截到 8KB：一篇长笔记不值得把整次提问的预算吃掉。
      out.push({ ref, content: got.content.slice(0, 8192) })
    } catch (e) { /* 越界或读不了就跳过这一个 */ }
  }
  return out
}

/** 遍历节点（拿不到就算了，它只用于收集关联文件）。 */
function collectNodesSafe(plan) {
  try { return collectNodes(plan, 'any') } catch (e) { return [] }
}

// ------------------------------------------------------------- AI 助手人设

/** 人设文件固定叫 agents.md，与 plan.json 同目录（都在被 git 忽略的 plan/ 下）。 */
const PERSONA_FILE = 'agents.md'

const personaFile = (dir) => join(dir, PERSONA_FILE)

/** 读人设；文件不存在 / 读不了就用默认人设（没配过 ≠ 没有性格）。 */
function readPersona(dir) {
  try {
    const file = personaFile(dir)
    if (!existsSync(file)) return DEFAULT_PERSONA
    const text = readFileSync(file, 'utf8')
    return text.trim() === '' ? DEFAULT_PERSONA : text
  } catch (e) {
    return DEFAULT_PERSONA
  }
}

/**
 * 往人设的「记住的事」一节末尾追加一条（AI 被要求「记住：…」时用）。
 * 没有这一节就补一节——人设是人手写的，章节顺序不该被假设。
 */
function appendToPersona(text, line) {
  const body = text === '' ? DEFAULT_PERSONA : text
  const item = '- ' + line.replace(/^记住[:：]\s*/, '').replace(/\s+/g, ' ').trim()
  const lines = body.split('\n')
  const at = lines.findIndex((l) => /^##\s*记住的事/.test(l))
  if (at < 0) return body.replace(/\s*$/, '') + '\n\n## 记住的事\n' + item + '\n'
  // 插到这一节的最后一条列表项之后（跳过紧随其后的空行）。
  let i = at + 1
  let last = at
  while (i < lines.length && !/^##\s/.test(lines[i])) {
    if (/^\s*-\s/.test(lines[i])) last = i
    i += 1
  }
  lines.splice(last + 1, 0, item)
  return lines.join('\n')
}

/**
 * 一轮问答最多回带几轮历史，以及每轮截到多少字。
 * 历史是「接着聊」用的，不是存档：太多轮会把 token 吃光，也让模型跟着旧话题跑。
 */
const MAX_HISTORY = 6
const MAX_HISTORY_CHARS = 1500

/**
 * 读 vault 内文件 / 列文件夹。返回 { exists, ref, abs, kind, ... }；
 * 缺 vault 时返回 exists:false（不抛错，让 agent / 面板拿不到数据时平稳处理，
 * 而不是中断）；**路径越界（../ 逃逸）仍抛错**——那是越权访问，必须拦下来。
 * 工具（plan_file_read）与 HTTP 数据面（/file-read）共用同一份逻辑。
 */
function readVaultEntry(plan, ref, kind) {
  const vaultPath = plan.vaultPath
  if (!vaultPath) {
    return { exists: false, vaultConfigured: false, ref, abs: '', kind: FILE_KIND.includes(kind) ? kind : 'file', vaultPath: '', content: '', entries: [] }
  }
  const raw = resolveRef(vaultPath, ref)
  const k = FILE_KIND.includes(kind) ? kind : 'file'
  const exists = existsSync(raw)
  if (!exists) return { exists: false, ref, abs: raw, kind: k, vaultPath, content: '', entries: [] }
  if (k === 'folder') {
    if (!statSync(raw).isDirectory()) {
      return { exists: true, isFileNotFolder: true, ref, abs: raw, kind: k, entries: [] }
    }
    const entries = readdirSync(raw).map((name) => {
      const isDir = statSync(join(raw, name)).isDirectory()
      return { name, kind: isDir ? 'folder' : 'file' }
    })
    return { exists: true, ref, abs: raw, kind: k, entries }
  }
  if (!statSync(raw).isFile()) {
    return { exists: true, isFolderNotFile: true, ref, abs: raw, kind: k, content: '' }
  }
  const buf = readFileSync(raw)
  const MAX = 200 * 1024
  const tooBig = buf.length > MAX
  const content = (tooBig ? buf.subarray(0, MAX) : buf).toString('utf8')
  return {
    exists: true,
    ref,
    abs: raw,
    kind: k,
    bytes: buf.length,
    truncated: tooBig,
    content: tooBig ? content + '\n\n…（已截断，原文 ' + buf.length + ' 字节）' : content,
  }
}

/**
 * 定位一个「待办」。agent 勾选进度的入口用它：限定类型可以拦住「把整条
 * 计划标成已完成」这类误操作，并给出可读的替代方向。
 */
function resolveTodo(plan, ref) {
  return resolveNode(plan, ref, 'todo')
}

export function apply(ctx) {
  // ---------------------------------------------------------------- 模型工具

  ctx.tools.register(makeTool(
    'plan_show',
    '查看当前工作区的工作计划。是一棵**递归树**：计划下可以挂子计划（深度不限），叶子是待办；'
      + '不挂在任何计划下的顶层待办就是收件箱。每个节点都带自动算好的完成度与管控提示。'
      + '返回里另外有三份清单值得先看：delegated（我委派出去的，含逾期未回执）、'
      + 'behind（进度没跟上周期的，按差距排序）、unverified（已完成但没有证据、等你核验的）。'
      + '计划文件位于 <工作区>/plan/plan.json。',
    {},
    async (_args, exec) => {
      const store = storeFor(cwdOf(exec))
      const plan = await store.load()
      return { ok: true, dir: store.dir, plan: withProgress(plan, store.root) }
    },
  ))

  ctx.tools.register(makeTool(
    'plan_node_add',
    '新增一个节点。**类型由结构派生**：新建的都是待办（叶子，实际动手做的事），'
      + '挂在某个节点下就是它的子项——挂上子项的那个节点自动成为计划。'
      + 'parent 不传就放在顶层——顶层待办即收件箱，适合「先记下来、之后再归位」。'
      + '重要程度决定这个节点要走多少流程：高 = 必须周期与负责人；中 = 要有结束日期；低 = 只记录。',
    {
      title: { type: 'string', required: true, description: '节点标题，一句话说清要达成什么或要做什么' },
      parent: { type: 'string', description: '可选：父节点的 id 或标题。不传则放到顶层；挂在待办下会把那个待办变成计划' },
      owner: { type: 'string', description: '可选：负责人（计划用）' },
      start: { type: 'string', description: '可选：周期开始 YYYY-MM-DD（计划用）' },
      end: { type: 'string', description: '可选：周期结束 YYYY-MM-DD（计划用）' },
      due: { type: 'string', description: '可选：截止日期 YYYY-MM-DD（待办用）' },
      priority: { type: 'string', description: '可选：重要程度 ' + PRIORITY.join(' / ') + '，默认 normal（中）' },
      target: { type: 'number', description: '可选：量化目标值（与 current 配套，适合可计数的计划）' },
      current: { type: 'number', description: '可选：当前值' },
      unit: { type: 'string', description: '可选：量化单位（个 / 万元 / % 等）' },
      note: { type: 'string', description: '可选：备注' },
    },
    async (args, exec) => {
      const store = storeFor(cwdOf(exec))
      const plan = await store.load()
      const node = makeNode(plan, {
        title: args?.title,
        owner: args?.owner,
        start: args?.start,
        end: args?.end,
        due: args?.due,
        priority: args?.priority,
        target: args?.target,
        current: args?.current,
        unit: args?.unit,
        note: args?.note,
      })
      appendChild(plan, node, args?.parent)
      await store.save(plan, { reason: typeOf(node) + '-add' })
      return {
        ok: true,
        node: { id: node.id, type: typeOf(node), title: node.title },
        warnings: nodeWarnings(node, typeOf(node)),
        plan: withProgress(plan, store.root),
      }
    },
  ))

  ctx.tools.register(makeTool(
    'plan_node_set',
    '更新任意节点的字段：标题、负责人、周期、截止、重要程度、状态、量化进度、备注、完成证据。'
      + '不传的字段保持不动。类型由结构派生：有子项的节点是计划（状态 active / done / dropped），'
      + '叶子是待办（状态 todo / doing / done / dropped）。'
      + '有未完成子项的计划不能手动标 done（它的完成由子项派生：做完子项它会自动完成）。'
      + '把状态改成 done 时，用 evidenceRef 附上产出（文件路径 / 会话 id / 命令），'
      + '否则它会被列进「已完成但无证据」——那是给人核验「AI 真的干完了」用的清单。',
    {
      node: { type: 'string', required: true, description: '节点 id（如 n1 / g1）或标题' },
      title: { type: 'string', description: '可选：新标题' },
      owner: { type: 'string', description: '可选：负责人' },
      start: { type: 'string', description: '可选：周期开始 YYYY-MM-DD' },
      end: { type: 'string', description: '可选：周期结束 YYYY-MM-DD' },
      due: { type: 'string', description: '可选：截止日期 YYYY-MM-DD' },
      priority: { type: 'string', description: '可选：重要程度 ' + PRIORITY.join(' / ') },
      status: { type: 'string', description: '可选：计划 active/done/dropped；待办 todo/doing/done/dropped' },
      target: { type: 'number', description: '可选：量化目标值' },
      current: { type: 'number', description: '可选：当前值' },
      unit: { type: 'string', description: '可选：量化单位' },
      note: { type: 'string', description: '可选：备注' },
      ...EVIDENCE_PARAMS,
      ...FILE_PARAMS,
      ...DEP_PARAMS,
    },
    async (args, exec) => {
      const store = storeFor(cwdOf(exec))
      const plan = await store.load()
      const { node } = resolveNode(plan, args?.node, 'any')
      const beforeStatus = node.status
      applyFields(node, args)
      // 有未完成子项的计划不能手动完成（它的完成由子项派生）。
      assertStatusAllowed(node, args?.status)
      if (optStr(args?.status) !== undefined) setStatus(node, args.status)
      // 完成 / 撤回的向上派生：父可能被自动完成或重新打开。
      const autoReason = propagateStatus(plan, node, beforeStatus, todayStr())
      // 依赖 / 星标 / 重复：依赖要在状态之后（spawn 要知道最终状态）。
      const dep = depInputOf(args)
      const depReasons = applyDeps(plan, node, dep)
      const spawned = spawnIfRecurring(plan, node, beforeStatus, todayStr())
      // 证据在状态之后追加：先落成 done 再挂凭据，两者是同一次改变的原子结果。
      const evidence = evidenceInputOf(args)
      if (evidence !== undefined) addEvidence(node, evidence)
      // 文件关联（与证据刻意分开）：资料是「做这件事要看的」，文件夹也行，
      // 跟完没完成无关，不进「无证据完成项」那条审查线。
      const file = fileInputOf(args)
      if (file !== undefined) {
        if (file.op === 'remove') removeFile(node, file.ref)
        else addFile(node, file)
      }
      const type = typeOf(node)
      await store.save(plan, {
        reason: type + '-set'
          + (evidence !== undefined ? '+evidence' : '')
          + (file !== undefined ? '+file' + (file.op === 'remove' ? '-rm' : '') : '')
          + depReasons.map((r) => '+' + r).join('')
          + (spawned !== null ? '+recur-spawn' : '')
          + autoReason,
      })
      return {
        ok: true,
        node,
        warnings: nodeWarnings(node, type),
        evidenceWarnings: evidenceWarnings(node, store.root),
        unverified: isUnverified(node),
        spawned: spawned === null ? undefined : { id: spawned.id, title: spawned.title, due: spawned.due ?? '' },
        plan: withProgress(plan, store.root),
      }
    },
  ))

  ctx.tools.register(makeTool(
    'plan_node_move',
    '把一个节点移到另一个计划下（收件箱归位），或调整它在同一层里的顺序。'
      + 'parent 不传就移到顶层。不能移到自己的子孙下面——那会形成环。',
    {
      node: { type: 'string', required: true, description: '要移动的节点 id 或标题' },
      parent: { type: 'string', description: '可选：目标父计划的 id 或标题。**不传就移到顶层**（收件箱）——工具参数不接受 null，要移回顶层请省略这个参数' },
      index: { type: 'number', description: '可选：落在第几个位置（从 0 起），不传则追加到末尾' },
    },
    async (args, exec) => {
      const store = storeFor(cwdOf(exec))
      const plan = await store.load()
      const r = moveNode(plan, args?.node, args?.parent, args?.index)
      await store.save(plan, { reason: 'node-move' })
      return {
        ok: true,
        node: { id: r.node.id, title: r.node.title },
        from: r.from,
        to: r.to,
        plan: withProgress(plan, store.root),
      }
    },
  ))

  ctx.tools.register(makeTool(
    'plan_node_remove',
    '删除一个节点。删计划会**连带删掉它的整棵子树**——返回值里的 removed 会告诉你删了多少东西。',
    {
      node: { type: 'string', required: true, description: '节点 id 或标题' },
    },
    async (args, exec) => {
      const store = storeFor(cwdOf(exec))
      const plan = await store.load()
      const r = removeNode(plan, args?.node)
      await store.save(plan, { reason: 'node-remove' })
      return {
        ok: true,
        removed: { id: r.node.id, type: typeOf(r.node), title: r.node.title, parent: r.parent, stats: r.removed },
        plan: withProgress(plan, store.root),
      }
    },
  ))

  ctx.tools.register(makeTool(
    'plan_todo_set',
    '更新一个待办的状态。这是 agent 回写进度的主要入口：干完一件事就把它标成 done，'
      + '完成时会自动记下完成时间（doneAt），计划的完成度会自动重算。'
      + '标完成时请用 evidenceRef 附上产出（文件路径 / 会话 id / 命令 / 链接）——'
      + '「AI 说它干完了」需要可核验的凭据，没有凭据的完成项会被列进「已完成但无证据」等人核验。',
    {
      todo: { type: 'string', required: true, description: '待办的 id（如 n3 / t1）或标题' },
      status: { type: 'string', required: true, description: '新状态：' + TODO_STATUS.join(' / ') + '（todo=待办, doing=进行中, done=已完成, dropped=已放弃）' },
      note: { type: 'string', description: '可选：追加备注（留痕为什么放弃/怎么完成的）' },
      ...EVIDENCE_PARAMS,
      ...DEP_PARAMS,
    },
    async (args, exec) => {
      const store = storeFor(cwdOf(exec))
      const plan = await store.load()
      const found = resolveTodo(plan, args?.todo)
      const beforeStatus = found.node.status
      setStatus(found.node, args?.status)
      // 完成 / 撤回的向上派生：父计划可能被自动完成或重新打开。
      const autoReason = propagateStatus(plan, found.node, beforeStatus, todayStr())
      const note = optStr(args?.note)
      if (note !== undefined) found.node.note = note
      // 依赖 / 星标 / 重复：完成带 recur 的待办会自动克隆出下一条。
      const dep = depInputOf(args)
      const depReasons = applyDeps(plan, found.node, dep)
      const spawned = spawnIfRecurring(plan, found.node, beforeStatus, todayStr())
      const evidence = evidenceInputOf(args)
      if (evidence !== undefined) addEvidence(found.node, evidence)
      const file = fileInputOf(args)
      if (file !== undefined) {
        if (file.op === 'remove') removeFile(found.node, file.ref)
        else addFile(found.node, file)
      }
      await store.save(plan, { reason: 'todo-' + found.node.status
        + (evidence !== undefined ? '+evidence' : '')
        + (file !== undefined ? '+file' + (file.op === 'remove' ? '-rm' : '') : '')
        + depReasons.map((r) => '+' + r).join('')
        + (spawned !== null ? '+recur-spawn' : '')
        + autoReason })
      return {
        ok: true,
        todo: found.node,
        warnings: nodeWarnings(found.node, 'todo'),
        evidenceWarnings: evidenceWarnings(found.node, store.root),
        unverified: isUnverified(found.node),
        spawned: spawned === null ? undefined : { id: spawned.id, title: spawned.title, due: spawned.due ?? '' },
        plan: withProgress(plan, store.root),
      }
    },
  ))

  // ------------------------------------------------- 文件库关联：vault 配置 + 读文件

  ctx.tools.register(makeTool(
    'plan_config_set',
    '配置本工作区对接的 Obsidian vault 根目录（绝对路径）。这是**机器相关**配置——'
      + '只存在本机 plan.json 顶层（vaultPath），节点上只记相对 vault 根的逻辑路径，'
      + '换机器 / 换人也不会读到对不上的绝对路径。不传 vaultPath（或传空串）即清除配置。'
      + '路径必须是真实存在的目录，否则会报错。配置好后，节点上的文件关联就能生成'
      + 'obsidian:// 打开链接，agent 也能用 plan_file_read 直接读库里的笔记。',
    {
      vaultPath: { type: 'string', description: '可选：Obsidian vault 的绝对根目录（如 /Users/me/vault）；不传或传空即清除' },
    },
    async (args, exec) => {
      const store = storeFor(cwdOf(exec))
      const plan = await store.load()
      const raw = optStr(args?.vaultPath)
      if (raw === undefined || raw === '') {
        delete plan.vaultPath
        await store.save(plan, { reason: 'config-vault-clear' })
        return { ok: true, vaultPath: '', cleared: true, plan: withProgress(plan, store.root) }
      }
      const abs = resolve(raw)
      if (!existsSync(abs) || !statSync(abs).isDirectory()) {
        throw new Error('vault 路径不存在或不是目录：' + abs + '（请确认 Obsidian vault 的绝对路径）')
      }
      plan.vaultPath = abs
      await store.save(plan, { reason: 'config-vault' })
      return { ok: true, vaultPath: abs, exists: true, plan: withProgress(plan, store.root) }
    },
  ))

  ctx.tools.register(makeTool(
    'plan_file_read',
    '读 Obsidian vault 里的资料——这是「深度对接」的关键：agent 能直接看到节点关联的'
      + '文件 / 文件夹内容，而不是只知道有个路径。ref 是**相对 vault 根**的逻辑路径'
      + '（节点 files 上存的就是它）。kind=file 读文本正文（超大文件会被截断并标注）；'
      + 'kind=folder 列出目录条目（每条标 file / folder）。路径越界（../ 逃逸 vault 根）会被拒绝。'
      + '未配置 vault 或文件不存在都会明确返回 exists:false，不会报错中断。',
    {
      ref: { type: 'string', required: true, description: '相对 vault 根的路径（与节点 files[].ref 一致）；以 / 开头则视为绝对路径' },
      kind: { type: 'string', description: '可选：' + FILE_KIND.join(' / ') + '（file=读文件, folder=列目录），不传按 file' },
    },
    async (args, exec) => {
      const store = storeFor(cwdOf(exec))
      const plan = await store.load()
      const entry = readVaultEntry(plan, args?.ref, args?.kind)
      return { ok: true, ...entry }
    },
  ))

  // ------------------------------------------------- 重要程度 / 委派（任意节点）

  ctx.tools.register(makeTool(
    'plan_priority_set',
    '设置任意节点（计划或待办）的重要程度。它不是标签而是管控强度开关：'
      + 'high 要求周期与负责人、落后要预警、完成要证据；normal 要求有截止；low 只记录不催。'
      + '返回 warnings 指出还缺什么。给计划填了 start + end 之后，进度落后于周期会被自动标出来。',
    {
      node: { type: 'string', required: true, description: '节点 id（如 n1 / g1）或标题' },
      priority: { type: 'string', required: true, description: PRIORITY.join(' / ') + '（high=高, normal=中, low=低）' },
    },
    async (args, exec) => {
      const store = storeFor(cwdOf(exec))
      const plan = await store.load()
      const found = resolveNode(plan, args?.node, 'any')
      setPriority(found.node, args?.priority)
      await store.save(plan, { reason: 'priority-' + priorityOf(found.node) })
      return {
        ok: true,
        node: { id: found.node.id, type: typeOf(found.node), title: found.node.title, priority: priorityOf(found.node) },
        warnings: nodeWarnings(found.node, typeOf(found.node)),
        plan: withProgress(plan, store.root),
      }
    },
  ))

  ctx.tools.register(makeTool(
    'plan_delegate_set',
    '把一件事委派给某人。记录委派对象、委派时间与期望完成时间，回执状态初始为 pending（待接受）。'
      + '重新委派（换人）会把回执重置为待接受并刷新委派时间——上一轮的回执作废。',
    {
      node: { type: 'string', required: true, description: '节点 id 或标题（计划 / 待办均可）' },
      to: { type: 'string', required: true, description: '委派给谁（人名）' },
      expectAt: { type: 'string', description: '可选：期望完成日期 YYYY-MM-DD，逾期未回执会被标出来' },
      note: { type: 'string', description: '可选：交代的话 / 期望产出' },
    },
    async (args, exec) => {
      const store = storeFor(cwdOf(exec))
      const plan = await store.load()
      const found = resolveNode(plan, args?.node, 'any')
      setDelegate(found.node, { to: args?.to, expectAt: args?.expectAt, note: args?.note })
      await store.save(plan, { reason: 'delegate-set' })
      return {
        ok: true,
        node: { id: found.node.id, type: typeOf(found.node), title: found.node.title },
        delegate: delegateState(found.node),
        plan: withProgress(plan, store.root),
      }
    },
  ))

  ctx.tools.register(makeTool(
    'plan_delegate_receipt',
    '登记一次委派回执：对方接受了 / 拒绝了 / 把事交回来了。'
      + '委派如果没有回执，就等于交代完石沉大海——所以回执要显式记下来。',
    {
      node: { type: 'string', required: true, description: '节点 id 或标题' },
      status: { type: 'string', required: true, description: '回执状态：' + DELEGATE_STATUS.join(' / ') + '（pending=待接受, accepted=已接受, declined=已拒绝, returned=已交回）' },
      expectAt: { type: 'string', description: '可选：改期望完成日期 YYYY-MM-DD' },
      note: { type: 'string', description: '可选：回执备注' },
    },
    async (args, exec) => {
      const store = storeFor(cwdOf(exec))
      const plan = await store.load()
      const found = resolveNode(plan, args?.node, 'any')
      setReceipt(found.node, args?.status, { expectAt: args?.expectAt, note: args?.note })
      await store.save(plan, { reason: 'delegate-' + found.node.delegate.status })
      return {
        ok: true,
        node: { id: found.node.id, type: typeOf(found.node), title: found.node.title },
        delegate: delegateState(found.node),
        plan: withProgress(plan, store.root),
      }
    },
  ))

  ctx.tools.register(makeTool(
    'plan_delegated',
    '列出所有委派出去的事项（我委派出去的）：对象、期望完成时间、回执状态，逾期未回执的排在前面。',
    {
      open: { type: 'boolean', description: '可选：只看未完成（默认 true）' },
    },
    async (args, exec) => {
      const store = storeFor(cwdOf(exec))
      const plan = await store.load()
      const all = delegatedList(plan)
      const openOnly = args?.open !== false
      const items = openOnly ? all.filter((x) => x.status !== 'done' && x.status !== 'dropped') : all
      return {
        ok: true,
        total: all.length,
        items: items.map((x) => ({ ...x, typeLabel: TYPE_LABEL[x.type] ?? x.type })),
      }
    },
  ))

  ctx.tools.register(makeTool(
    'plan_snapshot',
    '给当前计划手动打一个版本快照（留档到 plan/.versions/）。适合在一个阶段收尾、大改之前手动钉一版。',
    {
      reason: { type: 'string', description: '可选：留档原因，会写进快照文件名便于回溯' },
    },
    async (args, exec) => {
      const store = storeFor(cwdOf(exec))
      const file = await store.snapshot(optStr(args?.reason) ?? 'manual')
      return { ok: true, file, dir: store.versions }
    },
  ))

  ctx.tools.register(makeTool(
    'plan_history',
    '列出计划的历史版本（最新在前）。每次通过工具修改计划前都会自动留档，所以这里能看到完整演进。',
    {
      limit: { type: 'number', description: '可选：最多返回多少条，默认 30' },
    },
    async (args, exec) => {
      const store = storeFor(cwdOf(exec))
      const limit = Number.isFinite(args?.limit) ? Math.max(1, Math.min(200, Number(args.limit))) : 30
      return { ok: true, dir: store.versions, versions: await store.history(limit) }
    },
  ))

  ctx.tools.register(makeTool(
    'plan_restore',
    '把计划回滚到某个历史版本。回滚前会先归档当前版本，所以回滚本身也是可撤销的。',
    {
      file: { type: 'string', required: true, description: 'plan_history 返回的版本文件名' },
    },
    async (args, exec) => {
      const store = storeFor(cwdOf(exec))
      const file = str(args?.file)
      if (file === '') throw new Error('需要版本文件名')
      const plan = await store.restore(file)
      return { ok: true, restoredFrom: file, plan: withProgress(plan, store.root) }
    },
  ))

  // ------------------------------------------------------------- HTTP 数据面

  // webServer 是可选的：宿主没有 web 表面时（headless 等）工具照常可用。
  ctx.inject(['webServer'], (serverCtx) => {
    const json = (res, body, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    }

    const DEFAULT_MAX_BODY_BYTES = 1024 * 1024
    /**
     * /ai-parse 要收 base64 图片，1MiB 根本不够（一张截图转 base64 就三四 MiB），
     * 所以请求体上限按路由给。**不统一抬到 8MiB**：其余路由都是几十字节的 JSON，
     * 给它们放大上限只是白白扩大攻击面。
     */
    const readBody = (req, maxBytes = DEFAULT_MAX_BODY_BYTES) => new Promise((resolve, reject) => {
      let data = ''
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > maxBytes) {
          const err = new Error('请求体过大（上限 ' + Math.round(maxBytes / 1024 / 1024) + 'MiB）')
          err.statusCode = 413
          reject(err)
          req.destroy()
          return
        }
        data += chunk
      })
      req.on('end', () => {
        try { resolve(data === '' ? {} : JSON.parse(data)) } catch (e) { reject(e) }
      })
      req.on('error', reject)
    })

    /**
     * 浏览器请求不携带会话，所以由前端传 sessionId，宿主侧反查 cwd。
     * 逐个扫在线 agent 的 session.header —— 与 dsh-todo-board 同样的做法。
     */
    const resolveCwd = (sessionId) => {
      if (typeof sessionId !== 'string' || sessionId === '') {
        throw new Error('缺少 sessionId：浏览器面板需要它来定位当前工作区')
      }
      const agents = serverCtx.get('agents')
      if (agents === undefined) throw new Error('宿主未提供 agents 服务，无法解析工作区')
      for (const agent of agents.list()) {
        const session = agent === null || agent === undefined ? undefined : agent.session
        const header = session === null || session === undefined ? undefined : session.header
        if (header === null || header === undefined) continue
        if (header.id !== sessionId) continue
        const cwd = header.cwd
        if (typeof cwd === 'string' && cwd !== '') return cwd
      }
      throw new Error('找不到会话 ' + sessionId + ' 的工作区目录（会话可能已关闭）')
    }

    const AI_MAX_BODY_BYTES = 12 * 1024 * 1024
    /**
     * 一次模型调用最多等多久。
     *
     * **量出来的，不是拍的**：真机实测（opencode-go-new / mimo-v2.6-flash，11 条待办、
     * 一次归组请求）**花了 65 秒**。原来的 90 秒已经被用掉七成——任务再多几条、
     * 或者带一张图，就正好撞上限，用户看到的是「模型 90 秒没有返回」这种
     * 把原因说歪的报错（他并没有说错话，是慢）。
     *
     * 放宽到 150 秒是安全的：**等待块上那三秒就出现的「算了」能中止这次请求**
     * （客户端 AbortController，见 runAi），所以等得久不会把人锁死在转圈里。
     * 宁可让它跑完，也不要在第 91 秒把一次已经算了一半的调用掐掉。
     */
    const AI_TIMEOUT_MS = 150_000

    /**
     * AI 入口是否可用。**派生量，不落盘**：每次现问宿主有没有 llm 服务与默认模型。
     * 面板据此决定要不要渲染那个入口——比「渲染出来点了才报错」强。
     * llm / agentDefaultModel 都是**可选**服务：宿主没装模型插件时这里只是
     * available=false，工具与面板其它部分照常工作。
     */
    const aiStatus = () => {
      const llm = serverCtx.get('llm')
      if (llm === undefined || llm === null) {
        return { available: false, provider: '', model: '', reason: '宿主没有可用的模型服务（llm）' }
      }
      const defaults = serverCtx.get('agentDefaultModel')
      const sel = defaults !== undefined && defaults !== null && typeof defaults.currentSelection === 'function'
        ? defaults.currentSelection() : null
      const provider = sel !== null && sel !== undefined && typeof sel.provider === 'string' ? sel.provider : ''
      const model = sel !== null && sel !== undefined && typeof sel.model === 'string' ? sel.model : ''
      if (provider === '' || model === '') {
        return { available: false, provider: '', model: '', reason: '还没有选定默认模型' }
      }
      return { available: true, provider, model, reason: '' }
    }

    /**
     * 图片能不能交给当前模型。
     * 查得到能力就按能力判（明确不支持 → 拦下来并说清换哪个）；查不到就**放行**，
     * 让它走到模型那儿由模型自己报错——因为「查不到」往往是宿主版本差异，
     * 为此挡掉一个本来能用的功能不划算。
     */
    const assertImageCapable = async (llm, status) => {
      if (typeof llm.resolveModelInfo !== 'function') return
      let info = null
      try {
        info = await llm.resolveModelInfo(status.provider, status.model)
      } catch (e) {
        return
      }
      const modes = info !== null && info !== undefined && Array.isArray(info.inputModalities) ? info.inputModalities : []
      if (modes.length > 0 && !modes.includes('image')) {
        throw new Error('当前模型「' + status.model + '」不支持图片输入：换一个带视觉能力的模型，或只用文字 / 语音')
      }
    }

    const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

    const route = (path, handler, maxBytes = DEFAULT_MAX_BODY_BYTES) => {
      serverCtx.webServer.register({
        kind: 'exact',
        path: '/api/workbench' + path,
        handler: (req, res) => Promise.resolve(handler(req, res, maxBytes)).catch((e) => {
          const status = e !== null && typeof e === 'object' && e.statusCode ? e.statusCode : 500
          json(res, { ok: false, error: e instanceof Error ? e.message : String(e) }, status)
        }),
      })
    }

    route('/get', async (req, res) => {
      const body = await readBody(req)
      const cwd = resolveCwd(body.sessionId)
      const store = storeFor(cwd)
      const plan = await store.load()
      json(res, { ok: true, cwd, dir: store.dir, ai: aiStatus(), plan: withProgress(plan, store.root) })
    })

    /**
     * AI 入口：把一段文本（语音转写 / 粘贴的纪要）或几张图片交给模型，换回一组
     * 结构化待办，并附「该归到哪个计划」的候选。**不写任何数据**——采纳哪条、
     * 建在哪儿，由用户在面板上点，之后仍走 /node-add。
     *
     * 为什么**不给 agent 也加一个 plan_ai_* 工具**：这个能力的价值是「人手上有一张
     * 截图 / 一段口述，不想自己整理成待办」。agent 从来不缺这个能力——它自己就
     * 看得见图片、读得懂口述，直接调 plan_node_add 即可，中间插一次模型调用只会
     * 多一层失真。工具面因此保持不动（多一个工具，agent 每次决策就多一个候选）。
     * 面板这条路之所以必要，是因为**人**没法把自己看到的东西直接变成结构化数据。
     *
     * 归位候选复用 store 的 suggestParent（与收件箱那条待办同一份权重、同一套解释），
     * 模型只负责说「我觉得归到叫 X 的计划」，由 matchPlan 去比对——这样建议
     * 一半可解释、一半有语义，两条路互为兜底。
     */
    route('/ai-parse', async (req, res, maxBytes) => {
      const body = await readBody(req, maxBytes ?? AI_MAX_BODY_BYTES)
      const store = storeFor(resolveCwd(body.sessionId))
      const plan = await store.load()
      const status = aiStatus()
      if (status.available === false) throw new Error('AI 解析不可用：' + status.reason)

      const text = optStr(body.text) ?? ''
      const sent = Array.isArray(body.images) ? body.images : []
      if (sent.length > MAX_IMAGES) throw new Error('一次最多 ' + MAX_IMAGES + ' 张图片')
      if (text === '' && sent.length === 0) {
        throw new Error('没有可解析的内容：问一句，或说点什么、贴一段文字、选一张图片')
      }

      const content = []
      if (sent.length > 0) {
        const attachments = serverCtx.get('attachments')
        if (attachments === undefined || attachments === null) {
          throw new Error('宿主没有附件服务（attachments），处理不了图片')
        }
        await assertImageCapable(serverCtx.get('llm'), status)
        const inputs = []
        for (const img of sent) {
          if (img === null || typeof img !== 'object') throw new Error('图片格式不对')
          const mediaType = typeof img.mediaType === 'string' ? img.mediaType : ''
          const data = typeof img.data === 'string' ? img.data : ''
          if (!IMAGE_TYPES.includes(mediaType)) {
            throw new Error('不支持的图片类型：' + (mediaType === '' ? '未声明' : mediaType)
              + '（只认 ' + IMAGE_TYPES.join(' / ') + '）')
          }
          if (data === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error('图片数据不是合法的 base64')
          inputs.push({
            data: Buffer.from(data, 'base64'),
            mediaType,
            ...(typeof img.name === 'string' && img.name !== '' ? { name: img.name } : {}),
          })
        }
        // 先入库（内容寻址、规范化尺寸），模型拿到的才是 ImageAttachmentRef。
        for (const ref of await attachments.saveImages(inputs)) {
          content.push({ type: 'image', attachment: ref })
        }
      }
      // ---- 上下文：模型要「掌握当前与归纳的全部信息」，才答得出「我现在该做什么」。
      // 三块：全貌（aiContext）+ 历史相似任务（historyText）+ 按需读的 vault 文件。
      // 文件只在**问题里点到了它**时才读——全读一遍既慢又撑爆上下文。
      const today = todayStr()
      const picked = pickVaultFiles(plan, text, 3)
      const fileBlock = picked.length > 0
        ? '【按需打开的关联文件】\n' + picked.map((f) => '### ' + f.ref + '\n' + f.content).join('\n\n')
        : ''
      const history = [historyText(plan, text, 3), fileBlock].filter((x) => x !== '').join('\n\n')
      const persona = readPersona(store.dir)

      // 会话内的前几轮：只取最近几轮、每轮截断，避免一次请求把 token 吃光。
      const past = Array.isArray(body.history) ? body.history : []
      const messages = []
      let kept = 0
      for (const turn of past.slice(-MAX_HISTORY)) {
        if (turn === null || typeof turn !== 'object') continue
        const role = turn.role === 'assistant' ? 'assistant' : 'user'
        const t = String(turn.text ?? '').slice(0, MAX_HISTORY_CHARS)
        if (t.trim() === '') continue
        messages.push({
          id: randomUUID(),
          role,
          content: [{ type: 'text', text: t }],
          source: { kind: 'plugin', plugin: 'dsh-workbench' },
        })
        kept += 1
        if (kept >= MAX_HISTORY) break
      }
      // 文字块压在图片**之后**：先给模型看图，再让它按指令拆条，符合视觉模型的习惯。
      content.push({ type: 'text', text: aiUserText(text) })
      messages.push({
        id: randomUUID(),
        role: 'user',
        content,
        source: { kind: 'plugin', plugin: 'dsh-workbench' },
      })

      let raw = ''
      let truncated = false
      try {
        const out = await collectText(serverCtx.get('llm'), {
          provider: status.provider,
          model: status.model,
          messages,
          system: aiSystemPrompt(planOutline(plan), today, {
            persona,
            context: aiContext(plan, today),
            history,
          }),
          // 额度要放得下提示词自己要的东西（最多 MAX_TASKS 条带 advice/options 的
          // 待办），见 ai.js 里 MAX_OUTPUT_TOKENS 那段。
          maxTokens: MAX_OUTPUT_TOKENS,
          signal: AbortSignal.timeout(AI_TIMEOUT_MS),
        })
        raw = out.text
        truncated = out.truncated
      } catch (e) {
        if (e !== null && typeof e === 'object' && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
          throw new Error('模型 ' + Math.round(AI_TIMEOUT_MS / 1000) + ' 秒没有返回，素材可能太复杂，少一点再试')
        }
        throw e
      }

      const parsed = parseAiReply(raw)
      // 被截断**不是**「什么都没有」：extractJson 会把残缺 JSON 里完整的那部分捞回来
      // （补右括号，丢掉最后那条写了一半的）。只有连一段完整前缀都凑不出来时才报错。
      if (parsed.error !== '') {
        if (truncated) throw new Error('模型回复被长度上限截断，素材可能太长，少说一点再试')
        throw new Error(parsed.error)
      }
      if (truncated) {
        // 拿到了东西、但只拿到一部分——**说出来**。悄悄少几条待办比报错更难发现。
        parsed.reply = (parsed.reply === '' ? '' : parsed.reply + '\n')
          + '· （回复被长度上限截断，上面只拿到前面这些；先采纳，再补一句处理剩下的）'
      }
      // **已有同名任务的「草稿」不是新建，是归位/改动。**
      // 用户的原话：「我本来就有两条任务是已经存在的了，你现在做的是要进行一些合并删减，
      // 而不是说让我确认再加任务」——模型经常一边在 reply 里写「这两条本来就在手上，
      // 别当新任务再建一遍」，一边照样把它们塞进 tasks。那是**格式**上的错，靠改提示词
      // 治不干净，所以在 host 这一层直接拦住：同名的转成 edits，tasks 里不再下发。
      const split = splitExistingTasks(plan, attachSuggestions(plan, parsed.tasks, today))
      json(res, {
        ok: true,
        // 问答与录入是同一次调用的两种产出：只提问时 tasks 为空，
        // 只报事时 reply 是一句确认。面板两种都要能渲染。
        reply: parsed.reply,
        tasks: split.fresh,
        // **改动已有任务**与**合并任务**：模型给的是标题，这里匹配回真实节点。
        // 匹配不上的 ok=false 原样带回去——AI 指错了要让人看见（同 list 的纪律）。
        // 转出来的改动排在前面：它们对应「我刚才说的那条其实已经有了」，最该先看见。
        edits: split.moved.concat(matchEdits(plan, parsed.edits)),
        merges: matchMerges(plan, parsed.merges),
        // **删除任务**：模型给标题，这里匹配回真实节点。只是「提议」——
        // 客户端渲染成卡，用户点确认才真的删（删除不可逆，不由模型一句话落库）。
        deletes: matchDeletes(plan, parsed.deletes),
        // AI 动态生成的清单：标题匹配回真实节点（匹配不上的 ok=false 带回去）。
        list: matchListTitles(plan, parsed.list),
        read: picked.map((f) => f.ref),
        turns: kept,
        model: { provider: status.provider, model: status.model },
      })
    }, AI_MAX_BODY_BYTES)

    /**
     * **把「其实是已有任务」的草稿摘出来，转成改动。**
     *
     * 判据是**标题完全相等**（去掉空白标点后），不做模糊匹配：模糊匹配在这里会把
     * 「去长安应急指挥中心进行验收」和另一条沾边的标题并到一起，那是猜，不是判。
     * 对不上的照样留在 tasks 里——新建是常态，「这条已经有了」是例外。
     *
     * 转出来的改动带上 `exists: true`，面板据此说清「已经在计划里」而不是「要新建」：
     * 用户看到一张改动卡（归入 / 改截止），而不是一张「再建一遍」的草稿卡。
     */
    function splitExistingTasks(plan, tasks) {
      const flat = collectNodes(plan, 'any')
      const exact = new Map()
      for (const x of flat) {
        const t = norm(String(x.node.title ?? ''))
        if (t !== '' && !exact.has(t)) exact.set(t, x.node)
      }
      const fresh = []
      const moved = []
      for (const t of tasks) {
        const hit = exact.get(norm(String(t.title)))
        if (hit === undefined) { fresh.push(t); continue }
        const patch = {}
        // 只放模型**明确给了**的字段：没给表示「这个不改」，不是「清空」。
        if (typeof t.due === 'string' && t.due !== '') patch.due = t.due
        if (typeof t.priority === 'string' && t.priority !== '') patch.priority = t.priority
        if (typeof t.note === 'string' && t.note !== '') patch.note = t.note
        if (typeof t.plan === 'string' && t.plan !== '') patch.plan = t.plan
        moved.push({
          target: String(hit.title),
          patch,
          why: typeof t.advice === 'string' ? t.advice : '',
          id: String(hit.id ?? ''),
          ok: true,
          exists: true,
        })
      }
      return { fresh, moved }
    }

    /**
     * 把 AI 清单里的**任务标题**匹配回节点。
     * 匹配规则与 attachSuggestions 的「模型点名计划」一致（相等 → 包含，取最长），
     * 匹配不上的条目 ok=false 原样返回——AI 指错了要让人看得见，而不是悄悄丢掉。
     */
    function matchListTitles(plan, list) {
      if (list === null || list === undefined) return null
      const flat = collectNodes(plan, 'any')
      const items = (Array.isArray(list.items) ? list.items : []).map((t) => {
        const hit = hitByTitle(flat, t)
        return {
          title: String(t),
          id: hit === null ? null : String(hit.id ?? ''),
          ok: hit !== null,
        }
      })
      return { title: String(list.title ?? ''), items }
    }

    /**
     * 按标题在整棵树里找节点：完全相等优先，其次互相包含（取标题最长的那个，
     * 免得「数据」命中一堆）。找不到返回 null。
     *
     * 三种「模型点名了一个已有节点」的地方（清单 / 改动 / 合并）共用这一处，
     * 免得三处各写一套、慢慢长出三套匹配口径。
     */
    function hitByTitle(flat, want) {
      const w = norm(String(want))
      if (w === '') return null
      let hit = null
      let best = 0
      for (const x of flat) {
        const got = norm(String(x.node.title ?? ''))
        if (got === '') continue
        if (got === w) return x.node
        if ((got.includes(w) || w.includes(got)) && got.length > best) {
          hit = x.node
          best = got.length
        }
      }
      return hit
    }

    /**
     * **改动已有任务**：把 target 标题匹配回节点。
     * 匹配不上、或者那条根本没字段可改的，ok=false 照样带回去——面板显示成
     * 「没对上：<标题>」，用户一眼看出模型抄错了哪个名字。
     */
    function matchEdits(plan, edits) {
      if (!Array.isArray(edits)) return []
      const flat = collectNodes(plan, 'any')
      return edits.map((e) => {
        const hit = hitByTitle(flat, e.target)
        return {
          target: e.target,
          patch: e.patch,
          why: e.why,
          id: hit === null ? null : String(hit.id ?? ''),
          ok: hit !== null,
        }
      })
    }

    /**
     * **合并任务**：keep 留下、fold 并进去。两种 mode：
     *   · `merge`（默认）——fold 的子项/证据/关联并进 keep，**然后删掉 fold**（重复条目）。
     *   · `children`——**每一条 fold 都挪到 keep 下面当子项，一条都不删**
     *     （用户原话：「我要的就是要把一些任务进行合并，然后作为计划，然后其他的作为它的子计划。」）
     *
     * 两种 mode 都要 keep 与全部 fold 匹配上才算 ok。
     *
     * 剔掉三种无意义项，剔的时候把原因记进 `skipped`（卡片上照实说，不静默丢）：
     *   ① fold 里混进了 keep 自己（按 id 判，标题写得不完全一样时也能认出来）；
     *   ② 同一条被 fold 两次；
     *   ③ children 模式下**挪了会成环**——keep 就在这条 fold 底下（把上级挪进自己的子孙，
     *      store 的 moveNode 会直接拒绝，面板点下去只会报错）；已经在 keep 底下的也别再挪一次。
     * 剩下的对不上就记在 `missing` 里带回去——「哪一条没对上」必须说出来，
     * 否则用户只会看到一条不执行的卡片。
     */
    function matchMerges(plan, merges) {
      if (!Array.isArray(merges)) return []
      const flat = collectNodes(plan, 'any')
      // 父节点要按 id 回查：判断「这条是不是已经在 keep 底下」用得到。
      const byId = new Map(flat.map((x) => [String(x.node.id ?? ''), x]))
      return merges.map((m) => {
        const mode = m.mode === 'children' ? 'children' : 'merge'
        const keep = hitByTitle(flat, m.keep)
        const keepId = keep === null ? null : String(keep.id ?? '')
        const missing = []
        const skipped = []
        const fold = []
        const seen = new Set(keepId === null ? [] : [keepId])
        for (const t of (Array.isArray(m.fold) ? m.fold : [])) {
          const hit = hitByTitle(flat, t)
          if (hit === null) { missing.push(String(t)); continue }
          const id = String(hit.id ?? '')
          if (seen.has(id)) { skipped.push({ title: String(hit.title ?? ''), why: '重复列了同一条' }); continue }
          seen.add(id)
          if (mode === 'children' && keep !== null) {
            // keep 在这条底下 → 挪过去成环；这条本来就在 keep 底下 → 不用挪。
            if (isDescendantOf(plan, keep, hit)) {
              skipped.push({ title: String(hit.title ?? ''), why: '它是「' + String(keep.title ?? '') + '」的上级，挪进去会成环' })
              continue
            }
            const here = byId.get(id)
            if (here !== undefined && here.parent !== null && String(here.parent.id ?? '') === keepId) {
              skipped.push({ title: String(hit.title ?? ''), why: '已经在「' + String(keep.title ?? '') + '」下面了' })
              continue
            }
          }
          fold.push({ id, title: String(hit.title ?? '') })
        }
        return {
          keep: m.keep,
          fold: m.fold,
          mode,
          title: m.title,
          why: m.why,
          keepId,
          keepTitle: keep === null ? '' : String(keep.title ?? ''),
          folds: fold,
          missing,
          skipped,
          // keep 下面已经有子项时，它本来就（即将）是计划——卡片上要能说清会多出几个子项。
          keepKids: keep === null ? 0 : childrenOf(keep).length,
          ok: keep !== null && fold.length > 0 && missing.length === 0,
        }
      })
    }

    /**
     * **删除任务**：把模型给的标题匹配回真实节点。
     *
     * 与 matchMerges 同一条纪律：匹配不上的记在 missing 里带回去——「哪一条没对上」
     * 必须说出来，否则用户只会看到一张不执行的卡。
     *
     * 只匹配、**不执行**。真正的删除走既有的 plan_node_remove（客户端点确认后调），
     * 所以这里不新增任何写入通路。
     */
    function matchDeletes(plan, deletes) {
      if (!Array.isArray(deletes)) return []
      const flat = collectNodes(plan, 'any')
      return deletes.map((d) => {
        const hit = hitByTitle(flat, d.target)
        return {
          target: d.target,
          why: d.why,
          id: hit === null ? null : String(hit.id ?? ''),
          title: hit === null ? '' : String(hit.title ?? ''),
          // 有子项的节点删掉会连带子树——卡片上要能说清「会一起删掉 N 个子项」。
          children: hit === null ? 0 : collectNodes({ nodes: [hit] }, 'any').length - 1,
          ok: hit !== null,
        }
      })
    }

    /** 与 ai.js 的 norm 同款（ai.js 没导出它，这里只用到这一种形态）。 */
    function norm(text) {
      return String(text ?? '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase()
    }

    /**
     * 读人设（`plan/agents.md`）。文件不在就用内置的默认人设——
     * 「没配过」不等于「没有人设」，助手从第一天起就该有稳定的性格与专业。
     */
    route('/persona', async (req, res) => {
      const body = await readBody(req)
      const store = storeFor(resolveCwd(body.sessionId))
      json(res, { ok: true, path: personaFile(store.dir), text: readPersona(store.dir), default: DEFAULT_PERSONA })
    })

    /** 写人设。人改全文；AI 追加走 `append`（只往「记住的事」一节末尾加一条）。 */
    route('/persona-set', async (req, res) => {
      const body = await readBody(req)
      const store = storeFor(resolveCwd(body.sessionId))
      const file = personaFile(store.dir)
      let text = typeof body.text === 'string' ? body.text : ''
      if (body.append !== undefined && body.append !== null && String(body.append).trim() !== '') {
        text = appendToPersona(readPersona(store.dir), String(body.append).trim())
      }
      try {
        mkdirSync(store.dir, { recursive: true })
        writeFileSync(file, text, 'utf8')
      } catch (e) {
        throw new Error('写不了人设文件（' + file + '）：' + (e instanceof Error ? e.message : String(e)))
      }
      json(res, { ok: true, path: file, text })
    })

    /**
     * 勾选待办。与工具走同一条写入路径（含版本归档）。
     * body 里可以带 evidenceKind / evidenceRef / evidenceNote 追加一条完成证据——
     * 面板目前不发，但两个写入入口的语义保持一致，工具能做的事数据面也能做。
     */
    route('/todo-set', async (req, res) => {
      const body = await readBody(req)
      const store = storeFor(resolveCwd(body.sessionId))
      const plan = await store.load()
      // 限定类型找待办：面板上的待办可能挂在任意深度的计划下，也可能在收件箱里。
      const found = resolveTodo(plan, body.todo)
      const beforeStatus = found.node.status
      setStatus(found.node, body.status)
      // 完成 / 撤回的向上派生：父计划可能被自动完成或重新打开。
      const autoReason = propagateStatus(plan, found.node, beforeStatus, todayStr())
      // 依赖 / 星标 / 重复（详情编辑页与执行清单走这里）。
      const dep = depInputOf(body)
      const depReasons = applyDeps(plan, found.node, dep)
      const spawned = spawnIfRecurring(plan, found.node, beforeStatus, todayStr())
      const evidence = evidenceInputOf(body)
      if (evidence !== undefined) addEvidence(found.node, evidence)
      const file = fileInputOf(body)
      if (file !== undefined) {
        if (file.op === 'remove') removeFile(found.node, file.ref)
        else addFile(found.node, file)
      }
      await store.save(plan, {
        reason: 'todo-' + found.node.status
          + (evidence === undefined ? '' : '+evidence')
          + (file === undefined ? '' : '+file' + (file.op === 'remove' ? '-rm' : ''))
          + depReasons.map((r) => '+' + r).join('')
          + (spawned !== null ? '+recur-spawn' : '')
          + autoReason,
      })
      json(res, { ok: true, plan: withProgress(plan, store.root) })
    })

    /** 新增节点（收件箱快速记一条，或计划下加子项）。 */
    route('/node-add', async (req, res) => {
      const body = await readBody(req)
      const store = storeFor(resolveCwd(body.sessionId))
      const plan = await store.load()
      const node = makeNode(plan, {
        title: body.title,
        owner: body.owner,
        due: body.due,
        start: body.start,
        end: body.end,
        priority: body.priority,
        note: body.note,
        metric: body.metric,
      })
      appendChild(plan, node, body.parent)
      await store.save(plan, { reason: typeOf(node) + '-add' })
      json(res, { ok: true, node: { id: node.id, type: typeOf(node) }, plan: withProgress(plan, store.root) })
    })

    /**
     * 改节点属性（类型 / 重要程度 / 委派回执 / 状态 / 标题 / 完成证据）。面板上的
     * 「高/中/低」徽章点击循环、⇧/⇩ 换型、回执按钮都走这里——不再为每种属性各开一条路由。
     */
    route('/node-set', async (req, res) => {
      const body = await readBody(req)
      const store = storeFor(resolveCwd(body.sessionId))
      const plan = await store.load()
      const found = resolveNode(plan, body.node, 'any')
      const beforeStatus = found.node.status
      const reasons = []
      // 有未完成子项的计划不能手动完成（它的完成由子项派生）。
      assertStatusAllowed(found.node, body.status)
      if (optStr(body.title) !== undefined || optStr(body.note) !== undefined) {
        applyFields(found.node, { title: body.title, note: body.note })
        reasons.push('node-edit')
      }
      if (optStr(body.priority) !== undefined) {
        setPriority(found.node, body.priority)
        reasons.push('priority-' + priorityOf(found.node))
      }
      if (optStr(body.status) !== undefined) {
        setStatus(found.node, body.status)
        reasons.push(typeOf(found.node) + '-' + found.node.status)
      }
      // 完成 / 撤回的向上派生：父可能被自动完成或重新打开。
      const autoReason = propagateStatus(plan, found.node, beforeStatus, todayStr())
      if (autoReason !== '') reasons.push(autoReason)
      // ---- 表单语义：详情编辑页整块提交的部分（写入 / 清空 / 删证据）。
      // 写入与清空分两条通路：`applyFields` 是「不传就不动」（agent 的增量语义），
      // 而表单是「所见即所得」，把负责人清空就是要删掉它。混在一条通路里，
      // 要么清不掉，要么 agent 少传一个参数就把数据抹了。
      const patch = {}
      if (typeof body.owner === 'string') patch.owner = body.owner
      if (typeof body.start === 'string') patch.start = body.start
      if (typeof body.end === 'string') patch.end = body.end
      if (typeof body.due === 'string') patch.due = body.due
      if (body.metric !== null && body.metric !== undefined && typeof body.metric === 'object') {
        patch.metric = body.metric
      }
      if (Object.keys(patch).length > 0) {
        applyFields(found.node, patch)
        reasons.push('node-edit')
      }
      if (Array.isArray(body.clear) && body.clear.length > 0) {
        // 返回实际清掉的条数：没改动就不记这一条 reason，避免留一版空快照。
        if (clearFields(found.node, body.clear) > 0) reasons.push('node-clear')
      }
      if (optStr(body.evidenceRemove) !== undefined) {
        if (removeEvidence(found.node, body.evidenceRemove, body.evidenceKind)) reasons.push('evidence-rm')
      }
      // 委派：换人 → setDelegate（回执作废）；只是挪期望时间 → 保留回执。
      // 不区分的话，每次保存表单都会把对方「已接受」打回「待接受」。
      if (optStr(body.to) !== undefined) {
        const d = found.node.delegate
        const cur = d !== null && d !== undefined && typeof d === 'object' ? d : {}
        if (body.to !== cur.to) {
          setDelegate(found.node, { to: body.to, expectAt: body.expectAt, note: body.note })
          reasons.push('delegate-set')
        } else if (optStr(body.expectAt) !== cur.expectAt) {
          setDelegateExpectAt(found.node, body.expectAt)
          reasons.push('delegate-expect')
        }
      }
      if (optStr(body.receipt) !== undefined) {
        setReceipt(found.node, body.receipt, { expectAt: body.expectAt, note: body.note })
        reasons.push('delegate-' + found.node.delegate.status)
      }
      const evidence = evidenceInputOf(body)
      if (evidence !== undefined) {
        addEvidence(found.node, evidence)
        reasons.push('evidence')
      }
      const file = fileInputOf(body)
      if (file !== undefined) {
        if (file.op === 'remove') removeFile(found.node, file.ref)
        else addFile(found.node, file)
        reasons.push('file' + (file.op === 'remove' ? '-rm' : ''))
      }
      // 依赖 / 星标 / 重复（详情编辑页的依赖区、★ 与重复下拉走这里）。
      const dep = depInputOf(body)
      reasons.push(...applyDeps(plan, found.node, dep))
      const spawned = spawnIfRecurring(plan, found.node, beforeStatus, todayStr())
      if (spawned !== null) reasons.push('recur-spawn')
      if (reasons.length === 0) {
        // 只传了已废弃的 filed 时，给一句说明而不是「没有要改的属性」——
        // 后者会让 agent 以为自己参数名写错了，然后反复试。
        if (body !== null && body !== undefined && typeof body.filed === 'boolean') {
          throw new Error('filed 已废弃并忽略：顶层现在不分「收件箱 / 工作计划」两栏，待办与计划平铺在一起。想让一条待办变成计划，直接给它加子项（plan_node_add 带 parent）')
        }
        throw new Error('没有要改的属性：可传 title / note / type / status / priority / owner / start / end / due / metric / to / receipt / clear / evidenceRef / fileRef / blockedAdd / blockedRemove / star / recur')
      }
      await store.save(plan, { reason: reasons.join('+') })
      json(res, {
        ok: true,
        node: { id: found.node.id, type: typeOf(found.node), unverified: isUnverified(found.node) },
        evidenceWarnings: evidenceWarnings(found.node, store.root),
        plan: withProgress(plan, store.root),
      })
    })

    /** 移动节点（收件箱归位 / 调整顺序）。 */
    route('/node-move', async (req, res) => {
      const body = await readBody(req)
      const store = storeFor(resolveCwd(body.sessionId))
      const plan = await store.load()
      const r = moveNode(plan, body.node, body.parent, body.index)
      await store.save(plan, { reason: 'node-move' })
      json(res, { ok: true, node: { id: r.node.id }, from: r.from, to: r.to, plan: withProgress(plan, store.root) })
    })

    /** 删除节点（连带子树）。 */
    route('/node-remove', async (req, res) => {
      const body = await readBody(req)
      const store = storeFor(resolveCwd(body.sessionId))
      const plan = await store.load()
      const r = removeNode(plan, body.node)
      await store.save(plan, { reason: 'node-remove' })
      json(res, { ok: true, removed: { id: r.node.id, stats: r.removed }, plan: withProgress(plan, store.root) })
    })

    route('/init', async (req, res) => {
      const body = await readBody(req)
      const store = storeFor(resolveCwd(body.sessionId))
      const plan = await store.load()
      const title = optStr(body.title) ?? plan.title
      // 保留节点，只重置标题等元信息。
      const next = { ...emptyPlan(title), nodes: plan.nodes, version: plan.version }
      await store.save(next, { reason: 'init' })
      json(res, { ok: true, plan: withProgress(next, store.root) })
    })

    route('/snapshot', async (req, res) => {
      const body = await readBody(req)
      const store = storeFor(resolveCwd(body.sessionId))
      const file = await store.snapshot(optStr(body.reason) ?? 'manual')
      json(res, { ok: true, file, versions: await store.history(30) })
    })

    route('/history', async (req, res) => {
      const body = await readBody(req)
      const store = storeFor(resolveCwd(body.sessionId))
      json(res, { ok: true, versions: await store.history(30) })
    })

    /**
     * 配置 / 清除 vault 路径（与 plan_config_set 同语义，数据面入口）。
     * 校验目录必须真实存在，否则返回 error 让面板提示。
     */
    route('/config-set', async (req, res) => {
      const body = await readBody(req)
      const store = storeFor(resolveCwd(body.sessionId))
      const plan = await store.load()
      const raw = optStr(body.vaultPath)
      if (raw === undefined || raw === '') {
        delete plan.vaultPath
        await store.save(plan, { reason: 'config-vault-clear' })
        json(res, { ok: true, vaultPath: '', cleared: true, plan: withProgress(plan, store.root) })
        return
      }
      const abs = resolve(raw)
      if (!existsSync(abs) || !statSync(abs).isDirectory()) {
        json(res, { ok: false, error: 'vault 路径不存在或不是目录：' + abs })
        return
      }
      plan.vaultPath = abs
      await store.save(plan, { reason: 'config-vault' })
      json(res, { ok: true, vaultPath: abs, exists: true, plan: withProgress(plan, store.root) })
    })

    /**
     * 读 vault 内文件 / 列文件夹（与 plan_file_read 同语义，数据面入口）。
     * 缺 vault / 越界 / 不存在都转成 JSON 返回，不抛 500。
     */
    route('/file-read', async (req, res) => {
      const body = await readBody(req)
      const store = storeFor(resolveCwd(body.sessionId))
      const plan = await store.load()
      try {
        const entry = readVaultEntry(plan, body.ref, body.kind)
        json(res, { ok: true, ...entry })
      } catch (e) {
        json(res, { ok: false, error: e.message })
      }
    })
  })
}
