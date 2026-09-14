/**
 * AI 解析半边的纯函数测试（src/ai.js）。
 *
 * 这一层盯的是**模型的坏习惯**：回复包代码围栏、前后加寒暄、日期写「下周三」、
 * 优先级写「高」、把 JSON 写成数组、一条都给不出来。这些都不是异常，是常态，
 * 所以 `parseAiReply` 必须逐条被钉住——漏一条的表现是「面板上弹出一句看不懂的
 * 报错」，而根因其实只是解析没兜住。
 *
 * 另一半是**候选顺序**：模型点名的计划要排在规则打分前面，收件箱与新建计划
 * 永远在最后。顺序错了不报错，只是「建议」看着像随便排的——所以也要钉。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_TASKS,
  aiSystemPrompt,
  aiUserText,
  attachSuggestions,
  collectText,
  matchPlan,
  parseAiReply,
  planOutline,
} from '../src/ai.js'

/** 一份够用的递归计划：数据治理（父）→ 台账补录（子），外加一个不相干的计划。 */
function fixture() {
  return {
    title: '个人工作计划',
    schema: 2,
    version: 2,
    nodes: [
      {
        id: 'p1', type: 'plan', title: '数据治理', owner: '张三',
        children: [
          { id: 'p2', type: 'plan', title: '台账补录', children: [{ id: 't1', type: 'todo', title: '补台区台账' }] },
        ],
      },
      { id: 'p3', type: 'plan', title: '低电压治理攻坚' },
    ],
  }
}

test('planOutline 用标题路径表达层级，并带上负责人', () => {
  const text = planOutline(fixture())
  assert.ok(text.includes('- 数据治理（负责人 张三）'), text)
  assert.ok(text.includes('- 数据治理 / 台账补录'), '子计划要带上父计划的标题路径')
  assert.ok(text.includes('- 低电压治理攻坚'))
  assert.ok(!text.includes('p1'), '大纲里不给 id——模型复述 id 我们无从校验')
})

test('planOutline 有上限，计划再多也不会把提示词撑爆', () => {
  const many = { nodes: [] }
  for (let i = 0; i < 60; i++) many.nodes.push({ id: 'x' + i, type: 'plan', title: '计划' + i })
  const lines = planOutline(many, 5).split('\n')
  assert.equal(lines.length, 5)
})

test('系统提示词带今天、带大纲，并要求只回 JSON', () => {
  const prompt = aiSystemPrompt(planOutline(fixture()), '2026-09-15')
  assert.ok(prompt.includes('2026-09-15'), '要让模型知道今天，否则它算不出「下周三」')
  assert.ok(prompt.includes('数据治理 / 台账补录'))
  assert.ok(prompt.includes('"tasks"'))
  assert.ok(prompt.includes('不要 Markdown 代码围栏'))
})

test('工作区还没有计划时，提示词明说「没有任何计划」', () => {
  const prompt = aiSystemPrompt('', '2026-09-15')
  assert.ok(prompt.includes('还没有任何计划'))
})

test('用户素材用显式分隔符框起来', () => {
  const text = aiUserText('下周三前把台账补完')
  assert.ok(text.includes('<<<'))
  assert.ok(text.includes('下周三前把台账补完'))
})

test('parseAiReply 认代码围栏、认前后寒暄', () => {
  // 寒暄里**故意带一对花括号**：只靠「从第一个 { 开始配平」会在 `{共 1 条}` 上
  // 撞死（那不是合法 JSON），必须先剥围栏。这条断言就是为了挡住「把围栏剥离
  // 当成冗余删掉」——加它的第一版寒暄里没有花括号，结果剥离与否都能过，
  // 反证没抓到任何东西。
  const raw = '好的，如下 {共 1 条}：\n```json\n{"tasks":[{"title":"补台账","due":"2026-09-20"}]}\n```\n希望有帮助。'
  const r = parseAiReply(raw)
  assert.equal(r.error, '')
  assert.equal(r.tasks.length, 1)
  assert.equal(r.tasks[0].title, '补台账')
  assert.equal(r.tasks[0].due, '2026-09-20')
})

test('parseAiReply 也认裸 JSON 与裸数组', () => {
  assert.equal(parseAiReply('{"tasks":[{"title":"a"}]}').tasks.length, 1)
  assert.equal(parseAiReply('[{"title":"a"},{"title":"b"}]').tasks.length, 2)
})

test('parseAiReply 收敛非法字段：日期不合规丢弃、优先级认中文、缺失留空', () => {
  const r = parseAiReply('{"tasks":['
    + '{"title":"甲","due":"下周三","priority":"高"},'
    + '{"title":"乙","due":"2026-10-01","priority":"urgent"},'
    + '{"title":"丙","note":"  备注  ","plan":"数据治理"}]}')
  const [a, b, c] = r.tasks
  // 没换算成具体日期的「下周三」直接丢：编一个日期出来会直接进逾期统计。
  assert.equal(a.due, '')
  assert.equal(a.priority, 'high')
  assert.equal(b.due, '2026-10-01')
  assert.equal(b.priority, '', '不认的取值退回默认，不替模型猜')
  assert.equal(c.due, '')
  assert.equal(c.note, '备注')
  assert.equal(c.plan, '数据治理')
})

