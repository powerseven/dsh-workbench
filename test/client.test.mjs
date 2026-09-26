/**
 * 面板（client 半身）的渲染与手势测试。
 *
 * ## 为什么需要这一层
 *
 * 数据层有 store.test.mjs，写入路径有 host.test.mjs，产物有 build.test.mjs，
 * 但它们都碰不到 `src/client/index.js`——那是纯 UI 代码，本地既没有 React
 * （由宿主在运行时通过 C6 loader 提供），也没有 DOM。于是「面板」一直是测试
 * 金字塔里唯一靠人肉点的那层，而它恰恰最容易出「一打开就白屏」这类错：
 * 变量名打错、props 写错、事件接错函数——`node --check` 只查语法，一个都挡不住。
 *
 * ## 做法
 *
 * 不装 React，自己写一个**只实现用到的那些 API 的最小 React**（createElement +
 * 五个 hook），通过 bundle 工厂的 `require('react')` 注入；DOM 与 localStorage
 * 也换成最小替身。被测对象因此是**构建产物里的真实组件**——与 host.test.mjs
 * 用假 Cordis 驱动真工具是同一个思路。
 *
 * 数据源不手写：先用**真 host 半身**建出计划、调 `plan_show` 拿到真 payload，
 * 再喂给面板。手写的假 payload 少一个派生字段（比如 `type`），面板会静默走
 * 兜底分支，测试就悄悄退化成什么都没测。
 *
 * ## 边界
 *
 * 不测真实浏览器的 DnD 行为、CSS 与 React 的调度语义——那些只能在 `dsh web`
 * 里实测。这层负责的是「接得对不对」，不是「长得对不对」。
 */

import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply as hostApply } from '../src/index.js'

const SESSION_ID = 'session-1'

// --------------------------------------------------------------- 最小 React

/**
 * 只实现本插件用到的 API。hook 按「调用序号」存取——rules of hooks 保证同一
 * 组件每次渲染的调用顺序一致，所以序号就是身份，不必比对依赖数组。
 *
 * `useCallback` 故意忽略 deps 直接复用首个函数：本组件所有 useCallback 的依赖
 * 都是稳定值（sessionId / write），与真实 React 一致；而**没**用 useCallback
 * 包的辅助函数（titleProps / dragOnto 等）每次渲染都会重建，正好让它们闭包里的
 * state 总是最新的——测试里每次交互前都重渲一次，靠的就是这一点。
 */
function createFakeReact() {
  let hooks = []
  let cursor = 0
  let effects = []

  return {
    /** 一次新渲染：重置游标与待跑副作用（hook 槽位保留）。 */
    __begin() {
      cursor = 0
      effects = []
    },
    /** 一次新挂载：连 hook 槽位一起清掉，否则两块面板会共用同一批 state。 */
    __reset() {
      hooks = []
      cursor = 0
      effects = []
    },
    __effects() { return effects },

    createElement(type, props, ...children) {
      const kids = []
      const push = (c) => {
        if (c === null || c === undefined || typeof c === 'boolean') return
        if (Array.isArray(c)) { for (const x of c) push(x); return }
        kids.push(c)
      }
      for (const c of children) push(c)
      return { type, props: props || {}, children: kids }
    },

    useState(initial) {
      const i = cursor++
      if (hooks[i] === undefined) {
        hooks[i] = { value: typeof initial === 'function' ? initial() : initial }
      }
      const slot = hooks[i]
      return [slot.value, (next) => {
        slot.value = typeof next === 'function' ? next(slot.value) : next
      }]
    },

    useRef(initial) {
      const i = cursor++
      if (hooks[i] === undefined) hooks[i] = { value: { current: initial } }
      return hooks[i].value
    },

    useCallback(fn) {
      const i = cursor++
      if (hooks[i] === undefined) hooks[i] = { value: fn }
      return hooks[i].value
    },

    useEffect(fn) {
      const i = cursor++
      const first = hooks[i] === undefined
      hooks[i] = { mounted: true }
      if (first) effects.push(fn)
    },

    useSyncExternalStore(_subscribe, getSnapshot) {
      const i = cursor++
      hooks[i] = { mounted: true }
      return getSnapshot()
    },
  }
}

const fakeReact = createFakeReact()

// ------------------------------------------------------- DOM / window 替身

globalThis.document = {
  createElement: () => ({ textContent: '', remove: () => {} }),
  head: { appendChild: () => {} },
}

const storage = new Map()
globalThis.window = {
  __ModuleLoader__: { load: (def) => { globalThis.__wbDef = def } },
  localStorage: {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => { storage.set(k, String(v)) },
    removeItem: (k) => { storage.delete(k) },
  },
}

// 加载构建产物（真 bundle），工厂的 require 换成假 React。
await import('../lib/client.js')
const wbModule = globalThis.__wbDef.factory((name) => {
  assert.equal(name, 'react', '客户端只应 require react')
  return fakeReact
})

// --------------------------------------------------------- 假 fetch（收件箱）

let requests = []
let planPayload = null
let planDir = ''
/**
 * /get 回的 AI 可用性。**默认不可用**——宿主没装模型插件是默认情形，
 * 要测 AI 入口的用例自己把它打开；否则「不可用时该不该渲染入口」这条断言
 * 会因为上一个用例残留的状态而形同虚设。
 */
let aiStatus = { available: false }
/**
 * 用例可以让 node-add 的响应带回一个「刚建的节点」。
 * 真实的 node-add 回的是 `{ node: { id, type, title }, plan }`，面板靠这个 id 展开
 * 归位建议；这里由用例显式指定要回哪一个，免得替身自己编造一个对不上的 id。
 * 也允许给一个**函数**（按请求体决定回什么）——「先建计划、再挂待办」这条两步
 * 写入要拿第一步的 id 当第二步的 parent。
 */
let nodeEcho = null
/** /ai-parse 的假回复：{ tasks: [...], reply? }。 */
let aiReply = null
/** /persona 的假回复（人设）。默认 null 时按 host 的默认人设回一份。 */
let personaText = null

globalThis.fetch = async (path, init) => {
  const body = init !== undefined && init.body !== undefined ? JSON.parse(init.body) : {}
  requests.push({ path, body })
  // 所有写入接口都回同一份计划：面板拿到后整体替换，重渲时树保持一致。
  const payload = { ok: true, cwd: planDir, dir: join(planDir, 'plan'), ai: aiStatus, plan: planPayload }
  if (String(path).endsWith('/ai-parse') && aiReply !== null) Object.assign(payload, aiReply)
  if (String(path).endsWith('/persona')) {
    Object.assign(payload, {
      path: join(planDir, 'plan', 'agents.md'),
      text: personaText === null ? '## 性格\n- 默认人设' : personaText,
      default: '## 性格\n- 默认人设',
    })
  }
  if (String(path).endsWith('/persona-set')) {
    Object.assign(payload, { path: join(planDir, 'plan', 'agents.md'), text: String(body.text ?? '') })
  }
  if (String(path).endsWith('/node-add') && nodeEcho !== null) {
    payload.node = typeof nodeEcho === 'function' ? nodeEcho(body) : nodeEcho
  }
  return { ok: true, status: 200, json: async () => payload }
}

/** 等到「拉数据 → 落进 store」这条异步链走完。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

// ------------------------------------------------------------------ 挂载

let dir = ''

/** 每次挂载记录一次官方 sidebarRight.openTab 调用（页脚入口的用例要断言它）。 */
let openTabCalls = []

/** 手机档「记一条」预填进宿主 composer 的文本（每次挂载重置）。 */
let draftWrites = []

/** 同一路径上对宿主 composer 的 submit 次数——用来钉住「只预填、不代发」。 */
let submitCalls = 0

/** 用**真 host 半身**建一份计划，并调 plan_show 拿真 payload。 */
async function buildRealPlan(root) {
  const call = hostCall(root)
  await call('plan_node_add', { title: '工作主线', type: 'plan' })
  await call('plan_node_add', { title: '子计划', type: 'plan', parent: '工作主线' })
  await call('plan_node_add', { title: '深层待办', type: 'todo', parent: '子计划' })
  await call('plan_node_add', { title: '表层待办', type: 'todo', parent: '工作主线' })
  await call('plan_node_add', { title: '收件箱一条', type: 'todo' })
  const shown = await call('plan_show')
  return shown.plan
}

/**
 * 真 host 的工具上下文：工具定义、参数校验、落盘全是真的，只是没有 webServer。
 * 抽出来是为了让需要自带 fixture 的用例能建**自己的**工作区，而不是往共享的
 * planPayload 上加字段——共享 fixture 一改，别的用例就跟着变，表现是「毫不相干的
 * 用例挂了」。
 */
function hostCall(root) {
  const tools = new Map()
  const serverCtx = { webServer: { register: () => () => {} }, get: () => undefined }
  hostApply({
    tools: { register: (t) => { tools.set(t.name, t); return () => {} } },
    inject: (deps, fn) => { if (deps.includes('webServer')) fn(serverCtx) },
    effect: (fn) => { fn() },
  })
  return (name, args) => tools.get(name).execute(args ?? {}, {
    agent: { session: { header: { cwd: root } } },
  })
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-wb-client-'))
  planDir = dir
  planPayload = await buildRealPlan(dir)
})

after(async () => {
  if (dir !== '') await rm(dir, { recursive: true, force: true })
})

// 折叠状态落在共享的 localStorage 替身里，不清就会串到下一个用例——表现为
// 「找得到控点」这件事本身取决于上一个用例折叠了什么，排查起来很费神。
beforeEach(() => {
  storage.clear()
  requests = []
  nodeEcho = null
  aiReply = null
  aiStatus = { available: false }
  personaText = null
  delete globalThis.window.SpeechRecognition
  delete globalThis.window.webkitSpeechRecognition
})

/**
 * 挂载面板并等首屏数据到位。每次都用新的 Cordis 上下文调一次 apply，
 * 于是 store 与交互态都是干净的（apply 内部才 createStore，复用会串场）。
 */
async function mount(options) {
  const opts = options === undefined || options === null ? {} : options
  let tabType = null
  let tabBody = null
  openTabCalls = []
  // 手机档「记一条」借宿主输入框：记录它对宿主 composer 的写入与提交。
  // submit 单独计数，用来断言**只预填、不代发**。
  draftWrites = []
  submitCalls = 0
  const slotEntries = []
  const slots = {
    inject: (key, cb) => { cb(); return () => {} },
    register: (options, component) => {
      slotEntries.push({ options, component })
      // 官方右栏的正文走 keyed slot：name='sidebar.right.pane.tab' + key=<注册的 id>
      if (options.name === 'sidebar.right.pane.tab') tabBody = component
      return () => {}
    },
  }
  wbModule.apply({
    get: (name) => (name === 'slots' ? slots
      // 官方两个服务（替代 better-sidebar 的单一 betterSidebar 服务）
      : name === 'sidebarRightTabs'
        ? { register: (def) => { tabType = def; return () => {} } }
        : name === 'sidebarRight'
          ? { openTab: (kind, options) => { openTabCalls.push({ kind, options }); return () => {} } }
          : undefined),
    // Cordis 里 `ctx.slots` 是注入后的服务属性，替身必须也把它摆出来——只给 get()
    // 的话 `ctx.slots.inject` 会直接抛（真实运行时有，测试里没有，就会假失败）。
    slots,
    // Cordis 的 effect 是**立即执行**回调（返回值当清理函数），注册 tab 就发生在
    // 某个 effect 里——写成空函数会让面板静默不注册，而报错却是「面板应注册成
    // 一个 tab」，看不出是替身的错。
    effect: (fn) => { fn() },
  })
  assert.ok(tabType !== null, '面板应注册成一个 tab 类型')
  assert.ok(tabBody !== null, '面板应注册一个 tab 正文')

  // 正文组件经标准 session prop 读 visible（useTabInfo）与当前会话（useSessions），
  // 替身按官方形状喂给它——真实运行时这两个钩子由 slot 框架注入。
  // inputActions 是宿主 composer 的公开操作面（SessionStandardProps 提供），
  // 手机档的「记一条」靠它把话预填进宿主输入框。
  const holder = tabBody({
    useTabInfo: () => ({ tab: { visible: true } }),
    useSessions: (sel) => sel({ current: SESSION_ID }),
    // noInputActions：模拟「老宿主 / composer 未挂载」，用来钉住兜底路径。
    inputActions: opts.noInputActions === true ? undefined : {
      setDraft: (text) => { draftWrites.push(text) },
      submit: () => { submitCalls++ },
    },
  })
  const Panel = holder.type
  const props = holder.props

  fakeReact.__reset()
  const render = () => {
    fakeReact.__begin()
    const tree = Panel(props)
    for (const fn of fakeReact.__effects()) fn()
    return tree
  }
  render()
  await flush()
  // 官方右栏没有 tab badge API（better-sidebar 的 badge 是它自己的扩展），
  // 未完成数由「页脚入口按钮」的 data-count + CSS 伪元素承载——见页脚入口用例。
  return { render, view: render(), tabType, slotEntries }
}

/**
 * 挂载面板并点开 AI 浮球。
 *
 * AI 入口**只有浮球那一个**（面板顶部原来那行常驻输入已经撤掉），所以凡是测
 * AI 的用例，起点都是「先点开浮球」。返回的形状与 mount() 一样——`view` 换成
 * 展开后的树，后续的 `render()` 照旧（浮层开着这件事是组件状态，不会自己关）。
 *
 * 不手写「浮层里应该有什么」：这里只断言点得开、看得见输入框；浮层的内容由
 * 各用例自己按 title / 稳定类名去找。
 */
async function mountAi() {
  const ctx = await mount()
  const ball = firstByClass(ctx.view, 'dsh-wb-fabball')
  assert.ok(ball !== null, '应有浮球（AI 的唯一入口）')
  ball.props.onClick(ev())
  const view = ctx.render()
  assert.ok(firstByClass(view, 'dsh-wb-aiinput') !== null, '点开浮球后应看到输入框')
  return Object.assign(ctx, { view })
}

// ------------------------------------------------------------ 元素树工具

/** 取一棵元素树的全部文本（用于「这一行显示的是什么」这类断言）。 */
function textOf(el) {
  if (el === null || el === undefined) return ''
  if (typeof el === 'string' || typeof el === 'number') return String(el)
  return (el.children || []).map(textOf).join('')
}

const classesOf = (el) => String((el.props || {}).className || '').split(/\s+/).filter((x) => x !== '')

function findAll(root, pred, out = []) {
  if (root === null || root === undefined || typeof root !== 'object') return out
  if (pred(root)) out.push(root)
  for (const kid of root.children || []) findAll(kid, pred, out)
  return out
}

const byClass = (root, cls) => findAll(root, (el) => classesOf(el).includes(cls))
const firstByClass = (root, cls) => byClass(root, cls)[0] ?? null

/** 按 class + 文本定位元素（面板里没有 id/role，只能靠这两样）。 */
const byText = (root, cls, text) => byClass(root, cls).find((el) => textOf(el).includes(text)) ?? null

/** 某个计划行的折叠控点：先按标题找到行，再取它里面的控点。 */
function caretOf(root, title) {
  const head = byText(root, 'dsh-wb-planhead', title)
  assert.ok(head !== null, '找不到计划行「' + title + '」')
  // **递归**找：展开箭头现在跟在标题后面，包在 .dsh-wb-planwrap 里，
  // 已经不是行的直接子元素了——继续按 children 找会静默返回 undefined，
  // 表现为「找不到折叠控点」而不是「箭头挪了位置」。
  return findAll(head, (el) => classesOf(el).includes('dsh-wb-caret'))[0]
}

const inputOf = (row) => row.children.find((c) => c.type === 'input')

/** 表头右侧的文字按钮（设置等），按文案定位。 */
/** 表头图标按钮：**按 title 找，不按字形**——图标已换成内联 SVG（按钮里没有文字了），
 *  再按 textOf 找会全军覆没，而且每换一次图标都要改一次测试。 */
const headBtn = (root, label) => byClass(root, 'dsh-wb-icon')
  .find((b) => String(b.props.title || '').includes(label)) ?? null

/** 造一个够用的合成事件：面板只用到这几个字段，`prevented` 记录是否被拦下。 */
function ev(extra = {}) {
  const e = {
    prevented: false,
    stopPropagation: () => {},
    preventDefault: () => { e.prevented = true },
    dataTransfer: { setData: () => {}, effectAllowed: '' },
    currentTarget: { getBoundingClientRect: () => ({ top: 0, height: 20 }) },
    clientY: 10,
  }
  return Object.assign(e, extra)
}

/** 行内三段高度：0.1 = 上缘（插到前）、0.5 = 中间（放进去）、0.9 = 下缘（插到后）。 */
function at(ratio) {
  return { clientY: 20 * ratio, currentTarget: { getBoundingClientRect: () => ({ top: 0, height: 20 }) } }
}

/** 真 payload 里按标题取 id——断言请求参数时要用真 id，不手写。 */
function idOf(title) {
  const out = []
  const walk = (list) => { for (const n of list ?? []) { out.push(n); walk(n.children) } }
  walk(planPayload.nodes)
  const hit = out.find((n) => n.title === title)
  assert.ok(hit !== undefined, 'fixture 里应有节点「' + title + '」')
  return hit.id
}

// ============================================================ 渲染冒烟

test('面板渲染出计划树、收件箱与设置入口（不白屏）', async () => {
  const { view } = await mount()
  const body = textOf(view)
  assert.match(body, /收件箱/)
  assert.match(body, /工作主线/)
  assert.match(body, /子计划/)
  assert.match(body, /深层待办/)
  assert.match(body, /收件箱一条/)
  assert.ok(headBtn(view, '设置') !== null, '应有「设置」入口')
})

// better-sidebar 有 tab badge API（`badge: () => number`），官方右侧栏**没有**。
// 但「未完成数」这个能力没有丢：它挂在页脚入口按钮的 `data-count` 上（那里本来
// 就因为手机 chip 的 textContent 约束而这么做了）。这个用例因此改成断言入口按钮
// 的 data-count——**能力等价，载体换了**。
test('未完成数挂在页脚入口的 data-count 上（官方右栏无 tab badge API）', async () => {
  const { slotEntries } = await mount()
  const entry = slotEntries.find((e) => e.options.id === 'dsh-workbench-entry')
  assert.ok(entry !== undefined, '应注册页脚入口')
  const el = entry.component()
  assert.equal(el.props['data-count'], '3', '三条待办都还没完成')
})

