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
  PlanStore,
  NODE_STATUS,
  TASK_STATUS,
  emptyPlan,
  goalProgress,
  krProgress,
  nextId,
  planProgress,
  resolveRef,
  taskCounts,
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

/** 给计划补上派生字段（进度），返回给模型/前端时用。 */
function withProgress(plan) {
  return {
    ...plan,
    progress: planProgress(plan),
    counts: taskCounts(plan),
    goals: (plan.goals ?? []).map((goal) => ({
      ...goal,
      progress: goalProgress(goal),
      krs: (goal.krs ?? []).map((kr) => ({ ...kr, progress: krProgress(kr) })),
    })),
  }
}

const str = (v) => (typeof v === 'string' ? v.trim() : '')
const optStr = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined)

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
    '新增一个目标（计划树的顶层）。目标下再用 plan_kr_add 挂关键结果。',
    {
      title: { type: 'string', required: true, description: '目标标题，一句话说清要达成什么' },
      owner: { type: 'string', description: '可选：负责人' },
      start: { type: 'string', description: '可选：周期开始 YYYY-MM-DD' },
      end: { type: 'string', description: '可选：周期结束 YYYY-MM-DD' },
      note: { type: 'string', description: '可选：备注' },
    },
    async (args, exec) => {
      const store = storeFor(cwdOf(exec))
      const title = str(args?.title)
      if (title === '') throw new Error('目标标题不能为空')
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
      plan.goals.push(goal)
      await store.save(plan, { reason: 'goal-add' })
      return { ok: true, goal, plan: withProgress(plan) }
    },
  ))

  ctx.tools.register(makeTool(
    'plan_kr_add',
    '在某个目标下新增关键结果（KR）。已声明目标 id 或标题均可定位。KR 可以声明 target/current 做量化跟踪，也可以只挂任务清单。',
    {
      goal: { type: 'string', required: true, description: '目标 id（如 g1）或标题' },
      title: { type: 'string', required: true, description: '关键结果标题' },
      target: { type: 'number', description: '可选：量化目标值（与 current 配套）' },
      current: { type: 'number', description: '可选：当前值' },
      unit: { type: 'string', description: '可选：量化单位（个 / 万元 / % 等）' },
      note: { type: 'string', description: '可选：备注' },
    },
    async (args, exec) => {
      const store = storeFor(cwdOf(exec))
      const title = str(args?.title)
      if (title === '') throw new Error('KR 标题不能为空')
      const plan = await store.load()
      const { node: goal } = resolveRef(plan, args?.goal, 'goal')
      const kr = { id: nextId(plan, 'k'), title, status: 'active', tasks: [] }
      if (Number.isFinite(args?.target)) kr.target = Number(args.target)
      if (Number.isFinite(args?.current)) kr.current = Number(args.current)
      const unit = optStr(args?.unit)
      if (unit !== undefined) kr.unit = unit
      const note = optStr(args?.note)
      if (note !== undefined) kr.note = note
      if (goal.krs === undefined) goal.krs = []
      goal.krs.push(kr)
      await store.save(plan, { reason: 'kr-add' })
      return { ok: true, kr, goal: goal.id, plan: withProgress(plan) }
    },
  ))

  ctx.tools.register(makeTool(
    'plan_task_add',
    '在某个关键结果下新增任务（计划树的叶子，实际动手做的事）。',
    {
      kr: { type: 'string', required: true, description: 'KR 的 id（如 k1）或标题' },
      title: { type: 'string', required: true, description: '任务标题' },
      due: { type: 'string', description: '可选：截止日期 YYYY-MM-DD' },
      note: { type: 'string', description: '可选：备注' },
    },
    async (args, exec) => {
      const store = storeFor(cwdOf(exec))
      const title = str(args?.title)
      if (title === '') throw new Error('任务标题不能为空')
      const plan = await store.load()
      const { node: kr } = resolveRef(plan, args?.kr, 'kr')
      const task = { id: nextId(plan, 't'), title, status: 'todo' }
      const due = optStr(args?.due)
      if (due !== undefined) task.due = due
      const note = optStr(args?.note)
      if (note !== undefined) task.note = note
      if (kr.tasks === undefined) kr.tasks = []
      kr.tasks.push(task)
      await store.save(plan, { reason: 'task-add' })
      return { ok: true, task, kr: kr.id, plan: withProgress(plan) }
    },
  ))

  ctx.tools.register(makeTool(
    'plan_task_set',
    '更新一个任务的状态。这是 agent 回写进度的主要入口：干完一件事就把它标成 done，计划的完成度会自动重算。',
    {
      task: { type: 'string', required: true, description: '任务 id（如 t1）或标题' },
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
      const { node: task } = resolveRef(plan, args?.task, 'task')
      task.status = status
      const note = optStr(args?.note)
      if (note !== undefined) task.note = note
      await store.save(plan, { reason: 'task-' + status })
      return { ok: true, task, plan: withProgress(plan) }
    },
  ))

  ctx.tools.register(makeTool(
    'plan_kr_set',
    '更新关键结果的量化进度或状态（target/current/status）。挂任务清单的 KR 不需要调这个，改变任务状态即可。',
    {
      kr: { type: 'string', required: true, description: 'KR 的 id 或标题' },
      current: { type: 'number', description: '可选：当前值' },
      target: { type: 'number', description: '可选：目标值' },
      status: { type: 'string', description: '可选：active / done / dropped' },
      note: { type: 'string', description: '可选：备注' },
    },
    async (args, exec) => {
      const store = storeFor(cwdOf(exec))
      const plan = await store.load()
      const { node: kr } = resolveRef(plan, args?.kr, 'kr')
      if (Number.isFinite(args?.current)) kr.current = Number(args.current)
      if (Number.isFinite(args?.target)) kr.target = Number(args.target)
      if (typeof args?.status === 'string' && args.status.trim() !== '') {
        const status = args.status.trim()
        if (!NODE_STATUS.includes(status)) {
          throw new Error('status 必须是 ' + NODE_STATUS.join(' / ') + ' 之一，收到：' + status)
        }
        kr.status = status
      }
      const note = optStr(args?.note)
      if (note !== undefined) kr.note = note
      await store.save(plan, { reason: 'kr-set' })
      return { ok: true, kr, plan: withProgress(plan) }
    },
  ))

  ctx.tools.register(makeTool(
    'plan_goal_set',
    '更新目标的标题、负责人、周期、状态或备注。',
    {
      goal: { type: 'string', required: true, description: '目标 id 或标题' },
      title: { type: 'string', description: '可选：新标题' },
      owner: { type: 'string', description: '可选：负责人' },
      start: { type: 'string', description: '可选：周期开始 YYYY-MM-DD' },
      end: { type: 'string', description: '可选：周期结束 YYYY-MM-DD' },
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
      if (typeof args?.status === 'string' && args.status.trim() !== '') {
        const status = args.status.trim()
        if (!NODE_STATUS.includes(status)) {
          throw new Error('status 必须是 ' + NODE_STATUS.join(' / ') + ' 之一，收到：' + status)
        }
        goal.status = status
      }
      await store.save(plan, { reason: 'goal-set' })
      return { ok: true, goal, plan: withProgress(plan) }
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
      const { node: task } = resolveRef(plan, body.task, 'task')
      task.status = status
      await store.save(plan, { reason: 'task-' + status })
      json(res, { ok: true, plan: withProgress(plan) })
    })

    route('/init', async (req, res) => {
      const body = await readBody(req)
      const store = storeFor(resolveCwd(body.sessionId))
      const plan = await store.load()
      const title = optStr(body.title) ?? plan.title
      const next = { ...emptyPlan(title), goals: plan.goals, version: plan.version }
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
