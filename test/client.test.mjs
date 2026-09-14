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
import { mkdtemp, rm } from 'node:fs/promises'
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

globalThis.fetch = async (path, init) => {
  const body = init !== undefined && init.body !== undefined ? JSON.parse(init.body) : {}
  requests.push({ path, body })
  // 所有写入接口都回同一份计划：面板拿到后整体替换，重渲时树保持一致。
  const payload = { ok: true, cwd: planDir, dir: join(planDir, 'plan'), plan: planPayload }
  return { ok: true, status: 200, json: async () => payload }
}

/** 等到「拉数据 → 落进 store」这条异步链走完。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

// ------------------------------------------------------------------ 挂载

let dir = ''

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
})

/**
 * 挂载面板并等首屏数据到位。每次都用新的 Cordis 上下文调一次 apply，
 * 于是 store 与交互态都是干净的（apply 内部才 createStore，复用会串场）。
 */
async function mount() {
  let tab = null
  wbModule.apply({
    get: (name) => (name === 'slots' ? {} : name === 'betterSidebar'
      ? { registerTab: (def) => { tab = def; return () => {} } }
      : undefined),
    // Cordis 的 effect 是**立即执行**回调（返回值当清理函数），注册 tab 就发生在
    // 某个 effect 里——写成空函数会让面板静默不注册，而报错却是「面板应注册成
    // 一个 tab」，看不出是替身的错。
    effect: (fn) => { fn() },
  })
  assert.ok(tab !== null, '面板应注册成一个 tab')

  const holder = tab.component({ scope: { sessionId: SESSION_ID } })
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
  return { render, view: render(), badge: () => tab.badge() }
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
  return head.children.find((c) => classesOf(c).includes('dsh-wb-caret'))
}

/**
 * 「＋ 新建顶层计划」展开后的那一行。它和收件箱输入框共用 `dsh-wb-add`，
 * 靠独有的「建计划」按钮区分——按 class 取第一个会拿到收件箱那个，
 * 于是测试往收件箱里打字，断言却指望它建计划。
 */
const rootAddRow = (root) => byClass(root, 'dsh-wb-add')
  .find((d) => d.children.some((c) => c.type === 'button' && textOf(c) === '建计划'))

const inputOf = (row) => row.children.find((c) => c.type === 'input')

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

/**
 * 宽容器下待办行/计划头是**固定列的 grid**（见 src/client/index.js 的 @container 块）。
 * 元素落在哪一列由 class 指定（CSS 里的常量），而**顺序**由渲染代码决定，两边必须
 * 一致——不一致的后果很难查：只声明了列、没声明行的元素会按 DOM 顺序参与自动排列，
 * 而自动排列的游标**只能往前走**。于是只要 DOM 顺序与列号顺序相反（例如把 pri 排
 * 在 evid 前面），后出现的那个就会被甩到**第二行**：列看着没错，行高从 24px 翻到 48px。
 * CSS 里用 grid-row:1 兜了底，但顺序本身也得钉住，否则将来改列号就会静默错位。
 * 这条断言跑的是**真构建产物里的真组件**，是唯一能挡住它的地方。
 */
