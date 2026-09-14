/**
 * 客户端纯逻辑单元测试（node:test）。
 * logic.cjs 是 CommonJS，用 createRequire 直接加载——它刻意不依赖
 * React/DOM，所以可以在 Node 里测。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { pct, barWidth, statusLabel, sortTasks, summarize, toggleStatus } = require('../src/client/logic.cjs')

test('pct 四舍五入并夹取到 0..100', () => {
  assert.equal(pct(0), '0%')
  assert.equal(pct(0.256), '26%')
  assert.equal(pct(1), '100%')
  assert.equal(pct(1.5), '100%')
  assert.equal(pct(-1), '0%')
})

test('pct 对脏数据不抛错', () => {
  assert.equal(pct(undefined), '0%')
  assert.equal(pct(null), '0%')
  assert.equal(pct(NaN), '0%')
  assert.equal(pct('0.5'), '0%')
})

test('barWidth 与 pct 同源', () => {
  assert.equal(barWidth(0.5), '50%')
  assert.equal(barWidth(undefined), '0%')
})

test('statusLabel 覆盖四种状态且对未知值兜底', () => {
  assert.equal(statusLabel('todo'), '待办')
  assert.equal(statusLabel('doing'), '进行中')
  assert.equal(statusLabel('done'), '已完成')
  assert.equal(statusLabel('dropped'), '已放弃')
  assert.equal(statusLabel('乱写'), '待办')
  assert.equal(statusLabel(undefined), '待办')
})

test('sortTasks 把未完成排在前、已完成沉底', () => {
  const tasks = [
    { id: 't1', status: 'done' },
    { id: 't2', status: 'todo' },
    { id: 't3', status: 'dropped' },
    { id: 't4', status: 'doing' },
  ]
  assert.deepEqual(sortTasks(tasks).map((t) => t.id), ['t2', 't4', 't1', 't3'])
})

test('sortTasks 不改动入参', () => {
  const tasks = [{ id: 't1', status: 'done' }, { id: 't2', status: 'todo' }]
  const before = tasks.map((t) => t.id)
  sortTasks(tasks)
  assert.deepEqual(tasks.map((t) => t.id), before)
})

test('sortTasks 容忍非数组', () => {
  assert.deepEqual(sortTasks(undefined), [])
  assert.deepEqual(sortTasks(null), [])
})

test('summarize 统计目标/KR/任务与完成数', () => {
  const plan = {
    goals: [{
      krs: [
        { tasks: [{ status: 'done' }, { status: 'todo' }] },
        { tasks: [{ status: 'doing' }] },
      ],
    }],
  }
  const s = summarize(plan)
  assert.equal(s.goals, 1)
  assert.equal(s.krs, 2)
  assert.equal(s.tasks, 3)
  assert.equal(s.done, 1)
  assert.equal(s.open, 2, 'dropped 之外的未完成都算 open')
  assert.equal(s.hasPlan, true)
})

test('summarize 不计 dropped 为 open', () => {
  const plan = { goals: [{ krs: [{ tasks: [{ status: 'dropped' }, { status: 'todo' }] }] }] }
  assert.equal(summarize(plan).open, 1)
})

test('summarize 优先用服务端算好的 progress', () => {
  const plan = { progress: 0.42, goals: [{ krs: [{ tasks: [{ status: 'done' }] }] }] }
  assert.equal(summarize(plan).progress, 0.42)
})

test('summarize 在缺 progress 时按任务比例兜底', () => {
  const plan = { goals: [{ krs: [{ tasks: [{ status: 'done' }, { status: 'todo' }] }] }] }
  assert.equal(summarize(plan).progress, 0.5)
})

test('summarize 对空计划与脏数据安全', () => {
  assert.equal(summarize(null).hasPlan, false)
  assert.equal(summarize(null).goals, 0)
  assert.equal(summarize({}).hasPlan, false)
  assert.equal(summarize({ goals: 'nope' }).goals, 0)
  assert.equal(summarize({ goals: [{}] }).krs, 0)
})

test('toggleStatus 在待办与已完成之间切换', () => {
  assert.equal(toggleStatus('todo'), 'done')
  assert.equal(toggleStatus('done'), 'todo')
  assert.equal(toggleStatus('doing'), 'done')
  assert.equal(toggleStatus(undefined), 'done')
})
