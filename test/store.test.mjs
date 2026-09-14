/**
 * 计划数据层单元测试（node:test，无外部依赖）。
 * 运行：npm test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  PlanStore,
  emptyPlan,
  goalProgress,
  krProgress,
  nextId,
  planProgress,
  renderMarkdown,
  resolveRef,
  taskCounts,
} from '../src/store.js'

/** 一个可用的样例计划。 */
function samplePlan() {
  const plan = emptyPlan('测试计划')
  plan.goals.push({
    id: 'g1',
    title: '完成低电压治理攻坚',
    status: 'active',
    owner: '张三',
    start: '2026-10-01',
    end: '2026-12-31',
    krs: [
      {
        id: 'k1',
        title: '完成 12 个台区改造',
        status: 'active',
        target: 12,
        current: 3,
        unit: '个',
        tasks: [],
      },
      {
        id: 'k2',
        title: '建立治理台账',
        status: 'active',
        tasks: [
          { id: 't1', title: '收集基础数据', status: 'done' },
          { id: 't2', title: '录入系统', status: 'doing', due: '2026-11-01' },
          { id: 't3', title: '复核', status: 'todo' },
        ],
      },
    ],
  })
  return plan
}

async function withTemp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wb-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- 进度计算

test('量化 KR 按 current/target 计算', () => {
  assert.equal(krProgress({ target: 12, current: 3 }), 0.25)
  // 超额完成夹取到 1
  assert.equal(krProgress({ target: 2, current: 5 }), 1)
})

test('清单 KR 按任务完成比例计算', () => {
  const kr = { tasks: [{ status: 'done' }, { status: 'todo' }, { status: 'todo' }, { status: 'done' }] }
  assert.equal(krProgress(kr), 0.5)
})

test('清单 KR 里 dropped 任务不计入完成数', () => {
  const kr = { tasks: [{ status: 'done' }, { status: 'dropped' }] }
  assert.equal(krProgress(kr), 0.5)
})

test('空 KR 按自身状态给 0 或 1', () => {
  assert.equal(krProgress({ tasks: [] }), 0)
  assert.equal(krProgress({ tasks: [], status: 'done' }), 1)
})

test('量化优先于任务清单', () => {
  const kr = { target: 10, current: 1, tasks: [{ status: 'done' }] }
  assert.equal(krProgress(kr), 0.1)
})

test('目标完成度是各 KR 的平均', () => {
  const plan = samplePlan()
  // k1 = 3/12 = 0.25；k2 = 1/3 ≈ 0.3333…
  const expected = (0.25 + 1 / 3) / 2
  assert.ok(Math.abs(goalProgress(plan.goals[0]) - expected) < 1e-9)
})

test('全计划完成度是各目标的平均；无目标时为 0', () => {
  const plan = samplePlan()
  assert.ok(Math.abs(planProgress(plan) - goalProgress(plan.goals[0])) < 1e-9)
  assert.equal(planProgress(emptyPlan()), 0)
})

// -------------------------------------------------------------------- 计数

test('taskCounts 统计四种状态并给出总数', () => {
  const plan = samplePlan()
  const c = taskCounts(plan)
  assert.equal(c.total, 3)
  assert.equal(c.done, 1)
  assert.equal(c.doing, 1)
  assert.equal(c.todo, 1)
  assert.equal(c.dropped, 0)
})

test('taskCounts 把非法状态按 todo 计', () => {
  const plan = emptyPlan()
  plan.goals.push({ id: 'g1', title: 'x', krs: [{ id: 'k1', title: 'y', tasks: [{ id: 't1', title: 'z', status: '乱写' }] }] })
  assert.equal(taskCounts(plan).todo, 1)
})

// -------------------------------------------------------------------- id

test('nextId 跳过已用编号，不受层级影响', () => {
  const plan = samplePlan()
  assert.equal(nextId(plan, 'g'), 'g2')
  // k1/k2 已用
  assert.equal(nextId(plan, 'k'), 'k3')
  // t1/t2/t3 已用（嵌套在 KR 内也要扫到）
  assert.equal(nextId(plan, 't'), 't4')
})