test('待办行的元信息顺序与 grid 列号一致，且三个动作按钮各占一列', async () => {
  const keep = planPayload
  const tmp = await mkdtemp(join(tmpdir(), 'dsh-wb-grid-'))
  try {
    const call = hostCall(tmp)
    await call('plan_node_add', { title: '主线', type: 'plan' })
    // 一条「满徽章」的待办：委派 + 证据 + 重要程度 + 逾期日期，一次覆盖 4 个槽位。
    await call('plan_node_add', { title: '满徽章待办', type: 'todo', parent: '主线', due: '2000-01-01' })
    await call('plan_priority_set', { node: '满徽章待办', priority: 'high' })
    await call('plan_delegate_set', { node: '满徽章待办', to: '张三', expectAt: '2000-01-02' })
    await call('plan_todo_set', {
      todo: '满徽章待办', status: 'done', evidenceKind: 'file', evidenceRef: '交付物.md',
    })
    planPayload = (await call('plan_show')).plan

    const { view } = await mount()
    const row = byText(view, 'dsh-wb-task', '满徽章待办')
    assert.ok(row !== null, '找不到「满徽章待办」那一行')

    // 先钉住 fixture 真的带上了徽章：否则下面的顺序断言会退化成「什么都没验」。
    const present = row.children.map((c) => classesOf(c)[0])
    for (const cls of ['dsh-wb-deleg', 'dsh-wb-evid', 'dsh-wb-pri', 'dsh-wb-taskdue']) {
      assert.ok(present.includes(cls), 'fixture 没带上 ' + cls + '，断言会变空')
    }

    // 元信息的相对顺序必须与 CSS 的列号顺序（deleg 3 → warn 4 → behind 5 →
    // evid 6 → pri 7 → due 8）一致。unverif 与 evid 共用 evid 那一列。
    const SLOT = {
      'dsh-wb-deleg': 3, 'dsh-wb-warn': 4, 'dsh-wb-behind': 5,
      'dsh-wb-evid': 6, 'dsh-wb-unverif': 6, 'dsh-wb-pri': 7, 'dsh-wb-taskdue': 8,
    }
    const slots = present.filter((c) => SLOT[c] !== undefined).map((c) => SLOT[c])
    assert.deepEqual(slots, [...slots].sort((a, b) => a - b),
      '元信息的渲染顺序与 grid 列号顺序不一致（会被自动排列甩到第二行）')

    // 三个动作按钮靠修饰类各占一列；少一个就会错列、并与徽章重叠。
    const acts = row.children.filter((c) => classesOf(c).includes('dsh-wb-act'))
    assert.deepEqual(
      acts.map((a) => classesOf(a).filter((x) => x !== 'dsh-wb-act')),
      [['dsh-wb-act-move'], ['dsh-wb-act-plan'], ['dsh-wb-act-del']],
    )
  } finally {
    planPayload = keep
    await rm(tmp, { recursive: true, force: true })
  }
})

test('面板渲染出计划树、收件箱与新建入口（不白屏）', async () => {
  const { view } = await mount()
  const body = textOf(view)
  assert.match(body, /收件箱/)
  assert.match(body, /工作主线/)
  assert.match(body, /子计划/)
  assert.match(body, /深层待办/)
  assert.match(body, /收件箱一条/)
  assert.ok(firstByClass(view, 'dsh-wb-rootadd') !== null, '应有「＋ 新建顶层计划」入口')
})

test('tab 角标显示未完成数', async () => {
  const { badge } = await mount()
  assert.equal(badge(), 3, '三条待办都还没完成')
})

test('空工作区时也能建第一个计划（不被迫去开对话）', async () => {
  const keep = planPayload
  planPayload = { schema: 2, version: 1, title: '空', nodes: [] }
  try {
    const { render, view } = await mount()
    assert.match(textOf(firstByClass(view, 'dsh-wb-empty')), /还没有计划/)

    firstByClass(view, 'dsh-wb-rootadd').props.onClick(ev())
    inputOf(rootAddRow(render())).props.onChange({ target: { value: '新主线' } })

    requests = []
    inputOf(rootAddRow(render())).props.onKeyDown(ev({ key: 'Enter' }))
    assert.equal(requests.length, 1)
    assert.equal(requests[0].path, '/api/workbench/node-add')
    assert.equal(requests[0].body.title, '新主线')
    assert.equal(requests[0].body.type, 'plan')
    assert.equal('parent' in requests[0].body, false, '顶层计划不该带 parent')
  } finally {
    planPayload = keep
  }
})

// ============================================================ 折叠展开

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

test('单击标题延后切换：一次双击不会顺手把事办了', async () => {
  const { render, view } = await mount()
  requests = []

  // 一次真实的双击会先来两次 click、再来一次 dblclick。两个 click 一个都不能
  // 落地，否则改名会顺带切换完成状态（还多留一个版本快照）。
  byText(view, 'dsh-wb-tasktitle', '表层待办').props.onClick(ev())
  byText(render(), 'dsh-wb-tasktitle', '表层待办').props.onClick(ev())
  byText(render(), 'dsh-wb-tasktitle', '表层待办').props.onDoubleClick(ev())

  await new Promise((r) => setTimeout(r, 260))
  await flush()
  assert.equal(requests.length, 0, '双击不该切换完成状态')
  assert.ok(firstByClass(render(), 'dsh-wb-rename') !== null, '而是进入改名')
})

test('只单击（不双击）仍然会切换完成状态', async () => {
  const { render, view } = await mount()
  requests = []
  byText(view, 'dsh-wb-tasktitle', '表层待办').props.onClick(ev())
  await new Promise((r) => setTimeout(r, 260))
  await flush()
  assert.equal(requests.length, 1)
  assert.equal(requests[0].path, '/api/workbench/todo-set')
  assert.equal(requests[0].body.todo, idOf('表层待办'))
})