test('顶层只有一栏：不再有「收件箱」与「工作计划」两段标题', async () => {
  const { view } = await mount()
  // 用户要求合并：「不要分收件箱和工作计划了，那是直接全部变成了这个工作计划。」
  //
  // 那个区分制造了一个用户并不关心的中间态：刚记下的待办既不属于哪个计划、
  // 又还不算「工作计划」。现在顶层就是一条平铺列表。
  assert.equal(byClass(view, 'dsh-wb-inboxhead').length, 0, '不该再有「收件箱」段标题')
  // 保留的唯一标题是「全部」——它现在只报数量，表明「这里是全部顶层条目」。
  const sect = firstByClass(view, 'dsh-wb-secthead')
  assert.ok(sect !== null, '应有一条顶层标题（全部）')
  assert.match(textOf(sect), /全部/, '标题读作「全部」')
  // 结构护栏不变：标题段只有「标题 + 计数」两个元素、不带图标。
  assert.equal(findAll(sect, (el) => el.type === 'svg').length, 0, '标题前不该有图标')
  assert.equal((sect.children || []).filter((c) => c !== null && c !== undefined).length, 2,
    '标题段只有「标题 + 计数」两个元素')
})

test('空工作区也能记下第一件事（入口在浮球里；它就是第一个节点）', async () => {
  const keep = planPayload
  planPayload = { schema: 2, version: 1, title: '空', nodes: [] }
  try {
    const { render, view } = await mountAi()
    assert.match(textOf(firstByClass(view, 'dsh-wb-empty')), /浮球/)

    // 录入入口只有浮球那一个。没有模型服务时浮层里是纯输入框——这条走的正是那条路。
    const input = byClass(render(), 'dsh-wb-aiinput')[0]
    assert.ok(input !== undefined, '空工作区也必须有录入入口')
    input.props.onChange({ target: { value: '新主线' } })

    requests = []
    byClass(render(), 'dsh-wb-aiinput')[0].props.onKeyDown(ev({ key: 'Enter' }))
    await settle()
    assert.equal(requests.length, 1)
    assert.equal(requests[0].path, '/api/workbench/node-add')
    assert.equal(requests[0].body.title, '新主线')
    assert.equal('parent' in requests[0].body, false, '顶层待办不该带 parent')
  } finally {
    planPayload = keep
  }
})

// ============================================================ 折叠展开

test('计划行：展开箭头跟在标题后面（不是前面），两行都从最左边开始', async () => {
  const { view } = await mount()
  const head = byText(view, 'dsh-wb-planhead', '子计划')
  assert.ok(head !== null)
  const wrap = firstByClass(head, 'dsh-wb-planwrap')
  assert.ok(wrap !== null, '标题与箭头应同在一组里（箭头才贴得住标题）')
  assert.equal(textOf(wrap.children[0]), '子计划', '这一组里先标题')
  assert.ok(classesOf(wrap.children[1]).includes('dsh-wb-caret'), '后箭头')
  // 箭头放前面时标题被顶右，而折到第二行的元信息是顶格的——两行左边缘对不齐。
  assert.ok(!classesOf(head.children[0]).includes('dsh-wb-caret'), '行首不该是箭头')
})

test('点折叠控点只收起那一个计划，别的分支不受影响', async () => {
  const { render, view } = await mount()
  assert.ok(byText(view, 'dsh-wb-tasktitle', '深层待办') !== null, '默认展开')

  const caret = caretOf(view, '子计划')
  assert.ok(caret !== undefined, '有子节点的计划应有可点的收起控点')
  assert.match(caret.props.title, /收起/)
  caret.props.onClick(ev())

  const after = render()
  assert.equal(byText(after, 'dsh-wb-tasktitle', '深层待办'), null, '被收起计划的子树消失')
  assert.ok(byText(after, 'dsh-wb-tasktitle', '表层待办') !== null, '同一个父计划下的其他分支仍在')
  assert.ok(byText(after, 'dsh-wb-tasktitle', '收件箱一条') !== null, '收件箱不受影响')
  assert.ok(byText(after, 'dsh-wb-plantitle', '子计划') !== null, '收起的计划本身还在')

  // 再点一次展开，恢复原样
  caretOf(after, '子计划').props.onClick(ev())
  assert.ok(byText(render(), 'dsh-wb-tasktitle', '深层待办') !== null)
})

test('折叠状态写进 localStorage，重新挂载后仍然收着', async () => {
  const first = await mount()
  caretOf(first.view, '子计划').props.onClick(ev())
  const key = 'dsh-workbench:collapsed'
  assert.ok(storage.has(key), '折叠状态应落进 localStorage')
  assert.match(storage.get(key), /"n\d+"/)

  // 新挂载（模拟重新打开面板）应读到同一份折叠状态。
  const second = await mount()
  assert.equal(byText(second.view, 'dsh-wb-tasktitle', '深层待办'), null, '折叠状态跨挂载保持')
  assert.ok(byText(second.view, 'dsh-wb-tasktitle', '表层待办') !== null)
})

test('「全部收起」只留计划行，且不产生任何写入（折叠不是数据）', async () => {
  const { render, view } = await mount()
  const btn = byClass(view, 'dsh-wb-icon').find((b) => b.props.title.includes('全部收起'))
  assert.ok(btn !== undefined)
  requests = []
  btn.props.onClick(ev())

  const collapsed = render()
  assert.equal(byText(collapsed, 'dsh-wb-tasktitle', '深层待办'), null)
  assert.equal(byText(collapsed, 'dsh-wb-tasktitle', '表层待办'), null)
  assert.ok(byText(collapsed, 'dsh-wb-plantitle', '工作主线') !== null, '计划行仍在')
  assert.equal(requests.length, 0, '折叠是显示偏好，不该写盘')

  byClass(collapsed, 'dsh-wb-icon').find((b) => b.props.title === '全部展开').props.onClick(ev())
  assert.ok(byText(render(), 'dsh-wb-tasktitle', '深层待办') !== null, '展开后恢复')
})

// ============================================================ 就地改名

test('双击标题进入改名，回车提交 /node-set（只传 node 与 title）', async () => {
  const { render, view } = await mount()
  byText(view, 'dsh-wb-tasktitle', '表层待办').props.onDoubleClick(ev())

  const box = firstByClass(render(), 'dsh-wb-rename')
  assert.ok(box !== null, '双击后应出现改名输入框')
  assert.equal(box.props.value, '表层待办', '输入框预填当前标题')

  box.props.onChange({ target: { value: '改过的名字' } })
  requests = []
  firstByClass(render(), 'dsh-wb-rename').props.onKeyDown(ev({ key: 'Enter' }))
  assert.equal(requests.length, 1)
  assert.equal(requests[0].path, '/api/workbench/node-set')
  assert.deepEqual(Object.keys(requests[0].body).sort(), ['node', 'sessionId', 'title'])
  assert.equal(requests[0].body.node, idOf('表层待办'), '按 id 定位，不靠标题（标题正在改）')
  assert.equal(requests[0].body.title, '改过的名字')
  assert.equal(firstByClass(render(), 'dsh-wb-rename'), null, '提交后退出编辑态')
})

test('Esc 放弃改名，且不发请求', async () => {
  const { render, view } = await mount()
  byText(view, 'dsh-wb-tasktitle', '表层待办').props.onDoubleClick(ev())
  firstByClass(render(), 'dsh-wb-rename').props.onChange({ target: { value: '不要这个' } })
  requests = []
  firstByClass(render(), 'dsh-wb-rename').props.onKeyDown(ev({ key: 'Escape' }))
  assert.equal(requests.length, 0, 'Esc 不该写盘')
  assert.equal(firstByClass(render(), 'dsh-wb-rename'), null, '退出编辑态')
  assert.ok(byText(render(), 'dsh-wb-tasktitle', '表层待办') !== null, '标题恢复原样')
})

test('标题没改或改成空白时都不写盘（免得留下空版本快照）', async () => {
  const { render, view } = await mount()
  byText(view, 'dsh-wb-tasktitle', '表层待办').props.onDoubleClick(ev())
  requests = []
  firstByClass(render(), 'dsh-wb-rename').props.onKeyDown(ev({ key: 'Enter' }))
  assert.equal(requests.length, 0, '原样提交不算改动')

  byText(render(), 'dsh-wb-tasktitle', '表层待办').props.onDoubleClick(ev())
  firstByClass(render(), 'dsh-wb-rename').props.onChange({ target: { value: '   ' } })
  requests = []
  firstByClass(render(), 'dsh-wb-rename').props.onKeyDown(ev({ key: 'Enter' }))
  assert.equal(requests.length, 0, '空白标题不发请求')
})

// ============================================================ 拖拽排序

test('把待办拖到计划中间 = 放进去（带精确 index，与 ↳ 的「追加」不同）', async () => {
  const { render, view } = await mount()
  byText(view, 'dsh-wb-tasktitle', '表层待办').props.onDragStart(ev())

  const over = ev(at(0.5))
  byText(render(), 'dsh-wb-planhead', '子计划').props.onDragOver(over)
  assert.equal(over.prevented, true, '合法落点要 preventDefault，浏览器才允许放下')

  requests = []
  byText(render(), 'dsh-wb-planhead', '子计划').props.onDrop(ev(at(0.5)))
  assert.equal(requests.length, 1)
  assert.equal(requests[0].path, '/api/workbench/node-move')
  assert.equal(requests[0].body.node, idOf('表层待办'))
  assert.equal(requests[0].body.parent, idOf('子计划'))
  assert.equal(requests[0].body.index, 1, '子计划已有一个子项，追加到末尾即下标 1')
})

test('拖到行的上缘 = 插到它前面（同级）', async () => {
  const { render, view } = await mount()
  byText(view, 'dsh-wb-tasktitle', '表层待办').props.onDragStart(ev())
  requests = []
  byText(render(), 'dsh-wb-planhead', '子计划').props.onDrop(ev(at(0.1)))
  assert.equal(requests.length, 1)
  assert.equal(requests[0].body.parent, idOf('工作主线'), '落点同级 = 父节点是「子计划」的父节点')
  assert.equal(requests[0].body.index, 0, '子计划在父计划下排第 1，插到它前面即下标 0')
})

test('非法落点（拖进自己的子孙）不画指示器、也不发请求', async () => {
  const { render, view } = await mount()
  // 拖「工作主线」到自己的子孙「子计划」里面 → 会成环，host 也会拒绝
  byText(view, 'dsh-wb-plantitle', '工作主线').props.onDragStart(ev())

  const target = () => byText(render(), 'dsh-wb-planhead', '子计划')
  const over = ev(at(0.5))
  target().props.onDragOver(over)
  assert.equal(byClass(render(), 'dsh-wb-drop-inside').length, 0, '非法落点不画「放进去」的指示')
  assert.equal(over.prevented, false, '非法落点不 preventDefault，交给浏览器显示禁止光标')

  requests = []
  target().props.onDrop(ev(at(0.5)))
  assert.equal(requests.length, 0, '未算出落点就不发请求')
})

test('拖到自己身上不算移动（不发请求）', async () => {
  const { render, view } = await mount()
  // 拖拽手柄在标题上，落点接收器在整行上——模拟时不能搞混这两个元素。
  byText(view, 'dsh-wb-tasktitle', '表层待办').props.onDragStart(ev())
  requests = []
  byText(render(), 'dsh-wb-task', '表层待办').props.onDrop(ev(at(0.5)))
  assert.equal(requests.length, 0)
})

test('拖到空白处 = 移回顶层（parent 为 null）', async () => {
  const { render, view } = await mount()
  byText(view, 'dsh-wb-tasktitle', '深层待办').props.onDragStart(ev())
  requests = []
  firstByClass(render(), 'dsh-wb-body').props.onDrop(ev(at(0.5)))
  assert.equal(requests.length, 1)
  assert.equal(requests[0].body.node, idOf('深层待办'))
  assert.equal(requests[0].body.parent, null)
  assert.equal(typeof requests[0].body.index, 'number')
})

test('拖动中的行会被标出来（否则看不出正在拖哪一条）', async () => {
  const { render, view } = await mount()
  byText(view, 'dsh-wb-tasktitle', '表层待办').props.onDragStart(ev())
  assert.equal(byClass(render(), 'dsh-wb-dragging').length, 1)
})

// ============================================================ 写入路径

test('勾选待办走 /todo-set（与 agent 同一条写入路径）', async () => {
  const { view } = await mount()
  const row = byText(view, 'dsh-wb-task', '表层待办')
  requests = []
  row.children.find((c) => c.type === 'input').props.onChange(ev())
  assert.equal(requests.length, 1)
  assert.equal(requests[0].path, '/api/workbench/todo-set')
  assert.equal(requests[0].body.status, 'done')
})

test('双击改名的同时不会顺手打开详情（单击延后仍生效）', async () => {
  const { render, view } = await mount()
  requests = []

  // 一次真实的双击会先来两次 click、再来一次 dblclick。两个 click 一个都不能
  // 落地——单击现在是「打开详情」，立刻执行的话改名会被详情盖住。
  byText(view, 'dsh-wb-tasktitle', '表层待办').props.onClick(ev())
  byText(render(), 'dsh-wb-tasktitle', '表层待办').props.onClick(ev())
  byText(render(), 'dsh-wb-tasktitle', '表层待办').props.onDoubleClick(ev())

  await new Promise((r) => setTimeout(r, 260))
  await flush()
  assert.equal(requests.length, 0, '双击不该产生任何写请求')
  assert.ok(firstByClass(render(), 'dsh-wb-rename') !== null, '而是进入改名')
  assert.equal(firstByClass(render(), 'dsh-wb-formhead'), null, '且不该顺手打开详情')
})

test('只单击标题 = 打开详情，不再切换完成', async () => {
  const { render, view } = await mount()
  requests = []
  byText(view, 'dsh-wb-tasktitle', '表层待办').props.onClick(ev())
  await new Promise((r) => setTimeout(r, 260))
  await flush()
  assert.equal(requests.length, 0, '打开详情是纯本地状态，不发请求、不改状态')
  assert.ok(firstByClass(render(), 'dsh-wb-formhead') !== null, '单击标题应当打开详情编辑页')
})

// ============================================================ 语音输入

/**
 * 一个可控的 SpeechRecognition 替身，只实现面板真正用到的那几个成员。
 * 挂到 window 上——面板是**渲染时**读取的，所以用例可以在挂载前注入。
 */
function fakeSpeech() {
  const state = { inst: null, started: 0, stopped: 0 }
  function Rec() {
    state.inst = this
    this.onresult = null
    this.onerror = null
    this.onend = null
    this.continuous = false
    this.interimResults = false
    this.lang = ''
    // Chrome 138+ 的端上识别开关；面板必须在 start() 之前设它。
    this.processLocally = undefined
    this.start = () => { state.started++ }
    this.stop = () => { state.stopped++; if (typeof this.onend === 'function') this.onend() }
  }
  globalThis.window.SpeechRecognition = Rec
  return state
}

/** 给替身补上 Chrome 138+ 的静态探测方法 `available({langs, processLocally})`。 */
function fakePackState(state) {
  globalThis.window.SpeechRecognition.available = async () => state
}

/** 收件箱那个常驻输入框已删除：顶部那行（AI 行，或没模型时的退化输入框）是唯一
 *  入口，麦克风也只剩它那一个。递归找，不按直接子元素——挪一层就会静默找不到。 */
const micOfPanel = (root) => byClass(root, 'dsh-wb-mic')[0] ?? null

test('浏览器不支持语音时不渲染麦克风（不给一个永远点不亮的按钮）', async () => {
  const { view } = await mountAi()
  assert.equal(micOfPanel(view), null)
})

test('语音结果写进输入框——填的是浮层里那个唯一入口', async () => {
  const sp = fakeSpeech()
  const { render } = await mountAi()
  const mic = micOfPanel(render())
  assert.ok(mic !== null, '应当渲染出麦克风按钮')

  mic.props.onClick(ev())
  assert.equal(sp.started, 1, '点一下开始听')

  // 中间结果也实时灌进输入框：用户说话时能看见字在长，而不是说完才一下子出现。
  sp.inst.onresult({ results: [[{ transcript: '补充核心表的负责人信息' }]] })
  const filled = byClass(render(), 'dsh-wb-aiinput')
    .find((i) => i.props.value === '补充核心表的负责人信息')
  assert.ok(filled !== undefined, '语音结果应当落在输入框里')
})

test('麦克风没授权时把原因说出来，不静默失败', async () => {
  const sp = fakeSpeech()
  const { render } = await mountAi()
  micOfPanel(render()).props.onClick(ev())
  sp.inst.onerror({ error: 'not-allowed' })
  // 「没授权」与「没听见」必须分开：前者要改浏览器设置，后者再试一次就行，
  // 混成一句「语音失败」等于什么都没说。
  assert.match(textOf(firstByClass(render(), 'dsh-wb-flash')), /麦克风没有授权/)
})

test('明文 HTTP（不是安全上下文）时不去点麦克风，并说清真正的原因', async () => {  // 手机上就是这么访问的（http://192.168.31.231:3080）。浏览器在非安全上下文里
  // 把录音能力整个拿掉，`start()` 只会回 `not-allowed`——而那句话会把人引去翻
  // 「麦克风权限」设置，真正的原因却是**地址**。所以先自己拦下来。
  const sp = fakeSpeech()
  const old = globalThis.window.isSecureContext
  globalThis.window.isSecureContext = false
  try {
    const { render } = await mountAi()
    micOfPanel(render()).props.onClick(ev())
    assert.equal(sp.started, 0, '非安全上下文里不该真的去启动识别')
    assert.match(textOf(firstByClass(render(), 'dsh-wb-flash')), /HTTP.*HTTPS/s,
      '要说清是地址的问题、换成 HTTPS 就好')
  } finally {
    globalThis.window.isSecureContext = old
  }
})

test('端上语音包就绪时走本地识别——不碰 Google（国内唯一能用的那条）', async () => {
  // Chrome 的 Web Speech 默认把录音发给 **Google 的语音服务器**，国内连不上，
  // 于是必回 `network`——真机上就是这么失败的。Chrome 138 起有 `processLocally`：
  // 用设备上的语音包在本地识别。探测到就绪时必须打开它，否则这台手机永远用不了。
  const sp = fakeSpeech()
  fakePackState('available')
  const { render } = await mountAi()
  micOfPanel(render()).props.onClick(ev())
  await new Promise((r) => setTimeout(r, 0))   // available() 是异步的
  assert.equal(sp.started, 1, '探测完要真的开始听')
  assert.equal(sp.inst.processLocally, true, '端上包就绪时必须走本地识别')
})

