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
  CONTEXT_LIMIT,
  DEFAULT_PERSONA,
  MAX_EDITS,
  MAX_FOLD_CHILDREN,
  MAX_OPTIONS,
  MAX_TASKS,
  aiContext,
  aiSystemPrompt,
  aiUserText,
  attachSuggestions,
  collectText,
  extractJson,
  historyText,
  matchPlan,
  normDeletes,
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
      // 有子项才是计划：p3 挂一个子任务，否则派生成待办、进不了计划大纲。
      { id: 'p3', type: 'plan', title: '低电压治理攻坚', children: [{ id: 't2', type: 'todo', title: '排查低电压台区' }] },
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
  for (let i = 0; i < 60; i++) {
    many.nodes.push({ id: 'x' + i, type: 'plan', title: '计划' + i, children: [{ id: 'c' + i, title: 'x', status: 'todo' }] })
  }
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

test('parseAiReply 丢掉没有标题的条目；连一句回复都没有才算失败', () => {
  const r = parseAiReply('{"tasks":[{"due":"2026-10-01"},{"title":"   "}]}')
  assert.equal(r.tasks.length, 0)
  // 「只提问不录入」现在是合法结果（reply 非空即可），所以不再因为没标题就报错。
  assert.equal(r.error, '模型既没有回答，也没有给出待办或改动')
  assert.equal(parseAiReply('{"reply":"没有待办，只是在闲聊"}').error, '', '只回答不建任务也不算失败')

  // 完全没有 JSON 时也要说清，而不是抛 JSON.parse 的原始报错。
  const bad = parseAiReply('抱歉，我没看懂。')
  assert.match(bad.error, /没有给出能解析的 JSON/)
  assert.ok(bad.error.includes('我没看懂'), '错误里带上模型的原话片段，便于判断是提示词的问题还是模型抽风')
})

test('改动已有任务：认得的字段归一，认不得的一个都不进来', () => {
  // 白名单的边界要钉住：**认得的字段**（说一句就能改的那些）归一后进来，
  // **认不得的**（metric / starred / 什么乱七八糟的键）一律丢——放进来就等于
  // 让模型能清空任意字段，而它并不真的知道那些字段的语义。
  const r = parseAiReply(JSON.stringify({
    reply: '好的',
    edits: [
      {
        target: ' 补台账 ',
        patch: { due: '2026-10-02', priority: '高', note: '改成周五', plan: '数据治理', status: '完成', owner: '张三', start: '2026-10-01', end: '2026-12-31' },
        options: [
          { label: '挪到下周', why: '这周排不开', patch: { due: '2026-10-09' } },
          { label: '没有 patch 的选项', why: '' },
        ],
        why: '你说的',
      },
      { target: '旧清单', patch: { metric: { target: 10 }, starred: true } },
      { target: '', patch: { due: '2026-10-01' } },
    ],
  }))
  assert.equal(r.edits.length, 1, '只有第一条真的改得动')
  const e = r.edits[0]
  assert.equal(e.target, '补台账', 'target 两侧空白要修掉')
  assert.equal(e.patch.priority, 'high', '「高」要归一到 high')
  assert.equal(e.patch.status, 'done', '「完成」要归一到 done')
  assert.equal(e.patch.owner, '张三')
  assert.equal(e.patch.note, '改成周五')
  assert.equal(e.patch.metric, undefined, 'metric 不在白名单里')
  assert.equal(e.patch.starred, undefined, 'starred 不在白名单里')
  // 可选项：patch 为空的选项等于没有内容，丢掉（点它什么都不会变）。
  assert.equal(e.options.length, 1)
  assert.equal(e.options[0].label, '挪到下周')
  assert.equal(e.options[0].patch.due, '2026-10-09')
})

test('合并任务：keep 不能并进自己，fold 空了整条丢掉', () => {
  const r = parseAiReply(JSON.stringify({
    reply: '好的',
    merges: [
      { keep: '数据梳理', fold: ['旧清单', '数据梳理', ' '], title: '数据梳理（含旧清单）', why: '是一件事' },
      { keep: 'A', fold: [], title: 'x' },
      { keep: '', fold: ['B'] },
    ],
  }))
  assert.equal(r.merges.length, 1)
  assert.deepEqual(r.merges[0].fold, ['旧清单'], 'keep 自己与空白项都要剔掉')
  assert.equal(r.merges[0].title, '数据梳理（含旧清单）')
  assert.equal(r.merges[0].why, '是一件事')
  assert.equal(r.merges[0].mode, 'merge', '不给 mode 时默认「并进去删掉」——判错的方向不一样，见 normMergeMode')
})

