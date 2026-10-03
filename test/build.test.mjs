/**
 * 构建产物测试。
 *
 * 守的是一类「不报错但完全不工作」的失效：client 半身如果没被无条件导出，
 * 浏览器里插件会静默不注册——没有任何错误日志，面板就是不出现。
 * 这类问题靠人眼 review 很容易漏，所以直接对产物断言。
 */

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const lib = join(root, 'lib')

let client = ''
let host = ''

before(() => {
  execFileSync(process.execPath, [join(root, 'scripts', 'build.mjs')], { cwd: root, stdio: 'pipe' })
  client = readFileSync(join(lib, 'client.js'), 'utf8')
  host = readFileSync(join(lib, 'index.js'), 'utf8')
})

test('build 产出 host 与 client 三个文件', () => {
  for (const f of ['index.js', 'store.js', 'ai.js', 'client.js']) {
    assert.ok(existsSync(join(lib, f)), '缺少构建产物 ' + f)
  }
})

test('client bundle 用正确的插件 id 包装成 C6 模块', () => {
  assert.match(client, /^window\.__ModuleLoader__\.load\(\{ id: "dsh-workbench", factory: \(require\) =>/)
  assert.match(client, /return module\.exports; \} \}\);\n$/, 'bundle 必须以工厂返回收尾')
})