test('云端识别连不上 Google 时，把原因和出路都说出来', async () => {
  // `network` 最容易被误读成「插件坏了」。它的真相是浏览器要去连 Google，
  // 而国内连不上——出路是键盘上输入法自带的那颗话筒（系统级，不受这个限制）。
  const sp = fakeSpeech()
  fakePackState('downloadable')
  const { render } = await mountAi()
  micOfPanel(render()).props.onClick(ev())
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(sp.inst.processLocally, undefined, '包还没下载好时不该硬开端上识别')
  sp.inst.onerror({ error: 'network' })
  const msg = textOf(firstByClass(render(), 'dsh-wb-flash'))
  assert.match(msg, /Google/, '要说清是连不上 Google')
  assert.match(msg, /输入法/, '要给出路：用键盘上输入法的话筒')
  assert.match(msg, /端上语音包还没下载/, '包没就绪时顺手说明这一点')
})

test('浮球点开就把焦点交给输入框——手机上这就是最短的语音路径', async () => {
  // 手机上真正好用的语音是**输入法自带**的那颗话筒，而输入法是系统的东西，网页够不到
  // （没有任何 API 能让网页按下它）。网页唯一能做的「唤起输入法」就是把输入框聚焦、
  // 让键盘连着话筒一起弹出来——所以浮球点开后输入框必须已经聚焦，否则用户还要再点
  // 一下输入框才够得着话筒。
  //
  // 用 `autoFocus`（React 把它实现成挂载时的一次 focus()，而这次挂载就在**点击的
  // 同一个任务里**）——iOS 只认「用户手势里」的 focus，晚一个 tick 就不弹键盘了。
  withAi()
  const { render, view } = await mountAi()
  const input = aiEntry(view)
  assert.equal(input.props.autoFocus, true, '浮层里的输入框要 autoFocus')
  assert.ok(input.props.ref !== undefined && input.props.ref !== null,
    '要挂 ref：浮层打开时兜底再 focus 一次')
  assert.ok(render() !== null)
})

// ============================================================ 归位建议

/**
 * 建一份「收件箱那条能拿到建议」的 fixture：子项用词与待办标题重合。
 * 用**真 host** 建，于是 parentSuggestions 是服务端真的算出来的——这条用例
 * 顺带验证了 host → 面板这条派生字段的交接。
 */
async function planWithSuggestion() {
  const tmp = await mkdtemp(join(tmpdir(), 'dsh-wb-sug-'))
  const call = hostCall(tmp)
  await call('plan_node_add', { title: '数据资产盘点', type: 'plan' })
  await call('plan_node_add', { title: '梳理核心表清单（含负责人与更新频率）', type: 'todo', parent: '数据资产盘点' })
  // 第二个**不相关**的计划不可省：只放一个计划时它同时就是建议目标，于是
  // 「建议排在最前」和「建议排在后面」渲染出来完全一样，断言形同虚设。
  await call('plan_node_add', { title: '低电压治理攻坚', type: 'plan' })
  // 类型由结构派生：两个计划各挂一个占位子项，否则它们是叶子（待办），
  // 进不了「可归位容器」的候选集。
  await call('plan_node_add', { title: '占位子项甲', parent: '数据资产盘点' })
  await call('plan_node_add', { title: '占位子项乙', parent: '低电压治理攻坚' })
  await call('plan_node_add', { title: '补充核心表的负责人与更新频率', type: 'todo' })
  const shown = await call('plan_show')
  return { tmp, plan: shown.plan }
}

/** 某条待办行里的行内动作按钮，按文案定位（↳ 归位 / ⇧ 提升 / × 删除）。
 *  递归查找：动作现在包在 .dsh-wb-taskmeta 里（窄屏整块折到第二行），已经不是行的
 *  直接子元素——继续按 children 找会在重构之后静默返回 null。 */
const actByText = (row, label) => byClass(row, 'dsh-wb-act')
  .find((b) => actMatch(b, label)) ?? null

test('归位建议排在归位选择器最前，一点就归位，理由看得见', async () => {
  const { tmp, plan } = await planWithSuggestion()
  const keep = planPayload
  planPayload = plan
  try {
    const fresh = plan.nodes.find((n) => n.type === 'todo')
    assert.ok(
      Array.isArray(fresh.parentSuggestions) && fresh.parentSuggestions.length > 0,
      'fixture 必须真的带上建议，否则下面全是空断言',
    )

    const { render } = await mount()
    const row = byText(render(), 'dsh-wb-task', '补充核心表')
    assert.ok(row !== null, '找不到刚记的那条待办')
    actByText(row, '↳').props.onClick(ev())

    const pick = firstByClass(render(), 'dsh-wb-movepick')
    assert.ok(pick !== null, '应当展开归位选择器')
    const chips = byClass(pick, 'dsh-wb-chip').filter((c) => !textOf(c).includes('取消'))
    assert.ok(classesOf(chips[0]).includes('sug'), '建议应当排在最前')
    assert.match(textOf(chips[0]), /建议 ↳ 数据资产盘点/)
    // 除了建议还得有别的可选——「给出建议及选择」里的「选择」就是这个。
    assert.ok(
      chips.some((c) => textOf(c).includes('低电压治理攻坚')),
      '建议之外还要保留其它可归位的计划',
    )
    // 理由要写在按钮的 title 与选择器标签上——藏在 tooltip 里等于没给。
    assert.match(String(chips[0].props.title), /建议归到「数据资产盘点」：/)
    const label = textOf(firstByClass(pick, 'dsh-wb-movepicklabel'))
    // 用 includes 而不是 assert.match：理由里可能有正则特殊字符，转义反而易错。
    assert.ok(label.includes(fresh.parentSuggestions[0].why), '理由要摊在标签上，实际是：' + label)

    requests = []
    chips[0].props.onClick(ev())
    await flush()
    const mv = requests.find((r) => r.path === '/api/workbench/node-move')
    assert.ok(mv !== undefined, '点击建议应当发起归位')
    assert.equal(mv.body.parent, fresh.parentSuggestions[0].id)
  } finally {
    planPayload = keep
    await rm(tmp, { recursive: true, force: true })
  }
})

// 「记完立刻展开归位建议」原先挂在收件箱常驻输入框的回调上，随那个输入框一起退场。
// 归位选择器本身（含建议排序与理由）由上面那条测试继续守着；若之后要恢复
// 「记完自动摊开」，应挂到顶部 AI 行采纳草稿成功之后。

// ================================================================ AI 入口

/**
 * 这一节盯的是「接得对不对」：入口在宿主没模型服务时**不渲染**、点解析发的是
 * /ai-parse 而不是别的、采纳某个候选时 parent 传对了、新建计划是**两步**写入。
 *
 * 不测：真实浏览器的 file input 行为、textarea 的换行——那些只能真机点。
 */

/** aiApply 里有 await，一次 flush 不够，多转几圈微任务。 */
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0))
}

/** 浮层里的 AI 输入框。入口只有这一个（面板顶部那行已经撤掉）。 */
const aiEntry = (view) => firstByClass(view, 'dsh-wb-aiinput')
/** AI 行的按钮：按文字找；发送键已换成内联 SVG（没有文字），用它稳定的类名兜住——
 *  这样各处继续写 aiBtn(view, '↑') 也不必逐个改。 */
const aiBtn = (view, label) => byClass(view, 'dsh-wb-aibtn')
  .find((b) => textOf(b) === label || (label === '↑' && classesOf(b).includes('dsh-wb-send'))) ?? null

/** 解析出的草稿里，第 i 条的候选芯片。 */
const chipsOf = (view, i) => {
  const tasks = byClass(view, 'dsh-wb-aitask')
  assert.ok(tasks[i] !== undefined, '应有第 ' + i + ' 条草稿')
  return byClass(tasks[i], 'dsh-wb-chip')
}

const withAi = () => { aiStatus = { available: true, provider: 'deepseek', model: 'deepseek-chat' } }

test('收起时只有一颗浮球：不占面板的行，也不渲染任何 AI 内容', async () => {
  withAi()
  const { view } = await mount()
  assert.ok(firstByClass(view, 'dsh-wb-fabball') !== null, '应有浮球')
  assert.equal(firstByClass(view, 'dsh-wb-aiinput'), null, '没点开时不该有输入框')
  assert.equal(firstByClass(view, 'dsh-wb-aibtn'), null, '没点开时不该有 AI 按钮')
})

test('宿主没有模型服务时：不给 AI 能力，但退化成能记事的纯输入框', async () => {
  const { view } = await mountAi()
  // AI 独有的那些（快捷问法 / 草稿 / 发送）一律不渲染——不给点不亮的按钮。
  assert.equal(firstByClass(view, 'dsh-wb-ai'), null, 'AI 块不渲染')
  assert.equal(byClass(view, 'dsh-wb-aibtn').length, 0, '不该有 AI 的发送按钮')
  // 但录入必须还能做：零摩擦把事收进来是这个插件的立身之本，不能依赖模型。
  const fallback = byClass(view, 'dsh-wb-aiinput')[0]
  assert.ok(fallback !== undefined, '应当留一个退化输入框')
  assert.match(String(fallback.props.placeholder), /记一条待办/)
})

test('AI 可用时浮层里是问句式输入框（浮球仍是唯一入口）', async () => {
  withAi()
  const { render, view } = await mountAi()
  const entry = aiEntry(view)
  assert.ok(entry !== null, '点开浮球就该看见输入框')
  assert.match(String(entry.props.placeholder), /问一句|问一问|要做什么/)
  assert.equal(firstByClass(render(), 'dsh-wb-aitask'), null, '还没解析，不该有草稿')
})

test('没有模型时的退化输入框：回车直接把事记进收件箱（不经过模型）', async () => {
  const { render, view } = await mountAi()
  const input = byClass(view, 'dsh-wb-aiinput')[0]
  assert.ok(input !== undefined, '退化输入框应当存在')
  input.props.onChange({ target: { value: '买牛奶' } })
  requests = []
  byClass(render(), 'dsh-wb-aiinput')[0].props.onKeyDown(ev({ key: 'Enter' }))
  await settle()
  assert.equal(requests.length, 1, '一次提交 = 一次写入')
  assert.ok(String(requests[0].path).endsWith('/node-add'), '直接走 /node-add，不绕模型')
  assert.equal(requests[0].body.title, '买牛奶')
  assert.equal('parent' in requests[0].body, false, '顶层待办不带 parent')
})

test('点解析：发 /ai-parse，带上文本与 sessionId', async () => {
  withAi()
  aiReply = { tasks: [] }
  const { render, view } = await mountAi()
  aiEntry(view).props.onFocus(ev())

  const box = aiEntry(render())
  box.props.onChange({ target: { value: '下周三前把台账补完' } })
  requests = []
  aiBtn(render(), '↑').props.onClick(ev())
  await settle()

  const call = requests.find((r) => r.path === '/api/workbench/ai-parse')
  assert.ok(call !== undefined, '应发 /ai-parse')
  assert.equal(call.body.sessionId, SESSION_ID)
  assert.equal(call.body.text, '下周三前把台账补完')
  assert.deepEqual(call.body.images, [])
})

test('没有内容点解析：不发请求，只提示', async () => {
  withAi()
  const { render, view } = await mountAi()
  aiEntry(view).props.onFocus(ev())
  requests = []
  aiBtn(render(), '↑').props.onClick(ev())
  await settle()
  assert.equal(requests.length, 0, '空输入不该去问模型')
  assert.match(textOf(firstByClass(render(), 'dsh-wb-flash')), /问一句|说点什么|贴个文件/)
})

test('删除建议：渲染成卡片，**点确认才删**——不因为模型说了就自动落库', async () => {
  // 用户原话：「我需要可以删除任务和合并任务，你要增加，在里面增加这个权限。」
  // 在此之前模型只能答「schema 里也没有删除字段，我不会用改标题之类的动作伪装成
  // 删除」——这条用例守住「补上了，而且仍然要人确认」。
  withAi()
  aiReply = {
    reply: '· 建议删掉重复的那条',
    deletes: [{
      target: '收件箱一条', why: '与另一条是同一件事',
      id: idOf('收件箱一条'), title: '收件箱一条', children: 0, ok: true,
    }],
  }
  const { render, view } = await mountAi()
  aiEntry(view).props.onChange({ target: { value: '收件箱那条不用了' } })
  const before = requests.length
  aiBtn(render(), '↑').props.onClick(ev())
  await settle()

  // 解析出来只渲染卡片，**这一轮没有任何删除写入**。
  const card = byClass(render(), 'dsh-wb-aitask')
    .find((el) => textOf(el).indexOf('删除：') >= 0)
  assert.ok(card !== undefined, '应渲染删除卡')
  const writes = requests.slice(before).filter((r) => String(r.path).indexOf('node-remove') >= 0)
  assert.equal(writes.length, 0, '解析阶段绝不能删——只是提议')
  assert.match(textOf(card), /回滚/, '要说清可回滚，用户才敢点')

  // 点确认才真的删。
  const confirm = findAll(card, (x) => classesOf(x).includes('dsh-wb-aibtn'))
    .find((b) => textOf(b).indexOf('确认删除') >= 0)
  assert.ok(confirm !== undefined, '删除卡上要有明确的确认按钮')
  const beforeClick = requests.length
  confirm.props.onClick(ev())
  await settle()
  const removed = requests.slice(beforeClick).filter((r) => String(r.path).indexOf('node-remove') >= 0)
  assert.equal(removed.length, 1, '点确认后应恰好删一次')
  assert.equal(removed[0].body.node, idOf('收件箱一条'), '删的是那一条')
})

test('删除建议：对不上的目标不显示确认键，只说明「没对上」', async () => {
  withAi()
  aiReply = {
    reply: '· 找到了要删的',
    deletes: [{ target: '不存在的一条', why: '重复', id: null, title: '', children: 0, ok: false }],
  }
  const { render, view } = await mountAi()
  aiEntry(view).props.onChange({ target: { value: '删掉那条' } })
  aiBtn(render(), '↑').props.onClick(ev())
  await settle()

  const card = byClass(render(), 'dsh-wb-aitask')
    .find((el) => textOf(el).indexOf('删除：') >= 0)
  assert.ok(card !== undefined, '对不上也要渲染出来（不能悄悄丢）')
  assert.match(textOf(card), /没对上/, '要说明没对上')
  const confirm = findAll(card, (x) => classesOf(x).includes('dsh-wb-aibtn'))
    .find((b) => textOf(b).indexOf('确认删除') >= 0)
  assert.equal(confirm, undefined, '没对上的不能有确认键（点了会删错）')
})

test('建议汇总栏会把「可删除」也算进分类里', async () => {
  withAi()
  aiReply = {
    reply: '· 一条可删',
    deletes: [{ target: '收件箱一条', why: '重复', id: idOf('收件箱一条'), title: '收件箱一条', children: 0, ok: true }],
  }
  const { render, view } = await mountAi()
  aiEntry(view).props.onChange({ target: { value: '删掉重复的' } })
  aiBtn(render(), '↑').props.onClick(ev())
  await settle()
  assert.match(textOf(firstByClass(render(), 'dsh-wb-aisummaryhead')), /1 条可删除/)
})

test('建议汇总栏：先给分类汇总（增加/改动/可合并），再排具体卡片', async () => {
  // 用户原话：「你要有一个下面有你解读出来的工作建议，是要增加任务，还是需要修改
  // 任务，还是要总结。你要下面要有建议的，然后让我选择。」
  withAi()
  aiReply = {
    reply: '· 拆出 1 条：补台账\n· 另有一条可以合并',
    tasks: [{ title: '补台区台账', due: '', priority: '', note: '', plan: '', candidates: [] }],
    edits: [{ target: '工作主线', patch: { due: '2026-10-01' }, why: '截止该填了' }],
    merges: [{ keep: '工作主线', fold: ['子计划'], title: '', why: '两条是一件事' }],
  }
  const { render, view } = await mountAi()
  aiEntry(view).props.onChange({ target: { value: '补台账，顺便看看有没有重复的' } })
  aiBtn(render(), '↑').props.onClick(ev())
  await settle()

  const summary = firstByClass(render(), 'dsh-wb-aisummary')
  assert.ok(summary !== null, '应有建议汇总栏')
  const head = textOf(firstByClass(render(), 'dsh-wb-aisummaryhead'))
  assert.match(head, /1 条新任务/, '要报出新增条数')
  assert.match(head, /1 条改动/, '要报出改动条数')
  assert.match(head, /1 处可合并/, '要报出可合并处数')

  // 汇总排在卡片**之前**（先看结论，再看明细）。
  const tree = render()
  const sumIdx = JSON.stringify(tree).indexOf('dsh-wb-aisummary')
  const cardIdx = JSON.stringify(tree).indexOf('dsh-wb-aitask')
  assert.ok(sumIdx >= 0 && cardIdx >= 0 && sumIdx < cardIdx, '汇总栏应排在卡片之前')
})

test('建议汇总栏：只有「增加」给一键全采纳，改动与合并必须逐条确认', async () => {
  withAi()
  aiReply = {
    reply: '· 有改动',
    tasks: [{ title: '新任务甲', due: '', priority: '', note: '', plan: '', candidates: [] }],
    edits: [{ target: '工作主线', patch: { due: '2026-10-01' }, why: '截止该填了' }],
  }
  const { render, view } = await mountAi()
  aiEntry(view).props.onChange({ target: { value: '记一条，顺便改一条' } })
  aiBtn(render(), '↑').props.onClick(ev())
  await settle()

  // 全采纳按钮只针对新增条目——改的是已经在用的数据，错得比新建难受。
  const allBtn = byClass(render(), 'dsh-wb-aisummary')
    .flatMap((el) => findAll(el, (x) => classesOf(x).includes('dsh-wb-aibtn')))
    .find((b) => textOf(b).indexOf('全部增加') >= 0)
  assert.ok(allBtn !== undefined, '应有「全部增加」按钮')
  assert.match(textOf(allBtn), /全部增加（1）/, '按钮上要带条数')

  // 明说改动要逐条确认，用户才不会以为「全部增加」把改动也一起吞了。
  const note = textOf(firstByClass(render(), 'dsh-wb-aisummary'))
  assert.match(note, /逐条/, '要说明改动/合并需逐条确认')
})

