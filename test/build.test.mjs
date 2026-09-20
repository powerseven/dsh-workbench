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
  assert.match(client, /module\.exports = \{ name: 'dsh-workbench-client'/)
  assert.match(client, /inject: \['slots', 'betterSidebar'\]/)
  assert.match(client, /apply: apply \}/)
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
    'function paceText(', 'function boardColumns(',
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

test('host 半身暴露 /api/workbench 数据面', () => {
  assert.match(host, /'\/api\/workbench' \+ path/)
  for (const route of ['/get', '/ai-parse', '/todo-set', '/node-add', '/node-set', '/node-move', '/node-remove', '/init', '/snapshot', '/history', '/config-set', '/file-read']) {
    assert.ok(host.includes("route('" + route + "'"), 'host 缺少路由 ' + route)
  }
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