test('client 无条件导出 name/inject/apply（否则面板静默不注册）', () => {
  // 导出可以是单行或多行形式，所以按字段分别匹配，不钉整段字面量。
  assert.match(client, /module\.exports = \{[\s\S]{0,200}?name: 'dsh-workbench-client'/)
  // 官方右侧栏的两个服务必须声明：不声明时 apply 开头 ctx.get 拿到 undefined
  // 就静默 return，面板不注册（PITFALLS 坑 #472 的形态）。
  assert.match(client, /inject: \['slots', 'sidebarRight', 'sidebarRightTabs'\]/)
  assert.match(client, /apply: apply/)
  // 导出语句前面不能有 window 守卫
  assert.doesNotMatch(client, /if \(typeof window === 'undefined'[\s\S]{0,200}module\.exports = \{ name:/)
})

test('client bundle 内联了纯逻辑函数（UI 直接引用闭包里的名字）', () => {
  for (const fn of [
    'function summarize(', 'function sortNodes(', 'function toggleStatus(', 'function pct(',
    'function priorityLabel(', 'function nextPriority(', 'function delegateText(',
    'function flattenNodes(', 'function focusList(', 'function filterCounts(',
    'function nodeType(', 'function progressOf(', 'function moveTargets(',
    'function inboxOf(', 'function planNodes(', 'function childrenOf(',
    'function evidenceLabel(', 'function evidenceList(', 'function unverifiedOf(',
    'function paceText(', 'function reportOf(', 'function dayLabel(',
    'function parseCollapsed(', 'function serializeCollapsed(', 'function descendantCount(',
    'function isDescendantOf(', 'function dropTarget(',
    'function filesList(', 'function fileLabel(', 'function obsidianLink(',
    'function statusListOf(', 'function formDraftOf(', 'function emptyDraft(',
    'function formRequest(', 'function formErrors(', 'function planByName(',
  ]) {
    assert.ok(client.includes(fn), 'bundle 缺少内联函数 ' + fn)
  }
})

test('折叠状态的 localStorage 键只有一处定义（两处各写一份会静默读错值）', () => {
  // logic.cjs 与 client/index.js 被内联进同一个闭包：前者用 var 声明键名，
  // 后者直接引用。若哪天两边各写一份 const，先声明的会赢——改另一处就不生效，
  // 而且不报错（本次实现时就先踩了一次重复声明）。
  assert.equal((client.match(/dsh-workbench:collapsed/g) || []).length, 1)
})

/** 取出源码里的 CSS 块（去掉注释行），供下面的样式纪律断言使用。 */
function cssBlock() {
  const src = readFileSync(join(root, 'src', 'client', 'index.js'), 'utf8')
  const block = src.slice(src.indexOf('const CSS = ['), src.indexOf('].join(\'\')'))
  return {
    raw: block,
    // 去掉 // 注释行，并压掉空白与字符串拼接符号，便于做稳定的包含判断
    flat: block.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n').replace(/[\s'+]/g, ''),
  }
}

test('面板样式不自管主题：产物里没有 prefers-color-scheme 分支', () => {
  // 明暗两态由宿主重映射 --dsw-alias-* 完成（body[data-ds-dark-theme]{…}）。
  // 面板自己写 @media (prefers-color-scheme: dark) 是错的：那跟的是系统偏好，
  // 在「系统深色 + 用户选浅色」时会渲染出深色块，与宿主主题错位。
  // 这条断言就是为了挡住它被写回来。
  //
  // 先去掉行注释再查：解释这条纪律的注释本身会写出这个媒体查询的名字，
  // 不剥注释就会自己撞自己（本次加断言时先踩了一次）。
  const code = client.replace(/\/\/[^\n]*/g, '')
  assert.doesNotMatch(code, /prefers-color-scheme/)
  // 但「减少动态效果」是 WCAG 要求、与主题无关，必须留着。
  assert.match(code, /prefers-reduced-motion/)
})

test('面板样式只认宿主 design token，不自造颜色', () => {
  // 硬编码 hex / rgba 一旦出现，明暗两态就必然只对一半，而且换肤时不会跟随。
  const { raw } = cssBlock()
  const rules = raw.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  assert.doesNotMatch(rules, /#[0-9a-fA-F]{3,8}\b/, 'CSS 里出现了硬编码颜色')
  assert.doesNotMatch(rules, /\brgba?\(/, 'CSS 里出现了 rgb()/rgba() 颜色')
})

test('面板引用的每一个 --wb-* token 都真的定义了（否则整条声明静默消失）', () => {
  // 2026-10-03 加。这条守的是上一条守不住的失效模式：
  // 上面只管「不许写死颜色」，管不了「引用了一个不存在的变量」。
  // 而 var(--wb-x) 在 --wb-x 未定义时，那条声明会在**计算值阶段被整条丢弃**——
  // 不报错、不渲染、测试全绿。当时就中过三枚：
  // --wb-border-tertiary / --wb-border-secondary / --wb-success，
  // 收尾复盘那一块的分隔线、按钮边框与「完成」绿因此全部没画出来。
  const { flat } = cssBlock()
  const used = new Set()
  for (const m of flat.matchAll(/var\(\s*(--wb-[a-z0-9-]+)/g)) used.add(m[1])
  const defined = new Set()
  for (const m of flat.matchAll(/(--wb-[a-z0-9-]+)\s*:/g)) defined.add(m[1])
  const missing = [...used].filter((t) => !defined.has(t)).sort()
  assert.deepEqual(missing, [],
    '这些 --wb-* token 被 var() 引用但从未定义——那条 CSS 会被静默丢弃：' + missing.join(', '))
  assert.ok(used.size > 0, '一条都没抓到说明 cssBlock() 取错了范围，测试在空转')
})

test('别名层落在面板自己的根上，不在 :root', () => {
  // var() 是在「声明它的那个元素」上完成替换的：写在 :root(html) 会按 html 的
  // 浅色算死，body[data-ds-dark-theme] 的暗色映射传不下来——这正是「换了主题
  // 面板不跟着变」的成因。声明在 .dsh-wb-wrap 才随上下文一起翻转。
  const { flat } = cssBlock()
  // 允许写成选择器列表：手机浮球注册在宿主的 shell.overlay 里、不在 .dsh-wb-wrap
  // 之下，所以它必须自己带一份别名层。要求只有两条：列表里必须有 .dsh-wb-wrap，
  // 且一律不许写在 :root 上。
  assert.ok(
    /\.dsh-wb-wrap[^{}]*\{--wb-fg:var\(--dsw-alias-label-primary\)/.test(flat),
    '别名层没有声明在 .dsh-wb-wrap 上',
  )
  assert.ok(!flat.includes(':root{'), '别名层不应声明在 :root 上')
})

test('面板字体与圆角取宿主标尺，且胶囊配了 corner-shape:round', () => {
  // 字号一律走宿主阶梯（11/12/13），不出现自定的 font-size 像素值。
  const { flat } = cssBlock()
  for (const t of ['var(--dsw-font-xxxs-11)', 'var(--dsw-font-xxs-12)', 'var(--dsw-font-xs-13)']) {
    assert.ok(flat.includes(t), 'CSS 没有使用宿主字号 token ' + t)
  }
  // 宿主对 * 施加 corner-shape:superellipse(1.5)，胶囊会被压变形，须配回 round。
  assert.match(flat, /corner-shape:round/)
})

test('侧栏页脚入口跟邻居同一把尺，且计数不进 textContent', () => {
  // 页脚入口跟宿主的「设置」、dsh-context 的「Context Insights」并排，尺寸必须
  // 一致（真机反馈：「mac 上的大小和上下文洞察的大小字体不一样」）。这几个值是从
  // 真机上量出来的，不是配出来的——改一个就会跟邻居错开，而错开在测试里没有
  // 别的证据，所以在这里钉住（见 AGENTS.md 坑 #31）。
  // 这条规则在 src 里就是一整行字符串，所以直接用 raw 断言（flat 会把 `+` 也压掉，
  // `calc(100% + 4px)` 会变成 `calc(100%4px)`，没法读）。
  const { raw, flat } = cssBlock()
  const line = raw.split('\n').find((l) => l.includes("'.dsh-wb-entry{"))
  assert.ok(line !== undefined, 'CSS 里没有 .dsh-wb-entry 规则')
  for (const decl of [
    'height:42px', 'padding:0 10px 0 8px', 'gap:8px', 'border-radius:12px',
    'font:var(--wb-f-footer)', 'width:calc(100% + 4px)', 'margin:0 -2px',
  ]) {
    assert.ok(line.includes(decl), '.dsh-wb-entry 缺少与页脚邻居对齐的 ' + decl)
  }
  // 页脚按钮不配回 corner-shape:round——宿主对 * 施加的 superellipse(1.5) 是
  // 这一排按钮的共同底子，邻居都没配回，只有面板内部的胶囊才要（坑 #19）。
  assert.ok(!line.includes('corner-shape'), '.dsh-wb-entry 不该动 corner-shape')
  // 未完成数走伪元素：zen 的 harvestName() 读 el.textContent，真实节点里的数字
  // 会变成手机主屏 chip 的名字（还会连累按名字存的 chip 开关偏好）。
  assert.match(flat, /\.dsh-wb-entry::after\{content:attr\(data-count\)/)
  assert.ok(!flat.includes('dsh-wb-entrycount'), '计数不能是真实节点，只能走伪元素')
})

test('浮层唯一的关闭入口：用带上下文的选择器，别赌源码顺序', () => {
  // 浮层原来有两颗「关闭」：标题行的 ✕ 和快捷行的「收起」，调的是同一个
  // setFabOpen(false)——同一动作两个控件，用户会先想「这俩有区别吗」。删掉文字那颗
  // 之后 ✕ 成了唯一入口，点击区要靠更靠后的规则放大。
  //
  // **这里钉的是「怎么压住」而不是「写在后面」**：`.dsh-wb-icon` 的 `padding:2px 6px`
  // 与单类规则同权重，谁后写谁赢——这种依赖源码顺序的写法极脆（第一版就是这么写的，
  // 结果规则看着在、量出来还是 30×22）。带一层上下文（两个类）就与顺序无关了。
  // 用 raw 而不是 flat：flat 会把空白和 `+` 一起压掉，`A B{}` 会变成 `A.B{}`，
  // 看着像复合选择器，读起来是错的。
  const { raw } = cssBlock()
  assert.ok(raw.includes("'.dsh-wb-fabrow .dsh-wb-fabclose{padding:var(--wb-sp-3);}'"),
    '关闭入口要写成 `.dsh-wb-fabrow .dsh-wb-fabclose{padding:var(--wb-sp-3);}`（靠权重压住 .dsh-wb-icon，不靠源码顺序）')
})

test('窄屏强制折行只作用于待办行，计划行不强制（放得下就一行）', () => {
  // 计划行的元信息只有「重要程度 / 进度 / ＋」三样，短标题（「计划一」）一行放得下；
  // 硬折成两行既难看又多占一行。待办行徽章与动作多、标题长短不一，必须强制折
  // 才能有确定性版式。这条断言守的就是「只作用于待办行」这个作用域——
  // 选择器一旦被改回 `.dsh-wb-taskmeta`，计划行会静默变回两行，界面上没别的证据。
  const { raw } = cssBlock()
  const phone = raw.slice(raw.indexOf('@media (max-width:640px)'))
  assert.ok(
    phone.includes('.dsh-wb-task .dsh-wb-taskmeta{flex:1 1 100%'),
    '窄屏的强制折行必须**限定在待办行**（.dsh-wb-task .dsh-wb-taskmeta）',
  )
})

test('软底状态胶囊的文字走中性色，语义色只做描边与底色', () => {
  // 宿主的红在浅色下是 #ec1313：对纯底 4.49:1（恰在 AA 的 4.5:1 线上），再叠一层
  // 5% 红软底就掉到 4.45:1，就不达标了。所以**行内小胶囊**里的红只承担描边与底色，
  // 文字一律中性（near-black / near-white，实测 18.9:1）。
  //
  // 例外是 `.dsh-wb-err`（整幅告警条）：一是它面积大、红字是通行约定，二是它的
  // 信息不靠颜色单独承载。这条断言只钉「小胶囊」，不去限制告警条。
  const { raw } = cssBlock()
  for (const sel of ['.dsh-wb-pri.high', '.dsh-wb-deleg.late']) {
    const line = raw.split('\n').find((l) => l.includes("'" + sel + '{'))
    assert.ok(line, '找不到规则 ' + sel)
    const body = line.slice(line.indexOf(sel + '{') + sel.length + 1)
    assert.match(body, /(^|;)color:var\(--wb-fg\)/, sel + ' 的文字色应当是中性 token')
    // 注意不能直接查 'color:var(--wb-danger)'：'border-color:var(--wb-danger)'
    // 里也含这个子串，会把正确的描边误判成文字色。
    assert.doesNotMatch(body, /(^|;)color:var\(--wb-danger\)/, sel + ' 不应把 danger 当文字色')
  }
})

test('确认按钮用宿主主按钮那一对，且底色不能与它所在行的底色相同', () => {
  // 真机反馈「没有确认的按钮？」——**渲染是对的，是样式把它藏了**：
  // 主按钮原来是 accent-soft 底，而它坐在 .dsh-wb-movepick（同样 accent-soft 底）
  // 里，同色叠同色，按钮在视觉上根本不成其为按钮。
  // 现在抄宿主自己的主按钮配方（button-primary-fill + label-primary-foreground，
  // 与宿主聊天/工具栏同款），对比度由宿主保证，换肤自动跟随（坑 #19/#31）。
  const { flat } = cssBlock()
  assert.ok(
    flat.includes('--wb-btn-fill:var(--dsw-alias-button-primary-fill)'),
    '别名层要映射宿主的主按钮填充色',
  )
  assert.ok(
    flat.includes('--wb-btn-fg:var(--dsw-alias-label-primary-foreground)'),
    '主按钮文字色要用宿主配套的前景色（对比度由宿主保证）',
  )
  const line = flat.split('}').find((l) => l.includes('.dsh-wb-aibtn.primary{'))
  assert.ok(line, '找不到 .dsh-wb-aibtn.primary 规则')
  assert.match(line, /background:var\(--wb-btn-fill\)/, '主按钮要实心（宿主主按钮填充）')
  assert.doesNotMatch(line, /background:var\(--wb-accent-soft\)/, '主按钮不能与所在行的底色同色')
  // 确认按钮还要好点：铺满 + 44px 触屏点击区下限。
  // 注意 flat 压掉了所有空白与 '+'，后代选择器里的空格也被吃掉了。
  assert.ok(flat.includes('.dsh-wb-aiact.dsh-wb-aibtn{flex:1;'), '要有独占一行的确认按钮行')
  assert.ok(flat.includes('min-height:44px'), '确认按钮的点击区不得小于 44px')
})

test('样式表带稳定 id、且不随 effect 卸载被删掉（坑 #38）', () => {
  // 这条守的是一个真机上反复出现的现象：面板有内容、但整份 CSS 不生效，
  // 而 host 自己的样式照常（截图里顶部 tab 栏正常、面板内全是浏览器默认渲染）。
  // 根因不在 CSS 内容，而在 injectStyles 把 <style> 的存在绑在 ctx.effect 的
  // 清理函数上：client 重载跑完清理却没重新 apply，样式就永久消失。
  assert.ok(client.includes("STYLE_ID = 'dsh-workbench-style'"), '样式表要有稳定 id，用于重复注入幂等')
  assert.ok(
    client.includes('document.getElementById(STYLE_ID)'),
    '注入前要先按 id 找已有元素——apply 跑第二次时必须复用，而不是堆一份',
  )
  // 清理函数不得再删元素。留一句空实现是刻意的，注释里写了理由。
  assert.doesNotMatch(
    client.slice(client.indexOf('function injectStyles')),
    /return \(\) => \{ el\.remove\(\) \}/,
    'injectStyles 不得返回删除 <style> 的清理函数（会让样式随 effect 卸载一起消失）',
  )
})

test('复选框列宽钉在 --wb-cb 上，计划框与待办的勾选框据此同宽同列', () => {
  // 真机反馈「同等级的任务及计划首个字要对齐」。根因是两件事叠加：
  //  ① 计划（有子项、不能手动完成）**不渲染**复选框，于是那一格是空的，
  //     而待办的复选框把标题往右顶了一格；
  //  ② 待办行的缩进是 `10 + depth*16`，计划头是 `depth*16` 且**没有左内边距**。
  // 两者一叠加，同深度的计划与待办首字差 33px。
  // 修法是让「复选框列」成为一个有名字的量（--wb-cb），框与勾选框都从它取宽。
  assert.match(client, /--wb-cb:\s*13px/, '复选框列宽要有 token（实测浏览器默认就是 13px）')
  assert.ok(
    client.includes('width:var(--wb-cb);height:var(--wb-cb)'),
    '计划的完成框要从 --wb-cb 取宽高，不能写死',
  )
  assert.ok(
    /\.dsh-wb-task input\[type=checkbox\]\{[^}]*width:var\(--wb-cb\)/.test(client),
    '待办的勾选框要显式钉住宽高（不钉就跟着 UA 默认值走，而那个值我们看不见也改不动）',
  )
  assert.ok(client.includes('.dsh-wb-cbplan'), '要有计划的完成框样式')
  assert.ok(client.includes('half'), '完成框要有半满态')
  // 不可点靠结构（span + 无 handler），不靠 pointer-events——那会连 title 提示一起吞掉
  assert.doesNotMatch(
    client.slice(client.indexOf('.dsh-wb-cbplan{')),
    /pointer-events:none/,
    '完成框不得用 pointer-events:none 挡点击（会连 tooltip 一起吞掉，「子项完成 2/5」就读不到了）',
  )
  // 两行必须从同一条基线起算：行内边距一致，计划头才有资格与待办并排对齐
  const pad = 'padding:var(--wb-sp-1) var(--wb-sp-2)'
  assert.ok(client.includes('.dsh-wb-task{display:flex;align-items:flex-start;gap:var(--wb-sp-3);' + pad),
    '待办行的内边距基线')
  assert.ok(client.includes('.dsh-wb-planhead{display:flex;align-items:baseline;gap:var(--wb-sp-3);' + pad),
    '计划头必须与待办行用同一份内边距，否则框列起点就差 4px')
})

test('缩进只有一条规则：深度 × 16，行样式里不许再叠常数（坑 #40）', () => {
  // 「10 + depth*16」那种硬凑偏移改一次就得改五处，漏一处就对不齐，而且不报错。
  assert.ok(client.includes('const INDENT_STEP = 16'), '每级缩进量要有常量')
  assert.ok(client.includes('const indent = (depth) =>'), '行缩进要有统一的函数')
  assert.doesNotMatch(
    client,
    /10 \+ depth \* 16/,
    '不许再出现 `10 + depth*16` 这种硬凑偏移——缩进只由 depth 决定',
  )
  assert.doesNotMatch(
    client,
    /marginLeft: 'min\('/,
    '行样式不许内联缩进算式，一律走 indent()/indentTitle()（两套百分比上限也是从这里来的）',
  )
})

test('client bundle 不引入构建期依赖（只用 require 取 React）', () => {
  const requires = [...client.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((m) => m[2])
  assert.deepEqual([...new Set(requires)], ['react'], '客户端只应 require react')
})

test('host 半身导出 name/inject/apply', () => {
  assert.match(host, /export const name = 'dsh-workbench'/)
  assert.match(host, /export const inject = \['tools'\]/)
  assert.match(host, /export function apply\(ctx\)/)
})

test('host 半身注册了完整的 plan_* 工具集（节点模型）', () => {
  for (const tool of [
    'plan_show', 'plan_node_add', 'plan_node_set', 'plan_node_move', 'plan_node_remove',
    'plan_todo_set', 'plan_priority_set',
    'plan_delegate_set', 'plan_delegate_receipt', 'plan_delegated',
    'plan_snapshot', 'plan_history', 'plan_restore',
    'plan_config_set', 'plan_file_read',
  ]) {
    assert.ok(host.includes("'" + tool + "'"), 'host 缺少工具 ' + tool)
  }
})

test('工具守卫不许漏：清单外的工具名就是「新增工具忘了同步清单」', () => {
  // 与下面路由守卫同一个道理，这里也补上反向检查（2026-10-03）。
  // AGENTS.md 明写「新增工具时同步更新 test/build.test.mjs 里的工具清单断言」，
  // 而单向断言只能挡住「清单里有、代码里没有」，挡不住反过来——
  // 那正是工具面越长越容易出的错（agent 每次决策都多一个候选）。
  const declared = [
    'plan_show', 'plan_node_add', 'plan_node_set', 'plan_node_move', 'plan_node_remove',
    'plan_todo_set', 'plan_priority_set',
    'plan_delegate_set', 'plan_delegate_receipt', 'plan_delegated',
    'plan_snapshot', 'plan_history', 'plan_restore',
    'plan_config_set', 'plan_file_read',
  ]
  const found = [...host.matchAll(/ctx\.tools\.register\(makeTool\(\s*'([^']+)'/g)].map((m) => m[1])
  assert.equal(found.length, declared.length,
    'tools.register 的调用数与守卫清单对不上（' + found.length + ' vs ' + declared.length + '）——'
    + '新增/删除工具请同步这条清单')
  assert.deepEqual([...new Set(found)].sort(), [...declared].sort(),
    '注册的工具集合与守卫清单不一致：' + found.join(', '))
})

test('host 半身暴露 /api/workbench 数据面', () => {
  assert.match(host, /'\/api\/workbench' \+ path/)
  for (const route of ['/get', '/ai-parse', '/persona', '/persona-set', '/todo-set', '/node-add', '/node-set', '/node-move', '/node-remove', '/init', '/snapshot', '/history', '/config-set', '/file-read']) {
    assert.ok(host.includes("route('" + route + "'"), 'host 缺少路由 ' + route)
  }
})

test('路由守卫不许漏：清单外的 route() 就是「新增路由忘了同步清单」', () => {
  // 2026-10-03 加。原来上面那个测试是**单向**的——只检查「清单里的都在」，
  // 于是 `/persona` 与 `/persona-set` 加进去时没人拦，AGENTS.md 与这里的
  // 数字一起停在 12 条（实际 14 条），而且破得静默。
  //
  // 加路由时漏改清单，是这里最容易犯又最难发现的错：功能是好的、测试是绿的，
  // 只是「两个准绳的数字都不准了」。所以改成双向：清单外的 route() 直接失败。
  const declared = ['/get', '/ai-parse', '/persona', '/persona-set', '/todo-set',
    '/node-add', '/node-set', '/node-move', '/node-remove', '/init', '/snapshot',
    '/history', '/config-set', '/file-read']
  const found = [...host.matchAll(/route\('([^']+)'/g)].map((m) => m[1])
  assert.deepEqual(
    [...new Set(found)].sort(),
    [...declared].sort(),
    'host 的 route() 集合与守卫清单不一致——新增路由请同步这条清单（漏加会被这里抓住）',
  )
  // 顺带钉住条数：AGENTS.md 与 README 都按这个数写说明，数字漂移过一次。
  assert.equal(declared.length, 14, '当前数据面是 14 条；改了这个数记得同步文档')
})

test('host 半身每个 src 文件都被拷进 lib（漏一个就是运行时「找不到模块」）', () => {
  // 加 host 侧新文件时最容易漏的是 scripts/build.mjs 的 HOST_FILES 清单——
  // 漏了以后 --dump-config 照样过（它只查组合树），只有真跑起来才报找不到模块。
  const script = readFileSync(join(root, 'scripts', 'build.mjs'), 'utf8')
  const listed = (script.match(/HOST_FILES = \[([^\]]+)\]/) || [])[1] ?? ''
  const names = [...listed.matchAll(/'([^']+)'/g)].map((m) => m[1])
  assert.ok(names.length >= 3, 'HOST_FILES 应当已列出 host 侧的多个文件')
  for (const name of names) {
    assert.ok(existsSync(join(root, 'lib', name)), 'lib/' + name + ' 不存在（src 里加了但没进 HOST_FILES？）')
  }
  // 反向：src 下新增的 .js 若没进清单，这里就会漏——所以顺手钉住 src 的清单。
  for (const name of readdirSync(join(root, 'src')).filter((f) => f.endsWith('.js'))) {
    assert.ok(names.includes(name), 'src/' + name + ' 没有出现在 HOST_FILES 里')
  }
})

test('cordis.patch.yml 用 insert 且 id 与包名一致', () => {
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /- insert:/)
  assert.match(patch, /id: dsh-workbench/)
  assert.match(patch, /name: 'dsh-workbench'/)
})

test('package.json 声明的入口文件真实存在', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.main, 'lib/index.js')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  for (const [k, v] of Object.entries(pkg.exports)) {
    const p = typeof v === 'string' ? v : v.default
    assert.ok(existsSync(join(root, p)), 'exports[' + k + '] 指向不存在的文件：' + p)
  }
  assert.ok(existsSync(join(root, pkg.dsh.bundle.patch)), 'bundle patch 文件不存在')
})

test('勾选框与树上的完成框同源；批量处理只调既有写入口，不新写一条批量路径', () => {
  // 用户原话：「这里面的整条任务，首先要给一个整体可以选择的框。如果我们都确认了，
  // 就按批量处理；也可以单独点，但单独点的时候，窗口不能退出。」
  //
  // 这一屏里现在有两处「小方框」：树行的完成框（--wb-cb）与建议卡的勾选。
  // 它们说的是同一种语言，尺寸就必须同源 —— 各量各的会出现「勾比完成框大一号」。
  assert.match(client, /\.dsh-wb-aicheck\{[^}]*width:var\(--wb-cb\)/,
    '建议卡的勾要从 --wb-cb 取宽高，不能自己配一个')
  assert.match(client, /\.dsh-wb-aicheck\{[^}]*height:var\(--wb-cb\)/)
  // 勾是**包在卡外面**的：一处包法服务四张卡。给四张卡各加一次勾，早晚有一处忘了。
  assert.match(client, /const aiPickedRow = \(item, card\)/)
  assert.ok(client.includes("aiPickedRow(task, aiTaskCard(task))")
    && client.includes("aiPickedRow(edit, aiEditCard(edit))")
    && client.includes("aiPickedRow(merge, aiMergeCard(merge))")
    && client.includes("aiPickedRow(item, aiDeleteCard(item))"),
  '四类卡片都要走同一个包勾的函数')

  // **批量不许另写一条写路径**：它逐条调的就是单点「就这么办」那四个函数。
  // 另写一条的后果很具体 —— 单点修好了、批量没修，用户看到的现象是
  // 「批量一按就少了一件事」，排查时两边都要看。
  const batch = client.slice(client.indexOf('const aiApplyPicked = async'), client.indexOf('const aiPickedRow'))
  for (const fn of ['aiAddNow(', 'aiEditNow(', 'applyMerge(', 'applyDelete(']) {
    assert.ok(batch.includes(fn), '批量处理必须复用 ' + fn + '（同一批写入口）')
  }
  assert.ok(batch.includes('await '), '必须逐条 await：合并要先建计划拿 id 才能挂下一条')
  // 队列顺序即批量顺序，删除（唯一不可逆的一类）必须排在最后。
  const q = client.slice(client.indexOf('const aiAdviceQueue = ()'), client.indexOf('const aiPickedOf'))
  assert.ok(
    q.indexOf("kind: 'task'") < q.indexOf("kind: 'edit'")
    && q.indexOf("kind: 'edit'") < q.indexOf("kind: 'merge'")
    && q.indexOf("kind: 'merge'") < q.indexOf("kind: 'delete'"),
    '队列顺序：新建 → 改动 → 合并 → 删除（不可逆的排在最后）',
  )

  // 「单独点一条不许关窗口」：采纳路径里不许再出现 setFabOpen(false)。
  // 只允许**交给表单**（面板被整块替换，留着只会自己弹回来）与**批量收尾**关。
  const merge = client.slice(client.indexOf('const applyMerge = async'), client.indexOf('const applyDelete = async'))
  assert.doesNotMatch(merge, /setFabOpen\(false\)/,
    '合并卡两个分支原先都调了 setFabOpen(false) —— 点一条就没法点第二条了')

  // 「挪到顶层」要有值可写：白名单当年用 `trim() !== ''` 把空串丢掉，
  // 于是这个功能**根本没有值可写**（用户看到的就是「点了只能改名」）。
  // 它在 ai.js 里，而这一层只常驻 client 与 host 两个产物，所以现读。
  const ai = readFileSync(join(lib, 'ai.js'), 'utf8')
  assert.match(ai, /export function normPlanTarget/)
  assert.match(ai, /export function editWantsDetach/)
  assert.match(ai, /单独出来/)
})