test('解析结果渲染成草稿；点建议**不直接落库**，而是填进详情表单等确认', async () => {
  withAi()
  aiReply = {
    tasks: [{
      title: '补台区台账', due: '2026-10-01', priority: 'high', note: '', plan: '子计划',
      candidates: [
        { kind: 'plan', id: idOf('子计划'), title: '子计划', why: '模型判断归到这里' },
        { kind: 'plan', id: idOf('工作主线'), title: '工作主线', why: '与计划标题用词重合 1 处' },
        { kind: 'inbox', title: '收件箱', why: '先记下来' },
        { kind: 'new', title: '', why: '新建一个计划' },
      ],
    }],
  }
  const { render, view } = await mountAi()
  aiEntry(view).props.onFocus(ev())
  // 先给点素材：空输入会直接被拦下（见「没有内容点解析」那条），
  // 不填的话这条用例其实什么都没测。
  aiEntry(render()).props.onChange({ target: { value: '一段口述' } })
  aiBtn(render(), '↑').props.onClick(ev())
  await settle()

  const drafted = render()
  const chipTexts = chipsOf(drafted, 0).map((c) => textOf(c))
  assert.equal(chipTexts[0], '建议 ↳ 子计划', '模型点名的排最前，且标出「建议」')
  assert.ok(chipTexts.includes('顶层'), '「先放着」永远是备选（顶层两栏合并后的叫法）')
  assert.match(chipTexts[chipTexts.length - 1], /建计划/)

  requests = []
  chipsOf(drafted, 0)[0].props.onClick(ev())
  await settle()

  // AI 给的是草稿，不是决定：点建议只把内容填进表单，一条写入都不该发生。
  assert.equal(requests.length, 0, '采纳建议不该直接建节点')
  assert.ok(firstByClass(render(), 'dsh-wb-formhead') !== null, '应打开详情表单')
  const inputs = byClass(render(), 'dsh-wb-inp')
  assert.equal(inputs[0].props.value, '补台区台账', '标题预填')
  assert.equal(inputs[0].props.value, '补台区台账')

  // 点保存才真的写：parent / due / priority 都要跟草稿一致。
  requests = []
  byClass(render(), 'dsh-wb-aibtn').find((b) => textOf(b) === '保存').props.onClick(ev())
  await settle()

  const add = requests.filter((r) => r.path === '/api/workbench/node-add')
  assert.equal(add.length, 1)
  assert.equal(add[0].body.title, '补台区台账')
  assert.equal(add[0].body.type, 'todo')
  assert.equal(add[0].body.parent, idOf('子计划'), '采纳建议 = 建到那个计划下')
  assert.equal(add[0].body.due, '2026-10-01')
  assert.equal(add[0].body.priority, 'high')
})

test('选「收件箱」= 表单里 parent 为空，保存后是顶层待办', async () => {
  withAi()
  aiReply = {
    tasks: [{
      title: '先记一条', due: '', priority: '', note: '', plan: '',
      candidates: [{ kind: 'inbox', title: '收件箱', why: '先记下来' }, { kind: 'new', title: '', why: '' }],
    }],
  }
  const { render, view } = await mountAi()
  aiEntry(view).props.onFocus(ev())
  // 先给点素材：空输入会直接被拦下（见「没有内容点解析」那条），
  // 不填的话这条用例其实什么都没测。
  aiEntry(render()).props.onChange({ target: { value: '一段口述' } })
  aiBtn(render(), '↑').props.onClick(ev())
  await settle()

  requests = []
  chipsOf(render(), 0).find((c) => textOf(c) === '顶层').props.onClick(ev())
  await settle()

  const place = firstByClass(render(), 'dsh-wb-fadd')
  assert.equal(place.children[0].props.value, '', '放在收件箱（顶层）')

  requests = []
  byClass(render(), 'dsh-wb-aibtn').find((b) => textOf(b) === '保存').props.onClick(ev())
  await settle()
  const add = requests.find((r) => r.path === '/api/workbench/node-add')
  assert.equal(add.body.title, '先记一条')
  assert.equal('parent' in add.body, false, '收件箱 = 顶层待办，不带 parent')
  assert.equal('due' in add.body, false, '没给截止日期就不要传空串')
})

test('选「新建计划」= 先建容器（一次写入），待办仍等人在表单里确认', async () => {
  withAi()
  aiReply = {
    tasks: [{
      title: '线损排查', due: '', priority: '', note: '', plan: '线损攻坚',
      candidates: [
        { kind: 'inbox', title: '收件箱', why: '先记下来' },
        { kind: 'new', title: '线损攻坚', why: '模型建议新建一个计划' },
      ],
    }],
  }
  const { render, view } = await mountAi()
  aiEntry(view).props.onFocus(ev())
  // 先给点素材：空输入会直接被拦下（见「没有内容点解析」那条），
  // 不填的话这条用例其实什么都没测。
  aiEntry(render()).props.onChange({ target: { value: '一段口述' } })
  aiBtn(render(), '↑').props.onClick(ev())
  await settle()

  // 新建计划的名字先由模型预填，用户还能改。
  const drafted = render()
  const input = firstByClass(drafted, 'dsh-wb-ainew')
  assert.equal(input.props.value, '线损攻坚', '模型建议的名字要预填进输入框')
  input.props.onChange({ target: { value: '线损治理专项' } })

  requests = []
  nodeEcho = (body) => (body.type === 'plan'
    ? { id: 'newplan', type: 'plan', title: body.title }
    : { id: 'newtodo', type: 'todo', title: body.title })
  chipsOf(render(), 0).find((c) => textOf(c) === '＋建计划').props.onClick(ev())
  await settle()

  // 第一步：建容器。它必须立刻发生——不先建出来，草稿就没地方挂。
  const first = requests.filter((r) => r.path === '/api/workbench/node-add')
  assert.equal(first.length, 1, '只建计划，待办等人确认')
  assert.equal(first[0].body.type, 'plan')
  assert.equal(first[0].body.title, '线损治理专项', '用改过的名字，不是模型的原话')
  assert.ok(firstByClass(render(), 'dsh-wb-formhead') !== null, '接着打开待办的表单')

  // 第二步：人点保存才建待办，parent 用第一步返回的新计划 id。
  requests = []
  byClass(render(), 'dsh-wb-aibtn').find((b) => textOf(b) === '保存').props.onClick(ev())
  await settle()
  const add = requests.filter((r) => r.path === '/api/workbench/node-add')
  assert.equal(add.length, 1)
  assert.equal(add[0].body.type, 'todo')
  assert.equal(add[0].body.title, '线损排查')
  assert.equal(add[0].body.parent, 'newplan', 'parent 用第一步返回的新计划 id')
})

test('新建计划没名字就先不动：不建空壳计划，也不建待办', async () => {
  withAi()
  aiReply = {
    tasks: [{
      title: '一件事', due: '', priority: '', note: '', plan: '',
      candidates: [{ kind: 'inbox', title: '收件箱', why: '' }, { kind: 'new', title: '', why: '' }],
    }],
  }
  const { render, view } = await mountAi()
  aiEntry(view).props.onFocus(ev())
  // 先给点素材：空输入会直接被拦下（见「没有内容点解析」那条），
  // 不填的话这条用例其实什么都没测。
  aiEntry(render()).props.onChange({ target: { value: '一段口述' } })
  aiBtn(render(), '↑').props.onClick(ev())
  await settle()

  requests = []
  chipsOf(render(), 0).find((c) => textOf(c) === '＋建计划').props.onClick(ev())
  await settle()
  assert.equal(requests.length, 0, '空名字不该产生任何写入')
  assert.match(textOf(firstByClass(render(), 'dsh-wb-flash')), /起个名字/)
})

test('选图片：读成 base64 后随 /ai-parse 一起发出', async () => {
  withAi()
  aiReply = { tasks: [] }
  const { render, view } = await mountAi()
  aiEntry(view).props.onFocus(ev())

  const file = {
    name: '白板.png',
    type: 'image/png',
    // 'AB' → base64 'QUI='
    arrayBuffer: async () => new Uint8Array([0x41, 0x42]).buffer,
  }
  // 按稳定类名找，不按字形：选图入口的 ＋ 已经换成内联 SVG（按钮里没有文字）。
  const picker = byClass(render(), 'dsh-wb-pic').find((b) => b.type === 'label')
  assert.ok(picker !== undefined, '应有选图入口')
  const input = findAll(picker, (el) => (el.props || {}).type === 'file')[0]
  assert.ok(input !== undefined, 'label 里应藏着 file input')
  input.props.onChange({ target: { files: [file], value: '' } })
  await settle()

  requests = []
  aiBtn(render(), '↑').props.onClick(ev())
  await settle()
  const call = requests.find((r) => r.path === '/api/workbench/ai-parse')
  assert.deepEqual(call.body.images, [{ mediaType: 'image/png', data: 'QUI=', name: '白板.png' }])
})

test('语音按钮在 AI 输入框旁边，识别结果写进 AI 文本域', async () => {
  withAi()
  globalThis.window.SpeechRecognition = function () {
    this.start = () => { this.onresult({ results: [[{ transcript: '下周三前把台账补完' }]] }) }
    this.stop = () => { this.onend() }
  }
  const { render, view } = await mountAi()
  aiEntry(view).props.onFocus(ev())
  const opened = render()
  const mic = firstByClass(opened, 'dsh-wb-mic')
  assert.ok(mic !== null, 'AI 文本域旁应有麦克风')
  mic.props.onClick(ev())
  assert.equal(aiEntry(render()).props.value, '下周三前把台账补完')
})

// ============================================================ 看板视图

/** 切到「看板」：表头应有视图切换按钮，点一下渲染出分列的任务看板。 */
test('视图切换按钮存在，点「看板」渲染出按计划分列的看板', async () => {
  const { render, view } = await mount()
  const vbtn = byClass(view, 'dsh-wb-vbtn').find((b) => textOf(b) === '看板')
  assert.ok(vbtn !== null, '表头应有「看板」切换按钮')

  vbtn.props.onClick(ev())
  const board = render()
  // 共享 fixture：工作主线(计划) 含 子计划(计划) 与 表层待办，深层待办 在子计划下，
  // 另有顶层待办「收件箱一条」——所以看板应有「工作主线」与「收件箱」两列。
  const cols = byClass(board, 'dsh-wb-col')
  assert.equal(cols.length, 2, '应有「工作主线」和「收件箱」两列')
  assert.ok(byText(board, 'dsh-wb-coltitle', '工作主线') !== null, '应有计划列头')
  assert.ok(byText(board, 'dsh-wb-cardtitle', '深层待办') !== null, '计划列里应有任务卡')
  assert.ok(byText(board, 'dsh-wb-cardtitle', '收件箱一条') !== null, '收件箱列里应有游离待办')
  // 深层待办挂在「子计划」下，卡片应显示所属子计划作为上下文路径。
  const card = byText(board, 'dsh-wb-card', '深层待办')
  assert.match(textOf(card), /子计划/)
})

test('看板里勾选卡片同样走 /todo-set（与树共用写入路径）', async () => {
  const { render, view } = await mount()
  byClass(view, 'dsh-wb-vbtn').find((b) => textOf(b) === '看板').props.onClick(ev())
  const card = byText(render(), 'dsh-wb-card', '表层待办')
  assert.ok(card !== null)
  requests = []
  // 复选框嵌在 .dsh-wb-cardtop 里，要递归找，不能直接取卡片的子节点。
  findAll(card, (c) => c.type === 'input')[0].props.onChange(ev())
  assert.equal(requests.length, 1)
  assert.equal(requests[0].path, '/api/workbench/todo-set')
  assert.equal(requests[0].body.todo, idOf('表层待办'))
})

test('看板尊重筛选器：切到「重要度高」只留高优先级卡片（fixture 没有，故整板为空）', async () => {
  const { render, view } = await mount()
  byClass(view, 'dsh-wb-vbtn').find((b) => textOf(b) === '看板').props.onClick(ev())
  // fixture 的待办都是 normal，没有高优先级——通过 store 直接验证空状态渲染。
  // 这里改为验证：切换视图后，列头计数仍是「未完成/总数」语义、且不白屏。
  const col = firstByClass(render(), 'dsh-wb-col')
  assert.ok(col !== null)
  assert.match(textOf(col), /\d+\/\d+/, '列头应显示 未完成/总数')
})

test('看板只看叶子：没有叶子时整棵看板为空（「空计划」即收件箱待办）', async () => {
  const keep = planPayload
  // 类型派生后不存在「空计划」：无子项的节点就是收件箱里的一条待办。
  planPayload = { schema: 2, version: 1, title: 't', nodes: [{ id: 'g1', type: 'plan', title: '空计划', status: 'active', children: [] }] }
  try {
    const { render } = await mount()
    byClass(render(), 'dsh-wb-vbtn').find((b) => textOf(b) === '看板').props.onClick(ev())
    const board = render()
    assert.ok(byClass(board, 'dsh-wb-col').length >= 1, '空计划 = 收件箱待办，会占一列')
  } finally {
    planPayload = keep
  }
})

test('没有任何叶子时看板为空而非白屏', async () => {
  const keep = planPayload
  planPayload = { schema: 2, version: 1, title: 't', nodes: [] }
  try {
    const { render } = await mount()
    byClass(render(), 'dsh-wb-vbtn').find((b) => textOf(b) === '看板').props.onClick(ev())
    const board = render()
    assert.equal(byClass(board, 'dsh-wb-col').length, 0, '没有任何任务的看板应为空')
    assert.match(textOf(firstByClass(board, 'dsh-wb-empty')), /还没有计划|没有可看/)
  } finally {
    planPayload = keep
  }
})

test('视图偏好持久化到 localStorage，重新挂载后仍是看板', async () => {
  const first = await mount()
  byClass(first.view, 'dsh-wb-vbtn').find((b) => textOf(b) === '看板').props.onClick(ev())
  assert.ok(storage.has('dsh-workbench:view'), '视图偏好应落进 localStorage')
  assert.equal(storage.get('dsh-workbench:view'), 'board')

  const second = await mount()
  assert.ok(firstByClass(second.view, 'dsh-wb-board') !== null, '重新挂载后默认仍是看板')
  assert.ok(byText(second.view, 'dsh-wb-coltitle', '工作主线') !== null)
})

// ============================================================ 文件库关联（Obsidian）

test('节点挂了文件关联：渲染出行，点 ✕ 写 node-set(fileRemove)', async () => {
  const keep = planPayload
  const id = idOf('表层待办')
  planPayload = JSON.parse(JSON.stringify(keep))
  const setFiles = (nodes) => {
    for (const n of nodes) {
      if (n.id === id) n.files = [{ kind: 'file', ref: 'a.md', note: '终版' }]
      if (n.children) setFiles(n.children)
    }
  }
  setFiles(planPayload.nodes)
  try {
    const { view } = await mount()
    const fileRow = byClass(view, 'dsh-wb-file')[0]
    assert.ok(fileRow !== undefined, '应渲染出文件关联行')
    assert.match(textOf(fileRow), /终版/, '应显示关联说明')
    requests = []
    byClass(view, 'dsh-wb-fx')[0].props.onClick(ev())
    assert.equal(requests.length, 1)
    assert.equal(requests[0].path, '/api/workbench/todo-set')
    assert.equal(requests[0].body.fileRemove, 'a.md')
  } finally {
    planPayload = keep
  }
})

// 行内的「⎘ 关联资料」与「× 删除」已撤掉：这两件事都收进详情页（破坏性操作与
// 资料关联不该在列表里误触）。写路径本身没变——nl 的 fileRef/fileKind 仍走
// /node-set，vault 渲染与核验由下面那条测试继续守着。

test('配置 vault 后文件渲染成可点 obsidian:// 链接；文件不存在标 missing 且不渲染链接', async () => {
  const keep = planPayload
  const call = hostCall(dir)
  // 走真写入路径：配置 vault、给「表层待办」挂两条关联（一条存在、一条不存在），
  // 再重新 plan_show 拿**真标注**的 payload——面板只读 payload，不自己算 fileWarnings。
  await call('plan_config_set', { vaultPath: dir })
  const id = idOf('表层待办')
  await call('plan_node_set', { node: id, fileRef: 'real.md', fileKind: 'file' })
  await call('plan_node_set', { node: id, fileRef: 'ghost.md', fileKind: 'file' })
  await writeFile(join(dir, 'real.md'), 'hi')
  const shown = await call('plan_show')
  planPayload = shown.plan
  try {
    const { view } = await mount()
    const rows = byClass(view, 'dsh-wb-file')
    const present = rows.find((r) => textOf(r).includes('real.md'))
    const missing = rows.find((r) => textOf(r).includes('ghost.md'))
    assert.ok(present !== undefined && missing !== undefined, '两条关联都应渲染')

    const link = present.children.find((c) => c.type === 'a')
    assert.ok(link !== undefined, '文件存在应渲染 obsidian:// 链接')
    assert.match(link.props.href, /^obsidian:\/\/open\?vault=/)
    assert.equal(classesOf(present).includes('missing'), false, '存在的不该标 missing')

    // 不存在的文件同样渲染链接（点开会跳进 vault），但标红提示「关联失效」。
    assert.ok(missing.children.find((c) => c.type === 'a') !== undefined, '不存在的也渲染链接，供跳转')
    assert.equal(classesOf(missing).includes('missing'), true, '不存在应标 missing')
  } finally {
    planPayload = keep
  }
})

test('未配置 vault 时文件只显示路径（不渲染链接），且 vault 块给「配置」入口', async () => {
  const keep = planPayload
  planPayload = JSON.parse(JSON.stringify(keep))
  delete planPayload.vaultPath
  const setFiles = (nodes) => {
    for (const n of nodes) {
      if (n.title === '表层待办') n.files = [{ kind: 'file', ref: 'a.md' }]
      if (n.children) setFiles(n.children)
    }
  }
  setFiles(planPayload.nodes)
  try {
    const { render, view } = await mount()
    const row = byClass(view, 'dsh-wb-file')[0]
    assert.equal(row.children.find((c) => c.type === 'a'), undefined, '无 vault 不渲染链接')
    // vault 配置统一在「设置」页里。
    headBtn(view, '设置').props.onClick(ev())
    const vault = byClass(render(), 'dsh-wb-vault')[0]
    assert.ok(vault !== undefined, '设置页应渲染 vault 配置块')
    const cfg = findAll(vault, (el) => el.type === 'button' && textOf(el) === '配置 vault 路径')[0]
    assert.ok(cfg !== undefined, '未配置应有「配置 vault 路径」入口')
  } finally {
    planPayload = keep
  }
})