test('parseAiReply 丢掉没有标题的条目，一条都不剩时给出人话错误', () => {
  const r = parseAiReply('{"tasks":[{"due":"2026-10-01"},{"title":"   "}]}')
  assert.equal(r.tasks.length, 0)
  assert.match(r.error, /没有给出任何待办标题/)

  // 完全没有 JSON 时也要说清，而不是抛 JSON.parse 的原始报错。
  const bad = parseAiReply('抱歉，我没看懂。')
  assert.match(bad.error, /没有给出能解析的 JSON/)
  assert.ok(bad.error.includes('我没看懂'), '错误里带上模型的原话片段，便于判断是提示词的问题还是模型抽风')
})

test('parseAiReply 最多 ' + MAX_TASKS + ' 条，防止模型一口气吐几百条把面板撑垮', () => {
  const list = []
  for (let i = 0; i < MAX_TASKS + 12; i++) list.push({ title: '任务' + i })
  assert.equal(parseAiReply(JSON.stringify({ tasks: list })).tasks.length, MAX_TASKS)
})

test('matchPlan 三级匹配：标题相等 → 路径结尾 → 互相包含', () => {
  const plan = fixture()
  assert.equal(matchPlan(plan, '台账补录').id, 'p2', '标题完全相等')
  assert.equal(matchPlan(plan, '数据治理 / 台账补录').id, 'p2', '模型复述了完整路径')
  assert.equal(matchPlan(plan, '低电压').id, 'p3', '互相包含时取最长的那个')
  assert.equal(matchPlan(plan, ''), null, '空提示不匹配任何东西')
  assert.equal(matchPlan(plan, '完全不存在的计划'), null)
})

test('attachSuggestions 把模型点名的计划排在最前，规则打分跟在后面', () => {
  // 模型说是「数据治理」（父计划），规则按字面重合会选「台账补录」（子计划）。
  // 两者不一致时**模型在前**——它读得懂语义，规则只认字面；把规则放前面
  // 等于让字面重合压过模型的判断。
  const tasks = attachSuggestions(fixture(), [
    { title: '把台账按台区补完', due: '', priority: '', note: '', plan: '数据治理' },
  ], '2026-09-15')
  const cands = tasks[0].candidates
  assert.equal(cands[0].kind, 'plan')
  assert.equal(cands[0].title, '数据治理')
  assert.equal(cands[0].why, '模型判断归到这里')
  assert.equal(cands[1].title, '台账补录')
  assert.match(cands[1].why, /用词重合/)
  // 反证：只留规则打分的话，第一条会是「台账补录」而不是「数据治理」。
  assert.notEqual(cands[0].title, '台账补录')
})

test('attachSuggestions 末尾永远是「收件箱」与「新建计划」', () => {
  const tasks = attachSuggestions(fixture(), [
    { title: '一件全新的事', due: '', priority: '', note: '', plan: '' },
  ], '2026-09-15')
  const cands = tasks[0].candidates
  assert.equal(cands[cands.length - 2].kind, 'inbox', '先记下来、之后再归位，永远是合法选择')
  const fresh = cands[cands.length - 1]
  assert.equal(fresh.kind, 'new')
  assert.equal(fresh.title, '', '模型没点名，新计划的名字留空由用户填')
})

test('attachSuggestions 模型点名但库里没有 → 变成「新建计划」的默认值', () => {
  // 任务名与库里所有计划都不沾边（连一个二元组都不共用），否则规则打分会
  // 命中「攻坚」这类常见词，本用例就退化成在测别的东西了。
  const tasks = attachSuggestions(fixture(), [
    { title: '整理会议室', due: '', priority: '', note: '', plan: '行政杂事' },
  ], '2026-09-15')
  const cands = tasks[0].candidates
  assert.ok(!cands.some((c) => c.kind === 'plan'), '不该凭空匹配到一个计划')
  const fresh = cands[cands.length - 1]
  assert.equal(fresh.kind, 'new')
  assert.equal(fresh.title, '行政杂事', '模型想说的是「新建一个」，它的名字要留作默认值')
  assert.match(fresh.why, /新建/)
})

test('attachSuggestions 不写回任何东西（纯函数）', () => {
  const plan = fixture()
  const before = JSON.stringify(plan)
  attachSuggestions(plan, [{ title: '补台账', due: '', priority: '', note: '', plan: '台账补录' }], '2026-09-15')
  assert.equal(JSON.stringify(plan), before, '解析阶段碰数据 = 用户改主意后留下垃圾')
})

test('collectText 只收 text-delta，不收思考过程', async () => {
  const llm = {
    stream: async function* () {
      yield { type: 'reasoning-delta', text: '让我想想…' }
      yield { type: 'text-delta', text: '{"tasks":' }
      yield { type: 'text-delta', text: '[]}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  assert.equal(await collectText(llm, {}), '{"tasks":[]}')
})

test('collectText 把三种坏结局翻译成人话', async () => {
  const withFinish = (reason) => ({
    stream: async function* () { yield { type: 'finish', reason } },
  })
  await assert.rejects(
    () => collectText(withFinish({ kind: 'error', failure: { message: 'rate limited' } }), {}),
    /模型调用失败：rate limited/,
  )
  await assert.rejects(
    () => collectText(withFinish({ kind: 'max-tokens' }), {}),
    /被长度上限截断/,
  )
  await assert.rejects(() => collectText(withFinish({ kind: 'aborted' }), {}), /模型调用失败/)
})