test('nextId 在不同前缀之间互不干扰', () => {
  const plan = emptyPlan()
  plan.goals.push({ id: 'g1', title: 'a', krs: [{ id: 'k1', title: 'b', tasks: [{ id: 't1', title: 'c', status: 'todo' }] }] })
  assert.equal(nextId(plan, 'g'), 'g2')
  assert.equal(nextId(plan, 't'), 't2')
})

// ------------------------------------------------------------------ resolve

test('resolveRef 支持按 id 定位', () => {
  const plan = samplePlan()
  assert.equal(resolveRef(plan, 'g1', 'goal').node.id, 'g1')
  assert.equal(resolveRef(plan, 'k2', 'kr').node.id, 'k2')
  assert.equal(resolveRef(plan, 't2', 'task').node.id, 't2')
})

test('resolveRef 支持按完整标题定位', () => {
  const plan = samplePlan()
  assert.equal(resolveRef(plan, '建立治理台账', 'kr').node.id, 'k2')
})

test('resolveRef 支持唯一包含匹配', () => {
  const plan = samplePlan()
  assert.equal(resolveRef(plan, '复核', 'task').node.id, 't3')
})

test('resolveRef 在有歧义时报错而不是随便挑一个', () => {
  const plan = emptyPlan()
  plan.goals.push({ id: 'g1', title: '目标A', krs: [{ id: 'k1', title: '改造台区', tasks: [] }] })
  plan.goals.push({ id: 'g2', title: '目标B', krs: [{ id: 'k2', title: '改造线路', tasks: [] }] })
  assert.throws(() => resolveRef(plan, '改造', 'kr'), /模糊匹配到多个/)
})

test('resolveRef 找不到时报错', () => {
  assert.throws(() => resolveRef(samplePlan(), '不存在的目标', 'goal'), /找不到 goal/)
})

test('resolveRef 空引用报错', () => {
  assert.throws(() => resolveRef(samplePlan(), '  ', 'goal'), /需要/)
})

// ---------------------------------------------------------------- Markdown

