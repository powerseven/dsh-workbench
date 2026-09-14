/**
 * dsh-workbench —— 浏览器半身（CommonJS 形式，由 scripts/build.mjs 包装为
 * DSH client-modules C6 bundle；纯逻辑辅助在 logic.cjs 中先行内联）。
 *
 * 表面：dsh-better-sidebar 的侧边卡片 tab「工作计划」——目标 → 关键结果 →
 * 任务三级树，带自动进度条与任务勾选。勾选直接回写 plan.json，
 * 所以面板与 agent 改的是同一份数据。
 *
 * betterSidebar 是硬依赖（inject 中声明），Cordis 会等服务出现后再 apply，
 * 因此不做降级形态。数据面：/api/workbench/*。
 */

const React = require('react')

const h = React.createElement

const CSS = [
  '.dsh-wb-wrap{display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px;}',
  '.dsh-wb-header{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid rgba(127,127,127,.2);flex:none;}',
  '.dsh-wb-title{font-weight:600;font-size:13px;}',
  '.dsh-wb-headright{margin-left:auto;display:flex;align-items:center;gap:4px;}',
  '.dsh-wb-pct{font-size:12px;font-weight:600;color:#0969da;}',
  '.dsh-wb-icon{border:1px solid transparent;background:transparent;border-radius:7px;padding:2px 6px;font-size:12px;cursor:pointer;color:inherit;line-height:1.5;}',
  '.dsh-wb-icon:hover{background:rgba(127,127,127,.14);}',
  '.dsh-wb-icon:disabled{opacity:.45;cursor:default;}',
  '.dsh-wb-bar{height:4px;background:rgba(127,127,127,.18);flex:none;}',
  '.dsh-wb-bar-fill{height:100%;background:#2da44e;transition:width .25s ease;}',
  '.dsh-wb-body{flex:1;overflow-y:auto;padding:8px 10px 14px;}',
  '.dsh-wb-goal{margin-bottom:14px;}',
  '.dsh-wb-goalhead{display:flex;align-items:baseline;gap:6px;margin:2px 0 4px;}',
  '.dsh-wb-goalid{font-size:10px;color:rgba(127,127,127,.75);flex:none;font-family:ui-monospace,monospace;}',
  '.dsh-wb-goaltitle{font-weight:600;line-height:1.45;word-break:break-word;flex:1;}',
  '.dsh-wb-goalpct{font-size:11px;color:rgba(127,127,127,.9);flex:none;}',
  '.dsh-wb-goalmeta{display:flex;gap:6px;flex-wrap:wrap;font-size:11px;color:rgba(127,127,127,.85);margin:0 0 6px;}',
  '.dsh-wb-goalbar{height:3px;background:rgba(127,127,127,.15);border-radius:2px;margin-bottom:8px;overflow:hidden;}',
  '.dsh-wb-goalbar > div{height:100%;background:#0969da;}',
  '.dsh-wb-kr{margin:0 0 4px 10px;padding:5px 0 3px;border-left:2px solid rgba(127,127,127,.2);padding-left:9px;}',
  '.dsh-wb-krhead{display:flex;align-items:baseline;gap:6px;}',
  '.dsh-wb-krid{font-size:10px;color:rgba(127,127,127,.7);flex:none;font-family:ui-monospace,monospace;}',
  '.dsh-wb-krtitle{flex:1;line-height:1.45;word-break:break-word;}',
  '.dsh-wb-krpct{font-size:11px;color:rgba(127,127,127,.9);flex:none;}',
  '.dsh-wb-krq{font-size:11px;color:#0969da;flex:none;}',
  '.dsh-wb-task{display:flex;align-items:flex-start;gap:6px;padding:3px 4px;border-radius:6px;cursor:pointer;margin:1px 0 1px 10px;}',
  '.dsh-wb-task:hover{background:rgba(127,127,127,.1);}',
  '.dsh-wb-task input{margin:2px 0 0;flex:none;cursor:pointer;}',
  '.dsh-wb-tasktitle{flex:1;line-height:1.45;word-break:break-word;}',
  '.dsh-wb-tasktitle.done{text-decoration:line-through;opacity:.5;}',
  '.dsh-wb-tasktitle.dropped{text-decoration:line-through;opacity:.4;}',
  '.dsh-wb-taskdue{font-size:10px;color:rgba(127,127,127,.8);flex:none;white-space:nowrap;}',
  '.dsh-wb-taskdue.overdue{color:#d1242f;}',
  '.dsh-wb-empty{padding:24px 10px;text-align:center;color:rgba(127,127,127,.75);font-size:12px;line-height:1.8;}',
  '.dsh-wb-err{margin:8px 10px;padding:8px 10px;border-radius:8px;background:rgba(209,36,47,.1);color:#d1242f;font-size:12px;line-height:1.6;word-break:break-word;}',
  '.dsh-wb-footer{padding:5px 10px;border-top:1px solid rgba(127,127,127,.18);font-size:10px;color:rgba(127,127,127,.7);flex:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
  '.dsh-wb-flash{padding:4px 10px;font-size:11px;color:#2da44e;flex:none;}',
  '@media (prefers-color-scheme: dark){.dsh-wb-pct{color:#6cb0f5;}.dsh-wb-goalbar > div{background:#2f7be0;}.dsh-wb-krq{color:#6cb0f5;}}',
].join('')