test('合并的两种 mode：保留为子任务（children）认得出来，认不出的一律当 merge', () => {
  // 用户原话：「我要的就是要把一些任务进行合并，然后作为计划，然后其他的作为它的子计划。」
  // 在有 mode 之前，模型看到 schema 里只写「fold 会被删掉」，就只能回答「不支持」。
  const r = parseAiReply(JSON.stringify({
    reply: '归到一个计划下面',
    merges: [
      { keep: '学科调研', fold: ['学情分析', '辅导闭环'], mode: 'children', title: '高中物理学科调研', why: '都是这次调研的一部分' },
      { keep: 'A', fold: ['B'], mode: '子任务' },
      { keep: 'C', fold: ['D'], mode: 'as-children' },
      { keep: 'E', fold: ['F'], mode: '随便写的' },
    ],
  }))
  assert.equal(r.merges.length, 4)
  assert.equal(r.merges[0].mode, 'children')
  assert.equal(r.merges[0].title, '高中物理学科调研', 'children 模式照样能改那一条的标题（当总标题用）')
  assert.equal(r.merges[1].mode, 'children', '中文写法也认')
  assert.equal(r.merges[2].mode, 'children')
  assert.equal(r.merges[3].mode, 'merge', '认不出来的宁可当 merge：多留几条只是麻烦，误删是事故')
})

test('children 模式的 fold 上限更高：用户是把一批任务归到一个计划下面', () => {
  // 真机上是十来条（见 AGENTS.md 的移动端反馈）。用 merge 的上限（10）会把用户
  // 明说的那批任务悄悄截断——他看到卡上少了一半，以为自己漏说了。
  const many = []
  for (let i = 0; i < MAX_FOLD_CHILDREN + 8; i++) many.push('任务' + i)
  const asGroup = parseAiReply(JSON.stringify({ merges: [{ keep: '总计划', fold: many, mode: 'children' }] }))
  assert.equal(asGroup.merges[0].fold.length, MAX_FOLD_CHILDREN, 'children 模式按 MAX_FOLD_CHILDREN 截')
  const asMerge = parseAiReply(JSON.stringify({ merges: [{ keep: '总计划', fold: many }] }))
  assert.equal(asMerge.merges[0].fold.length, MAX_EDITS, 'merge 模式仍按 MAX_EDITS（那是「一条条过」的数量，不是这批事的规模）')
})

test('提示词把两种 mode 都讲清楚，并明说不要反过来要用户列全清单', () => {
  // 这两条是同一个故障的两半：schema 里没有 children，模型就只能答「不支持、
  // 请补上完整列表」；两半都要钉住，否则模型退回老行为时没有测试会红。
  const p = aiSystemPrompt('学科调研', '2026-09-25', { context: '…' })
  assert.match(p, /mode="children"/, '提示词必须写清 children 模式')
  assert.match(p, /一条都不删/, '要写明 children 不删东西——这是它与 merge 的唯一区别')
  assert.match(p, /作为它的子计划/, '要覆盖用户的原话，那种说法必须被认出来')
  assert.match(p, /不要因为「你只能给标题」就反过来要用户把完整清单列出来/, '要禁止「请补上完整列表」这种把活推回去的回应')
  // 真机实测踩出来的：模型在 reply 里承诺「确认时可只勾选前 6 条作为子项」，而面板上
  // 根本没有逐条勾选——确认是「全执行」或「整条丢掉」两选一。说了兑现不了就是骗人。
  assert.match(p, /不要在 reply 里/, '要禁止承诺「可以只选其中几条」')
  assert.match(p, /点名写进 why/, '替代出口要写明：可疑的那几条点名进 why，让用户自己挪')
})

