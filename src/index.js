/**
 * dsh-workbench —— Host 半身。
 *
 * 提供两层接口，共用同一份数据（工作区内的 plan/ 目录）：
 *
 *   1. 模型工具（plan_*）—— 让 agent 直接读计划和回写进度。
 *      这是本插件相对普通待办应用的关键差异：AI 干完活可以自己把
 *      对应任务标记完成，进度不需要人来同步。
 *   2. /api/workbench/* HTTP 数据面 —— 浏览器侧边面板用。
 *
 * 工作区定位：每条工具调用都带着 agent，agent 的会话 header 里有 cwd，
 * plan/ 就建在那个目录下 —— 计划与产出同仓，可 git diff、可回溯。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  DELEGATE_STATUS,
  KIND_LABEL,
  PlanStore,
  NODE_STATUS,
  PRIORITY,
  TASK_STATUS,
  applyStatus,
  controlSummary,
  delegateState,
  delegatedList,
  emptyPlan,
  goalProgress,
  isDueWithin,
  isOverdue,
  krProgress,
  nextId,
  planProgress,
  priorityOf,
  resolveAny,
  resolveRef,
  nodeWarnings,
  setDelegate,
  setPriority,
  setReceipt,
  taskCounts,
  todayStr,
} from './store.js'

export const name = 'dsh-workbench'
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
 *   priority      缺省补成 normal，前端不必自己兜底
 *   warnings      按重要程度给出的管控缺口提示
 *   delegateState 委派的可判断形态（含两种逾期标记）
 *   overdue       是否逾期（含委派逾期）
 *   dueSoon       7 天内到期
 */
function annotate(node, kind, today) {
  return {
    ...node,
    priority: priorityOf(node),
    warnings: nodeWarnings(node, kind),
    delegateState: delegateState(node, today),
    overdue: isOverdue(node, today),
    dueSoon: isDueWithin(node, 7, today),
  }
}

/** 给计划补上派生字段（进度、管控汇总、委派清单），返回给模型/前端时用。 */
function withProgress(plan) {
  const today = todayStr()
  return {
    ...plan,
    progress: planProgress(plan),
    counts: taskCounts(plan),
    control: controlSummary(plan, today),
    delegated: delegatedList(plan, today),
    inbox: (plan.inbox ?? []).map((node) => annotate(node, 'inbox', today)),
    goals: (plan.goals ?? []).map((goal) => ({
      ...annotate(goal, 'goal', today),
      progress: goalProgress(goal),
      krs: (goal.krs ?? []).map((kr) => ({
        ...annotate(kr, 'kr', today),
        progress: krProgress(kr),
        tasks: (kr.tasks ?? []).map((task) => annotate(task, 'task', today)),
      })),
    })),
  }
}

const str = (v) => (typeof v === 'string' ? v.trim() : '')
const optStr = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined)

/**
 * 定位一个「待办」：子计划下的任务，或收件箱里的游离待办。
 *
 * 不能只按 kind='task' 找——收件箱待办的 kind 是 `inbox`，限定种类会漏掉它们，
 * 于是「收件箱里勾一条完成」直接报「找不到 task」。这一类错误只有把工具真跑
 * 一遍才会暴露（见 test/host.test.mjs）。
 */
function resolveTodo(plan, ref) {
  const found = resolveAny(plan, ref)
  if (found.kind !== 'task' && found.kind !== 'inbox') {
    throw new Error('「' + String(ref) + '」是' + (KIND_LABEL[found.kind] ?? found.kind)
      + '，不是待办——改计划/子计划的状态请用 plan_goal_set / plan_kr_set')
  }
  return found
}