function injectStyles(css) {
  const el = document.createElement('style')
  el.textContent = css
  document.head.appendChild(el)
  return () => { el.remove() }
}

/** 极简可订阅 store：只在 set 时替换整个 state 对象，getSnapshot 引用稳定。 */
function createStore() {
  let listeners = []
  let state = { plan: null, cwd: '', dir: '', loading: false, error: null, flash: '' }
  const get = () => state
  const set = (patch) => {
    state = Object.assign({}, state, patch)
    for (const fn of listeners.slice()) {
      try { fn() } catch (e) { console.error('[dsh-workbench] listener failed', e) }
    }
  }
  const subscribe = (fn) => {
    listeners.push(fn)
    return () => { listeners = listeners.filter((x) => x !== fn) }
  }
  return { get, set, subscribe }
}

function apply(ctx) {
  const slots = ctx.get('slots')
  if (slots === undefined) return
  const betterSidebar = ctx.get('betterSidebar')
  if (betterSidebar === undefined) return

  const store = createStore()
  ctx.effect(() => injectStyles(CSS))

  function useSnapshot() {
    return React.useSyncExternalStore(store.subscribe, store.get)
  }

  async function api(method, args) {
    const res = await fetch('/api/workbench/' + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args || {}),
    })
    let payload = null
    try { payload = await res.json() } catch (e) { /* 非 JSON 响应，落到下面的状态码分支 */ }
    if (!res.ok || payload === null || payload.ok === false) {
      const msg = payload !== null && payload.error ? payload.error : 'HTTP ' + res.status
      throw new Error(msg)
    }
    return payload
  }

  let flashTimer = null
  function flash(text) {
    store.set({ flash: text })
    if (flashTimer !== null) clearTimeout(flashTimer)
    flashTimer = setTimeout(() => { store.set({ flash: '' }) }, 1800)
  }

  function WorkbenchPanel(props) {
    const state = useSnapshot()
    const sessionId = props.sessionId

    const refresh = React.useCallback(() => {
      if (sessionId === undefined || sessionId === null || sessionId === '') {
        store.set({ error: '拿不到当前会话 id，无法定位工作区', loading: false })
        return
      }
      store.set({ loading: true })
      api('get', { sessionId })
        .then((r) => store.set({ plan: r.plan, cwd: r.cwd, dir: r.dir, error: null, loading: false }))
        .catch((e) => store.set({ error: e instanceof Error ? e.message : String(e), loading: false }))
    }, [sessionId])

    // 首次挂载与切换会话时拉取；可见性恢复时也刷新一次（agent 可能刚改过计划）。
    React.useEffect(() => { refresh() }, [refresh])

    const setTask = React.useCallback((task, status) => {
      api('task-set', { sessionId, task, status })
        .then((r) => store.set({ plan: r.plan, error: null }))
        .catch((e) => store.set({ error: e instanceof Error ? e.message : String(e) }))
    }, [sessionId])

    const snapshot = React.useCallback(() => {
      api('snapshot', { sessionId, reason: 'panel' })
        .then(() => flash('已留档一个版本'))
        .catch((e) => store.set({ error: e instanceof Error ? e.message : String(e) }))
    }, [sessionId])

    const plan = state.plan
    const sum = summarize(plan)
    const goals = plan !== null && plan !== undefined && Array.isArray(plan.goals) ? plan.goals : []

    const rows = []
    rows.push(h('div', { className: 'dsh-wb-header', key: 'h' },
      h('span', { className: 'dsh-wb-title' }, '工作计划'),
      h('div', { className: 'dsh-wb-headright' },
        h('span', { className: 'dsh-wb-pct' }, pct(sum.progress)),
        h('button', { className: 'dsh-wb-icon', title: '留档一个版本', onClick: snapshot, disabled: !sum.hasPlan }, '⤓'),
        h('button', { className: 'dsh-wb-icon', title: '刷新', onClick: refresh, disabled: state.loading }, '⟳'),
      ),
    ))
    rows.push(h('div', { className: 'dsh-wb-bar', key: 'bar' },
      h('div', { className: 'dsh-wb-bar-fill', style: { width: barWidth(sum.progress) } }),
    ))
    if (state.flash !== '') rows.push(h('div', { className: 'dsh-wb-flash', key: 'flash' }, state.flash))
    if (state.error !== null && state.error !== undefined) {
      rows.push(h('div', { className: 'dsh-wb-err', key: 'err' }, state.error))
    }

    const body = []
    if (goals.length === 0) {
      body.push(h('div', { className: 'dsh-wb-empty', key: 'empty' },
        h('div', null, '这个工作区还没有计划。'),
        h('div', null, '在对话里对 agent 说：'),
        h('div', { style: { marginTop: '6px', color: 'rgba(127,127,127,.95)' } },
          '「帮我把这个季度的工作计划拆成目标和关键结果」'),
        h('div', { style: { marginTop: '8px', fontSize: '11px' } }, '计划会落在 ' + (state.dir || '<工作区>/plan')),
      ))
    }

    for (const goal of goals) {
      const krs = Array.isArray(goal.krs) ? goal.krs : []
      const meta = []
      if (goal.owner) meta.push('负责人 ' + goal.owner)
      if (goal.start || goal.end) meta.push((goal.start || '?') + ' ~ ' + (goal.end || '?'))
      if (goal.status && goal.status !== 'active') meta.push(goal.status)

      const krNodes = []
      for (const kr of krs) {
        const tasks = sortTasks(kr.tasks)
        const q = typeof kr.target === 'number' && kr.target > 0
          ? (kr.current || 0) + '/' + kr.target + (kr.unit ? ' ' + kr.unit : '')
          : null
        const taskNodes = tasks.map((task) => {
          const done = task.status === 'done'
          const overdue = !done && task.status !== 'dropped' && typeof task.due === 'string' && task.due !== '' && task.due < todayStr()
          return h('label', { className: 'dsh-wb-task', key: task.id, title: statusLabel(task.status) + (task.note ? '\n' + task.note : '') },
            h('input', {
              type: 'checkbox',
              checked: done,
              onChange: () => setTask(task.id, toggleStatus(task.status)),
            }),
            h('span', { className: 'dsh-wb-tasktitle' + (done ? ' done' : task.status === 'dropped' ? ' dropped' : '') }, task.title),
            task.due ? h('span', { className: 'dsh-wb-taskdue' + (overdue ? ' overdue' : '') }, task.due) : null,
          )
        })
        krNodes.push(h('div', { className: 'dsh-wb-kr', key: kr.id },
          h('div', { className: 'dsh-wb-krhead' },
            h('span', { className: 'dsh-wb-krid' }, kr.id),
            h('span', { className: 'dsh-wb-krtitle' }, kr.title),
            q !== null ? h('span', { className: 'dsh-wb-krq' }, q) : null,
            h('span', { className: 'dsh-wb-krpct' }, pct(kr.progress)),
          ),
          taskNodes.length > 0 ? taskNodes : null,
        ))
      }

      body.push(h('div', { className: 'dsh-wb-goal', key: goal.id },
        h('div', { className: 'dsh-wb-goalhead' },
          h('span', { className: 'dsh-wb-goalid' }, goal.id),
          h('span', { className: 'dsh-wb-goaltitle' }, goal.title),
          h('span', { className: 'dsh-wb-goalpct' }, pct(goal.progress)),
        ),
        meta.length > 0 ? h('div', { className: 'dsh-wb-goalmeta' }, meta.map((m, i) => h('span', { key: i }, m))) : null,
        h('div', { className: 'dsh-wb-goalbar' }, h('div', { style: { width: barWidth(goal.progress) } })),
        krNodes.length > 0 ? krNodes : null,
      ))
    }

    rows.push(h('div', { className: 'dsh-wb-body', key: 'body' }, body))
    if (state.cwd !== '') rows.push(h('div', { className: 'dsh-wb-footer', key: 'f', title: state.cwd }, state.cwd))

    return h('div', { className: 'dsh-wb-wrap' }, rows)
  }

  function todayStr() {
    const d = new Date()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return d.getFullYear() + '-' + m + '-' + day
  }

  ctx.effect(() => betterSidebar.registerTab({
    id: 'dsh-workbench:plan',
    title: '工作计划',
    icon: (size) => h('span', { style: { fontSize: size, lineHeight: '1' } }, '🎯'),
    order: 40,
    single: true,
    badge: () => {
      const st = store.get()
      const sum = summarize(st.plan)
      return sum.open > 0 ? sum.open : null
    },
    component: (tabProps) => {
      const scope = tabProps === null || tabProps === undefined ? undefined : tabProps.scope
      const sessionId = scope === null || scope === undefined ? undefined : scope.sessionId
      return h(WorkbenchPanel, { sessionId, visible: tabProps === undefined ? undefined : tabProps.visible })
    },
  }), 'dsh-workbench: side-card tab')
}

// 客户端模块必须无条件导出，并声明 name / inject：
//   - 无条件：本文件被内联进 C6 bundle 工厂，工厂的返回值就是这个 module.exports。
//     若写成 `typeof window === 'undefined'` 守卫，浏览器里条件为假，
//     apply 永远不会被导出，面板会静默不注册（logic.cjs 那种守卫只适用于
//     纯逻辑文件——它的函数由同闭包的 UI 代码直接引用，不依赖导出）。
//   - inject：Cordis 会等这些服务就绪后再调 apply，避免 betterSidebar 尚未
//     挂载时 ctx.get 拿到 undefined 而静默跳过注册。
module.exports = { name: 'dsh-workbench-client', inject: ['slots', 'betterSidebar'], apply: apply }