test('只有改动或只有合并，也算一次成功的解析（不能判成失败）', () => {
  // 这条是坑 #25 的又一次执行：给模型加新产出时，**旧的「成功判据」要回头看**。
  // 「把 X 挪到某计划下」既不需要新任务、也不需要回答——漏了就会把它判成失败。
  const onlyEdit = parseAiReply('{"edits":[{"target":"补台账","patch":{"due":"2026-10-01"}}]}')
  assert.equal(onlyEdit.error, '', '只有改动不算失败')
  const onlyMerge = parseAiReply('{"merges":[{"keep":"A","fold":["B"]}]}')
  assert.equal(onlyMerge.error, '', '只有合并不算失败')
  // 但真的一份产出都没有时，还是要报错。
  assert.match(parseAiReply('{"reply":"","tasks":[],"edits":[],"merges":[]}').error, /没有任何|没有回答/)
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
  assert.deepEqual(await collectText(llm, {}), { text: '{"tasks":[]}', truncated: false })
})

test('collectText 把三种坏结局分开：两种是错，截断不是', async () => {
  const withFinish = (reason) => ({
    stream: async function* () { yield { type: 'finish', reason } },
  })
  await assert.rejects(
    () => collectText(withFinish({ kind: 'error', failure: { message: 'rate limited' } }), {}),
    /模型调用失败：rate limited/,
  )
  await assert.rejects(() => collectText(withFinish({ kind: 'aborted' }), {}), /模型调用失败/)
  // max-tokens **不抛错**：模型把能说的说完了，只是被额度截断。抛错等于把一份
  // 往往已经能用的回复整份丢掉（真机表现：拍照拆待办，一条都没出来，
  // 只挂一句「被长度上限截断」）。这里只如实报告 truncated。
  const cut = {
    stream: async function* () {
      yield { type: 'text-delta', text: '{"reply":"r","tasks":[{"title":"甲"}' }
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
    },
  }
  assert.deepEqual(await collectText(cut, {}), {
    text: '{"reply":"r","tasks":[{"title":"甲"}]'.slice(0, -1),
    truncated: true,
  })
})

test('被截断的 JSON：补右括号，保住完整的那部分', () => {
  // 最常见形态：截在第三条任务中间 → 前两条 + 那句 reply 都要留下来
  const cut = '{"reply":"· 拆出 3 条","tasks":[{"title":"甲","due":"2026-09-20"},{"title":"乙"},{"title":"丙（半'
  const p = parseAiReply(cut)
  assert.equal(p.error, '', '被截断的回复不该被判成解析失败')
  assert.deepEqual(p.tasks.map((t) => t.title), ['甲', '乙'])
  assert.equal(p.reply, '· 拆出 3 条')
  // 截在字符串中间救不回来（本来就无从猜起）——那就如实报错，别硬编
  assert.equal(extractJson('{"reply":"说到一半'), null)
  // 正常闭合的不受影响
  assert.deepEqual(extractJson('{"reply":"hi","tasks":[]}'), { reply: 'hi', tasks: [] })
})

// ---------------------------------------------------------------- 助手：上下文 / 意见 / 选项

const contextFixture = () => ({
  schema: 2, version: 1, title: 't', createdAt: 'x', updatedAt: 'x',
  nodes: [{
    id: 'p1', type: 'plan', title: '工作主线', owner: '我', start: '2026-01-01', end: '2026-12-31',
    status: 'active', children: [
      { id: 't1', type: 'todo', title: '补台账', due: '2026-09-01', status: 'doing', priority: 'high' },
      { id: 't2', type: 'todo', title: '写周报', due: '2026-09-16', status: 'todo' },
      {
        id: 't3', type: 'todo', title: '旧台账补录', status: 'done',
        doneAt: '2026-08-01T00:00:00.000Z', startedAt: '2026-07-20T00:00:00.000Z',
        evidence: [{ kind: 'file', ref: 'a.md', at: 'x' }],
      },
      // 完成但没证据：本插件独有的审查线，助手该主动提。
      { id: 't4', type: 'todo', title: '口头确认过的事', status: 'done', doneAt: '2026-08-05T00:00:00.000Z' },
    ],
  }],
})