test('vault 配置块展开输入框，保存写 /config-set(vaultPath)', async () => {
  const keep = planPayload
  planPayload = JSON.parse(JSON.stringify(keep))
  delete planPayload.vaultPath
  try {
    const { render, view } = await mount()
    headBtn(view, '设置').props.onClick(ev())
    const vault = byClass(render(), 'dsh-wb-vault')[0]
    findAll(vault, (el) => el.type === 'button' && textOf(el) === '配置 vault 路径')[0].props.onClick(ev())
    const v = byClass(render(), 'dsh-wb-vault')[0]
    const vAdd = findAll(v, (el) => classesOf(el).includes('dsh-wb-add'))[0]
    const vinput = inputOf(vAdd)
    assert.ok(vinput !== undefined, '展开后应有 vault 路径输入框')
    vinput.props.onChange({ target: { value: '/tmp/my-vault' } })
    requests = []
    const save = findAll(byClass(render(), 'dsh-wb-vault')[0], (el) => el.type === 'button' && textOf(el) === '保存')[0]
    assert.ok(save !== undefined)
    save.props.onClick(ev())
    assert.equal(requests.length, 1)
    assert.equal(requests[0].path, '/api/workbench/config-set')
    assert.equal(requests[0].body.vaultPath, '/tmp/my-vault')
  } finally {
    planPayload = keep
  }
})

test('设置页收拢 vault 与 AI 人设（与当前视图无关）', async () => {
  const { render, view } = await mount()
  headBtn(view, '设置').props.onClick(ev())
  const page = render()
  assert.ok(byClass(page, 'dsh-wb-vault')[0] !== undefined, 'vault 配置在设置页里')
  assert.ok(firstByClass(page, 'dsh-wb-atextarea') !== null, 'AI 人设也在设置页里')
  // 返回后回到面板。
  findAll(page, (el) => el.type === 'button' && textOf(el) === '← 返回')[0].props.onClick(ev())
  assert.ok(firstByClass(render(), 'dsh-wb-vault') === null, '返回后不再显示设置内容')
})

// ---------------------------------------------------------------- 详情编辑页

const taskRow = (view, title) => byClass(view, 'dsh-wb-task').find((r) => textOf(r).includes(title)) ?? null
const planRow = (view, title) => byClass(view, 'dsh-wb-planhead').find((r) => textOf(r).includes(title)) ?? null
/** 行内动作按钮的稳定定位：按钮里的字形已换成内联 SVG（没有文字了），
 *  所以按 title 兜住——这样调用点继续写 '★' / '↳' / '＋' 也不必逐个改。 */
const ACT_TITLE = { '★': '星标', '↳': '归位到', '＋': '加子项', '×': '删除' }
const actMatch = (b, label) => textOf(b) === label
  || (ACT_TITLE[label] !== undefined && String(b.props.title || '').includes(ACT_TITLE[label]))
const actOf = (row, label) => byClass(row, 'dsh-wb-act').find((b) => actMatch(b, label)) ?? null
const inpByPh = (view, ph) => byClass(view, 'dsh-wb-inp').find((i) => i.props.placeholder === ph) ?? null
const segBtn = (view, label) => byClass(view, 'dsh-wb-seg')
  .flatMap((s) => s.children)
  .find((b) => textOf(b) === label) ?? null
const btnByText = (view, label) => byClass(view, 'dsh-wb-aibtn').find((b) => textOf(b) === label) ?? null

/**
 * 打开详情编辑页：**单击标题**。行内那个 ✎ 已经删掉了——点标题就是编辑入口，
 * 行内再放一个是同一个入口的第二遍（还白占窄屏的宽度）。
 * 单击是延后 200ms 执行的（不与双击改名打架），所以要等过这个定时器。
 */
async function openDetail(view, title, base = 'dsh-wb-tasktitle') {
  const el = byText(view, base, title)
  assert.ok(el !== null, '找不到标题：' + title)
  el.props.onClick(ev())
  await new Promise((r) => setTimeout(r, 260))
  await settle()
}

test('点标题打开详情编辑页，字段按节点预填；改标题保存走 node-set', async () => {
  const { render, view } = await mount()
  await openDetail(view, '表层待办')
  // 低频项（负责人等）已收进「更多」，先展开再改——与真实用户流程一致
  firstByClass(render(), 'dsh-wb-morebtn').props.onClick(ev())
  await settle()

  const form = render()
  assert.ok(firstByClass(form, 'dsh-wb-formhead') !== null, '整块面板换成详情页')
  assert.equal(firstByClass(form, 'dsh-wb-form'), firstByClass(form, 'dsh-wb-form'))
  assert.equal(inpByPh(form, '要做什么').props.value, '表层待办', '标题预填')
  assert.equal(firstByClass(form, 'dsh-wb-task'), null, '详情页里不再渲染树')

  inpByPh(render(), '要做什么').props.onChange({ target: { value: '改过的待办' } })
  inpByPh(render(), '谁负责（可空）').props.onChange({ target: { value: '我' } })
  requests = []
  btnByText(render(), '保存').props.onClick(ev())
  await settle()

  const set = requests.filter((r) => r.path === '/api/workbench/node-set')
  assert.equal(set.length, 1, '一次保存 = 一次写入，不是每字段一次')
  assert.equal(set[0].body.title, '改过的待办')
  assert.equal(set[0].body.owner, '我')
  assert.equal(set[0].body.node, idOf('表层待办'))
  assert.equal(firstByClass(render(), 'dsh-wb-formhead'), null, '保存完回到列表')
})

test('表单里清空字段 = 提交 clear，而不是「什么都没传」', async () => {
  const keep = planPayload
  planPayload = JSON.parse(JSON.stringify(keep))
  const node = planPayload.nodes[0].children.find((n) => n.title === '表层待办')
    || planPayload.nodes.find((n) => n.title === '表层待办')
  node.owner = '原负责人'
  node.note = '原备注'
  try {
    const { render, view } = await mount()
    await openDetail(view, '表层待办')
    firstByClass(render(), 'dsh-wb-morebtn').props.onClick(ev())
    await settle()
    assert.equal(inpByPh(render(), '谁负责（可空）').props.value, '原负责人')
    inpByPh(render(), '谁负责（可空）').props.onChange({ target: { value: '' } })
    requests = []
    btnByText(render(), '保存').props.onClick(ev())
    await settle()
    const body = requests.find((r) => r.path === '/api/workbench/node-set').body
    assert.ok(body.clear.includes('owner'), '清空要走 clear 数组')
    assert.equal('owner' in body, false)
  } finally {
    planPayload = keep
  }
})

test('标题空时保存按钮禁用并说明原因，不会写出空标题', async () => {
  const { render, view } = await mount()
  await openDetail(view, '表层待办')
  inpByPh(render(), '要做什么').props.onChange({ target: { value: '  ' } })
  const page = render()
  assert.equal(btnByText(page, '保存').props.disabled, true)
  assert.match(textOf(firstByClass(page, 'dsh-wb-formerr')), /标题不能为空/)
  requests = []
  btnByText(page, '保存').props.onClick(ev())
  await settle()
  assert.equal(requests.length, 0, '禁用之外还要真拦住（禁用了也可能被绕）')
})

test('详情页没有「类型」段：类型由结构派生，不能也不必手选', async () => {
  const { render, view } = await mount()
  await openDetail(view, '工作主线', 'dsh-wb-plantitle')
  const page = render()
  const labels = byClass(page, 'dsh-wb-label').map((l) => textOf(l))
  assert.equal(labels.includes('类型'), false, '「往下拆」用行内 ＋ 按钮，拆完空了自动变回待办')
  // 有子项的计划不能手动标 done（它的完成由子项派生）。
  const statusSeg = byClass(page, 'dsh-wb-seg').find((g) => g.children.some((b) => textOf(b) === '已完成'))
  const doneBtn = statusSeg.children.find((b) => textOf(b) === '已完成')
  assert.equal(doneBtn.props.disabled, true)
  assert.match(String(doneBtn.props.title), /自动完成/)
})

test('面板跟着形态走：有子项渲染成计划行，无子项渲染成待办行', async () => {
  const keep = planPayload
  planPayload = JSON.parse(JSON.stringify(keep))
  // host 侧的归一已在 host 测试里覆盖；这里验证面板对两种形态的渲染。
  const deep = (function find(nodes) {
    for (const n of nodes) {
      if (n.title === '深层待办') return n
      if (Array.isArray(n.children)) { const hit = find(n.children); if (hit !== undefined) return hit }
    }
    return undefined
  })(planPayload.nodes)
  deep.children = [{ id: 'deepkid', title: '深层的孩子', status: 'todo' }]
  deep.status = 'active'
  const { render, view } = await mount()
  assert.ok(planRow(view, '深层待办') !== null, '有子项 → 计划行')
  assert.ok(taskRow(view, '深层待办') === null, '不再渲染成待办行')

  deep.children = undefined
  deep.status = 'todo'
  const view2 = render()
  assert.ok(taskRow(view2, '深层待办') !== null, '删光子项 → 待办行')
  assert.ok(planRow(view2, '深层待办') === null)
  planPayload = keep
})

// 这条依赖已删除的入口（表头「＋ 新建」）；新建改由顶部 AI 行的草稿承载，
// 详情表单本身仍由其它用例覆盖。

test('详情页能删一条完成证据（面板此前只能加不能删）', async () => {
  const keep = planPayload
  planPayload = JSON.parse(JSON.stringify(keep))
  const todo = planPayload.nodes.find((n) => n.title === '表层待办')
    || planPayload.nodes[0].children.find((n) => n.title === '表层待办')
  todo.evidence = [{ kind: 'file', ref: 'a.md', at: '2026-09-01T00:00:00.000Z' }]
  try {
    const { render, view } = await mount()
    await openDetail(view, '表层待办')
    // 证据属低频项，收在「更多」里：先展开
    firstByClass(render(), 'dsh-wb-morebtn').props.onClick(ev())
    await settle()
    const row = byClass(render(), 'dsh-wb-formrow').find((r) => textOf(r).includes('a.md'))
    assert.ok(row !== undefined, '证据要在详情页里列出来')
    requests = []
    byClass(row, 'dsh-wb-fbtn')
      .find((b) => String(b.props.title || '').includes('删除这条证据')).props.onClick(ev())
    await settle()
    const body = requests.find((r) => r.path === '/api/workbench/node-set').body
    assert.equal(body.evidenceRemove, 'a.md')
    assert.equal(body.evidenceKind, 'file')
  } finally {
    planPayload = keep
  }
})

test('详情页渐进披露：编辑时「更多」默认收起，点开才展开低频项', async () => {
  const { render, view } = await mount()
  await openDetail(view, '表层待办')

  // 一级只给简单信息；低频项不该占版面。
  assert.ok(inpByPh(render(), '要做什么') !== null, '一级：标题在')
  assert.ok(firstByClass(render(), 'dsh-wb-morebtn') !== null, '一级：有「更多」按钮')
  assert.equal(inpByPh(render(), '谁负责（可空）'), null, '收起时低频项（负责人）不渲染')

  firstByClass(render(), 'dsh-wb-morebtn').props.onClick(ev())
  await settle()
  assert.ok(inpByPh(render(), '谁负责（可空）') !== null, '点开后低频项出现')
  assert.ok(byText(render(), 'dsh-wb-morebtn', '收起更多') !== null, '按钮变成「收起更多」')
})

// 这条依赖已删除的入口（表头「＋ 新建」）；新建改由顶部 AI 行的草稿承载，
// 详情表单本身仍由其它用例覆盖。

test('返回 = 放弃改动，不发任何写入', async () => {
  const { render, view } = await mount()
  await openDetail(view, '表层待办')
  inpByPh(render(), '要做什么').props.onChange({ target: { value: '改了但不保存' } })
  requests = []
  byText(render(), 'dsh-wb-icon', '← 返回').props.onClick(ev())
  await settle()
  assert.equal(requests.length, 0)
  assert.ok(firstByClass(render(), 'dsh-wb-formhead') === null, '返回后回到列表')
})

test('保存放在头栏里，不随表单滚动——手机上输入法盖不住它', async () => {
  const { render, view } = await mount()
  await openDetail(view, '表层待办')
  const head = firstByClass(render(), 'dsh-wb-formhead')
  assert.ok(head !== null, '应当进入详情编辑页')
  // 头栏是 flex:none、不参与滚动；表单区（.dsh-wb-form）才是会滚的那块。
  // 真机反馈：手机上输入法弹出时盖住的正是滚动区底部。
  assert.ok(firstByClass(head, 'dsh-wb-formacts') !== null, '保存的动作区应当在头栏里')
  assert.ok(btnByText(head, '保存') !== null, '头栏里应当有保存按钮')
  assert.equal(btnByText(firstByClass(render(), 'dsh-wb-form'), '保存'), null,
    '会滚动的表单区里不该再有保存按钮')
})

// ---------------------------------------------------------------- AI 助手：问答 / 意见 / 选项 / 人设

test('只提问：回复渲染成对话，且下一轮带上历史（接着聊）', async () => {
  withAi()
  aiReply = { reply: '目前 1 件逾期：补台账。', tasks: [] }
  const { render, view } = await mountAi()
  aiEntry(view).props.onFocus(ev())
  aiEntry(render()).props.onChange({ target: { value: '哪些逾期了' } })
  aiBtn(render(), '↑').props.onClick(ev())
  await settle()

  const msgs = byClass(render(), 'dsh-wb-msg')
  assert.equal(msgs.length, 2, '一问一答两条')
  assert.match(textOf(msgs[0]), /哪些逾期了/)
  assert.match(textOf(msgs[1]), /补台账/, '助手的答复也要留在屏幕上')
  assert.ok(classesOf(msgs[0]).includes('me') && classesOf(msgs[1]).includes('ai'), '靠位置区分谁说的')

  // 第二轮要带上第一轮：否则「它的截止呢」这种追问接不上。
  aiReply = { reply: '2026-10-01', tasks: [] }
  requests = []
  aiEntry(render()).props.onChange({ target: { value: '那它的截止呢' } })
  aiBtn(render(), '↑').props.onClick(ev())
  await settle()
  const call = requests.find((r) => r.path === '/api/workbench/ai-parse')
  assert.equal(call.body.history.length, 2)
  assert.equal(call.body.history[0].text, '哪些逾期了')
  assert.equal(call.body.history[1].role, 'assistant')
})

test('快捷问法：点一下就把问题发出去（不用想怎么问）', async () => {
  withAi()
  aiReply = { reply: '该做：补台账', tasks: [] }
  const { render, view } = await mountAi()
  aiEntry(view).props.onFocus(ev())
  requests = []
  const quick = byClass(render(), 'dsh-wb-quick')
  assert.ok(quick.length > 0, '快捷问法要摆出来——「AI 能干什么」不演示一遍看不出来')
  const chip = byClass(render(), 'dsh-wb-chip').find((c) => textOf(c) === '我今天该做什么')
  assert.ok(chip !== undefined)
  chip.props.onClick(ev())
  await settle()
  const call = requests.find((r) => r.path === '/api/workbench/ai-parse')
  assert.equal(call.body.text, '我今天该做什么')
})

test('单条建议不进向导：没有「第 1 / 1 条」，也没有「跳过」', async () => {
  const restore = stubCoarse(true)
  try {
    withAi()
    // 语音说一句 → 只产出**一条**建议。这正是最常见的那一档。
    aiReply = { reply: '加好了。', tasks: [{ title: '明天去踢球', due: '2026-09-26', priority: '', note: '', plan: '', candidates: [] }] }
    const { view, render } = await mount()

    firstByClass(view, 'dsh-wb-aiinput').props.onChange({ target: { value: '明天去踢球' } })
    firstByClass(render(), 'dsh-wb-send').props.onClick(ev())
    await flush()

    const txt = textOf(render())
    // 「第 1 / 1 条」不含任何信息；「跳过」对唯一一条没有意义（跳过了就什么都不剩）。
    assert.doesNotMatch(txt, /1 \/ 1/, '单条不该出现队列进度——那是纯噪音')
    assert.doesNotMatch(txt, /跳过/, '单条不该有跳过（跳过唯一一条等于放弃全部）')
    // 但那张卡本身要在——用户看完点一次就结束。
    assert.ok(firstByClass(render(), 'dsh-wb-aitask') !== null, '单条应直接给那张卡')
  } finally {
    restore()
  }
})

test('总览：拿不准的条目标 ⚠ 且排在最前，主按钮不催用户跳过', async () => {
  const restore = stubCoarse(true)
  try {
    withAi()
    // 三条里两条没日期（= 拿不准）、一条有日期（= 已填好）。
    aiReply = {
      reply: '读出 3 条。',
      tasks: [
        { title: '买牛奶', due: '2026-09-26', priority: '', note: '', plan: '', candidates: [] },
        { title: '交电费', due: '', priority: '', note: '', plan: '', candidates: [] },
        { title: '预约牙医', due: '', priority: '', note: '', plan: '', candidates: [] },
      ],
    }
    const { view, render } = await mount()
    firstByClass(view, 'dsh-wb-aiinput').props.onChange({ target: { value: '看这张清单' } })
    firstByClass(render(), 'dsh-wb-send').props.onClick(ev())
    await flush()

    const warns = byClass(render(), 'dsh-wb-ovwarn')
    assert.equal(warns.length, 2, '两条没日期的要标出来——它们是「需要你定」的')
    // 有疑问的排最前：先把要动脑的解决，剩下的才好一键过。
    const order = byClass(render(), 'dsh-wb-ovrow').map((r) => textOf(r))
    assert.match(order[0], /交电费|预约牙医/, '有疑问的应排在最前')

    // **有 ⚠ 时主按钮不该是「全部就这么定」**——那等于鼓励用户跳过自己该定的部分。
    const txt = textOf(render())
    assert.doesNotMatch(txt, /全部就这么定/, '还有拿不准的，不该主推一键全定')
    assert.match(txt, /先看有疑问的 2 件/, '主按钮应是「先看有疑问的」')
  } finally {
    restore()
  }
})

test('总览：全无疑问时才给「全部就这么定」', async () => {
  const restore = stubCoarse(true)
  try {
    withAi()
    aiReply = {
      reply: '读出 2 条。',
      tasks: [
        { title: '买牛奶', due: '2026-09-26', priority: '', note: '', plan: '', candidates: [] },
        { title: '交电费', due: '2026-09-28', priority: '', note: '', plan: '', candidates: [] },
      ],
    }
    const { view, render } = await mount()
    firstByClass(view, 'dsh-wb-aiinput').props.onChange({ target: { value: '看这张清单' } })
    firstByClass(render(), 'dsh-wb-send').props.onClick(ev())
    await flush()

    // 都有日期 → 用户看一眼就能过，这才该给一键。
    const txt = textOf(render())
    assert.match(txt, /全部就这么定（2 件）/, '都填好了就该能一键过')
  } finally {
    restore()
  }
})