export function apply(ctx) {
  // ---------------------------------------------------------------- 模型工具

  ctx.tools.register(makeTool(
    'plan_show',
    '查看当前工作区的工作计划（目标 → 关键结果 → 任务 三级树，含自动计算的完成度）。计划文件位于 <工作区>/plan/plan.json。',
    {},
    async (_args, exec) => {
      const store = storeFor(cwdOf(exec))
      const plan = await store.load()
      return { ok: true, dir: store.dir, plan: withProgress(plan) }
    },
  ))

  ctx.tools.register(makeTool(
    'plan_goal_add',
    '新增一个计划（计划树的顶层）。计划下可以用 plan_kr_add 挂子计划，子计划下再用 plan_task_add 挂待办。'
      + '重要程度决定这个节点要走多少流程：高 = 必须周期与负责人；中 = 要有结束日期；低 = 只记录。',
    {
      title: { type: 'string', required: true, description: '计划标题，一句话说清要达成什么' },
      owner: { type: 'string', description: '可选：负责人' },
      start: { type: 'string', description: '可选：周期开始 YYYY-MM-DD' },
      end: { type: 'string', description: '可选：周期结束 YYYY-MM-DD' },
      priority: { type: 'string', description: '可选：重要程度 ' + PRIORITY.join(' / ') + '，默认 normal（中）' },
      note: { type: 'string', description: '可选：备注' },
    },
    async (args, exec) => {
      const store = storeFor(cwdOf(exec))
      const title = str(args?.title)
      if (title === '') throw new Error('计划标题不能为空')
      const plan = await store.load()
      const goal = {
        id: nextId(plan, 'g'),
        title,
        status: 'active',
        krs: [],
      }
      const owner = optStr(args?.owner)
      if (owner !== undefined) goal.owner = owner
      const start = optStr(args?.start)
      if (start !== undefined) goal.start = start
      const end = optStr(args?.end)
      if (end !== undefined) goal.end = end
      const note = optStr(args?.note)
      if (note !== undefined) goal.note = note
      if (optStr(args?.priority) !== undefined) setPriority(goal, args.priority)
      plan.goals.push(goal)
      await store.save(plan, { reason: 'goal-add' })
      return { ok: true, goal, warnings: nodeWarnings(goal, 'goal'), plan: withProgress(plan) }
    },
  ))

  ctx.tools.register(makeTool(
    'plan_kr_add',
    '在某个计划下新增子计划（KR）。已声明计划 id 或标题均可定位。子计划可以声明 target/current 做量化跟踪，也可以只挂待办清单。',
    {
      goal: { type: 'string', required: true, description: '计划 id（如 g1）或标题' },
      title: { type: 'string', required: true, description: '子计划标题' },
      owner: { type: 'string', description: '可选：负责人' },
      start: { type: 'string', description: '可选：周期开始 YYYY-MM-DD' },
      end: { type: 'string', description: '可选：周期结束 YYYY-MM-DD' },
      target: { type: 'number', description: '可选：量化目标值（与 current 配套）' },
      current: { type: 'number', description: '可选：当前值' },
      unit: { type: 'string', description: '可选：量化单位（个 / 万元 / % 等）' },
      priority: { type: 'string', description: '可选：重要程度 ' + PRIORITY.join(' / ') + '，默认 normal（中）' },
      note: { type: 'string', description: '可选：备注' },
    },
    async (args, exec) => {
      const store = storeFor(cwdOf(exec))
      const title = str(args?.title)
      if (title === '') throw new Error('子计划标题不能为空')
      const plan = await store.load()
      const { node: goal } = resolveRef(plan, args?.goal, 'goal')
      const kr = { id: nextId(plan, 'k'), title, status: 'active', tasks: [] }
      const owner = optStr(args?.owner)
      if (owner !== undefined) kr.owner = owner
      const start = optStr(args?.start)
      if (start !== undefined) kr.start = start
      const end = optStr(args?.end)
      if (end !== undefined) kr.end = end
      if (Number.isFinite(args?.target)) kr.target = Number(args.target)
      if (Number.isFinite(args?.current)) kr.current = Number(args.current)
      const unit = optStr(args?.unit)
      if (unit !== undefined) kr.unit = unit
      const note = optStr(args?.note)
      if (note !== undefined) kr.note = note
      if (optStr(args?.priority) !== undefined) setPriority(kr, args.priority)
      if (goal.krs === undefined) goal.krs = []
      goal.krs.push(kr)
      await store.save(plan, { reason: 'kr-add' })
      return { ok: true, kr, goal: goal.id, warnings: nodeWarnings(kr, 'kr'), plan: withProgress(plan) }
    },
  ))

  ctx.tools.register(makeTool(
    'plan_task_add',
    '在某个子计划下新增待办（实际动手做的事）。还不知道该挂在哪儿时，先用 plan_todo_add 丢进收件箱。',
    {
      kr: { type: 'string', required: true, description: '子计划的 id（如 k1）或标题' },
      title: { type: 'string', required: true, description: '待办标题' },
      due: { type: 'string', description: '可选：截止日期 YYYY-MM-DD' },
      priority: { type: 'string', description: '可选：重要程度 ' + PRIORITY.join(' / ') + '，默认 normal（中）' },
      note: { type: 'string', description: '可选：备注' },
    },
    async (args, exec) => {
      const store = storeFor(cwdOf(exec))
      const title = str(args?.title)
      if (title === '') throw new Error('待办标题不能为空')
      const plan = await store.load()
      const { node: kr } = resolveRef(plan, args?.kr, 'kr')
      const task = { id: nextId(plan, 't'), title, status: 'todo' }
      const due = optStr(args?.due)
      if (due !== undefined) task.due = due
      const note = optStr(args?.note)
      if (note !== undefined) task.note = note
      if (optStr(args?.priority) !== undefined) setPriority(task, args.priority)
      if (kr.tasks === undefined) kr.tasks = []
      kr.tasks.push(task)
      await store.save(plan, { reason: 'task-add' })
      return { ok: true, task, kr: kr.id, warnings: nodeWarnings(task, 'task'), plan: withProgress(plan) }
    },
  ))

  ctx.tools.register(makeTool(
    'plan_todo_add',
    '记一条待办，放进收件箱（不挂任何计划）。这是「记下来」成本最低的入口：'
      + '开会、聊天里冒出来的事先记上，之后再归位到子计划下。已经知道该挂哪儿就用 plan_task_add。',
    {
      title: { type: 'string', required: true, description: '待办标题' },
      due: { type: 'string', description: '可选：截止日期 YYYY-MM-DD' },
      priority: { type: 'string', description: '可选：重要程度 ' + PRIORITY.join(' / ') + '，默认 normal（中）' },
      note: { type: 'string', description: '可选：备注' },
    },
    async (args, exec) => {
      const store = storeFor(cwdOf(exec))
      const title = str(args?.title)
      if (title === '') throw new Error('待办标题不能为空')
      const plan = await store.load()
      const todo = { id: nextId(plan, 't'), title, status: 'todo' }
      const due = optStr(args?.due)
      if (due !== undefined) todo.due = due
      const note = optStr(args?.note)
      if (note !== undefined) todo.note = note
      if (optStr(args?.priority) !== undefined) setPriority(todo, args.priority)
      plan.inbox.push(todo)
      await store.save(plan, { reason: 'todo-add' })
      return { ok: true, todo, warnings: nodeWarnings(todo, 'inbox'), plan: withProgress(plan) }
    },
  ))

  ctx.tools.register(makeTool(
    'plan_task_set',
    '更新一个待办的状态。这是 agent 回写进度的主要入口：干完一件事就把它标成 done，'
      + '完成时会自动记下完成时间（doneAt），计划的完成度会自动重算。',
    {
      task: { type: 'string', required: true, description: '待办 id（如 t1）或标题' },
      status: { type: 'string', required: true, description: '新状态：todo(待办) / doing(进行中) / done(已完成) / dropped(已放弃)' },
      note: { type: 'string', description: '可选：追加备注（留痕为什么放弃/怎么完成的）' },
    },
    async (args, exec) => {
      const store = storeFor(cwdOf(exec))
      const status = str(args?.status)
      if (!TASK_STATUS.includes(status)) {
        throw new Error('status 必须是 ' + TASK_STATUS.join(' / ') + ' 之一，收到：' + status)
      }
      const plan = await store.load()
      const found = resolveTodo(plan, args?.task)
      applyStatus(found.node, status)
      const note = optStr(args?.note)
      if (note !== undefined) found.node.note = note
      await store.save(plan, { reason: 'task-' + status })
      return { ok: true, task: found.node, warnings: nodeWarnings(found.node, found.kind), plan: withProgress(plan) }
    },
  ))

  ctx.tools.register(makeTool(
    'plan_kr_set',
    '更新子计划的量化进度、周期、负责人、重要程度或状态。挂待办清单的子计划不需要调这个，改待办状态即可。',
    {
      kr: { type: 'string', required: true, description: '子计划的 id 或标题' },
      current: { type: 'number', description: '可选：当前值' },
      target: { type: 'number', description: '可选：目标值' },
      owner: { type: 'string', description: '可选：负责人' },
      start: { type: 'string', description: '可选：周期开始 YYYY-MM-DD' },
      end: { type: 'string', description: '可选：周期结束 YYYY-MM-DD' },
      priority: { type: 'string', description: '可选：重要程度 ' + PRIORITY.join(' / ') },
      status: { type: 'string', description: '可选：active / done / dropped' },
      note: { type: 'string', description: '可选：备注' },
    },
    async (args, exec) => {
      const store = storeFor(cwdOf(exec))
      const plan = await store.load()
      const { node: kr } = resolveRef(plan, args?.kr, 'kr')
      if (Number.isFinite(args?.current)) kr.current = Number(args.current)
      if (Number.isFinite(args?.target)) kr.target = Number(args.target)
      const owner = optStr(args?.owner)
      if (owner !== undefined) kr.owner = owner
      const start = optStr(args?.start)
      if (start !== undefined) kr.start = start
      const end = optStr(args?.end)
      if (end !== undefined) kr.end = end
      if (optStr(args?.priority) !== undefined) setPriority(kr, args.priority)
      if (typeof args?.status === 'string' && args.status.trim() !== '') {
        const status = args.status.trim()
        if (!NODE_STATUS.includes(status)) {
          throw new Error('status 必须是 ' + NODE_STATUS.join(' / ') + ' 之一，收到：' + status)
        }
        applyStatus(kr, status)
      }
      const note = optStr(args?.note)
      if (note !== undefined) kr.note = note
      await store.save(plan, { reason: 'kr-set' })
      return { ok: true, kr, warnings: nodeWarnings(kr, 'kr'), plan: withProgress(plan) }
    },
  ))

  ctx.tools.register(makeTool(
    'plan_goal_set',
    '更新计划的标题、负责人、周期、重要程度或备注。',
    {
      goal: { type: 'string', required: true, description: '计划 id 或标题' },
      title: { type: 'string', description: '可选：新标题' },
      owner: { type: 'string', description: '可选：负责人' },
      start: { type: 'string', description: '可选：周期开始 YYYY-MM-DD' },
      end: { type: 'string', description: '可选：周期结束 YYYY-MM-DD' },
      priority: { type: 'string', description: '可选：重要程度 ' + PRIORITY.join(' / ') },
      status: { type: 'string', description: '可选：active / done / dropped' },
      note: { type: 'string', description: '可选：备注' },
    },
    async (args, exec) => {
      const store = storeFor(cwdOf(exec))
      const plan = await store.load()
      const { node: goal } = resolveRef(plan, args?.goal, 'goal')
      const title = optStr(args?.title)
      if (title !== undefined) goal.title = title
      const owner = optStr(args?.owner)
      if (owner !== undefined) goal.owner = owner
      const start = optStr(args?.start)
      if (start !== undefined) goal.start = start
      const end = optStr(args?.end)
      if (end !== undefined) goal.end = end
      const note = optStr(args?.note)
      if (note !== undefined) goal.note = note
      if (optStr(args?.priority) !== undefined) setPriority(goal, args.priority)
      if (typeof args?.status === 'string' && args.status.trim() !== '') {
        const status = args.status.trim()
        if (!NODE_STATUS.includes(status)) {
          throw new Error('status 必须是 ' + NODE_STATUS.join(' / ') + ' 之一，收到：' + status)
        }
        applyStatus(goal, status)
      }
      await store.save(plan, { reason: 'goal-set' })
      return { ok: true, goal, warnings: nodeWarnings(goal, 'goal'), plan: withProgress(plan) }
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
      return { ok: true, restoredFrom: file, plan: withProgress(plan) }
    },
  ))

  // ------------------------------------------------- 重要程度 / 委派（任意节点）

  ctx.tools.register(makeTool(
    'plan_priority_set',
    '设置任意节点（计划 / 子计划 / 待办，含收件箱）的重要程度。它不是标签而是管控强度开关：'
      + 'high 要求周期与负责人、落后要预警；normal 要求有截止；low 只记录不催。返回 warnings 指出还缺什么。',
    {
      node: { type: 'string', required: true, description: '节点 id（如 g1 / k1 / t1）或标题' },
      priority: { type: 'string', required: true, description: PRIORITY.join(' / ') + '（high=高, normal=中, low=低）' },
    },
    async (args, exec) => {
      const store = storeFor(cwdOf(exec))
      const plan = await store.load()
      const found = resolveAny(plan, args?.node)
      setPriority(found.node, args?.priority)
      await store.save(plan, { reason: 'priority-' + priorityOf(found.node) })
      return {
        ok: true,
        node: { id: found.node.id, kind: found.kind, title: found.node.title, priority: priorityOf(found.node) },
        warnings: nodeWarnings(found.node, found.kind),
        plan: withProgress(plan),
      }
    },
  ))

  ctx.tools.register(makeTool(
    'plan_delegate_set',
    '把一件事委派给某人。记录委派对象、委派时间与期望完成时间，回执状态初始为 pending（待接受）。'
      + '重新委派（换人）会把回执重置为待接受并刷新委派时间——上一轮的回执作废。',
    {
      node: { type: 'string', required: true, description: '节点 id 或标题（计划 / 子计划 / 待办均可）' },
      to: { type: 'string', required: true, description: '委派给谁（人名）' },
      expectAt: { type: 'string', description: '可选：期望完成日期 YYYY-MM-DD，逾期未回执会被标出来' },
      note: { type: 'string', description: '可选：交代的话 / 期望产出' },
    },
    async (args, exec) => {
      const store = storeFor(cwdOf(exec))
      const plan = await store.load()
      const found = resolveAny(plan, args?.node)
      setDelegate(found.node, { to: args?.to, expectAt: args?.expectAt, note: args?.note })
      await store.save(plan, { reason: 'delegate-set' })
      return {
        ok: true,
        node: { id: found.node.id, kind: found.kind, title: found.node.title },
        delegate: delegateState(found.node),
        plan: withProgress(plan),
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
      const found = resolveAny(plan, args?.node)
      setReceipt(found.node, args?.status, { expectAt: args?.expectAt, note: args?.note })
      await store.save(plan, { reason: 'delegate-' + found.node.delegate.status })
      return {
        ok: true,
        node: { id: found.node.id, kind: found.kind, title: found.node.title },
        delegate: delegateState(found.node),
        plan: withProgress(plan),
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
        items: items.map((x) => ({ ...x, kindLabel: KIND_LABEL[x.kind] ?? x.kind })),
      }
    },
  ))

  // ------------------------------------------------------------- HTTP 数据面

  // webServer 是可选的：宿主没有 web 表面时（headless 等）工具照常可用。
  ctx.inject(['webServer'], (serverCtx) => {
    const json = (res, body, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    }

    const MAX_BODY_BYTES = 1024 * 1024
    const readBody = (req) => new Promise((resolve, reject) => {
      let data = ''
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          const err = new Error('请求体过大（上限 1MiB）')
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

    const route = (path, handler) => {
      serverCtx.webServer.register({
        kind: 'exact',
        path: '/api/workbench' + path,
        handler: (req, res) => Promise.resolve(handler(req, res)).catch((e) => {
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
      json(res, { ok: true, cwd, dir: store.dir, plan: withProgress(plan) })
    })

    route('/task-set', async (req, res) => {
      const body = await readBody(req)
      const store = storeFor(resolveCwd(body.sessionId))
      const status = str(body.status)
      if (!TASK_STATUS.includes(status)) {
        throw new Error('status 必须是 ' + TASK_STATUS.join(' / ') + ' 之一')
      }
      const plan = await store.load()
      // 用 resolveTodo 而不是 resolveRef(...,'task')：面板上的待办可能是收件箱里的
      // 游离待办（不挂在任何子计划下），限定种类会找不到它。
      const found = resolveTodo(plan, body.task)
      applyStatus(found.node, status)
      await store.save(plan, { reason: 'task-' + status })
      json(res, { ok: true, plan: withProgress(plan) })
    })

    /**
     * 改节点属性（重要程度 / 委派回执）。面板上的「高/中/低」徽章点击循环、
     * 以及将来的回执按钮都走这里——不再为每种属性各开一条路由。
     */
    route('/node-set', async (req, res) => {
      const body = await readBody(req)
      const store = storeFor(resolveCwd(body.sessionId))
      const plan = await store.load()
      const found = resolveAny(plan, body.node)
      const reasons = []
      if (optStr(body.priority) !== undefined) {
        setPriority(found.node, body.priority)
        reasons.push('priority-' + priorityOf(found.node))
      }
      if (optStr(body.receipt) !== undefined) {
        setReceipt(found.node, body.receipt, { expectAt: body.expectAt, note: body.note })
        reasons.push('delegate-' + found.node.delegate.status)
      }
      if (optStr(body.to) !== undefined) {
        setDelegate(found.node, { to: body.to, expectAt: body.expectAt, note: body.note })
        reasons.push('delegate-set')
      }
      if (reasons.length === 0) throw new Error('没有要改的属性：可传 priority / receipt / to')
      await store.save(plan, { reason: reasons.join('+') })
      json(res, { ok: true, node: { id: found.node.id, kind: found.kind }, plan: withProgress(plan) })
    })

    /** 收件箱快速记一条（面板顶部的输入框）。先记下来，之后再归位。 */
    route('/todo-add', async (req, res) => {
      const body = await readBody(req)
      const store = storeFor(resolveCwd(body.sessionId))
      const title = str(body.title)
      if (title === '') throw new Error('待办标题不能为空')
      const plan = await store.load()
      const todo = { id: nextId(plan, 't'), title, status: 'todo' }
      const due = optStr(body.due)
      if (due !== undefined) todo.due = due
      if (optStr(body.priority) !== undefined) setPriority(todo, body.priority)
      plan.inbox.push(todo)
      await store.save(plan, { reason: 'todo-add' })
      json(res, { ok: true, todo: { id: todo.id }, plan: withProgress(plan) })
    })

    route('/init', async (req, res) => {
      const body = await readBody(req)
      const store = storeFor(resolveCwd(body.sessionId))
      const plan = await store.load()
      const title = optStr(body.title) ?? plan.title
      // 保留 goals 与 inbox，只重置标题等元信息。
      const next = { ...emptyPlan(title), goals: plan.goals, inbox: plan.inbox, version: plan.version }
      await store.save(next, { reason: 'init' })
      json(res, { ok: true, plan: withProgress(next) })
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