test('aiContext 给出「当前 + 归纳」：方向、手上的活、逾期、最近完成、待核验、资料', () => {
  const ctx = aiContext(contextFixture(), '2026-09-15')
  assert.match(ctx, /【方向 \/ 顶层计划】/, '顶层计划就是方向，不为此新增概念')
  assert.match(ctx, /工作主线，进度/, '方向带进度，才能回答「哪个方向没动」')
  assert.match(ctx, /【手上未完成的待办（共 2 条）】/)
  assert.match(ctx, /补台账，截止 2026-09-01，重要度高，进行中/)
  assert.match(ctx, /【已逾期（1）】/, '逾期单独成段，才不会被淹没')
  assert.match(ctx, /【本周内到期（1）】/)
  assert.match(ctx, /【最近完成】/)
  assert.match(ctx, /旧台账补录，2026-08-01/)
  assert.match(ctx, /【已完成但没有证据/, '这是本插件独有的审查线')
  // 上下文里绝不出现 id：模型看到 id 就会复述 id，而我们无法校验它编的。
  assert.equal(/\bp1\b|\bt1\b/.test(ctx), false, '上下文只给标题与状态，不给 id')
  assert.equal(aiContext({ nodes: [] }, '2026-09-15').includes('【方向'), false, '空计划不产生空段落')
})

test('aiContext 每段最多 CONTEXT_LIMIT 条，超出要报还剩几条', () => {
  const nodes = []
  for (let i = 0; i < CONTEXT_LIMIT + 7; i++) nodes.push({ id: 'x' + i, type: 'todo', title: '活' + i, status: 'todo' })
  const ctx = aiContext({ schema: 2, nodes }, '2026-09-15')
  assert.match(ctx, /还有 7 条/, '截断时要说清还剩多少，而不是悄悄吃掉')
})

test('historyText 报出历史相似任务与「花了几天」', () => {
  // 「旧台账补录」与新增的「补台账」在字面上重合，应当被找出来。
  const h = historyText(contextFixture(), '补台账', 3)
  assert.match(h, /旧台账补录/)
  assert.match(h, /从开工到完成 12 天/, '判断这次排不排得动，靠的就是这个数')
  assert.match(h, /附了 1 条证据/)
  assert.equal(historyText(contextFixture(), '完全无关的一件事', 3), '', '没有相似的就别硬凑')
})

test('parseAiReply 取出 reply，以及每条的专家意见与选项', () => {
  const r = parseAiReply(JSON.stringify({
    reply: '本周有 1 件逾期：补台账。',
    tasks: [{
      title: '补台账', due: '2026-09-20', priority: 'high', plan: '工作主线',
      advice: '与手上的「补台账」重复；历史上「旧台账补录」用了 12 天。',
      options: [
        { label: '今天就排上', why: '已逾期', patch: { priority: 'high' } },
        { label: '排到下周', why: '手上还有 2 条', patch: { due: '2026-09-21' } },
      ],
    }],
  }))
  assert.equal(r.error, '')
  assert.match(r.reply, /逾期/)
  assert.equal(r.tasks[0].advice.includes('旧台账补录'), true)
  assert.equal(r.tasks[0].options.length, 2)
  assert.equal(r.tasks[0].options[0].label, '今天就排上')
  assert.deepEqual(r.tasks[0].options[1].patch, { due: '2026-09-21' })
})

test('选项的 patch 只认四个键，值不合法就丢', () => {
  const r = parseAiReply(JSON.stringify({
    reply: 'x',
    tasks: [{
      title: 't',
      options: [
        { label: '乱来', why: '', patch: { due: '下周三', priority: 'urgent', owner: '别人', id: 'n9' } },
        { label: '', why: '没有名字的选项' },
      ],
    }],
  }))
  assert.equal(r.tasks[0].options.length, 1, '没有 label 的选项整个丢掉')
  assert.equal(r.tasks[0].options[0].patch, undefined, 'patch 全非法时不带这个键：留个空对象只会让表单以为有东西要填')
  assert.equal(parseAiReply('{"reply":"x","tasks":[{"title":"t","options":[{"label":"a"},{"label":"b"},{"label":"c"},{"label":"d"}]}]}')
    .tasks[0].options.length, MAX_OPTIONS, '选项最多三个，再多就变菜单了')
})