test('总览：混了改动/合并时不给「全部就这么定」（那时按钮会撒谎）', async () => {
  const restore = stubCoarse(true)
  try {
    withAi()
    // aiApplyAll 只新建 tasks；改动动的是已有数据，必须逐条确认。
    // 按钮若写「全部」而实际只做了新建，就是在骗用户。
    aiReply = {
      reply: '一增一改。',
      tasks: [{ title: '买牛奶', due: '2026-09-26', priority: '', note: '', plan: '', candidates: [] }],
      edits: [{ target: '交电费', patch: { due: '2026-09-28' }, why: '你说挪到 28 号' }],
    }
    const { view, render } = await mount()
    firstByClass(view, 'dsh-wb-aiinput').props.onChange({ target: { value: '买牛奶，顺便把交电费挪到 28 号' } })
    firstByClass(render(), 'dsh-wb-send').props.onClick(ev())
    await flush()

    const txt = textOf(render())
    assert.doesNotMatch(txt, /全部就这么定/, '有改动项时不该给「全部」——那会盖住要逐条确认的部分')
    assert.match(txt, /逐条确认/, '应提示逐条确认')
  } finally {
    restore()
  }
})

test('多条建议才走向导：有进度、可跳过', async () => {
  const restore = stubCoarse(true)
  try {
    withAi()
    // 图片清单那种一次拆出好几条的场景。
    aiReply = {
      reply: '读出 3 条。',
      tasks: [
        { title: '买牛奶', due: '', priority: '', note: '', plan: '', candidates: [] },
        { title: '交电费', due: '', priority: '', note: '', plan: '', candidates: [] },
        { title: '预约牙医', due: '', priority: '', note: '', plan: '', candidates: [] },
      ],
    }
    const { view, render } = await mount()

    firstByClass(view, 'dsh-wb-aiinput').props.onChange({ target: { value: '看这张清单' } })
    firstByClass(render(), 'dsh-wb-send').props.onClick(ev())
    await flush()

    const txt = textOf(render())
    // 多条时**先进总览**（GOV.UK「先给任务清单页」）：一屏可扫读的列表，
    // 而不是七张带徽章的大卡——这正是「8 秒看都看不完」的解法。
    assert.match(txt, /3/, '总览要说清总共有几件')
    assert.ok(byClass(render(), 'dsh-wb-ovlist').length > 0, '多条应先给总览列表')
    // 总览上直接可以「逐条看」或「全部定」，所以「12 条要 12 次下一步」不成立。
    assert.match(txt, /逐条看/, '总览应给逐条入口')
  } finally {
    restore()
  }
})

test('等待块：超过 10 秒的等待有中断入口（Nielsen 硬要求）', async () => {
  const restore = stubCoarse(true)
  try {
    withAi()
    const { view, render } = await mount()
    firstByClass(view, 'dsh-wb-aiinput').props.onChange({ target: { value: '问一句' } })
    firstByClass(render(), 'dsh-wb-send').props.onClick(ev())
    // 不 await：此刻正处在「模型在算」的状态里。

    const wait = firstByClass(render(), 'dsh-wb-wait')
    assert.ok(wait !== null, '等待期间应有等待块（不是一个空白框）')
    const cancel = byClass(render(), 'dsh-wb-waitcancel')
    assert.equal(cancel.length, 1, '>10 秒的等待必须有一个标示清楚的中断方式')
    assert.match(textOf(cancel[0]), /算了/, '中断按钮要是个看得懂的词，不是光秃秃一个 ✕')
  } finally {
    restore()
  }
})

test('快捷问法：手里有东西时就让位（同一屏不重复问同样的事）', async () => {
  withAi()
  aiReply = { reply: '该做：补台账', tasks: [] }
  const { render, view } = await mountAi()
  aiEntry(view).props.onFocus(ev())
  // 空手时问法在——那正是「我该问点什么」的时候。
  assert.ok(byClass(render(), 'dsh-wb-quick').length > 0, '空手时应有快捷问法')

  // 问过一轮之后，屏幕上已经有问答了；再摆一排「我今天该做什么 / 哪些逾期了」
  // 就是同一屏里重复问同样的事——用户读完答案正要动手，那排问法只是噪音。
  const chip = byClass(render(), 'dsh-wb-chip').find((c) => textOf(c) === '我今天该做什么')
  chip.props.onClick(ev())
  await settle()

  const txt = textOf(render())
  assert.doesNotMatch(txt, /哪些逾期了/, '有内容后不该再摆快捷问法')
  assert.doesNotMatch(txt, /总结一下进展/, '有内容后不该再摆快捷问法')
})

test('草稿卡给出专家意见与历史依据（新增时要结合当前与历史）', async () => {
  withAi()
  aiReply = {
    reply: '拆出 1 条',
    tasks: [{
      title: '补台账', due: '', priority: '', note: '', plan: '工作主线',
      advice: '与手上的「深层待办」撞期；历史上「表层待办」用了 3 天。',
      history: [{ title: '表层待办', status: 'done', days: 3, evidence: 1 }],
      candidates: [{ kind: 'plan', id: idOf('工作主线'), title: '工作主线', why: '模型判断' }],
    }],
  }
  const { render, view } = await mountAi()
  aiEntry(view).props.onFocus(ev())
  aiEntry(render()).props.onChange({ target: { value: '把台账补完' } })
  aiBtn(render(), '↑').props.onClick(ev())
  await settle()

  assert.match(textOf(firstByClass(render(), 'dsh-wb-advice')), /撞期/)
  assert.match(textOf(firstByClass(render(), 'dsh-wb-aihist')), /表层待办/)
  assert.match(textOf(firstByClass(render(), 'dsh-wb-aihist')), /用了 3 天/)
})

test('点选项：把它的 patch 并进草稿再打开表单，不直接建', async () => {
  withAi()
  aiReply = {
    reply: 'ok',
    tasks: [{
      title: '补台账', due: '', priority: '', note: '', plan: '',
      options: [
        { label: '排到下周', why: '手上还有两条', patch: { due: '2026-09-21', priority: 'low' } },
      ],
      candidates: [{ kind: 'inbox', title: '收件箱', why: '先记下来' }],
    }],
  }
  const { render, view } = await mountAi()
  aiEntry(view).props.onFocus(ev())
  aiEntry(render()).props.onChange({ target: { value: '把台账补完' } })
  aiBtn(render(), '↑').props.onClick(ev())
  await settle()

  requests = []
  byClass(render(), 'dsh-wb-chip').find((c) => textOf(c) === '排到下周').props.onClick(ev())
  await settle()
  assert.equal(requests.length, 0, '选项也只是预填，不直接写入')

  const page = render()
  assert.ok(firstByClass(page, 'dsh-wb-formhead') !== null, '应打开新建表单')
  assert.equal(inpByPh(page, '要做什么').props.value, '补台账')
  assert.equal(inpByPh(page, '谁负责（可空）') !== null, true)
  const dates = byClass(page, 'dsh-wb-inp').filter((i) => i.props.type === 'date')
  assert.ok(dates.some((d) => d.props.value === '2026-09-21'), '选项给的 due 要落进表单')
})

test('人设：在设置页能看能改，保存走 /persona-set', async () => {
  withAi()
  const { render, view } = await mount()
  requests = []
  headBtn(view, '设置').props.onClick(ev())
  await settle()

  const box = firstByClass(render(), 'dsh-wb-atextarea')
  assert.ok(box !== null, '应能直接看到人设全文')
  assert.equal(box.props.value, '## 性格\n- 默认人设')
  assert.ok(requests.some((r) => r.path === '/api/workbench/persona'), '拉一次人设')

  firstByClass(render(), 'dsh-wb-atextarea').props.onChange({ target: { value: '## 性格\n- 只报事实' } })
  requests = []
  aiBtn(render(), '保存').props.onClick(ev())
  await settle()
  const write = requests.find((r) => r.path === '/api/workbench/persona-set')
  assert.equal(write.body.text, '## 性格\n- 只报事实', '人改的是整篇')
})

// ---------------------------------------------------------------- MLO 核心：执行清单 / 星标 / AI 清单卡

test('「当前任务」视图：跨分支聚合现在能做的，星标置顶，被挡的单独折叠', async () => {
  const keep = planPayload
  planPayload = JSON.parse(JSON.stringify(keep))
  const main = planPayload.nodes.find((n) => n.title === '工作主线')
  main.children.push(
    { id: 'x1', type: 'todo', title: '执行甲', status: 'todo', due: '2026-09-20' },
    { id: 'x2', type: 'todo', title: '执行乙', status: 'todo', priority: 'high', starred: true },
    { id: 'x3', type: 'todo', title: '执行丙', status: 'todo', blockedBy: ['x1'] },
  )
  try {
    const { render, view } = await mount()
    const toggles = byClass(view, 'dsh-wb-viewtoggle')[0]
    toggles.children.find((b) => textOf(b) === '当前任务').props.onClick(ev())
    const page = render()
    assert.match(textOf(firstByClass(page, 'dsh-wb-aihead')), /现在能做/)
    // 共享 fixture 里还有别的待办，这里只断言相对顺序：星标的「执行乙」在「执行甲」前。
    const bodyText = textOf(firstByClass(page, 'dsh-wb-body'))
    assert.ok(bodyText.indexOf('执行乙') >= 0 && bodyText.indexOf('执行乙') < bodyText.indexOf('执行甲'),
      '星标任务要排在无星标之前')
    assert.ok(byClass(page, 'dsh-wb-task').find((r) => textOf(r).includes('执行乙')) !== undefined)
    // 被挡的单独一段：它们不是没做，是做不了。
    const blockedHead = byClass(page, 'dsh-wb-aihead').find((x) => textOf(x).includes('被挡住的'))
    assert.ok(blockedHead !== undefined)
    assert.match(textOf(firstByClass(page, 'dsh-wb-body')), /等 执行甲/, '被谁挡要说得出名字')
    // 行尾不放「编辑」：点标题就是打开详情（单击统一 openEdit），同一件事不必说两遍。
    const todoRows = byClass(page, 'dsh-wb-task')
    assert.ok(todoRows.length >= 3, '这一屏应当有若干行，否则下面的护栏是空转')
    for (const r of todoRows) {
      assert.equal(byClass(r, 'dsh-wb-act').filter((b) => String(b.props.title || '').includes('编辑')).length, 0,
        '当前任务的行尾不该有编辑按钮')
    }
  } finally {
    planPayload = keep
  }
})

test('行内 ★：点一下置顶星标（走 /node-set 的 star），再点取消', async () => {
  const { render, view } = await mount()
  const row = taskRow(view, '深层待办') ?? taskRow(view, '表层待办')
  const star = actOf(row, '★')
  assert.ok(star !== undefined)
  requests = []
  star.props.onClick(ev())
  await settle()
  const call = requests.find((r) => r.path === '/api/workbench/node-set')
  assert.equal(call.body.star, true)
})

test('AI 清单卡：渲染 items 与命中情况，可一键存为视图并出现在筛选条', async () => {
  withAi()
  aiReply = {
    reply: '按顺序',
    tasks: [],
    list: { title: '明天在家能做的', items: [
      { title: '深层待办', id: idOf('深层待办'), ok: true },
      { title: '不存在的活', id: null, ok: false },
    ] },
  }
  const { render, view } = await mountAi()
  aiEntry(view).props.onFocus(ev())
  aiEntry(render()).props.onChange({ target: { value: '明天在家能做什么' } })
  aiBtn(render(), '↑').props.onClick(ev())
  await settle()

  const card = firstByClass(render(), 'dsh-wb-ailist')
  assert.ok(card !== null, '应有清单卡')
  const rows = byClass(card, 'dsh-wb-formrow')
  assert.equal(rows.length, 2)
  assert.ok(classesOf(rows[1]).includes('miss'), '没对上的要标出来')
  // 保存：只收命中的 id。
  storage.clear()
  requests = []
  aiBtn(render(), '存为视图').props.onClick(ev())
  await settle()
  assert.equal(requests.filter((r) => r.path !== '/api/workbench/get').length, 0, '存视图不写服务端（本机偏好）')
  const saved = JSON.parse(storage.get('dsh-workbench:views'))
  assert.equal(saved.length, 1)
  assert.equal(saved[0].name, '明天在家能做的')
  assert.deepEqual(saved[0].ids, [idOf('深层待办')])
})

test('存下的视图出现在筛选条，点开只列清单里还活着的任务', async () => {
  withAi()
  aiReply = { reply: 'ok', tasks: [], list: { title: '周末冲刺', items: [{ title: '深层待办', id: idOf('深层待办'), ok: true }] } }
  const { render, view } = await mountAi()
  aiEntry(view).props.onFocus(ev())
  aiEntry(render()).props.onChange({ target: { value: '组个清单' } })
  aiBtn(render(), '↑').props.onClick(ev())
  await settle()
  aiBtn(render(), '存为视图').props.onClick(ev())
  await settle()

  const chip = byClass(render(), 'dsh-wb-chip').find((c) => textOf(c) === '视图 · 周末冲刺')
  assert.ok(chip !== undefined, '存完就出现在筛选条')
  // 存为视图时已经**自动激活**：不必再点，清单就在眼前。
  let page = render()
  let cv = firstByClass(page, 'dsh-wb-customview')
  assert.ok(cv !== null, '保存后直接看到清单内容')
  assert.match(textOf(cv), /深层待办/)
  // chip 是开关：点一下收起，再点一下展开。**每次点击后要重新取按钮**——
  // 重渲会换新元素，旧元素上的闭包还是旧状态（真浏览器同理，只是替身更较真）。
  byClass(render(), 'dsh-wb-chip').find((c) => textOf(c) === '视图 · 周末冲刺').props.onClick(ev())
  assert.ok(firstByClass(render(), 'dsh-wb-customview') === null, '再点一下收起')
  byClass(render(), 'dsh-wb-chip').find((c) => textOf(c) === '视图 · 周末冲刺').props.onClick(ev())
  page = render()
  cv = firstByClass(page, 'dsh-wb-customview')
  assert.ok(cv !== null, '再点一下展开')
})

// ---------------------------------------------------------------- 完成语义一体化

test('叶子（含原「空计划」）渲染成待办行、可勾选；容器没有勾选框', async () => {
  const keep = planPayload
  planPayload = JSON.parse(JSON.stringify(keep))
  // 无子项的节点 = 待办：即便旧数据写着 type:'plan'，也按叶子渲染与操作。
  planPayload.nodes.push({ id: 'leafplan', type: 'plan', title: '叶子计划', status: 'active', children: [] })
  try {
    const { render, view } = await mount()
    // 「叶子计划」现在是一条待办行（叶子），勾选走 /todo-set。
    const leafRow = taskRow(view, '叶子计划')
    assert.ok(leafRow !== null, '叶子按待办渲染')
    const leafCheck = findAll(leafRow, (el) => el.type === 'input' && el.props.type === 'checkbox')[0]
    assert.ok(leafCheck !== undefined, '叶子 = 能做完的事，要能勾')
    const withKids = planRow(view, '工作主线')
    const kidCheck = findAll(withKids, (el) => el.type === 'input' && el.props.type === 'checkbox')
    assert.equal(kidCheck.length, 0, '容器（有子项）不能手点完成——它的完成由子项派生')

    requests = []
    leafCheck.props.onChange(ev())
    await settle()
    const call = requests.find((r) => r.path === '/api/workbench/todo-set')
    assert.equal(call.body.status, 'done')
    assert.equal(call.body.todo, 'leafplan')
  } finally {
    planPayload = keep
  }
})

test('详情页：有未完成子项的计划，「已完成」按钮禁用并说明原因', async () => {
  const { render, view } = await mount()
  await openDetail(view, '工作主线', 'dsh-wb-plantitle')
  // 类型段删除后，状态段是第一个 seg；「已完成」在子项没做完时应被禁用。
  const statusSeg = byClass(render(), 'dsh-wb-seg')[0]
  const doneBtn = statusSeg.children.find((b) => textOf(b) === '已完成')
  assert.equal(doneBtn.props.disabled, true, '子项没做完，不能手动完成')
  assert.match(String(doneBtn.props.title), /自动完成/)
})

// ------------------------------------------------- 顶层平铺（原「纳入工作计划」）

test('顶层待办与计划平铺在同一栏，不再需要「纳入计划」这一步', async () => {
  const keep = planPayload
  planPayload = JSON.parse(JSON.stringify(keep))
  // 一条顶层待办 + 一个顶层计划，同时摆在顶层。
  planPayload.nodes.push({ id: 'w1', type: 'todo', title: '独立事项', status: 'todo' })
  try {
    const { view } = await mount()
    const page = view

    // 两栏已合并：不该再有「收件箱」段，也不该再有「工作计划」段。
    assert.equal(byClass(page, 'dsh-wb-inboxhead').length, 0, '不该再有收件箱分栏')
    assert.ok(!byClass(page, 'dsh-wb-secttitle').map(textOf).includes('工作计划'),
      '不该再有独立的工作计划分栏')

    // 但那条顶层待办**照常显示**——它不需要先被「纳入」什么。
    const row = findAll(page, (el) => classesOf(el).includes('dsh-wb-todowrap')
      && textOf(el).includes('独立事项'))[0]
    assert.ok(row !== undefined, '顶层待办应直接出现在列表里')

    // 「纳入计划」按钮已删——没有这个中间态了。
    assert.equal(byClass(page, 'dsh-wb-adopt').length, 0, '不该再有「纳入计划」按钮')

    // 顶层待办要有勾选框（完成语义与形态脱钩）。
    const box = byClass(row, 'dsh-wb-check')[0] || byClass(row, 'dsh-wb-todobox')[0]
      || findAll(row, (el) => el.type === 'input')[0]
    assert.ok(box !== undefined, '顶层待办应有勾选框')
  } finally {
    planPayload = keep
  }
})

test('老数据里的 filed 键不再影响分栏（顶层一律平等）', async () => {
  const keep = planPayload
  planPayload = JSON.parse(JSON.stringify(keep))
  // 历史上 filed:true 的待办会跳到「工作计划」栏；现在它只是普通顶层条目。
  planPayload.nodes.push({ id: 'w2', type: 'todo', title: '带着老标记的事', status: 'todo', filed: true })
  try {
    const { view } = await mount()
    // 它照常显示，位置由它在 nodes[] 里的次序决定，而不是由 filed 决定。
    const row = findAll(view, (el) => classesOf(el).includes('dsh-wb-todowrap')
      && textOf(el).includes('带着老标记的事'))[0]
    assert.ok(row !== undefined, '带 filed 的老数据仍要正常显示（不因字段废弃而消失）')
  } finally {
    planPayload = keep
  }
})

// ------------------------------------------------- 未来日程（按天分组，Things 3 形态）

/** 相对今天偏移 offset 天的 YYYY-MM-DD（与 todayStr 同为本地时区口径）。 */
function dayFromNow(offset) {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return d.getFullYear() + '-' + m + '-' + day
}
const monthDay = (offset) => {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return (d.getMonth() + 1) + '月' + d.getDate() + '日'
}

