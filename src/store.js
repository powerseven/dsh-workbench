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
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const PLAN_DIR = 'plan'
export const PLAN_FILE = 'plan.json'
export const VIEW_FILE = 'PLAN.md'
export const VERSIONS_DIR = '.versions'

/** 任务状态取值。todo=待办, doing=进行中, done=已完成, dropped=已放弃。 */
export const TASK_STATUS = ['todo', 'doing', 'done', 'dropped']
/** 目标/关键结果状态取值。 */
export const NODE_STATUS = ['active', 'done', 'dropped']

/** 数值夹取到 [0,1]。 */
function clamp01(n) {
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

/** 生成一个带前缀的自增 id（g1/k1/t1…），扫描全树保证不撞。 */
export function nextId(plan, prefix) {
  let max = 0
  const consider = (id) => {
    if (typeof id !== 'string' || !id.startsWith(prefix)) return
    const n = Number(id.slice(prefix.length))
    if (Number.isInteger(n) && n > max) max = n
  }
  for (const goal of plan.goals ?? []) {
    consider(goal.id)
    for (const kr of goal.krs ?? []) {
      consider(kr.id)
      for (const task of kr.tasks ?? []) consider(task.id)
    }
  }
  return prefix + String(max + 1)
}

/** 一份空计划。 */
export function emptyPlan(title = '个人工作计划') {
  return {
    // 从 0 起：第一次 save 自增为 v1。
    version: 0,
    title,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    goals: [],
  }
}

/**
 * 单个关键结果的完成度：
 *   1. 声明了 target（>0）时按 current/target 计算——这是「量化 KR」；
 *   2. 否则按任务的完成比例计算——这是「清单 KR」；
 *   3. 都没有时，done 记 1，其余记 0。
 */
export function krProgress(kr) {
  if (Number.isFinite(kr.target) && kr.target > 0) {
    return clamp01((Number(kr.current) || 0) / kr.target)
  }
  const tasks = kr.tasks ?? []
  if (tasks.length === 0) return kr.status === 'done' ? 1 : 0
  const done = tasks.filter((t) => t.status === 'done').length
  return done / tasks.length
}

/** 目标完成度 = 其下所有 KR 完成度的算术平均；无 KR 时按自身状态。 */
export function goalProgress(goal) {
  const krs = goal.krs ?? []
  if (krs.length === 0) return goal.status === 'done' ? 1 : 0
  const sum = krs.reduce((acc, kr) => acc + krProgress(kr), 0)
  return sum / krs.length
}

/** 全计划完成度 = 所有目标完成度的平均。 */
export function planProgress(plan) {
  const goals = plan.goals ?? []
  if (goals.length === 0) return 0
  return goals.reduce((acc, g) => acc + goalProgress(g), 0) / goals.length
}

/** 全计划任务计数（用于面板角标与进度条文案）。 */
export function taskCounts(plan) {
  const out = { todo: 0, doing: 0, done: 0, dropped: 0, total: 0 }
  for (const goal of plan.goals ?? []) {
    for (const kr of goal.krs ?? []) {
      for (const task of kr.tasks ?? []) {
        const s = TASK_STATUS.includes(task.status) ? task.status : 'todo'
        out[s] += 1
        out.total += 1
      }
    }
  }
  return out
}

const pct = (n) => String(Math.round(n * 100)) + '%'

/** 把计划渲染成 Markdown 视图。纯函数，便于测试。 */
export function renderMarkdown(plan) {
  const lines = []
  lines.push('# ' + (plan.title || '个人工作计划'))
  lines.push('')
  lines.push('> 本文件由 dsh-workbench 从 `plan.json` 自动生成，请勿手工编辑——改动会在下次写入时被覆盖。')
  lines.push('')
  lines.push('- 计划版本：v' + String(plan.version ?? 1))
  lines.push('- 更新时间：' + String(plan.updatedAt ?? ''))
  lines.push('- 整体完成度：' + pct(planProgress(plan)))
  const c = taskCounts(plan)
  lines.push('- 任务：共 ' + String(c.total) + '，已完成 ' + String(c.done) + '，进行中 ' + String(c.doing) + '，待办 ' + String(c.todo))
  lines.push('')

  for (const goal of plan.goals ?? []) {
    lines.push('## ' + goal.id + ' · ' + (goal.title || '(未命名目标)') + '  ' + pct(goalProgress(goal)))
    if (goal.owner) lines.push('- 负责人：' + goal.owner)
    if (goal.start || goal.end) lines.push('- 周期：' + (goal.start || '?') + ' ~ ' + (goal.end || '?'))
    if (goal.status && goal.status !== 'active') lines.push('- 状态：' + goal.status)
    if (goal.note) lines.push('- 备注：' + goal.note)
    lines.push('')
    for (const kr of goal.krs ?? []) {
      const q = Number.isFinite(kr.target) && kr.target > 0
        ? '  ' + String(kr.current ?? 0) + '/' + String(kr.target) + (kr.unit ? ' ' + kr.unit : '')
        : ''
      lines.push('### ' + kr.id + ' · ' + (kr.title || '(未命名KR)') + '  ' + pct(krProgress(kr)) + q)
      if (kr.note) lines.push('')
      if (kr.note) lines.push('  ' + kr.note)
      lines.push('')
      for (const task of kr.tasks ?? []) {
        const box = task.status === 'done' ? '[x]' : '[ ]'
        const bits = []
        if (task.status === 'doing') bits.push('进行中')
        if (task.status === 'dropped') bits.push('已放弃')
        if (task.due) bits.push('截止 ' + task.due)
        lines.push('- ' + box + ' ' + task.id + ' · ' + (task.title || '(未命名任务)') + (bits.length ? '  _(' + bits.join('；') + ')_' : ''))
        if (task.note) lines.push('  - ' + task.note)
      }
      lines.push('')
    }
  }
  return lines.join('\n')
}

/**
 * 按 id 或标题在计划里定位一个节点。
 * 先精确匹配 id，再精确匹配标题，最后做一次包含匹配（大小写不敏感）。
 * 命中多个时报错而不是随便挑一个——静默挑错会让 agent 改错对象。
 */
export function resolveRef(plan, ref, kind) {
  if (typeof ref !== 'string' || ref.trim() === '') {
    throw new Error('需要一个 ' + kind + ' 的 id 或标题')
  }
  const needle = ref.trim()
  const lower = needle.toLowerCase()
  const nodes = []
  if (kind === 'goal') {
    for (const goal of plan.goals ?? []) nodes.push({ node: goal, parent: null })
  } else if (kind === 'kr') {
    for (const goal of plan.goals ?? []) for (const kr of goal.krs ?? []) nodes.push({ node: kr, parent: goal })
  } else {
    for (const goal of plan.goals ?? []) {
      for (const kr of goal.krs ?? []) for (const task of kr.tasks ?? []) nodes.push({ node: task, parent: kr })
    }
  }
  const byId = nodes.find((x) => x.node.id === needle)
  if (byId) return byId
  const byTitle = nodes.filter((x) => (x.node.title || '') === needle)
  if (byTitle.length === 1) return byTitle[0]
  if (byTitle.length > 1) throw new Error('标题「' + needle + '」匹配到多个 ' + kind + '，请改用 id')
  const byFuzzy = nodes.filter((x) => (x.node.title || '').toLowerCase().includes(lower))
  if (byFuzzy.length === 1) return byFuzzy[0]
  if (byFuzzy.length > 1) throw new Error('「' + needle + '」模糊匹配到多个 ' + kind + '，请改用 id')
  throw new Error('找不到 ' + kind + '：' + needle)
}

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

  /** 读取计划；文件不存在时返回一份空计划（不落盘，首次写入才创建）。 */
  async load() {
    if (!existsSync(this.file)) return emptyPlan()
    const raw = await readFile(this.file, 'utf8')
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      throw new Error('plan.json 不是合法 JSON（' + this.file + '）：' + (e instanceof Error ? e.message : String(e)))
    }
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.goals)) {
      throw new Error('plan.json 结构不合法：缺少 goals 数组（' + this.file + '）')
    }
    return parsed
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

  /** 回滚到某个历史版本（把当前版本也归档，所以回滚本身可撤销）。 */
  async restore(fileName) {
    const name = String(fileName)
    if (name.includes('/') || name.includes('\\') || name.includes('..')) {
      throw new Error('非法的版本文件名：' + name)
    }
    const target = join(this.versions, name)
    if (!existsSync(target)) throw new Error('版本不存在：' + name)
    await this.#archive('before-restore')
    const raw = await readFile(target, 'utf8')
    const plan = JSON.parse(raw)
    await mkdir(this.dir, { recursive: true })
    await writeFile(this.file, JSON.stringify(plan, null, 2) + '\n', 'utf8')
    await writeFile(this.view, renderMarkdown(plan), 'utf8')
    return plan
  }
}
