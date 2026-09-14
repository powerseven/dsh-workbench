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

import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  DELEGATE_STATUS,
  EVIDENCE_KIND,
  NODE_TYPE,
  PRIORITY,
  PlanStore,
  TODO_STATUS,
  TYPE_LABEL,
  addEvidence,
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
  inboxOf,
  isDueWithin,
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
  removeNode,
  resolveNode,
  setDelegate,
  setNodeType,
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
  MAX_IMAGES,
  aiSystemPrompt,
  aiUserText,
  attachSuggestions,
  collectText,
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
function annotate(node, today, root, parentSuggestions = []) {
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
    parentSuggestions,
  }
  out.behind = out.pace !== null && out.pace.behind === true
  // 子节点递归标注，覆盖掉 `...node` 带上来的原始 children。
  // 建议只给顶层待办算，所以递归时不再往下传。
  if (type === 'plan') out.children = childrenOf(node).map((child) => annotate(child, today, root))
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
      node, today, root, suggestions.get(String(node.id ?? '')) ?? [],
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
    '新增一个节点：type=plan 是计划（可以再挂子项），type=todo 是待办（叶子，实际动手做的事）。'
      + 'parent 不传就放在顶层——顶层待办即收件箱，适合「先记下来、之后再归位」。'
      + '重要程度决定这个节点要走多少流程：高 = 必须周期与负责人；中 = 要有结束日期；低 = 只记录。',
    {
      title: { type: 'string', required: true, description: '节点标题，一句话说清要达成什么或要做什么' },
      type: { type: 'string', description: '节点类型：' + NODE_TYPE.join(' / ') + '（plan=计划, todo=待办），默认 todo' },
      parent: { type: 'string', description: '可选：父计划的 id 或标题。不传则放到顶层' },
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
        type: args?.type,
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
    '更新任意节点的字段：标题、类型、负责人、周期、截止、重要程度、状态、量化进度、备注、完成证据。'
      + '不传的字段保持不动。计划的状态是 active / done / dropped，待办是 todo / doing / done / dropped。'
      + '改 type 可以把待办提升为计划（继续往下拆），或把空计划降回待办——'
      + '有子节点的计划不能降级为待办，要先移走或删掉子节点。'
      + '把状态改成 done 时，用 evidenceRef 附上产出（文件路径 / 会话 id / 命令），'
      + '否则它会被列进「已完成但无证据」——那是给人核验「AI 真的干完了」用的清单。',
    {
      node: { type: 'string', required: true, description: '节点 id（如 n1 / g1）或标题' },
      type: { type: 'string', description: '可选：改为 ' + NODE_TYPE.join(' / ') + '（plan=计划, todo=待办）' },
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
    },
    async (args, exec) => {
      const store = storeFor(cwdOf(exec))
      const plan = await store.load()
      const { node } = resolveNode(plan, args?.node, 'any')
      // 先换型再写字段：状态校验依赖类型，顺序反了会用旧类型校验新状态。
      if (optStr(args?.type) !== undefined) setNodeType(node, args.type)
      applyFields(node, args)
      if (optStr(args?.status) !== undefined) setStatus(node, args.status)
      // 证据在状态之后追加：先落成 done 再挂凭据，两者是同一次改变的原子结果。
      const evidence = evidenceInputOf(args)
      if (evidence !== undefined) addEvidence(node, evidence)
      const type = typeOf(node)
      await store.save(plan, { reason: evidence === undefined ? type + '-set' : type + '-set+evidence' })
      return {
        ok: true,
        node,
        warnings: nodeWarnings(node, type),
        evidenceWarnings: evidenceWarnings(node, store.root),
        unverified: isUnverified(node),
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
    },
    async (args, exec) => {
      const store = storeFor(cwdOf(exec))
      const plan = await store.load()
      const found = resolveTodo(plan, args?.todo)
      setStatus(found.node, args?.status)
      const note = optStr(args?.note)
      if (note !== undefined) found.node.note = note
      const evidence = evidenceInputOf(args)
      if (evidence !== undefined) addEvidence(found.node, evidence)
      await store.save(plan, { reason: 'todo-' + found.node.status + (evidence === undefined ? '' : '+evidence') })
      return {
        ok: true,
        todo: found.node,
        warnings: nodeWarnings(found.node, 'todo'),
        evidenceWarnings: evidenceWarnings(found.node, store.root),
        unverified: isUnverified(found.node),
        plan: withProgress(plan, store.root),
      }
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
    /** 一次模型调用最多等 90 秒；超时宁可报错，也不要让面板一直转圈。 */
    const AI_TIMEOUT_MS = 90_000

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
        throw new Error('没有可解析的内容：说点什么、贴一段文字，或选一张图片')
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
      // 文字块压在图片**之后**：先给模型看图，再让它按指令拆条，符合视觉模型的习惯。
      content.push({ type: 'text', text: aiUserText(text) })

      const messages = [{
        id: randomUUID(),
        role: 'user',
        content,
        source: { kind: 'plugin', plugin: 'dsh-workbench' },
      }]
      let raw = ''
      try {
        raw = await collectText(serverCtx.get('llm'), {
          provider: status.provider,
          model: status.model,
          messages,
          system: aiSystemPrompt(planOutline(plan), todayStr()),
          maxTokens: 2048,
          signal: AbortSignal.timeout(AI_TIMEOUT_MS),
        })
      } catch (e) {
        if (e !== null && typeof e === 'object' && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
          throw new Error('模型 ' + Math.round(AI_TIMEOUT_MS / 1000) + ' 秒没有返回，素材可能太复杂，少一点再试')
        }
        throw e
      }

      const parsed = parseAiReply(raw)
      if (parsed.error !== '') throw new Error(parsed.error)
      json(res, {
        ok: true,
        tasks: attachSuggestions(plan, parsed.tasks, todayStr()),
        model: { provider: status.provider, model: status.model },
      })
    }, AI_MAX_BODY_BYTES)

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
      setStatus(found.node, body.status)
      const evidence = evidenceInputOf(body)
      if (evidence !== undefined) addEvidence(found.node, evidence)
      await store.save(plan, { reason: 'todo-' + found.node.status + (evidence === undefined ? '' : '+evidence') })
      json(res, { ok: true, plan: withProgress(plan, store.root) })
    })

    /** 新增节点（收件箱快速记一条，或计划下加子项）。 */
    route('/node-add', async (req, res) => {
      const body = await readBody(req)
      const store = storeFor(resolveCwd(body.sessionId))
      const plan = await store.load()
      const node = makeNode(plan, {
        type: body.type,
        title: body.title,
        due: body.due,
        priority: body.priority,
        note: body.note,
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
      const reasons = []
      // 换型排在最前：状态是按类型校验的，顺序反了会用旧类型校验新状态。
      if (optStr(body.type) !== undefined) {
        setNodeType(found.node, body.type)
        reasons.push(typeOf(found.node) + '-retype')
      }
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
      if (optStr(body.receipt) !== undefined) {
        setReceipt(found.node, body.receipt, { expectAt: body.expectAt, note: body.note })
        reasons.push('delegate-' + found.node.delegate.status)
      }
      if (optStr(body.to) !== undefined) {
        setDelegate(found.node, { to: body.to, expectAt: body.expectAt, note: body.note })
        reasons.push('delegate-set')
      }
      const evidence = evidenceInputOf(body)
      if (evidence !== undefined) {
        addEvidence(found.node, evidence)
        reasons.push('evidence')
      }
      if (reasons.length === 0) {
        throw new Error('没有要改的属性：可传 type / priority / status / title / receipt / to / evidenceRef')
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
  })
}