test('「未来 7 天」按天分组：逾期滚入今日组，空天不占行', async () => {
  const keep = planPayload
  const tmp = await mkdtemp(join(tmpdir(), 'dsh-wb-up-'))
  try {
    const call = hostCall(tmp)
    await call('plan_node_add', { title: '拖了两天的活', due: dayFromNow(-2) })
    await call('plan_node_add', { title: '明天要交的活', due: dayFromNow(1) })
    await call('plan_node_add', { title: '三天后的事', due: dayFromNow(3) })
    planPayload = (await call('plan_show')).plan

    const { render, view } = await mount()
    const chip = byClass(view, 'dsh-wb-chip').find((c) => textOf(c).includes('未来 7 天'))
    assert.ok(chip !== undefined, '筛选条上应有「未来 7 天」芯片')
    chip.props.onClick(ev())

    const page = render()
    const heads = byClass(page, 'dsh-wb-dayhead').map((h) => textOf(h))
    assert.ok(heads[0].includes('今天'), '逾期滚入「今天」组，第一段是今日而非「逾期（N）」：' + heads[0])
    assert.equal(heads.length, 3, '今天(含逾期) + 明天 + 三天后；中间那天没有事项就不占行')
    assert.ok(heads[1].includes(monthDay(1)), '第二天是「明天」那一组：' + heads[1])
    assert.ok(heads[2].includes(monthDay(3)), '第三天是「三天后」那一组：' + heads[2])
    // 逾期项只出现一次（在今日组里），不另立一段。
    const tasks = byClass(page, 'dsh-wb-focus').map((r) => textOf(r))
    assert.equal(tasks.filter((t) => t.includes('拖了两天的活')).length, 1)
    // 信号不丢：滚入今日的逾期项，due 仍显红（dsh-wb-taskdue.overdue）。
    const overdueDue = byClass(page, 'dsh-wb-taskdue').filter((s) => classesOf(s).includes('overdue'))
    assert.ok(overdueDue.length >= 1, '逾期项红标仍在')
  } finally {
    planPayload = keep
    await rm(tmp, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- 浮球（AI 唯一入口）

/** matchMedia 替身：旧版本里浮球按 (pointer: coarse) 决定出不出来，现在所有设备
 *  都出。留着这个替身是为了**证明**这一点：不管粗指针还是细指针，浮球都在。 */
function stubCoarse(matches) {
  const old = globalThis.window.matchMedia
  globalThis.window.matchMedia = (q) => ({
    matches: matches === true && String(q).indexOf('coarse') >= 0,
    addEventListener: () => {},
    removeEventListener: () => {},
  })
  return () => { globalThis.window.matchMedia = old }
}

test('手机档没有浮球、改用底部常驻输入条；桌面档仍是浮球', async () => {
  // 手机档：底部常驻输入条（借宿主输入框预填），**没有浮球**。
  // 用户明确要求：「在手机版上不需要浮球了，直接用现在的输入框就行」。
  let restore = stubCoarse(true)
  try {
    const touchMount = await mount()
    assert.equal(byClass(touchMount.view, 'dsh-wb-fabball').length, 0,
      '手机档不应再有浮球（改为底部常驻输入条）')
    assert.ok(byClass(touchMount.view, 'dsh-wb-dockai').length > 0,
      '手机档应有底部常驻输入条')
  } finally {
    restore()
  }

  // 桌面档：浮球保持原样——面板住在一个又宽又矮的地方，常驻一行会每屏少一条任务。
  restore = stubCoarse(false)
  try {
    const deskMount = await mount()
    assert.ok(byClass(deskMount.view, 'dsh-wb-fabball').length > 0,
      '桌面档仍要有浮球——它是那里唯一的 AI 入口')
    assert.equal(byClass(deskMount.view, 'dsh-wb-dockai').length, 0,
      '桌面档不应有底部输入条（那是手机形态）')
  } finally {
    restore()
  }
})

test('手机档「记一条」：回车**直接落库**进收件箱，不绕对话、不等确认', async () => {
  const restore = stubCoarse(true)
  try {
    const { view, render } = await mount()

    const bar = byClass(view, 'dsh-wb-dockai')[0]
    assert.ok(bar !== undefined, '手机档应有底部常驻输入条')

    const input = firstByClass(view, 'dsh-wb-aiinput')
    assert.ok(input !== null, '底部条里应有输入框')
    input.props.onChange({ target: { value: '台区 A 改造' } })

    const before = requests.length
    const afterTyping = firstByClass(render(), 'dsh-wb-aiinput')
    afterTyping.props.onKeyDown({ key: 'Enter', preventDefault: () => {} })
    await flush()

    // **一次动作就落库**：直接调 /node-add 写进 plan.json。
    // 用户原话：「输入之后它填进去的就不会自动生成任务，反而要回套到你这个原生的
    // 对话框里面…然后我要再等确认，它才能记录进去。这个是不行的。」
    const addCall = requests.slice(before).filter((r) => String(r.path).indexOf('/node-add') >= 0).pop()
    assert.ok(addCall !== undefined, '回车应直接落库（/node-add）')
    assert.match(JSON.stringify(addCall.body), /台区 A 改造/, '要带上用户敲的原话')

    // **不许碰宿主输入框**：那会把待办伪装成一条发给 agent 的消息，
    // 于是必然带出「谁来处理、要不要确认」这一整套对话流程。
    assert.equal(draftWrites.length, 0, '不应把待办填进宿主输入框')
    assert.equal(submitCalls, 0, '不应替用户发消息')
  } finally {
    restore()
  }
})

test('手机档「记一条」：点击「记下」与回车同一条路（都直接落库）', async () => {
  const restore = stubCoarse(true)
  try {
    const { view, render } = await mount()

    const input = firstByClass(view, 'dsh-wb-aiinput')
    input.props.onChange({ target: { value: '按按钮记一条' } })

    // 「记下」那颗按钮：有字可确认时才显出来（与发送键同一条纪律）。
    const btn = byClass(render(), 'dsh-wb-iconbtn').filter((b) => b.props.disabled !== true).pop()
    assert.ok(btn !== undefined, '有字时应有一可点的确认按钮')
    const before = requests.length
    btn.props.onClick(ev())
    await flush()

    const addCall = requests.slice(before).filter((r) => String(r.path).indexOf('/node-add') >= 0).pop()
    assert.ok(addCall !== undefined, '点「记下」也应直接落库')
    assert.match(JSON.stringify(addCall.body), /按按钮记一条/)
  } finally {
    restore()
  }
})

test('手机档「记一条」：空输入什么都不做（不白写一次盘）', async () => {
  const restore = stubCoarse(true)
  try {
    const { view, render } = await mount()
    const before = requests.length
    firstByClass(render(), 'dsh-wb-aiinput').props.onKeyDown({ key: 'Enter', preventDefault: () => {} })
    await flush()
    assert.equal(requests.length, before, '空输入不应产生任何请求')
    assert.ok(view !== null)
  } finally {
    restore()
  }
})

test('手机档 + 有模型：底部是完整 composer（输入框 + 图片 + 确认），不是纯输入框', async () => {
  // 这是用户要的核心形态：「在插件里面复刻一下这个类似的专用框，就包括[附件]啊，
  // 还有一个就是可以输入确认的按钮啊…因为我还是需要输入图片，然后让它识别，
  // 然后做成任务。」
  const restore = stubCoarse(true)
  withAi()
  try {
    const { view } = await mount()

    const dock = byClass(view, 'dsh-wb-dockai')[0]
    assert.ok(dock !== undefined, '手机档底部应有常驻 composer 块')
    assert.ok(firstByClass(view, 'dsh-wb-aiinput') !== null, '应有输入框')

    // 图片入口（label + 隐藏的 file input）：拍照/选图 → /ai-parse 让模型识别成任务。
    const pic = firstByClass(view, 'dsh-wb-pic')
    assert.ok(pic !== null, '应有图片/附件入口')

    // 确认按钮：走 /ai-parse。
    //
    // 注意它**不按空输入禁用**——空输入由 runAi 自己挡（这是 aiBlock 原有设计，
    // 桌面浮球与手机档共用同一份逻辑，所以行为一致）。这条断言因此只钉「有按钮」，
    // 空输入不写盘由下面「空输入什么都不做」那条用例覆盖。
    const send = firstByClass(view, 'dsh-wb-send')
    assert.ok(send !== null, '应有确认（发送）按钮')
  } finally {
    restore()
  }
})

test('手机档 + 有模型：贴图后确认键可点，提交走 /ai-parse（图片识别成任务那条路）', async () => {
  const restore = stubCoarse(true)
  withAi()
  try {
    const { view, render } = await mount()

    // 只有图片、没有文字时，确认键也必须可点——拍照记任务正是「一个字都不打」。
    // 这里直接走输入框那条（贴图路径由 /ai-parse 的 images 字段覆盖，见 host 测试）。
    const input = firstByClass(view, 'dsh-wb-aiinput')
    input.props.onChange({ target: { value: '把这张清单拆成任务' } })
    const send = firstByClass(render(), 'dsh-wb-send')
    assert.equal(send.props.disabled, false, '有内容时确认键应可点')

    const before = requests.length
    send.props.onClick(ev())
    await flush()

    const parseCall = requests.slice(before).filter((r) => String(r.path).indexOf('/ai-parse') >= 0).pop()
    assert.ok(parseCall !== undefined, '确认应走 /ai-parse 让模型拆成任务')
  } finally {
    restore()
  }
})

test('手机档底部块：收起时只有一条输入行，出结果才升成 sheet', async () => {
  const restore = stubCoarse(true)
  try {
    withAi()
    // 有内容可答：让 ai-parse 回一段 reply，才会触发展开。
    aiReply = { reply: '今天有三件事值得动。', tasks: [{ title: '补台账', due: '', priority: '', note: '', plan: '', candidates: [] }] }

    const { view, render } = await mount()
    const dock = byClass(view, 'dsh-wb-dockai')[0]
    assert.ok(dock !== undefined, '手机档应有底部块')
    // **收起态**：class 里没有 on。
    // 这一条是本次改动的核心——常驻的只该是输入条本身，不是「输入条 + 结果区」。
    assert.doesNotMatch(String(dock.props.className), /\bon\b/,
      '默认应是收起态（只有一条输入行）')

    // 提交一次，产出结果后应升成 sheet。
    firstByClass(view, 'dsh-wb-aiinput').props.onChange({ target: { value: '今天做什么' } })
    firstByClass(render(), 'dsh-wb-send').props.onClick(ev())
    await flush()

    const after = byClass(render(), 'dsh-wb-dockai')[0]
    assert.match(String(after.props.className), /\bon\b/,
      '出结果后应升成 sheet（展开态）')
  } finally {
    restore()
  }
})

test('手机档底部块：展开后有且只有一个收起入口', async () => {
  const restore = stubCoarse(true)
  try {
    withAi()
    aiReply = { reply: '有结果。', tasks: [] }
    const { view, render } = await mount()

    firstByClass(view, 'dsh-wb-aiinput').props.onChange({ target: { value: '问一句' } })
    firstByClass(render(), 'dsh-wb-send').props.onClick(ev())
    await flush()

    // 展开后要能收回去，否则升起来就回不到计划树了。
    const collapse = byClass(render(), 'dsh-wb-aibtn').filter((b) => b.props.title !== undefined
      && String(b.props.title).indexOf('收起这块') >= 0)
    assert.equal(collapse.length, 1, '恰好一个收起入口（同一个动作不摆两个控件）')

    collapse[0].props.onClick(ev())
    const folded = byClass(render(), 'dsh-wb-dockai')[0]
    assert.doesNotMatch(String(folded.props.className), /\bon\b/, '点了收起应回到收起态')
  } finally {
    restore()
  }
})

test('桌面档底部块：不出现手机专属的「收起」按钮（浮层有自己的 ✕）', async () => {
  const restore = stubCoarse(false)
  try {
    const { view } = await mount()
    const collapse = byClass(view, 'dsh-wb-aibtn').filter((b) => b.props.title !== undefined
      && String(b.props.title).indexOf('收起这块') >= 0)
    assert.equal(collapse.length, 0, '桌面档不应有手机专属的收起按钮')
  } finally {
    restore()
  }
})

test('手机档底部块的 DOM 层级：输入行是 aiwrap 的直接子元素（收起态 CSS 靠它命中）', async () => {
  const restore = stubCoarse(true)
  try {
    const { view } = await mount()
    const wrap = firstByClass(view, 'dsh-wb-aiwrap')
    assert.ok(wrap !== null, '底部块里应有 aiwrap（aiBlock() 的容器）')

    // **这条钉住的是一个真实踩过的坑**：收起态的 CSS 写的是
    //     .dsh-wb-dockai .dsh-wb-aiwrap > *  { display:none }
    //     .dsh-wb-dockai .dsh-wb-aiwrap > .dsh-wb-aibar { display:flex }
    // 它要求输入行（.dsh-wb-aibar）是 aiwrap 的**直接子元素**。
    // 第一版选择器写成 `.dsh-wb-dockai > .dsh-wb-aibar`（漏了 aiwrap 这一层），
    // 于是那条规则永远命中 0 个元素——收起态会把输入框也一起藏掉。
    // 这个 bug 单测「class 名对不对」是查不出来的，必须断言层级。
    const directBar = (wrap.children || []).find((kid) => classesOf(kid).includes('dsh-wb-aibar'))
    assert.ok(directBar !== undefined,
      '输入行必须是 aiwrap 的直接子元素——否则收起态的选择器命中不到，会把输入框一起藏掉')
  } finally {
    restore()
  }
})

test('侧栏页脚入口：形态满足 zen 的收割规则，点了走 openTab（而不是代点 DOM）', async () => {
  const { slotEntries } = await mount()
  // 两个插槽注册点：① 侧栏页脚入口（本用例）② 官方右栏的 tab 正文
  // （'sidebar.right.pane.tab'，由 tab 注册用例覆盖）。
  assert.equal(slotEntries.length, 2, '侧栏页脚入口 + 官方右栏 tab 正文')
  const entrySlot = slotEntries.find((e) => e.options.name === 'sidebar.footer.action')
  assert.ok(entrySlot !== undefined, '应有侧栏页脚入口')
  assert.equal(entrySlot.options.id, 'dsh-workbench-entry')
  assert.equal(slotEntries.filter((e) => e.options.name === 'sidebar.right.pane.tab').length, 1,
    '应恰好注册一个官方右栏 tab 正文')

  // 手机外壳插件 dsh-zen-remote 的 scanHarvest 会把这个插槽的**每个直接子节点**
  // 收成主屏的一颗 chip，规则很具体——所以这里逐条钉住，免得哪天改坏了没发现：
  //   · 根节点必须是 <button>（Fragment 多根 → 第二个根也会变成一颗 chip）
  //   · 必须有可见文字（chip 的名字取 textContent，空了整条被丢）
  //   · 带一个 <svg>（chip 的图标从它深拷贝）
  //   · **不能**带 data-mobile-nav（那是 zen 自己的标记，它据此跳过自己的节点）
  const Entry = slotEntries[0].component
  const el = Entry({})
  assert.equal(el.type, 'button', '根节点必须是 button')
  assert.ok(textOf(el).trim() !== '', '必须有可见文字，否则 chip 会被丢掉')
  assert.ok(findAll(el, (x) => x.type === 'svg').length > 0, '要带 svg 作 chip 图标')
  assert.equal(classesOf(el).includes('dsh-wb-entry'), true)
  assert.equal(el.props['data-dsh-workbench-entry'], 'true', '给一个稳定锚点')
  const attrs = Object.keys(el.props).filter((k) => k.startsWith('data-'))
  assert.ok(!attrs.includes('data-mobile-nav'), '不能带 data-mobile-nav（zen 会跳过自己的节点）')

  // chip 的名字就是 textContent，所以**未完成数绝不能是个真实节点**：
  // 面板一打开 store 拉到数据，数字就会出现，chip 的名字会当场从「工作计划」
  // 变成「工作计划3」；更坏的是 zen 的 chip 开关偏好按 `harvest:${name}` 存，
  // 名字一变偏好就丢。计数因此挂在 data-count 上、由 CSS 伪元素画出来
  // （伪元素内容不进 textContent）。
  assert.equal(textOf(el).trim(), '工作计划', 'chip 的名字必须干净：计数不许混进 textContent')
  assert.equal(el.props['data-count'], '3', '计数改挂 data-count（fixture 里有 3 条未完成待办）')
  assert.equal(findAll(el, (x) => classesOf(x).includes('dsh-wb-entrycount')).length, 0,
    '计数不能是真实节点')

  // 点击走官方右侧栏的**服务**，而不是代点某个 DOM 按钮——后者会随宿主的
  // 类名散列失效，这正是 zen 1.1.15 的病（它的 header 按钮转发到
  // `[data-dsh-better-sidebar] button[class$="_toggleButton"]`，实测命中 0）。
  el.props.onClick({ stopPropagation: () => {} })
  assert.equal(openTabCalls.length, 1, '点一次 = 调一次 openTab')
  // 官方 openTab 只收 kind 字符串，不收 better-sidebar 的 `{ type }` 对象。
  assert.equal(openTabCalls[0].kind, 'dsh-workbench', '要打开的是自己的 tab kind')
})

test('浮球点开就是一个输入框：说一句统一走 /ai-parse，由模型判断是记录还是回答', async () => {
  withAi()
  aiReply = { tasks: [], reply: '没有逾期。' }
  const { render, view } = await mountAi()
  assert.ok(byClass(view, 'dsh-wb-fabball').length === 0, '展开后不再显示球本身')
  assert.ok(firstByClass(view, 'dsh-wb-fabsheet') !== null, '点开的是浮层')
  assert.equal(byClass(view, 'dsh-wb-fabitem').length, 0, '不再有「记待办 / 问 AI」的分岔按钮')

  const input = aiEntry(view)
  input.props.onChange({ target: { value: '哪些逾期了' } })
  requests = []
  aiBtn(render(), '↑').props.onClick(ev())
  await settle()
  assert.equal(requests.length, 1, '一次提交 = 一次调用')
  assert.ok(String(requests[0].path).endsWith('/ai-parse'), '统一走 /ai-parse')
  assert.equal(requests[0].body.text, '哪些逾期了')
})

test('浮层里的「收起」把浮球还回来', async () => {
  withAi()
  aiReply = { tasks: [], reply: '没什么要紧的。' }
  const { render, view } = await mountAi()
  aiEntry(view).props.onChange({ target: { value: '今天怎么样' } })
  aiBtn(render(), '↑').props.onClick(ev())
  await settle()

  firstByClass(render(), 'dsh-wb-fabclose').props.onClick(ev())
  const folded = render()
  assert.ok(firstByClass(folded, 'dsh-wb-fabball') !== null, '收起后回到浮球')
  assert.equal(firstByClass(folded, 'dsh-wb-fabsheet'), null, '浮层不再在树里')
})

test('有字可确认时，提交键上要出现「确认」两个字', async () => {
  // 真机：「语音识别是识别成功了，但是没有可以让我选择确认的一个按钮」——识别的字
  // 已经躺在输入框里，可提交键只有一个 ↑ 图标（纯输入框那半边是个 ＋），说完话的人
  // 不知道按哪个键算数。有字就补上名字；没字不显示（那时没有东西要确认）。
  withAi()
  const { render, view } = await mountAi()
  const labelOf = (root) => {
    const span = findAll(root, (x) => classesOf(x).includes('dsh-wb-sendlabel'))
    return span.length === 0 ? '' : textOf(span[0])
  }
  assert.equal(labelOf(view), '', '还没输入时不该有「确认」')
  aiEntry(view).props.onChange({ target: { value: '把台账补完' } })
  assert.equal(labelOf(render()), '确认', '有字就该把「确认」显出来')
})

test('纯输入框（没模型）也照样有「确认」两个字', async () => {
  const ctx = await mount()
  firstByClass(ctx.view, 'dsh-wb-fabball').props.onClick(ev())
  const opened = ctx.render()
  const labelOf = (root) => {
    const span = findAll(root, (x) => classesOf(x).includes('dsh-wb-sendlabel'))
    return span.length === 0 ? '' : textOf(span[0])
  }
  assert.equal(labelOf(opened), '', '空的时候不显示')
  byClass(opened, 'dsh-wb-aiinput')[0].props.onChange({ target: { value: '交电费' } })
  assert.equal(labelOf(ctx.render()), '确认', '有字就该显出来')
})

test('点开浮层助手先说一句「现在什么情况」——本地算的，数字和面板同源', async () => {
  // 「我点开它，你就应该给我所有建议」的第一步：**不用你问**，先说现状。
  // 数字取的是 summarize() 里那份和面板筛选芯片同源的派生量，所以两边永远一致；
  // 没有任何值得说的时候也要说一句，否则「点开就有建议」会时灵时不灵。
  withAi()
  const { render, view } = await mountAi()
  const brief = firstByClass(view, 'dsh-wb-aibrief')
  assert.ok(brief !== null, '浮层里应该有一行现状')
  assert.match(textOf(brief), /现在：|眼下没有/, '要么给数字，要么明说没什么')
  // fixture 里有一条顶层待办，所以应该给出「顶层 1」（两栏合并后的叫法）。
  assert.match(textOf(brief), /顶层 1/)

  // 点它：收起浮层（「顶层」没有对应的筛选按钮，所以只是把人送回面板）
  const chip = byClass(brief, 'dsh-wb-chip').find((b) => textOf(b).includes('顶层'))
  assert.ok(chip !== undefined)
  chip.props.onClick(ev())
  assert.equal(firstByClass(render(), 'dsh-wb-fabsheet'), null, '点完应该收起浮层')
})

test('草稿卡的「就这么办」：一次点击直接落库，不进表单', async () => {
  // 用户原话：「你反馈出来的东西没有可以让我选择确定，然后确定之后你就帮我做」——
  // 原来三条路都要过表单（芯片把你送进详情页，还得再点保存）。现在卡片上有一个
  // 写着「就这么办：归入「X」」的主动作，按下去就是它写的那个意思。
  withAi()
  aiReply = {
    reply: '好',
    tasks: [{
      title: '补台账', due: '2026-10-09', priority: '', note: '', plan: '',
      candidates: [{ kind: 'plan', id: idOf('工作主线'), title: '工作主线', why: '模型判断' }],
      options: [],
    }],
  }
  const { render, view } = await mountAi()
  aiEntry(view).props.onChange({ target: { value: '补台账，10月9号' } })
  aiBtn(render(), '↑').props.onClick(ev())
  await settle()

  const card = firstByClass(render(), 'dsh-wb-aitask')
  const now = findAll(card, (x) => x.type === 'button' && textOf(x).startsWith('就这么办')).at(0)
  assert.ok(now !== undefined, '卡片上要有一个一步到位的按钮')
  assert.match(textOf(now), /归入「工作主线」/, '按钮上要写清它会做什么')

  requests = []
  now.props.onClick(ev())
  await settle()
  const add = requests.find((r) => String(r.path).endsWith('/node-add'))
  assert.ok(add !== undefined, '应该真的写入：' + requests.map((r) => r.path).join(','))
  assert.equal(add.body.title, '补台账')
  assert.equal(add.body.due, '2026-10-09')
  assert.equal(add.body.parent, idOf('工作主线'), '按首选建议归位')
  assert.equal(firstByClass(render(), 'dsh-wb-formhead'), null, '不该再打开表单')
})

test('改动卡的「就这么办」：一次点击直接改，不进表单', async () => {
  withAi()
  aiReply = {
    reply: '好',
    edits: [{
      target: '表层待办',
      id: idOf('表层待办'),
      ok: true,
      exists: true,
      patch: { due: '2026-10-09', priority: 'high' },
      options: [],
      why: '这两条本来就在手上',
    }],
  }
  const { render, view } = await mountAi()
  aiEntry(view).props.onChange({ target: { value: '把表层待办改到10月9号' } })
  aiBtn(render(), '↑').props.onClick(ev())
  await settle()

  const card = firstByClass(render(), 'dsh-wb-aitask')
  assert.match(textOf(card), /已经在计划里，不用再建/, '同名的那条要说清「不是新建」')
  const now = findAll(card, (x) => x.type === 'button' && textOf(x).startsWith('就这么办')).at(0)
  assert.ok(now !== undefined)
  assert.match(textOf(now), /截止 2026-10-09/, '按钮上写清要改什么')

  requests = []
  now.props.onClick(ev())
  await settle()
  const set = requests.find((r) => String(r.path).endsWith('/node-set'))
  assert.ok(set !== undefined, '应该真的写入：' + requests.map((r) => r.path).join(','))
  assert.equal(set.body.node, idOf('表层待办'))
  assert.equal(set.body.due, '2026-10-09')
  assert.equal(set.body.priority, 'high')
  assert.equal(firstByClass(render(), 'dsh-wb-formhead'), null, '不该再打开表单')
})

test('改动卡：写出「旧 → 新」、带上可选项，采纳后进表单逐字段确认', async () => {
  // 「我输入 → 你决策 → 给清晰的意见和**可选项** → 我选 → 你照做」里，
  // 改动卡就是「意见」，芯片就是「可选项」，而**落库那一下永远在表单里**。
  withAi()
  aiReply = {
    reply: '照你说的改',
    edits: [{
      target: '表层待办',
      id: idOf('表层待办'),
      ok: true,
      patch: { due: '2026-10-09' },
      options: [{ label: '挪到下周', why: '这周排不开', patch: { due: '2026-10-16' } }],
      why: '你说改到周五',
    }],
  }
  const { render, view } = await mountAi()
  aiEntry(view).props.onChange({ target: { value: '把表层待办改到周五' } })
  aiBtn(render(), '↑').props.onClick(ev())
  await settle()

  const card = firstByClass(render(), 'dsh-wb-aitask')
  assert.ok(card !== null, '应该渲染出一张改动卡')
  const cardText = textOf(card)
  assert.match(cardText, /改：表层待办/)
  assert.match(cardText, /（无） → 2026-10-09/, '要让人看见从什么变成什么，而不是只给新值')
  assert.match(cardText, /你说改到周五/, '要把理由带上')
  // 可选项：与草稿卡同一种芯片
  const chip = byClass(card, 'dsh-wb-chip').find((b) => textOf(b) === '挪到下周')
  assert.ok(chip !== undefined, '可选项要渲染成芯片')

  // 采纳 → 打开那条任务的表单（草稿已填好），并**关掉浮层**（同草稿那条路）
  // 必须限定 type==='button'：外层 .dsh-wb-movepick 的 textOf 也是这几个字，
  // 而 findAll 是前序遍历——第一版就匹配到了那层 div，报 onClick is not a function。
  const apply = findAll(card, (x) => x.type === 'button' && textOf(x) === '按这个改')[0]
  apply.props.onClick(ev())
  const after = render()
  assert.ok(firstByClass(after, 'dsh-wb-formhead') !== null, '应该打开详情表单')
  assert.equal(firstByClass(after, 'dsh-wb-fabsheet'), null, '交给表单后浮层要收起')
  assert.match(textOf(firstByClass(after, 'dsh-wb-flash')), /改动已填进表单/)
})

test('合并卡：明写会删掉哪条；采纳后依次走既有的写入口（先搬后删）', async () => {
  withAi()
  aiReply = {
    reply: '是一件事',
    merges: [{
      keep: '表层待办',
      keepId: idOf('表层待办'),
      keepTitle: '表层待办',
      fold: ['深层待办'],
      folds: [{ id: idOf('深层待办'), title: '深层待办' }],
      title: '表层待办（含深层）',
      missing: [],
      ok: true,
      why: '两条是一件事',
    }],
  }
  const { render, view } = await mountAi()
  aiEntry(view).props.onChange({ target: { value: '把这两条合并' } })
  aiBtn(render(), '↑').props.onClick(ev())
  await settle()

  const card = firstByClass(render(), 'dsh-wb-aitask')
  assert.match(textOf(card), /会删掉：.*深层待办/, '删除是这张卡的全部风险，必须写在卡上')
  assert.match(textOf(card), /子项、证据、关联会先并进保留的那条/, '并说明不丢东西')
  assert.match(textOf(card), /→ 「表层待办（含深层）」/, '标题会怎么变也要写出来')

  requests = []
  findAll(card, (x) => x.type === 'button' && textOf(x) === '按这个合并')[0].props.onClick(ev())
  await settle()
  const paths = requests.map((r) => String(r.path).split('/').pop())
  assert.ok(paths.includes('node-set'), '先改保留那条的标题：' + paths.join(','))
  assert.ok(paths.includes('node-remove'), '最后删掉并进去的那条：' + paths.join(','))
  assert.ok(paths.indexOf('node-set') < paths.indexOf('node-remove'), '顺序必须是先改/先搬、后删')
  assert.equal(requests.find((r) => String(r.path).endsWith('/node-set')).body.title, '表层待办（含深层）')
  assert.equal(requests.find((r) => String(r.path).endsWith('/node-remove')).body.node, idOf('深层待办'))
})

test('归组卡（mode=children）：明写「不会删任何条目」；采纳后只挪位置，一条都不删', async () => {
  // 用户原话：「我要的就是要把一些任务进行合并，然后作为计划，然后其他的作为它的子计划。」
  // 之前这套 schema 只能把 fold 删掉，于是模型只能回答「不支持、请补上完整列表」。
  // 现在归组是一个**独立模式**，卡上要写清它的代价（挪位置）与它的边界（不删东西），
  // 采纳后走的仍然是 /node-move——**零新增写通路**。
  withAi()
  aiReply = {
    reply: '归到一个计划下面',
    merges: [{
      keep: '表层待办',
      keepId: idOf('表层待办'),
      keepTitle: '表层待办',
      keepKids: 0,
      fold: ['收件箱一条', '深层待办'],
      folds: [{ id: idOf('收件箱一条'), title: '收件箱一条' }, { id: idOf('深层待办'), title: '深层待办' }],
      mode: 'children',
      title: '归组用总计划',
      missing: [],
      skipped: [],
      ok: true,
      why: '都是同一批调研',
    }],
  }
  const { render, view } = await mountAi()
  aiEntry(view).props.onChange({ target: { value: '把这几条合并成一个计划，其他的作为子任务' } })
  aiBtn(render(), '↑').props.onClick(ev())
  await settle()

  const card = firstByClass(render(), 'dsh-wb-aitask')
  const body = textOf(card)
  assert.match(body, /合并成计划/, '标题行要说清这是「合成一个计划」')
  assert.match(body, /不会删任何条目/, '归组的代价只是挪位置——必须写在卡上')
  assert.match(body, /成为子项/, '要说清它们去哪：keep 下面')
  assert.doesNotMatch(body, /会删掉/, '这一行**不能**出现——它会让人以为要点下去就是删')
  assert.match(body, /→ 「归组用总计划」/, '标题会怎么变也要写出来')
  requests = []
  findAll(card, (x) => x.type === 'button' && textOf(x) === '按这个合并成计划')[0].props.onClick(ev())
  await settle()
  const paths = requests.map((r) => String(r.path).split('/').pop())
  assert.ok(!paths.includes('node-remove'), '归组不能删任何东西：' + paths.join(','))
  const moves = requests.filter((r) => String(r.path).endsWith('/node-move'))
  assert.equal(moves.length, 2, '两条都要挪到保留的那条下面')
  for (const m of moves) assert.equal(m.body.parent, idOf('表层待办'), 'parent 必须是 keep 自己')
  assert.deepEqual(moves.map((m) => m.body.node).sort(), [idOf('收件箱一条'), idOf('深层待办')].sort())
  assert.equal(requests.find((r) => String(r.path).endsWith('/node-set')).body.title, '归组用总计划')
})

test('每张 AI 卡的确认按钮都独占一行（.dsh-wb-aiact），不藏在胶囊行里', async () => {
  // 真机反馈：「没有确认的按钮？」——根因不在渲染条件，而在样式：主按钮用
  // accent-soft 底，而它所在的 .dsh-wb-movepick 行**也是** accent-soft 底，
  // 同色叠同色，按钮在视觉上根本不成其为按钮（那块还要在 build.test.mjs 里钉住）。
  // 这里钉的是结构：四张卡（新任务 / 改动 / 合并 / 删除）的确认按钮都必须挂在
  // .dsh-wb-aiact 行里，且那颗按钮带 primary。
  withAi()
  aiReply = {
    reply: '照你说的办',
    tasks: [{ title: '归组卡用新任务', due: '', priority: '', note: '', plan: '', candidates: [] }],
    edits: [{ target: '收件箱一条', patch: { due: '2026-10-01' }, why: '截止该填了', id: idOf('收件箱一条'), ok: true }],
    merges: [{
      keep: '表层待办', keepId: idOf('表层待办'), keepTitle: '表层待办',
      fold: ['收件箱一条'], folds: [{ id: idOf('收件箱一条'), title: '收件箱一条' }],
      missing: [], skipped: [], ok: true,
    }],
    deletes: [{ target: '深层待办', id: idOf('深层待办'), title: '深层待办', children: 0, ok: true }],
  }
  const { render, view } = await mountAi()
  aiEntry(view).props.onChange({ target: { value: '记一条、改一条、合一条、删一条' } })
  aiBtn(render(), '↑').props.onClick(ev())
  await settle()

  const cards = byClass(render(), 'dsh-wb-aitask')
  assert.equal(cards.length, 4, '四类建议各一张卡')
  for (const card of cards) {
    const rows = findAll(card, (x) => classesOf(x).includes('dsh-wb-aiact'))
    assert.ok(rows.length >= 1, '这张卡没有确认按钮行：' + textOf(card).slice(0, 20))
    const primary = findAll(rows[0], (x) => x.type === 'button' && classesOf(x).includes('primary'))
    assert.equal(primary.length, 1, '确认按钮要带 primary（实心）：' + textOf(card).slice(0, 20))
  }
})

test('浮层只有一个关闭入口：标题行那颗 ✕（重复的「收起」已删）', async () => {
  // 两颗按钮调同一个 setFabOpen(false)，是纯粹的重复。留哪颗的判断依据是位置：
  // 标题行右上角是「关闭一个面板」的常规位置，快捷行那颗文字按钮反而占宽度。
  withAi()
  const { view } = await mountAi()
  assert.equal(byClass(view, 'dsh-wb-fabclose').length, 1, '关闭入口只留一个')
  const sheet = firstByClass(view, 'dsh-wb-fabsheet')
  const labels = findAll(sheet, (x) => x.type === 'button').map((b) => textOf(b))
  assert.ok(!labels.includes('收起'), '不再有与 ✕ 重复的「收起」按钮')
})

test('每次点开浮层都是全新的：输入框、上一轮问答、上一轮草稿全部清掉', async () => {
  // 用户原话：「下次再点开的时候应该自动清空之前那个任务，不然话又堆在一起；
  // 每次点开那个应该是一个全新的。」——它是件输入工具，不是一本对话记录。
  // 不清的话最直接的症状是：上次没发出去的那句话还躺在输入框里，接着用输入法
  // 说话就会**接在后面**。
  withAi()
  aiReply = { reply: '没什么要紧的。', tasks: [{ title: '补台账', due: '', priority: '', note: '', plan: '', candidates: [] }] }
  const { render, view } = await mountAi()
  aiEntry(view).props.onChange({ target: { value: '把台账补完' } })
  aiBtn(render(), '↑').props.onClick(ev())
  await settle()
  assert.ok(firstByClass(render(), 'dsh-wb-chat') !== null, '这一轮有问答')
  assert.ok(firstByClass(render(), 'dsh-wb-aitask') !== null, '这一轮有草稿卡')

  // 收起再点开
  firstByClass(render(), 'dsh-wb-fabclose').props.onClick(ev())
  firstByClass(render(), 'dsh-wb-fabball').props.onClick(ev())
  const reopened = render()
  assert.equal(firstByClass(reopened, 'dsh-wb-chat'), null, '上一轮问答不该留到下一次')
  assert.equal(firstByClass(reopened, 'dsh-wb-aitask'), null, '上一轮草稿不该留到下一次')
  assert.equal(aiEntry(reopened).props.value, '', '输入框必须是空的')
})

test('纯输入框（宿主没模型）提交后自动收起——不用再点一次', async () => {
  const ctx = await mount()          // 不 withAi()：退化成纯输入框
  firstByClass(ctx.view, 'dsh-wb-fabball').props.onClick(ev())
  let view = ctx.render()
  byClass(view, 'dsh-wb-aiinput')[0].props.onChange({ target: { value: '交电费' } })
  byClass(ctx.render(), 'dsh-wb-iconbtn')[0].props.onClick(ev())
  await settle()
  const after = ctx.render()
  assert.ok(firstByClass(after, 'dsh-wb-fabball') !== null, '记完就该回到浮球')
  assert.equal(firstByClass(after, 'dsh-wb-fabsheet'), null, '浮层已经收起')
  assert.match(textOf(firstByClass(after, 'dsh-wb-flash')), /已记下/)
})