test('renderMarkdown 含标题、版本、进度与三级结构', () => {
  const md = renderMarkdown(samplePlan())
  assert.match(md, /# 测试计划/)
  assert.match(md, /## g1 · 完成低电压治理攻坚/)
  assert.match(md, /### k1 · 完成 12 个台区改造/)
  assert.match(md, /3\/12 个/)
  assert.match(md, /- \[x\] t1 · 收集基础数据/)
  assert.match(md, /- \[ \] t2 · 录入系统/)
  assert.match(md, /截止 2026-11-01/)
  assert.match(md, /负责人：张三/)
})

test('renderMarkdown 标注 doing 与 dropped', () => {
  const plan = emptyPlan()
  plan.goals.push({
    id: 'g1', title: 'G', krs: [{
      id: 'k1', title: 'K', tasks: [
        { id: 't1', title: '进行中的', status: 'doing' },
        { id: 't2', title: '放弃的', status: 'dropped' },
      ],
    }],
  })
  const md = renderMarkdown(plan)
  assert.match(md, /进行中/)
  assert.match(md, /已放弃/)
})

// ------------------------------------------------------------------- Store

test('load 在文件不存在时返回空计划', async () => {
  await withTemp(async (dir) => {
    const store = new PlanStore(dir)
    const plan = await store.load()
    assert.deepEqual(plan.goals, [])
    assert.equal(plan.version, 0)
  })
})

test('save 落盘 plan.json 与 PLAN.md，并自增版本号', async () => {
  await withTemp(async (dir) => {
    const store = new PlanStore(dir)
    const plan = await store.load()
    plan.goals.push({ id: 'g1', title: '目标', status: 'active', krs: [] })

    await store.save(plan, { reason: 'test' })
    assert.equal(plan.version, 1)

    const json = JSON.parse(await readFile(store.file, 'utf8'))
    assert.equal(json.version, 1)
    assert.equal(json.goals.length, 1)

    const md = await readFile(store.view, 'utf8')
    assert.match(md, /# 个人工作计划/)

    await store.save(plan, { reason: 'test2' })
    assert.equal(plan.version, 2)
  })
})

test('每次 save 前的版本被归档，history 最新在前', async () => {
  await withTemp(async (dir) => {
    const store = new PlanStore(dir)
    const plan = await store.load()
    plan.goals.push({ id: 'g1', title: 'v1 的目标', status: 'active', krs: [] })
    await store.save(plan, { reason: 'first' })

    plan.goals.push({ id: 'g2', title: 'v2 的目标', status: 'active', krs: [] })
    await store.save(plan, { reason: 'second' })

    const history = await store.history(10)
    assert.equal(history.length, 1, '第一次 save 时磁盘还没有文件，没有可归档的版本')
    assert.equal(history[0].reason, 'first')
  })
})

test('restore 回滚到历史版本，且回滚本身可撤销', async () => {
  await withTemp(async (dir) => {
    const store = new PlanStore(dir)
    const plan = await store.load()
    plan.goals.push({ id: 'g1', title: '原始目标', status: 'active', krs: [] })
    await store.save(plan, { reason: 'first' })

    plan.goals.push({ id: 'g2', title: '后来加的', status: 'active', krs: [] })
    await store.save(plan, { reason: 'second' })

    const history = await store.history(10)
    const first = history.find((v) => v.reason === 'first')
    assert.ok(first, '应该有 first 版本的归档')

    const restored = await store.restore(first.file)
    assert.equal(restored.goals.length, 1)
    assert.equal(restored.goals[0].title, '原始目标')

    // 回滚后磁盘上的计划也变了
    const onDisk = JSON.parse(await readFile(store.file, 'utf8'))
    assert.equal(onDisk.goals.length, 1)

    // 回滚前又归档了一次，所以现在 history 里多了 before-restore
    const after = await store.history(10)
    assert.ok(after.some((v) => v.reason === 'before-restore'))
  })
})

test('restore 拒绝路径穿越', async () => {
  await withTemp(async (dir) => {
    const store = new PlanStore(dir)
    await assert.rejects(() => store.restore('../../etc/passwd'), /非法的版本文件名/)
    await assert.rejects(() => store.restore('a/b.json'), /非法的版本文件名/)
  })
})

test('restore 对不存在的版本报错', async () => {
  await withTemp(async (dir) => {
    const store = new PlanStore(dir)
    await assert.rejects(() => store.restore('nope.json'), /版本不存在/)
  })
})

test('snapshot 在没有计划时报错', async () => {
  await withTemp(async (dir) => {
    const store = new PlanStore(dir)
    await assert.rejects(() => store.snapshot('x'), /还没有计划可归档/)
  })
})

test('snapshot 可以重复打点', async () => {
  await withTemp(async (dir) => {
    const store = new PlanStore(dir)
    const plan = await store.load()
    await store.save(plan, { reason: 'init' })
    await store.snapshot('阶段收尾')
    const history = await store.history(10)
    assert.ok(history.some((v) => v.reason === '阶段收尾'))
  })
})

test('load 对非法 JSON 报可读错误', async () => {
  await withTemp(async (dir) => {
    const store = new PlanStore(dir)
    await store.save(emptyPlan(), { reason: 'init' })
    await writeFile(store.file, '{ 这不是 JSON', 'utf8')
    await assert.rejects(() => store.load(), /不是合法 JSON/)
  })
})

test('load 对结构不合法的 JSON 报错', async () => {
  await withTemp(async (dir) => {
    const store = new PlanStore(dir)
    await store.save(emptyPlan(), { reason: 'init' })
    await writeFile(store.file, JSON.stringify({ title: 'x' }), 'utf8')
    await assert.rejects(() => store.load(), /缺少 goals 数组/)
  })
})

test('PlanStore 拒绝空根目录', () => {
  assert.throws(() => new PlanStore(''), /需要一个工作区根目录/)
})

test('计划落在 <root>/plan 下，不污染工作区根目录', async () => {
  await withTemp(async (dir) => {
    const store = new PlanStore(dir)
    assert.equal(store.dir, join(dir, 'plan'))
    await store.save(emptyPlan(), { reason: 'init' })
    assert.ok(existsSync(join(dir, 'plan', 'plan.json')))
    assert.ok(existsSync(join(dir, 'plan', 'PLAN.md')))
  })
})