test('系统提示词带上人设、全貌与历史；没有上下文也要能说清', () => {
  const p = aiSystemPrompt('- 工作主线', '2026-09-15', {
    persona: '## 性格\n- 简短',
    context: '【当前全貌】\n- 工作主线，进度 50%',
    history: '- 旧台账补录，已完成',
  })
  assert.match(p, /内置工作计划助手/)
  assert.match(p, /## 性格\n- 简短/, '人设来自工作区文件，不写死在代码里')
  assert.match(p, /【当前全貌】/)
  assert.match(p, /【历史相似任务】/)
  assert.match(p, /"reply"/)
  assert.match(p, /"advice"/)
  assert.match(p, /"options"/)
  // 没有上下文时不能留一个空段落给模型自己脑补。
  const empty = aiSystemPrompt('', '2026-09-15', {})
  assert.match(empty, /还没有任何计划/)
  assert.match(empty, DEFAULT_PERSONA.slice(0, 8) === '' ? /$/ : /内置默认|性格/, '没配人设时用默认人设')
})

test('默认人设里写明了性格、专业、边界与「记住的事」', () => {
  assert.match(DEFAULT_PERSONA, /## 性格/)
  assert.match(DEFAULT_PERSONA, /## 专业/)
  assert.match(DEFAULT_PERSONA, /## 边界/)
  assert.match(DEFAULT_PERSONA, /## 记住的事/, '持续改善要有个地方落笔')
  assert.match(DEFAULT_PERSONA, /不擅自改数据/, '只建议不改数据，这条要明确写进人设')
})

// ============================================================ 删除建议

test('normDeletes：收敛删除意图，target 必填、why 可空', () => {
  const out = normDeletes([
    { target: '明天回家', why: '与另一条重复' },
    { target: '  ', why: '空标题应被丢掉' },
    { why: '没有 target 也丢掉' },
    null,
    '不是对象',
    { target: '记错了的一条' },
  ])
  assert.equal(out.length, 2, '只留 target 非空的两条')
  assert.equal(out[0].target, '明天回家')
  assert.equal(out[0].why, '与另一条重复')
  assert.equal(out[1].why, '', 'why 缺省为空串，不是 undefined')
})

test('normDeletes：非数组一律回空（不抛）', () => {
  assert.deepEqual(normDeletes(undefined), [])
  assert.deepEqual(normDeletes(null), [])
  assert.deepEqual(normDeletes('删掉它'), [])
  assert.deepEqual(normDeletes({ target: 'x' }), [], '对象不是数组，不算删除建议')
})

test('parseAiReply：只给 deletes 也算有效结果（不能误判成失败）', () => {
  // 这条目录要跟着新产出一块长——漏一个就会把新形态误判成「模型既没有回答，
  // 也没有给出待办或改动」，而用户只是说了句「把那条删掉」。
  const parsed = parseAiReply(JSON.stringify({
    reply: '',
    deletes: [{ target: '明天回家', why: '重复了' }],
  }))
  assert.equal(parsed.error, '', '不应报错')
  assert.equal(parsed.deletes.length, 1)
  assert.equal(parsed.deletes[0].target, '明天回家')
})

test('parseAiReply：deletes 与 tasks 可以同时出现（删一条、记一条）', () => {
  const parsed = parseAiReply(JSON.stringify({
    reply: '· 删掉旧的，记一条新的',
    tasks: [{ title: '新的一条' }],
    deletes: [{ target: '旧的那条', why: '不用了' }],
  }))
  assert.equal(parsed.error, '')
  assert.equal(parsed.tasks.length, 1)
  assert.equal(parsed.deletes.length, 1)
})

test('提示词里必须写明 deletes（否则模型不会用，只会说「我不能删」）', () => {
  const p = aiSystemPrompt({ outline: '', context: '', history: '' })
  assert.match(p, /deletes/, '格式声明里要有 deletes')
  assert.match(p, /删除任务/, '规则里要有「删除任务」这一条')
  // 模型原先拒答的理由是「schema 里也没有删除字段」——那条理由必须不再成立。
  assert.match(p, /不可逆/, '要说清删除不可逆、只作为建议呈现')
})
