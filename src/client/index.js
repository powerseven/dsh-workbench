/**
 * dsh-workbench —— 浏览器半身（CommonJS 形式，由 scripts/build.mjs 包装为
 * DSH client-modules C6 bundle；纯逻辑辅助在 logic.cjs 中先行内联）。
 *
 * 表面：dsh-better-sidebar 的侧边卡片 tab「工作计划」——计划 → 子计划 →
 * 待办三级树，带自动进度条与待办勾选，外加：
 *   · 收件箱（不挂计划的游离待办）+ 顶部快速记一条
 *   · 重要程度徽章（点击在高/中/低之间循环）
 *   · 委派标记（对象 · 回执状态 · 期望时间，逾期标红）
 *   · 筛选条（重要度高 / 我委派出去的 / 本周到期 / 逾期）
 *
 * 勾选与徽章点击都直接回写 plan.json，所以面板与 agent 改的是同一份数据；
 * 写入统一走 /api/workbench/*，落到 host 半身的同一套 store 逻辑（含版本归档）。
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
  // 筛选条
  '.dsh-wb-filters{display:flex;gap:4px;padding:6px 8px;flex-wrap:wrap;flex:none;border-bottom:1px solid rgba(127,127,127,.14);}',
  '.dsh-wb-chip{border:1px solid rgba(127,127,127,.3);background:transparent;color:inherit;border-radius:11px;padding:2px 8px;font-size:11px;cursor:pointer;line-height:1.6;white-space:nowrap;}',
  '.dsh-wb-chip:hover{background:rgba(127,127,127,.12);}',
  '.dsh-wb-chip.on{background:rgba(9,105,218,.12);border-color:rgba(9,105,218,.5);color:#0969da;font-weight:600;}',
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
  '.dsh-wb-taskdue.overdue{color:#d1242f;font-weight:600;}',
  // 重要程度徽章
  '.dsh-wb-pri{flex:none;font-size:10px;line-height:1.6;padding:0 5px;border-radius:8px;cursor:pointer;border:1px solid transparent;user-select:none;}',
  '.dsh-wb-pri.normal{color:rgba(127,127,127,.85);border-color:rgba(127,127,127,.3);}',
  '.dsh-wb-pri.high{color:#fff;background:#d1242f;font-weight:600;}',
  '.dsh-wb-pri.low{color:rgba(127,127,127,.6);}',
  '.dsh-wb-pri:hover{filter:brightness(.94);}',
  // 委派标记
  '.dsh-wb-deleg{flex:none;font-size:10px;padding:0 5px;border-radius:8px;background:rgba(130,80,223,.12);color:#8250df;white-space:nowrap;max-width:11em;overflow:hidden;text-overflow:ellipsis;}',
  '.dsh-wb-deleg.late{background:rgba(209,36,47,.14);color:#d1242f;font-weight:600;}',
  // 管控缺口
  '.dsh-wb-warn{flex:none;font-size:10px;color:#9a6700;cursor:help;}',
  // 收件箱
  '.dsh-wb-inbox{margin-bottom:14px;padding-bottom:10px;border-bottom:1px dashed rgba(127,127,127,.3);}',
  '.dsh-wb-inboxhead{display:flex;align-items:baseline;gap:6px;margin:2px 0 6px;}',
  '.dsh-wb-inboxtitle{font-weight:600;}',
  '.dsh-wb-count{font-size:10px;color:rgba(127,127,127,.85);}',
  '.dsh-wb-add{display:flex;gap:4px;margin:0 0 4px 10px;}',
  '.dsh-wb-add input{flex:1;min-width:0;font:inherit;font-size:12px;padding:3px 7px;border-radius:6px;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;}',
  '.dsh-wb-add input:focus{outline:none;border-color:rgba(9,105,218,.6);}',
  '.dsh-wb-add button{border:1px solid rgba(127,127,127,.3);background:transparent;color:inherit;border-radius:6px;cursor:pointer;font-size:12px;padding:2px 8px;}',
  '.dsh-wb-add button:disabled{opacity:.4;cursor:default;}',
  // 聚焦列表
  '.dsh-wb-focus{display:flex;align-items:flex-start;gap:6px;padding:5px 6px;border-radius:6px;margin-bottom:2px;}',
  '.dsh-wb-focus:hover{background:rgba(127,127,127,.1);}',
  '.dsh-wb-focus input{margin:2px 0 0;flex:none;cursor:pointer;}',
  '.dsh-wb-focus .dsh-wb-tasktitle{flex:1;}',
  '.dsh-wb-path{font-size:10px;color:rgba(127,127,127,.75);font-family:ui-monospace,monospace;flex:none;}',
  '.dsh-wb-empty{padding:24px 10px;text-align:center;color:rgba(127,127,127,.75);font-size:12px;line-height:1.8;}',
  '.dsh-wb-hint{padding:6px 10px 2px;color:rgba(127,127,127,.75);font-size:11px;line-height:1.7;}',
  '.dsh-wb-err{margin:8px 10px;padding:8px 10px;border-radius:8px;background:rgba(209,36,47,.1);color:#d1242f;font-size:12px;line-height:1.6;word-break:break-word;}',
  '.dsh-wb-footer{padding:5px 10px;border-top:1px solid rgba(127,127,127,.18);font-size:10px;color:rgba(127,127,127,.7);flex:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
  '.dsh-wb-flash{padding:4px 10px;font-size:11px;color:#2da44e;flex:none;}',
  '@media (prefers-color-scheme: dark){.dsh-wb-pct{color:#6cb0f5;}.dsh-wb-goalbar > div{background:#2f7be0;}.dsh-wb-krq{color:#6cb0f5;}.dsh-wb-chip.on{color:#6cb0f5;}.dsh-wb-deleg{color:#b18aff;}.dsh-wb-pri.normal{color:rgba(200,200,200,.8);}}',
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
  let state = { plan: null, cwd: '', dir: '', loading: false, error: null, flash: '', filter: 'all' }
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
    // 输入框用组件本地状态：不放进 store，否则每敲一个字都要重渲整棵计划树。
    const [draft, setDraft] = React.useState('')

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

    /** 勾选待办：面板与 agent 走同一条写入路径。 */
    const setTask = React.useCallback((task, status) => {
      api('task-set', { sessionId, task, status })
        .then((r) => store.set({ plan: r.plan, error: null }))
        .catch((e) => store.set({ error: e instanceof Error ? e.message : String(e) }))
    }, [sessionId])

    /** 点徽章切换重要程度。 */
    const setPriority = React.useCallback((node, priority) => {
      api('node-set', { sessionId, node, priority })
        .then((r) => store.set({ plan: r.plan, error: null }))
        .catch((e) => store.set({ error: e instanceof Error ? e.message : String(e) }))
    }, [sessionId])

    /** 收件箱快速记一条。 */
    const addTodo = React.useCallback((title) => {
      api('todo-add', { sessionId, title })
        .then((r) => { store.set({ plan: r.plan, error: null }); setDraft(''); flash('已记入收件箱') })
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
    const inbox = plan !== null && plan !== undefined && Array.isArray(plan.inbox) ? plan.inbox : []

    /** 重要程度徽章：点击在高 → 中 → 低之间循环。 */
    const priBadge = (node) => {
      const p = node.priority === 'high' || node.priority === 'low' ? node.priority : 'normal'
      return h('span', {
        className: 'dsh-wb-pri ' + p,
        title: '重要程度：' + priorityLabel(p) + '（点击切换）',
        onClick: (e) => { e.preventDefault(); e.stopPropagation(); setPriority(node.id, nextPriority(p)) },
      }, priorityLabel(p))
    }

    /** 委派标记。逾期未回执的标红。 */
    const delegChip = (node) => {
      const text = delegateText(node)
      if (text === null) return null
      const d = node.delegateState
      const lines = ['委派给 ' + String(d.to) + '：' + delegateLabel(d.status)]
      if (d.expectAt !== null && d.expectAt !== undefined) lines.push('期望完成：' + d.expectAt)
      if (d.at !== null && d.at !== undefined) lines.push('委派时间：' + String(d.at).slice(0, 10))
      if (d.overdueReceipt) lines.push('⚠ 已逾期未回执')
      else if (d.overdueWork) lines.push('⚠ 已逾期未完成')
      return h('span', { className: 'dsh-wb-deleg' + (d.overdueReceipt ? ' late' : ''), title: lines.join('\n') }, text)
    }

    /** 管控缺口提示（重要度为高但缺周期/负责人等）。 */
    const warnBadge = (node) => {
      const list = Array.isArray(node.warnings) ? node.warnings : []
      if (list.length === 0) return null
      return h('span', { className: 'dsh-wb-warn', title: list.join('\n') }, '⚠')
    }

    const dueSpan = (node) => {
      if (typeof node.due !== 'string' || node.due === '') return null
      return h('span', { className: 'dsh-wb-taskdue' + (node.overdue === true ? ' overdue' : '') }, node.due)
    }

    /** 一条待办（收件箱项或子计划下的任务）。 */
    const todoRow = (node, key) => {
      const done = node.status === 'done'
      return h('label', {
        className: 'dsh-wb-task',
        key,
        title: statusLabel(node.status) + (node.note ? '\n' + node.note : ''),
      },
        h('input', {
          type: 'checkbox',
          checked: done,
          onChange: () => setTask(node.id, toggleStatus(node.status)),
        }),
        h('span', { className: 'dsh-wb-tasktitle' + (done ? ' done' : node.status === 'dropped' ? ' dropped' : '') }, node.title),
        delegChip(node),
        warnBadge(node),
        priBadge(node),
        dueSpan(node),
      )
    }

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

    // 筛选条：只显示「有货」的筛选器，窄侧栏里不堆一排空按钮。
    const chips = [h('button', {
      key: 'all',
      className: 'dsh-wb-chip' + (state.filter === 'all' ? ' on' : ''),
      onClick: () => store.set({ filter: 'all' }),
    }, '全部')]
    for (const f of FILTERS) {
      if (f.id === 'all') continue
      const n = sum.filters[f.id] || 0
      if (n === 0) continue
      chips.push(h('button', {
        key: f.id,
        className: 'dsh-wb-chip' + (state.filter === f.id ? ' on' : ''),
        title: '只看：' + f.label,
        onClick: () => store.set({ filter: state.filter === f.id ? 'all' : f.id }),
      }, f.label + ' ' + n))
    }
    if (sum.hasPlan) rows.push(h('div', { className: 'dsh-wb-filters', key: 'filters' }, chips))

    if (state.flash !== '') rows.push(h('div', { className: 'dsh-wb-flash', key: 'flash' }, state.flash))
    if (state.error !== null && state.error !== undefined) {
      rows.push(h('div', { className: 'dsh-wb-err', key: 'err' }, state.error))
    }

    const body = []

    if (state.filter !== 'all') {
      // 聚焦列表：筛选结果通常跨层级，摊平并带上路径比树形更好读。
      const items = focusList(plan, state.filter, todayStr())
      const label = (FILTERS.find((f) => f.id === state.filter) || {}).label || ''
      if (items.length === 0) {
        body.push(h('div', { className: 'dsh-wb-empty', key: 'nofocus' },
          h('div', null, '「' + label + '」下没有未完成的事项。')))
      }
      for (const item of items) {
        const node = item.node
        const isLeaf = item.kind === 'task' || item.kind === 'inbox'
        body.push(h('div', { className: 'dsh-wb-focus', key: item.kind + ':' + node.id },
          isLeaf
            ? h('input', {
              type: 'checkbox',
              checked: node.status === 'done',
              onChange: () => setTask(node.id, toggleStatus(node.status)),
            })
            : null,
          h('span', { className: 'dsh-wb-tasktitle' }, node.title),
          h('span', { className: 'dsh-wb-path' }, item.path),
          delegChip(node),
          warnBadge(node),
          priBadge(node),
          isLeaf ? dueSpan(node) : (node.end ? h('span', { className: 'dsh-wb-taskdue' }, node.end) : null),
        ))
      }
      rows.push(h('div', { className: 'dsh-wb-body', key: 'body' }, body))
      if (state.cwd !== '') rows.push(h('div', { className: 'dsh-wb-footer', key: 'f', title: state.cwd }, state.cwd))
      return h('div', { className: 'dsh-wb-wrap' }, rows)
    }

    // 收件箱：先记下来，之后再归位。没有它，「收不进来」这条就一直成立。
    const inboxRows = []
    inboxRows.push(h('div', { className: 'dsh-wb-inboxhead', key: 'ih' },
      h('span', { className: 'dsh-wb-goalid' }, '📥'),
      h('span', { className: 'dsh-wb-inboxtitle' }, '收件箱'),
      h('span', { className: 'dsh-wb-count' }, inbox.length > 0
        ? inbox.length + ' 条' + (sum.inboxOpen > 0 ? '（未完成 ' + sum.inboxOpen + '）' : '')
        : '空'),
    ))
    inboxRows.push(h('div', { className: 'dsh-wb-add', key: 'add' },
      h('input', {
        type: 'text',
        placeholder: '记一条待办，回车入收件箱…',
        value: draft,
        onChange: (e) => setDraft(e.target.value),
        onKeyDown: (e) => {
          if (e.key === 'Enter') { e.preventDefault(); if (draft.trim() !== '') addTodo(draft.trim()) }
        },
      }),
      h('button', {
        onClick: () => { if (draft.trim() !== '') addTodo(draft.trim()) },
        disabled: draft.trim() === '',
        title: '记入收件箱',
      }, '记下'),
    ))
    for (const todo of sortTasks(inbox)) inboxRows.push(todoRow(todo, 'inbox:' + todo.id))
    body.push(h('div', { className: 'dsh-wb-inbox', key: 'inbox' }, inboxRows))

    if (!sum.hasPlan) {
      body.push(h('div', { className: 'dsh-wb-empty', key: 'empty' },
        h('div', null, '这个工作区还没有计划。'),
        h('div', null, '先用上面的输入框记两条待办，或在对话里对 agent 说：'),
        h('div', { style: { marginTop: '6px', color: 'rgba(127,127,127,.95)' } },
          '「帮我把这个季度的工作计划拆成计划和子计划」'),
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
        krNodes.push(h('div', { className: 'dsh-wb-kr', key: kr.id },
          h('div', { className: 'dsh-wb-krhead' },
            h('span', { className: 'dsh-wb-krid' }, kr.id),
            h('span', { className: 'dsh-wb-krtitle' }, kr.title),
            delegChip(kr),
            warnBadge(kr),
            priBadge(kr),
            q !== null ? h('span', { className: 'dsh-wb-krq' }, q) : null,
            h('span', { className: 'dsh-wb-krpct' }, pct(kr.progress)),
          ),
          tasks.map((task) => todoRow(task, task.id)),
        ))
      }

      body.push(h('div', { className: 'dsh-wb-goal', key: goal.id },
        h('div', { className: 'dsh-wb-goalhead' },
          h('span', { className: 'dsh-wb-goalid' }, goal.id),
          h('span', { className: 'dsh-wb-goaltitle' }, goal.title),
          delegChip(goal),
          warnBadge(goal),
          priBadge(goal),
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
