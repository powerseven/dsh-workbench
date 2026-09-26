/**
 * dsh-workbench —— 浏览器半身（CommonJS 形式，由 scripts/build.mjs 包装为
 * DSH client-modules C6 bundle；纯逻辑辅助在 logic.cjs 中先行内联）。
 *
 * 表面：dsh-better-sidebar 的侧边卡片 tab「工作计划」——一棵**递归计划树**
 * （计划 → 子计划 → … 深度不限，叶子是待办），带自动进度条与待办勾选，外加：
 *   · 收件箱（不挂在任何计划下的顶层待办）+ 顶部快速记一条
 *   · 归位：把收件箱里的待办移进任意计划下（↳ 按钮）
 *   · 计划下直接加子项（待办或子计划），节点可删除
 *   · 换型：待办 ⇧ 提升为计划继续拆，空计划 ⇩ 降回待办
 *   · 重要程度徽章（点击在高/中/低之间循环）
 *   · 委派标记（对象 · 回执状态 · 期望时间，逾期标红）
 *   · 落后标记（进度没跟上周期的节点，徽章显示差多少个百分点）
 *   · 完成证据标记（⎘n 已附证据 / ⊘ 已完成但无证据，等人核验）
 *   · 筛选条（重要度高 / 我委派出去的 / 未来 7 天（按天分组）/ 逾期 / 落后 / 无证据的完成项）
 *   · 就地编辑：双击改名、拖拽排序与归位、折叠展开（层级深了要能收）
 *
 * 勾选、徽章、归位、删除、改名、排序都直接回写 plan.json，所以面板与 agent
 * 改的是同一份数据；写入统一走 /api/workbench/*，落到 host 半身的同一套
 * store 逻辑（含版本归档）——面板不自己算完成度，也不自己写盘。
 *
 * **就地编辑没有为它新增任何工具或路由**：改名走 /node-set 的 title，
 * 排序走 /node-move 的 index，都是既有入口。折叠状态是本机显示偏好，
 * 只进 localStorage，不进 plan.json（它不属于计划数据，也不该被版本留档）。
 *
 * betterSidebar 是硬依赖（inject 中声明），Cordis 会等服务出现后再 apply，
 * 因此不做降级形态。数据面：/api/workbench/*。
 */

const React = require('react')

const h = React.createElement

// ── 内联 SVG 图标（与宿主同一套线描风格：24×24、stroke=currentColor、圆头圆角）──
// 为什么不用文字字形（emoji / Unicode 符号）：字重、光学中心、笔画粗细都跟真图标
// 不是一路的，混在宿主界面里一眼就不像亲生的。内联 SVG 零依赖，颜色走 currentColor，
// 于是明暗两态与宿主换肤都自动跟随。
const ICONS = {
  plus: 'M12 5v14M5 12h14',
  send: 'M12 19V5M5 12l7-7 7 7',
  mic: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3ZM19 10v2a7 7 0 0 1-14 0v-2M12 19v3',
  stop: 'M7 7h10v10H7z',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z',
  refresh: 'M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6',
  collapse: 'M6 15l6-6 6 6',
  expand: 'M6 9l6 6 6-6',
  star: 'M12 3l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8 6.2 20.9l1.1-6.5L2.6 9.8l6.5-.9L12 3z',
  link: 'M21.4 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48',
  edit: 'M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z',
  move: 'M15 10l5 5-5 5M4 4v7a4 4 0 0 0 4 4h12',
  close: 'M18 6L6 18M6 6l12 12',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  warn: 'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
  folder: 'M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2z',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  bulb: 'M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z',
  target: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  check: 'M20 6L9 17l-5-5',
  trash: 'M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15',
}
const icon = (name, size) => h('svg', {
  className: 'dsh-wb-svg',
  width: size === undefined ? 16 : size,
  height: size === undefined ? 16 : size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': 'true',
}, h('path', { d: ICONS[name] }))

/**
 * 官方右侧栏的引导页胶囊要的是**组件类型**（`ComponentType<IconProps>`），
 * 不是 icon() 返回的元素，所以这里包一个。
 *
 * IconProps 的 size 是可选数字；宿主不传时退回 16（与页脚入口同档）。
 */
const TargetIcon = (props) => {
  const size = props !== null && props !== undefined && props.size !== undefined ? props.size : 16
  return icon('target', size)
}

// 官方右侧栏的 tab 身份。**id 与 kind 分开**是官方契约要求的：
//   · id   —— 这个实现在 tab 系统里的身份，全局唯一，也是正文 slot 的 key；
//   · kind —— 类型判别符，openTab 用它按名字打开。
// 两者都取 'dsh-workbench'：本插件只注册一个类型，没有「extension 接管 builtin」
// 那种 id 与 kind 需要分家的场景。
const TAB_ID = 'dsh-workbench'
const TAB_KIND = 'dsh-workbench'

/**
 * 建议向导里那一行「分类」的中文名。
 *
 * 为什么要标出来：用户看到「改动已有」就该知道这条动的是**已有数据**，
 * 而「新任务」是新建——两类建议的风险完全不同（改错了比建错了难受得多），
 * 所以类别必须在标题行里看得见，不能只靠卡片长什么样去猜。
 */
const KIND_LABEL = { task: '新任务', edit: '改动已有', merge: '合并', delete: '删除' }

/**
 * 「现在是不是手机档」——给**结构**用的判断（要不要渲染浮球、输入条挂哪儿）。
 *
 * 为什么需要 JS 判断而不只靠 CSS：浮球与底部输入条是**两个不同的渲染结构**，
 * 不是一个元素的两种样式——CSS 藏不掉「浮球点了会 setFabOpen」这件事，留着它
 * 就会和常驻输入条抢同一个输入状态。
 *
 * 判定与 dsh-web-mobile 的 MOBILE_QUERY 保持同一个口径（宽度 < 1024 且触摸优先），
 * 这样两边的「手机档」永远指同一批设备，不会出现它当你是手机、我不当的错位。
 * matchMedia 不可用时（测试替身/老环境）按**桌面**处理：桌面是浮球形态，
 * 而测试断言的正是那个形态。
 */
const MOBILE_QUERY = '(max-width: 1023px) and (pointer: coarse)'

function useIsMobile() {
  const [mobile, setMobile] = React.useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    try { return window.matchMedia(MOBILE_QUERY).matches === true } catch (e) { return false }
  })
  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
    let mq
    try { mq = window.matchMedia(MOBILE_QUERY) } catch (e) { return undefined }
    if (mq === undefined || mq === null) return undefined
    const onChange = () => setMobile(mq.matches === true)
    onChange()
    // 老 Safari 只有 addListener；两个都试一下，都没有就算了（下次渲染仍会重算）。
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    }
    if (typeof mq.addListener === 'function') {
      mq.addListener(onChange)
      return () => mq.removeListener(onChange)
    }
    return undefined
  }, [])
  return mobile
}


const CSS = [
  // ── 别名层 ──────────────────────────────────────────────────────────────
  // 只做一件事：把宿主的设计 token 映射成面板自用的短名。面板**不自己定义任何
  // 颜色**——宿主的明暗两态是靠重映射 --dsw-alias-* 完成的
  // （body[data-ds-dark-theme]{…}），所以这里映射一次，面板就自动跟随
  // 「用户在设置里选的主题」。此前用 @media (prefers-color-scheme: dark) 打补丁
  // 是错的：那跟的是系统偏好，在「系统深色 + 用户选浅色」时会渲染出深色块。
  //
  // 声明在 .dsh-wb-wrap 而不是 :root：var() 是在「声明它的那个元素」上就完成
  // 替换的，写在 :root(html) 会按 html 的浅色算死，body 换成暗色也传不下来——
  // 那正是「换了主题面板不跟着变」的成因。落在自己的根上才随上下文一起翻转，
  // 顺带不污染全局命名空间。
  // 别名层同时声明在「面板根」和「浮球根」上：浮球虽然渲染在面板树里，但它是
  // position:fixed 的独立根，自己带一份别名层最稳（与坑 #18 同源：var() 在声明它的
  // 那个元素上就完成替换）。
  // 别名层要覆盖每一处面板自己渲染的根：面板本身、浮球、以及侧栏页脚入口
  // （页脚入口在宿主的侧栏页脚里，不在 .dsh-wb-wrap 子树内）。
  '.dsh-wb-wrap,.dsh-wb-fab,.dsh-wb-entry{'
  + '--wb-fg:var(--dsw-alias-label-primary);'
  + '--wb-fg-2:var(--dsw-alias-label-secondary);'
  // 只用两级文字。面板字号全在 11–13px，宿主更浅的两级灰（tertiary 3.7:1、
  // caption 2.5:1）在这个尺寸下达不到 AA 的 4.5:1，所以层级改由字重、描边和
  // 留白表达——「不要只靠颜色拉开层级」。
  + '--wb-line:var(--dsw-alias-border-l3);'
  + '--wb-line-2:var(--dsw-alias-border-l4);'
  + '--wb-hover:var(--dsw-alias-interactive-bg-hover);'
  + '--wb-active:var(--dsw-alias-interactive-bg-active);'
  // 强调色只有一个来源：宿主的链接色。进度、选中、焦点环、复选框全用它，
  // 于是「蓝」在面板里恒等于「可交互 / 正在进行」，不再有第二、第三种含义。
  + '--wb-accent:var(--dsw-alias-link);'
  + '--wb-accent-soft:var(--dsw-alias-state-business-tertiary);'
  // **主按钮那一对**。原来确认按钮用 accent-soft 底，而它所在的行也是 accent-soft 底
  // （.dsh-wb-movepick）——同色叠同色，按钮在视觉上根本不成其为按钮，真机反馈
  // 「没有确认的按钮？」就是这条。现在直接抄**宿主自己的主按钮配方**
  // （button-primary-fill + label-primary-foreground，是宿主聊天/工具栏同款搭配），
  // 对比度由宿主保证，既不自己造色也不会在换肤后失配。
  + '--wb-btn-fill:var(--dsw-alias-button-primary-fill);'
  + '--wb-btn-fg:var(--dsw-alias-label-primary-foreground);'
  + '--wb-btn-hover:var(--dsw-alias-button-primary-hover);'
  // 浮层/浮球的底：宿主的「浮层与气泡」底。面板自身不用它（面板跟着宿主栏背景），
  // 但悬浮在内容之上的东西必须自己有不透明的底，否则底下的字会透上来。
  + '--wb-bg:var(--dsw-alias-bg-overlay);'
  // 语义色里只有 danger 在白底够 4.5:1，可以直接上文字；warn 只有 2.8:1、
  // success 只有 2.3:1，所以它俩只做软底，文字一律走中性。
  + '--wb-danger:var(--dsw-alias-state-error-primary);'
  + '--wb-danger-soft:var(--dsw-alias-interactive-bg-hover-danger);'
  + '--wb-warn-soft:var(--dsw-alias-state-warn-tertiary);'
  // 间距与圆角取宿主侧栏组件的既有标尺（间距 2/4/6/8/12，圆角 4/6/8/999）。
  // 命名出来是为了让「不许写随手值」这条能被一眼检查。
  + '--wb-sp-1:2px;--wb-sp-2:4px;--wb-sp-3:6px;--wb-sp-4:8px;--wb-sp-5:12px;'
  + '--wb-r-1:4px;--wb-r-2:6px;--wb-r-3:8px;--wb-pill:999px;'
  // 字号别名：面板只用到宿主的 11/12/13 三档，而宿主手机档的正文是 14/16——
  // 于是面板在手机上恒定「小一号」（真机反馈：装了 zen 的手机适配插件后更明显，
  // 因为 zen 只改宿主自己的类名，碰不到第三方插件的类）。抬一档放在别名层做，
  // 值仍然全部取自宿主阶梯（不写自定 px）。
  + '--wb-f1:var(--dsw-font-xs-13);--wb-f1s:var(--dsw-font-xs-strong-13);'
  + '--wb-f2:var(--dsw-font-xxs-12);--wb-f2s:var(--dsw-font-xxs-strong-12);'
  + '--wb-f3:var(--dsw-font-xxxs-11);--wb-f3s:var(--dsw-font-xxxs-strong-11);'
  // 侧栏页脚那一行的字号。它**不是**面板正文的一档：页脚入口跟它左右邻居
  // （宿主的「设置」、dsh-context 的「Context Insights」）并排站着，尺寸必须取
  // 同一把尺——宿主页脚按钮的标尺是 14/22，比面板正文大一档（见坑 #31）。
  + '--wb-f-footer:var(--dsw-font-s-14);'
  + '--wb-dur:var(--ds-transition-duration);--wb-ease:var(--ds-ease-in-out);'
  + 'font:var(--wb-f1);color:var(--wb-fg);}',
  // 面板自身的布局单独一条。浮球不要这些：它是 fixed 定位的独立根，
  // 套上 height:100% 会把整个浮层铺满，还会挡掉下面的点击。
  '.dsh-wb-wrap{display:flex;flex-direction:column;height:100%;min-height:0;}',
  // ── 浮球：AI 的唯一入口（面板树里的一部分，打开「工作计划」时才存在）──────
  // 固定在底部居中并让出安全区。**所有设备都渲染**——它不再只是手机形态：
  // 面板顶部那行 AI 输入已经撤掉，桌面端也靠它进。
  // 抬到 24px 而不是 12px：真机反馈「位置要高一点」——原来那颗球紧贴屏底，
  // 压住了面板自己的路径行、也贴着手机的返回手势条，手指够着不舒服。
  // 浮层（.dsh-wb-fabsheet）的定位基准就是这个盒子，所以它跟着一起抬高。
  '.dsh-wb-fab{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(24px + env(safe-area-inset-bottom,0px));display:flex;flex-direction:column;align-items:center;gap:var(--wb-sp-2);pointer-events:auto;z-index:2147483000;}',
  // 球里的图标必须**真的居中**：`.dsh-wb-svg` 是 display:block，而 button 默认只对
  // 行内内容做 text-align 居中——块级子元素会贴着内容盒左边排。真机上量出来图标
  // 比圆心偏左约 9px（上下也偏），就是这条来的。flex 两端居中最稳。
  '.dsh-wb-fabball{width:48px;height:48px;display:flex;align-items:center;justify-content:center;border:1px solid var(--wb-line-2);background:var(--wb-bg);color:var(--wb-fg);border-radius:var(--wb-pill);corner-shape:round;cursor:pointer;font:var(--wb-f1s);}',
  // 输入浮层：用 fixed 而不是跟着浮球走，方便按键盘高度整体上移（visualViewport）。
  // 它现在装的是一整块 AI 内容（输入行 + 问答 + 草稿卡 + 清单卡），所以自己滚，
  // 而不是把浮层撑出屏幕——手机上它已经占满整个视口宽度了（390px）。
  '.dsh-wb-fabsheet{position:fixed;left:50%;transform:translateX(-50%);width:min(520px,calc(100vw - var(--wb-sp-5) * 2));max-height:min(72vh,560px);overflow-y:auto;overscroll-behavior:contain;background:var(--wb-bg);border:1px solid var(--wb-line-2);border-radius:var(--wb-r-3);padding:var(--wb-sp-4);display:flex;flex-direction:column;gap:var(--wb-sp-3);pointer-events:auto;z-index:2147483001;}',
  '.dsh-wb-fabsheet .dsh-wb-fabrow{display:flex;align-items:center;gap:var(--wb-sp-2);}',
  // 浮层那颗 ✕ 是**唯一**的关闭入口（快捷行里重复的那颗「收起」已删），所以点击区
  // 按宿主图标按钮的标尺给足 28×28；图标是 display:block 的 svg，靠对称内边距居中。
  '.dsh-wb-fabrow .dsh-wb-fabclose{padding:var(--wb-sp-3);}',
  '.dsh-wb-fabhead{font:var(--wb-f2s);flex:1;min-width:0;}',
  // 侧栏页脚入口：一个「工作计划」按钮。它同时是**手机端主屏的一颗 chip**——
  // 手机外壳插件 dsh-zen-remote 会扫描 [data-slot="sidebar.footer.action"] 的
  // 每个直接子节点，把第三方插件的入口自动收成主屏 chip（它的 scanHarvest）。
  // 所以这个按钮必须是一个 <button> 根节点、并且**带着可见文字**（chip 的名字
  // 取自 textContent）与一个 <svg>（chip 的图标从它克隆）。
  //
  // 尺寸是**照抄邻居量出来的**，不是配出来的（见坑 #31）：它跟宿主的「设置」、
  // dsh-context 的「Context Insights」同处一个 footerActions 列里，三个的
  // 盒模型必须一致，否则一眼就看出「这不是亲生的」。实测宿主设置按钮与
  // .lc-ov-entry 的值完全相同：高 42、内边距 0 10px 0 8px、圆角 12、
  // 间距 8、字号 14/22；.lc-ov-entry 另加 width:calc(100% + 4px) + margin:0 -2px
  // 去抹掉 footerActions 的左右缩进，我们也照做。
  // 注意**不写 corner-shape:round**：宿主对 * 施加的 superellipse(1.5) 是页脚
  // 这一堆按钮的共同底子，页脚里没有谁把它配回 round（面板内部的胶囊才要配回，
  // 那是坑 #19 的范围）。
  '.dsh-wb-entry{box-sizing:border-box;width:calc(100% + 4px);height:42px;margin:0 -2px;padding:0 10px 0 8px;display:flex;align-items:center;gap:8px;border:0;background:transparent;color:var(--wb-fg);cursor:pointer;border-radius:12px;font:var(--wb-f-footer);text-align:left;overflow:hidden;transition:background var(--wb-dur) var(--wb-ease);}',
  '.dsh-wb-entry:hover{background:var(--wb-hover);}',
  '.dsh-wb-entry>svg{flex:none;}',
  // 标签**不抢剩余空间**（`flex:0 1 auto`，不是 `auto`）：抢了的话后面的计数会被推到
  // 按钮最右边，跟邻居的图标贴在一起，看上去像是别人的角标。让标签按内容宽、计数
  // 紧跟其后（间距就是按钮自己的 gap:8px），读起来是「工作计划 5」。
  // 仍然留 min-width:0 + 省略号：标签将来变长时是收窄，不是把计数挤出去。
  '.dsh-wb-entry .dsh-wb-entrylabel{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
  // 计数**必须走伪元素**，不能是个真的 <span>：zen 的 `harvestName()` 取的是
  // `el.textContent`，伪元素的内容不进 textContent，而真实节点的文字会进——
  // 那会让手机主屏那颗 chip 的名字从「工作计划」变成「工作计划5」，而且 chip 的
  // 开关偏好是按名字（`harvest:${name}`）存的，数字一变偏好就丢。这不是洁癖：
  // 面板一打开、store 拉到数据，计数就有了，chip 的名字会当场变。
  '.dsh-wb-entry::after{content:attr(data-count);flex:none;font:var(--wb-f3);font-variant-numeric:tabular-nums;color:var(--wb-fg-2);}',
  '.dsh-wb-entry:not([data-count])::after{content:none;}',
  // AI 内容块搬进浮层后要交出「面板里那条横幅」的样式：上下留白与外框归浮层，
  // 否则同一块内容会套上两层边框、两圈 padding。
  '.dsh-wb-fabsheet .dsh-wb-aiwrap{padding:0;border-bottom:none;}',
  // 面板内统一按 border-box 算盒模型。缺了这条时，`width:100%` 且带 padding/border
  // 的输入框（.dsh-wb-inp / .dsh-wb-atextarea）会**实打实多出** 12px padding + 2px
  // 边框：详情页里每个字段都被撑出 14px，输入框还会越过面板右边界。宿主没有全局
  // reset（实测 body 的 box-sizing 就是 content-box），所以这一层必须自己声明。
  '.dsh-wb-wrap,.dsh-wb-wrap *,.dsh-wb-wrap *::before,.dsh-wb-wrap *::after,'
  + '.dsh-wb-fab,.dsh-wb-fab *{box-sizing:border-box;}',
  // 焦点环。此前全表没有一条 :focus-visible，键盘用户完全看不出停在哪。
  // outline 不参与布局，所以出现时行不会跳。
  '.dsh-wb-wrap :focus-visible{outline:2px solid var(--wb-accent);outline-offset:1px;}',
  // 宿主对 * 施加了 corner-shape:superellipse(1.5)（方角更耐看），但把胶囊压得
  // 走形，所以整圆形状要按宿主约定显式配回 round。
  '.dsh-wb-chip,.dsh-wb-rootdrop{corner-shape:round;}',
  // ── 表头 ────────────────────────────────────────────────────────────────
  '.dsh-wb-header{display:flex;align-items:center;gap:var(--wb-sp-4);padding:var(--wb-sp-4) var(--wb-sp-5);border-bottom:1px solid var(--wb-line);flex:none;}',
  '.dsh-wb-title{font:var(--wb-f1s);}',
  '.dsh-wb-headright{margin-left:auto;display:flex;align-items:center;gap:var(--wb-sp-1);}',
  // 总进度是最重要的一个数，所以给它最高层级（近黑 + 等宽数字）。以前是蓝色
  // 小字：既压不过标题，又在白底只有 4.2:1。把强调色让给「可交互」之后，
  // 数字回到中性反而更醒目。
  '.dsh-wb-pct{font:var(--wb-f1s);font-variant-numeric:tabular-nums;color:var(--wb-fg);}',
  '.dsh-wb-svg{display:block;flex:none;}',
  '.dsh-wb-icon{border:1px solid transparent;background:transparent;border-radius:var(--wb-r-2);padding:var(--wb-sp-1) var(--wb-sp-3);font:inherit;color:var(--wb-fg-2);cursor:pointer;line-height:1.5;transition:background var(--wb-dur) var(--wb-ease),color var(--wb-dur) var(--wb-ease);}',
  '.dsh-wb-icon:hover{background:var(--wb-hover);color:var(--wb-fg);}',
  '.dsh-wb-icon:active{background:var(--wb-active);}',
  '.dsh-wb-icon:disabled{opacity:.45;cursor:default;}',
  '.dsh-wb-bar{height:3px;background:var(--wb-line);flex:none;}',
  '.dsh-wb-bar-fill{height:100%;background:var(--wb-accent);transition:width var(--wb-dur) var(--wb-ease);}',
  // ── 筛选条 ──────────────────────────────────────────────────────────────
  '.dsh-wb-filters{display:flex;gap:var(--wb-sp-2);padding:var(--wb-sp-3) var(--wb-sp-5);flex-wrap:wrap;flex:none;border-bottom:1px solid var(--wb-line);}',
  // 按钮的横向内边距只给 6px。这 6 个筛选按钮在窄宽（≈420px 的侧栏）下总宽 383px，
  // 加上 5 个 4px 间隙是 403px——筛选行可用宽只要低于这个数就会折成两行，而第二行
  // 只挂一个孤零零的按钮，整块高度还会从 37px 涨到 49px。用 sp-4(8px) 时 6 个按钮
  // 各宽 4px，实测就会折行。纵向补回 2px 是为了让 11px 的字有正常行高，不与折行冲突。
  '.dsh-wb-chip{border:1px solid var(--wb-line-2);background:transparent;color:var(--wb-fg-2);border-radius:var(--wb-pill);padding:var(--wb-sp-1) var(--wb-sp-3);font:var(--wb-f3);cursor:pointer;white-space:nowrap;max-width:14em;overflow:hidden;text-overflow:ellipsis;transition:background var(--wb-dur) var(--wb-ease),color var(--wb-dur) var(--wb-ease);}',
  '.dsh-wb-chip:hover{background:var(--wb-hover);color:var(--wb-fg);}',
  // 选中态用「填充 + 描边 + 加粗」三重区分，不靠颜色单独表意。
  '.dsh-wb-chip.on{background:var(--wb-accent-soft);border-color:var(--wb-accent);color:var(--wb-fg);font-weight:600;}',
  // 建议按钮：和「用户自己挑的目标」区分开——它是系统推断的。沿用强调色，
  // 但**位置在前 + 文案带「建议」**才是主要区分手段，颜色只是辅助（不靠颜色单独表意）。
  '.dsh-wb-chip.sug{background:var(--wb-accent-soft);border-color:var(--wb-accent);color:var(--wb-fg);}',
  // ── 主体 ────────────────────────────────────────────────────────────────
  '.dsh-wb-body{flex:1;overflow-y:auto;padding:var(--wb-sp-4) var(--wb-sp-5) var(--wb-sp-5);}',
  // ── 看板视图 ────────────────────────────────────────────────────────────
  // 看板是树形之外另一种读法：每个顶层计划（含收件箱）占一列，待办摊成卡片。
  // 节点多了以后树会越缩越深、越难俯瞰；看板「横向铺开」让「每个计划里有什么」
  // 一眼可见。面板住在 ≈1000px 宽、纵向偏矮的底部工作台，横向铺列恰好吃准这个尺寸。
  // 它**只读** /get 下发的同一份 payload，不新增任何工具或路由。
  '.dsh-wb-board{display:flex;gap:var(--wb-sp-4);overflow-x:auto;overflow-y:auto;padding:var(--wb-sp-4) var(--wb-sp-5) var(--wb-sp-5);align-items:flex-start;}',
  '.dsh-wb-col{flex:0 0 210px;min-width:210px;max-width:210px;display:flex;flex-direction:column;gap:var(--wb-sp-2);}',
  // 列头用一条上边线把它和相邻列分开；收窄内边距，让一列里多塞下几张卡片。
  '.dsh-wb-colhead{display:flex;align-items:baseline;gap:var(--wb-sp-2);padding:var(--wb-sp-1) var(--wb-sp-2) var(--wb-sp-2);border-top:2px solid var(--wb-line);}',
  '.dsh-wb-coltitle{flex:1;font:var(--wb-f1s);word-break:break-word;}',
  '.dsh-wb-colpct{flex:none;font:var(--wb-f3);font-variant-numeric:tabular-nums;color:var(--wb-fg-2);}',
  '.dsh-wb-colcount{flex:none;font:var(--wb-f3);font-variant-numeric:tabular-nums;color:var(--wb-fg-2);}',
  '.dsh-wb-cards{display:flex;flex-direction:column;gap:var(--wb-sp-2);}',
  // 卡片：复用行密度思路——纵向内边距给很小，靠 hover 底色连成一片。
  '.dsh-wb-card{border:1px solid var(--wb-line-2);border-radius:var(--wb-r-2);padding:var(--wb-sp-2) var(--wb-sp-3);transition:background var(--wb-dur) var(--wb-ease),border-color var(--wb-dur) var(--wb-ease);}',
  '.dsh-wb-card:hover{background:var(--wb-hover);border-color:var(--wb-line);}',
  '.dsh-wb-card.done{opacity:.55;}',
  '.dsh-wb-cardtop{display:flex;align-items:flex-start;gap:var(--wb-sp-2);}',
  '.dsh-wb-planhead input,.dsh-wb-focus input{margin:var(--wb-sp-1) 0 0;flex:none;cursor:pointer;accent-color:var(--wb-accent);}',
  '.dsh-wb-cardtop input{margin:var(--wb-sp-1) 0 0;flex:none;cursor:pointer;accent-color:var(--wb-accent);}',
  '.dsh-wb-cardtitle{flex:1;word-break:break-word;cursor:pointer;}',
  '.dsh-wb-cardtitle.done{text-decoration:line-through;color:var(--wb-fg-2);}',
  // 卡片上的上下文路径：说明这张卡属于哪个子计划（列只代表顶层计划）。
  '.dsh-wb-cardpath{font:var(--wb-f3);font-family:var(--ds-font-family-code);color:var(--wb-fg-2);word-break:break-word;margin-top:2px;}',
  '.dsh-wb-cardmeta{display:flex;gap:var(--wb-sp-2);flex-wrap:wrap;align-items:center;margin-top:var(--wb-sp-2);}',
  // ── 视图切换（树 / 看板）───────────────────────────────────────────────
  // 段控：和筛选按钮同一套语言（填充 + 描边 + 加粗表示选中），不靠颜色单独表意。
  '.dsh-wb-viewtoggle{display:flex;border:1px solid var(--wb-line-2);border-radius:var(--wb-pill);overflow:hidden;flex:none;}',
  '.dsh-wb-vbtn{border:none;background:transparent;color:var(--wb-fg-2);cursor:pointer;font:var(--wb-f3);padding:var(--wb-sp-1) var(--wb-sp-3);line-height:1.6;}',
  '.dsh-wb-vbtn.on{background:var(--wb-accent-soft);color:var(--wb-fg);font-weight:600;}',
  '.dsh-wb-icon.on{background:var(--wb-accent-soft);color:var(--wb-fg);border-color:var(--wb-accent);}',
  '.dsh-wb-shutdown{background:var(--wb-hover);border-radius:var(--wb-r-2);margin:var(--wb-sp-2) var(--wb-sp-2) 0;padding:var(--wb-sp-2) var(--wb-sp-3);}',
  '.dsh-wb-shutdown-head{display:flex;align-items:center;justify-content:space-between;font:var(--wb-f3);font-weight:500;color:var(--wb-fg-2);margin-bottom:var(--wb-sp-1);}',
  '.dsh-wb-shrow{display:flex;align-items:center;gap:var(--wb-sp-2);padding:var(--wb-sp-1) 0;border-top:1px solid var(--wb-border-tertiary);}',
  '.dsh-wb-shrow .dsh-wb-tasktitle{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
  '.dsh-wb-shact{display:flex;gap:var(--wb-sp-1);flex:none;}',
  '.dsh-wb-shact .dsh-wb-act{padding:2px var(--wb-sp-2);font:var(--wb-f3);border-radius:var(--wb-r-2);border:1px solid var(--wb-border-secondary);background:var(--wb-bg);color:var(--wb-fg-2);cursor:pointer;}',
  '.dsh-wb-shact .dsh-wb-act.done{color:var(--wb-success);border-color:var(--wb-success);}',
  // ── 计划节点（递归，深度用 margin-left 表达）────────────────────────────
  '.dsh-wb-plan{margin-bottom:var(--wb-sp-2);}',
  // 标题与紧跟其后的进度条是一个视觉单元，所以下边距收到 0：让进度条贴住标题，
  // 「谁属于谁」靠贴合表达，比靠留白表达更省纵向空间，也更清楚。
  '.dsh-wb-planhead{display:flex;align-items:baseline;gap:var(--wb-sp-3);margin:var(--wb-sp-1) 0 0;}',
  // 标题 + 展开箭头一组。标题**不伸张**（flex:0 1 auto），于是箭头紧跟在最后一个字后面；
  // 撑开行宽交给这层 wrap。
  '.dsh-wb-planwrap{flex:1 1 auto;min-width:0;display:flex;align-items:baseline;gap:var(--wb-sp-2);}',
  '.dsh-wb-plantitle{flex:0 1 auto;min-width:0;font:var(--wb-f1s);word-break:break-word;}',
  '.dsh-wb-planpct{flex:none;font:var(--wb-f3);font-variant-numeric:tabular-nums;color:var(--wb-fg-2);}',
  '.dsh-wb-planq{flex:none;font:var(--wb-f3);color:var(--wb-fg-2);}',
  '.dsh-wb-planmeta{display:flex;gap:var(--wb-sp-3);flex-wrap:wrap;font:var(--wb-f3);color:var(--wb-fg-2);margin:0 0 var(--wb-sp-2);}',
  // 计划级进度条已删除（原先两条 .dsh-wb-planbar 规则在此）：它横在计划标题与
  // 子计划之间，读起来就是一条「下划线」，而完成度在标题行右侧的百分比里已经
  // 说清楚了。层级关系改由缩进表达。
  // 计划的完成 / 放弃改用标题样式表达，不再单写一行「已完成」——省一行纵向空间，
  // 也和待办的标法统一（.dsh-wb-tasktitle.done / .dropped）。
  '.dsh-wb-plantitle.done{text-decoration:line-through;color:var(--wb-fg-2);}',
  '.dsh-wb-plantitle.dropped{text-decoration:line-through;color:var(--wb-fg-2);}',
  // ── 待办行 ──────────────────────────────────────────────────────────────
  // 待办行按「密」来配：这个面板住在底部工作台里，纵向空间是最稀缺的资源，
  // 一行省 3px、11 行就能多露出一条半任务。所以纵向内边距只给 2px、行间距给 0，
  // 行与行的分隔交给 hover 底色——顺带得到「整列连成一片」的列表观感。
  // 行高不在这里写死，直接吃 .dsh-wb-wrap 的 var(--wb-f1)（13px/20px），
  // 与宿主自己的列表同一套行高标尺。
  '.dsh-wb-task{display:flex;align-items:flex-start;gap:var(--wb-sp-3);padding:var(--wb-sp-1) var(--wb-sp-2);border-radius:var(--wb-r-2);margin:0;transition:background var(--wb-dur) var(--wb-ease);}',
  '.dsh-wb-task:hover{background:var(--wb-hover);}',
  '.dsh-wb-task input{margin:var(--wb-sp-1) 0 0;flex:none;cursor:pointer;accent-color:var(--wb-accent);}',
  '.dsh-wb-tasktitle{flex:1;word-break:break-word;cursor:pointer;}',
  // 标题之后的元信息 + 动作按钮。宽屏上它是一段不收缩的尾部（与以前一样），
  // 窄屏上整体折成第二行（见下面的媒体查询）。
  '.dsh-wb-taskmeta{display:flex;align-items:center;gap:var(--wb-sp-2);flex:none;min-width:0;}',
  // 完成态用「变灰」而不是 opacity：叠透明度会把对比度一起压下去。
  '.dsh-wb-tasktitle.done{text-decoration:line-through;color:var(--wb-fg-2);}',
  '.dsh-wb-tasktitle.dropped{text-decoration:line-through;color:var(--wb-fg-2);}',
  '.dsh-wb-taskdue{flex:none;font:var(--wb-f3);font-variant-numeric:tabular-nums;color:var(--wb-fg-2);white-space:nowrap;}',
  // 逾期日期是全表唯一「红字」——有意保留，但要说清它的真实数字：宿主的 error
  // token 在浅色下是 #ec1313，对面板底色 4.49:1，严格按不四舍五入的算法差 0.01
  // 不到 AA 的 4.5:1（这里底色是纯底，没有软底再往下压，所以比胶囊那两处好）。
  // 之所以接受：它是每行里唯一需要立刻行动的信号，换成中性色就被埋掉了；
  // 而且宿主的 token 集里找不到「明暗两态都能安全当文字」的第二个红。
  '.dsh-wb-taskdue.overdue{color:var(--wb-danger);font-weight:600;}',
  // 行内动作按钮：以前 opacity:0 只在 hover 现身，键盘与触屏完全够不到。
  // 现在键盘用 :focus-within 揭示，触屏用 @media (hover:none) 常驻。
  '.dsh-wb-act{flex:none;border:none;background:transparent;color:var(--wb-fg-2);cursor:pointer;font:var(--wb-f3);padding:0 var(--wb-sp-1);border-radius:var(--wb-r-1);line-height:1.6;opacity:0;transition:opacity var(--wb-dur) var(--wb-ease),background var(--wb-dur) var(--wb-ease);}',
  '.dsh-wb-task:hover .dsh-wb-act,.dsh-wb-planhead:hover .dsh-wb-act,.dsh-wb-task:focus-within .dsh-wb-act,.dsh-wb-planhead:focus-within .dsh-wb-act,.dsh-wb-card:hover .dsh-wb-act,.dsh-wb-card:focus-within .dsh-wb-act,.dsh-wb-focus:hover .dsh-wb-act,.dsh-wb-focus:focus-within .dsh-wb-act{opacity:1;}',
  '.dsh-wb-act:hover{background:var(--wb-hover);color:var(--wb-fg);}',
  // ── 重要程度徽章 ────────────────────────────────────────────────────────
  // ── 重要程度徽章 ────────────────────────────────────────────────────────
  // 留白纪律（Superlist / Google Tasks）：砍掉描边 / 软底 / 圆角，降级为纯文字。
  // AA 对比度是硬约束——红 / 琥珀文字在浅色下都够不到 4.5:1，所以「高」不再靠红，
  // 改靠字重；中 / 低走中性灰。盒子去掉后，强调只由字号、字重与间隔承担。
  '.dsh-wb-pri{flex:none;font:var(--wb-f3s);user-select:none;color:var(--wb-fg-2);}',
  '.dsh-wb-pri.normal{color:var(--wb-fg-2);}',
  '.dsh-wb-pri.low{color:var(--wb-fg-2);}',
  '.dsh-wb-pri.medium{color:var(--wb-fg);}',
  '.dsh-wb-pri.high{color:var(--wb-fg);font-weight:600;}',
  // 徽章已不可点，故不再有 hover 态——「改重要程度」这件事全部回到详情页。
  // ── 委派标记 ────────────────────────────────────────────────────────────
  // 纯文字：正常态走强调色（链接语义，AA 安全）；逾期回执只靠字重 + tooltip，
  // 不再用红软底做盒子。
  '.dsh-wb-deleg{flex:none;font:var(--wb-f3);white-space:nowrap;max-width:11em;overflow:hidden;text-overflow:ellipsis;color:var(--wb-accent);cursor:help;}',
  '.dsh-wb-deleg.late{color:var(--wb-fg);font-weight:600;}',
  // ── 管控缺口 ────────────────────────────────────────────────────────────
  '.dsh-wb-warn{flex:none;font:var(--wb-f3);color:var(--wb-fg-2);cursor:help;}',
  // ── 落后于周期 ──────────────────────────────────────────────────────────
  // 琥珀软底已砍；落后靠字重 + 「落后 N%」文字本身表意，不靠颜色。
  '.dsh-wb-behind{flex:none;font:var(--wb-f3s);white-space:nowrap;color:var(--wb-fg);font-weight:600;cursor:help;}',
  // ── 完成证据：⎘n = 已附证据；⊘ = 已完成但无证据（待核验）──────────────
  // 两者都自带符号，颜色冗余，统一中性；缺失证据靠字重强调。
  '.dsh-wb-evid{flex:none;font:var(--wb-f3);color:var(--wb-fg-2);cursor:help;}',
  '.dsh-wb-evid.bad{color:var(--wb-fg);font-weight:600;}',
  '.dsh-wb-unverif{flex:none;font:var(--wb-f3s);color:var(--wb-fg-2);cursor:help;}',
  // ── 收件箱 ──────────────────────────────────────────────────────────────
  '.dsh-wb-inbox{margin-bottom:var(--wb-sp-5);padding-bottom:var(--wb-sp-4);border-bottom:1px dashed var(--wb-line-2);}',
  '.dsh-wb-inboxhead{display:flex;align-items:baseline;gap:var(--wb-sp-3);margin:var(--wb-sp-1) 0 var(--wb-sp-3);}',
  '.dsh-wb-inboxtitle{font:var(--wb-f1s);}',
  // 「工作计划」分栏标题。刻意**不要**收件箱那条虚线：虚线是「收件箱到此为止」的
  // 分隔，而工作计划是与它并列的另一栏，不是收件箱的延续。
  '.dsh-wb-secthead{display:flex;align-items:baseline;gap:var(--wb-sp-3);margin:0 0 var(--wb-sp-3);}',
  '.dsh-wb-secttitle{font:var(--wb-f1s);}',
  // 收件箱行上的「纳入计划」。常显而非悬停才出——它的意义就是催人清空收件箱，
  // 藏起来等于没做（这也是本面板里唯一常显的行内按钮）。
  // 尺寸与同行徽章（.dsh-wb-pri 的 font/padding/border 三件套）严格一致，
  // 高度才会一样；先前写了 line-height:1.7，它是全行最高的一块，看着就不齐。
  '.dsh-wb-adopt{flex:none;font:var(--wb-f3);padding:0 var(--wb-sp-3);border-radius:var(--wb-r-3);border:1px solid var(--wb-line-2);background:transparent;color:var(--wb-fg-2);cursor:pointer;white-space:nowrap;transition:background var(--wb-dur) var(--wb-ease),color var(--wb-dur) var(--wb-ease),border-color var(--wb-dur) var(--wb-ease);}',
  '.dsh-wb-adopt:hover{background:var(--wb-hover);color:var(--wb-fg);border-color:var(--wb-line);}',
  '.dsh-wb-count{font:var(--wb-f3);font-variant-numeric:tabular-nums;color:var(--wb-fg-2);}',
  '.dsh-wb-add{display:flex;gap:var(--wb-sp-2);margin:0 0 var(--wb-sp-2);}',
  '.dsh-wb-add input{flex:1;min-width:0;font:inherit;padding:var(--wb-sp-2) var(--wb-sp-3);border-radius:var(--wb-r-2);border:1px solid var(--wb-line-2);background:transparent;color:var(--wb-fg);transition:border-color var(--wb-dur) var(--wb-ease);}',
  '.dsh-wb-add input::placeholder{color:var(--wb-fg-2);}',
  '.dsh-wb-add input:focus{border-color:var(--wb-accent);}',
  '.dsh-wb-add button{border:1px solid var(--wb-line-2);background:transparent;color:var(--wb-fg-2);border-radius:var(--wb-r-2);cursor:pointer;font:var(--wb-f2);padding:var(--wb-sp-2) var(--wb-sp-4);white-space:nowrap;transition:background var(--wb-dur) var(--wb-ease),color var(--wb-dur) var(--wb-ease);}',
  '.dsh-wb-add button:hover:not(:disabled){background:var(--wb-hover);color:var(--wb-fg);}',
  '.dsh-wb-add button:disabled{opacity:.4;cursor:default;}',
  // 语音按钮：外壳沿用提交按钮那一套，只是里面只放一个符号，所以横向收窄。
  // 选择器要写到 `.dsh-wb-add .dsh-wb-mic`——`.dsh-wb-add button` 的特异性比单类高，
  // 只写 `.dsh-wb-mic` 会被它压住。
  '.dsh-wb-add .dsh-wb-mic{padding:var(--wb-sp-2) var(--wb-sp-3);line-height:1;}',
  // 正在听 = 强调色描边 + 软底，沿用面板里「选中」那一套语言，不另造一套状态色。
  '.dsh-wb-add .dsh-wb-mic.on{border-color:var(--wb-accent);background:var(--wb-accent-soft);color:var(--wb-fg);}',
  // ── 归位选择器 ──（同样收进强调色，不再另开一个紫色）
  '.dsh-wb-movepick{display:flex;gap:var(--wb-sp-2);flex-wrap:wrap;align-items:center;margin:var(--wb-sp-1) 0 var(--wb-sp-3);padding:var(--wb-sp-3);border-radius:var(--wb-r-2);background:var(--wb-accent-soft);border:1px dashed var(--wb-accent);}',
  '.dsh-wb-movepicklabel{font:var(--wb-f3);color:var(--wb-fg-2);}',
  // ── 建议汇总（AI 解读完先给一张分类汇总，再排具体卡片）──────────────────
  // 位置在卡片**之前**：用户要先知道「它读出了几件事、分别是哪类」，再决定
  // 一口全采纳还是逐条看。所以它是这段结果的标题行，不是页脚。
  '.dsh-wb-aisummary{display:flex;flex-direction:column;gap:var(--wb-sp-1);margin:var(--wb-sp-2) 0 var(--wb-sp-1);padding:var(--wb-sp-3);border-radius:var(--wb-r-2);background:var(--wb-accent-soft);border:1px solid var(--wb-accent);}',
  '.dsh-wb-aisummaryhead{font:var(--wb-f2s);color:var(--wb-fg);}',
  // 汇总里的说明行（「结论见上方…」「改动请逐条确认」）：弱一档，不跟主按钮抢注意力。
  '.dsh-wb-aisummarynote{font:var(--wb-f3);color:var(--wb-fg-2);}',
  // 汇总里的按钮行不继承 movepick 的虚线框（汇总本身已经是实线强调框了，套两层很吵）。
  '.dsh-wb-aisummary .dsh-wb-movepick{margin:0;padding:0;border:0;background:transparent;}',
  // ── AI 入口 ─────────────────────────────────────────────────────────────
  // 整块用「强调色虚线框 + 软底」：这一区的内容**不是用户手打的**，是模型给的，
  // 一眼要能分辨。虚线也顺带说明「还没落定」——点过采纳才会真写进计划。
  '.dsh-wb-ai{margin:0 var(--wb-sp-5) var(--wb-sp-4);padding:var(--wb-sp-4);border:1px dashed var(--wb-accent);border-radius:var(--wb-r-2);background:var(--wb-accent-soft);}',
  '.dsh-wb-aihead{display:flex;align-items:center;gap:var(--wb-sp-3);margin:0 0 var(--wb-sp-3);font:var(--wb-f2s);}',
  // 模型名摆在标题行右端：建议是谁给的、用的是哪个模型，不应该藏起来。
  '.dsh-wb-aimodel{margin-left:auto;font:var(--wb-f3);color:var(--wb-fg-2);max-width:16em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
  '.dsh-wb-airow{display:flex;gap:var(--wb-sp-2);align-items:flex-start;}',
  // 多行文本域：口述转写往往是一整段，一行输入框装不下也不好改。
  '.dsh-wb-aitext{flex:1;min-width:0;font:inherit;color:var(--wb-fg);background:transparent;border:1px solid var(--wb-line-2);border-radius:var(--wb-r-2);padding:var(--wb-sp-2) var(--wb-sp-3);min-height:48px;resize:vertical;}',
  '.dsh-wb-aitext::placeholder{color:var(--wb-fg-2);}',
  '.dsh-wb-aitext:focus{border-color:var(--wb-accent);}',
  // 无描边、软底：宿主 composer 里的图标按钮就是这个样子（真机反馈：一排描边方框很山寨）。
  // dsh-wb-iconbtn 是**没有模型时**那颗「记入收件箱」的提交键——它跟发送键是同一个
  // 位子上的同一件事，外观必须共用一套；单独写一份迟早会走形。
  // 图标 + 文字并排：`.dsh-wb-svg` 是 display:block，button 里块级子元素后面再跟一个
  // span 会**折到第二行**（与坑 #28 同一个成因）。所以这两个按钮统一 inline-flex 居中，
  // 间距交给 gap——图标和文字才会规规矩矩在同一行上。
  '.dsh-wb-aibtn,.dsh-wb-iconbtn{display:inline-flex;align-items:center;gap:var(--wb-sp-2);border:1px solid transparent;background:transparent;color:var(--wb-fg-2);border-radius:var(--wb-pill);cursor:pointer;font:var(--wb-f2);padding:var(--wb-sp-2) var(--wb-sp-3);white-space:nowrap;transition:background var(--wb-dur) var(--wb-ease),color var(--wb-dur) var(--wb-ease);}',
  '.dsh-wb-aibtn:hover:not(:disabled),.dsh-wb-iconbtn:hover:not(:disabled){background:var(--wb-hover);color:var(--wb-fg);}',
  '.dsh-wb-aibtn:disabled,.dsh-wb-iconbtn:disabled{opacity:.4;cursor:default;}',
  // 「解析」是这一块的主动作，给它**实心**（宿主主按钮那一对），与其它次要按钮区分。
  //
  // 原来是 accent-soft 底 + 加粗，但它当时坐在同样 accent-soft 底的 .dsh-wb-movepick
  // 里——**同色叠同色**，真机上根本看不出那里有个按钮（用户原话：「没有确认的按钮？」）。
  // 换成宿主自己的主按钮填充（button-primary-fill + label-primary-foreground）：
  // 对比度由宿主配色保证，不自己造色，明暗两态自动跟随，也不与宿主抢约定。
  '.dsh-wb-aibtn.primary{background:var(--wb-btn-fill);color:var(--wb-btn-fg);font-weight:600;}',
  '.dsh-wb-aibtn.primary:hover:not(:disabled){background:var(--wb-btn-hover);color:var(--wb-btn-fg);}',
  // **每张 AI 建议卡上那一个主动作**：整行铺满、按钮撑满、点击区 44px。
  //
  // 为什么单独一类：.dsh-wb-movepick 还在服务**多选**的那些行（归入候选、可选项），
  // 那里要的是「几个小胶囊并排」，铺满就没法看了。而「就这么办 / 按这个改 /
  // 确认删除 / 按这个合并」这四张卡各自**只有那一个**动作——它就是这张卡唯一要人
  // 回答的问题，藏在虚线框里的小胶囊里等于没有。44px 是触屏点击区的下限。
  '.dsh-wb-aiact{display:flex;margin:var(--wb-sp-3) 0 0;}',
  '.dsh-wb-aiact .dsh-wb-aibtn{flex:1;justify-content:center;min-height:44px;font:var(--wb-f2s);border-radius:var(--wb-r-2);}',
  // 同一张卡上的**第二条路**（「按这个改」进表单）：同样铺满、同样好点，但描边 +
  // 中性文字——它是备选，不该跟实心主按钮抢眼。两颗实心按钮并排会让人犹豫该点哪颗。
  '.dsh-wb-aiact .dsh-wb-aibtn:not(.primary){border-color:var(--wb-line-2);color:var(--wb-fg);}',
  '.dsh-wb-aibtn.mic.on{background:var(--wb-accent-soft);color:var(--wb-fg);}',
  '.dsh-wb-aipics{display:flex;gap:var(--wb-sp-2);flex-wrap:wrap;align-items:center;margin:var(--wb-sp-3) 0 0;font:var(--wb-f3);color:var(--wb-fg-2);}',
  '.dsh-wb-aipic{display:inline-flex;align-items:center;gap:var(--wb-sp-1);max-width:14em;overflow:hidden;}',
  '.dsh-wb-aipic > button{border:none;background:transparent;color:inherit;cursor:pointer;font:inherit;padding:0 var(--wb-sp-1);}',
  '.dsh-wb-aitask{padding:var(--wb-sp-3) 0;border-top:1px dashed var(--wb-line-2);}',
  // AI 点名了一个对不上的标题（清单/改动/合并都会出现）：**压暗但不隐藏**。
  // 藏起来用户只会觉得「它没反应」，压暗 + 明写「没对上」才看得出是模型抄错了名字。
  '.dsh-wb-aitask.miss{opacity:.55;}',
  '.dsh-wb-aititle{display:flex;gap:var(--wb-sp-3);align-items:baseline;}',
  '.dsh-wb-aititle > span{flex:1;word-break:break-word;}',
  '.dsh-wb-aimeta{font:var(--wb-f3);color:var(--wb-fg-2);white-space:nowrap;}',
  // 新建计划的输入框就放在候选行里：它是「候选之一」，不是另一块表单——
  // 用户的心智是「挑一个去处」，不是「先选模式再填表」。
  '.dsh-wb-ainew{flex:none;width:9em;min-width:0;font:var(--wb-f3);color:var(--wb-fg);background:transparent;border:1px solid var(--wb-line-2);border-radius:var(--wb-r-3);padding:var(--wb-sp-1) var(--wb-sp-3);}',
  '.dsh-wb-ainew::placeholder{color:var(--wb-fg-2);}',
  '.dsh-wb-ainew:focus{border-color:var(--wb-accent);}',
  // ── 折叠控点（无子节点时占位不可点，让同层标题左边缘对齐）──────────────
  '.dsh-wb-caret{flex:none;width:12px;text-align:center;cursor:pointer;color:var(--wb-fg-2);user-select:none;font:var(--wb-f3);border-radius:var(--wb-r-1);}',
  '.dsh-wb-caret:hover{background:var(--wb-hover);color:var(--wb-fg);}',
  '.dsh-wb-caret.none{visibility:hidden;cursor:default;}',
  // ── 就地改名（输入框沿用标题的字号与字重，换进去时行高不跳）────────────
  '.dsh-wb-rename{flex:1;min-width:0;font:inherit;font-weight:600;padding:0 var(--wb-sp-2);border-radius:var(--wb-r-1);border:1px solid var(--wb-accent);background:transparent;color:var(--wb-fg);}',
  '.dsh-wb-rename:focus{outline:none;}',
  // ── 拖拽：落点用 inset 阴影画线，不参与布局，出现时行不会抖 ──────────────
  '.dsh-wb-drop-before{box-shadow:inset 0 2px 0 0 var(--wb-accent);}',
  '.dsh-wb-drop-after{box-shadow:inset 0 -2px 0 0 var(--wb-accent);}',
  '.dsh-wb-drop-inside{background:var(--wb-accent-soft);outline:1px dashed var(--wb-accent);outline-offset:-1px;}',
  '.dsh-wb-dragging{opacity:.4;}',
  '.dsh-wb-rootdrop{height:2px;border-radius:var(--wb-pill);background:var(--wb-accent);margin:var(--wb-sp-3) var(--wb-sp-1);}',
  // ── 聚焦列表 ────────────────────────────────────────────────────────────
  '.dsh-wb-focus{display:flex;align-items:flex-start;gap:var(--wb-sp-3);padding:var(--wb-sp-1) var(--wb-sp-2);border-radius:var(--wb-r-2);margin:0;transition:background var(--wb-dur) var(--wb-ease);}',
  '.dsh-wb-focus:hover{background:var(--wb-hover);}',
  '.dsh-wb-focus input{margin:var(--wb-sp-1) 0 0;flex:none;cursor:pointer;accent-color:var(--wb-accent);}',
  '.dsh-wb-focus .dsh-wb-tasktitle{flex:1;}',
  '.dsh-wb-path{flex:none;font:var(--wb-f3);font-family:var(--ds-font-family-code);color:var(--wb-fg-2);}',
  '.dsh-wb-empty{padding:var(--wb-sp-5);text-align:center;color:var(--wb-fg-2);line-height:1.8;}',
  // ── 未来日程（按天分组）────────────────────────────────────────────
  // 日期标题比正文小一号、次级色：它是**分组标记**，不是内容；要一眼看得出
  // 「这几条属于同一天」，又不能和待办标题抢注意力。
  '.dsh-wb-daygroup{margin-top:var(--wb-sp-4);}',
  '.dsh-wb-dayhead{font:var(--wb-f3);font-weight:500;color:var(--wb-fg-2);padding:var(--wb-sp-1) var(--wb-sp-2);letter-spacing:.02em;}',
  '.dsh-wb-dayhead.today{color:var(--wb-accent);}',
  '.dsh-wb-err{margin:var(--wb-sp-4) var(--wb-sp-5);padding:var(--wb-sp-4) var(--wb-sp-5);border-radius:var(--wb-r-2);background:var(--wb-danger-soft);color:var(--wb-danger);line-height:1.6;word-break:break-word;}',
  '.dsh-wb-footer{padding:var(--wb-sp-3) var(--wb-sp-5);border-top:1px solid var(--wb-line);font:var(--wb-f3);color:var(--wb-fg-2);flex:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
  '.dsh-wb-flash{padding:var(--wb-sp-2) var(--wb-sp-5);font:var(--wb-f3);color:var(--wb-fg-2);flex:none;}',
  // ── 手机档底部块：收起一条输入行，展开才是一整块 AI 内容 ──────────────────
  //
  // **收起的意义**（这是对「常驻」的修正）：常驻的只该是输入条本身。
  // 390×780 的手机上，原来那块常驻内容一上来就吃掉 60% 屏（≈470px），
  // 计划树只剩不到 180px（两三条待办），而且它自己 overflow-y:auto、
  // 和上面的 .dsh-wb-body 形成**两个滚动容器争手势**——面板里出现两条
  // 互不相干的滚动条，这才是用户说的「叠在一起」。
  //
  // 收起态：只留 .dsh-wb-aibar（输入行）可见，其余子块全部 display:none。
  //   · 用 display:none 而不是 max-height:0——后者会让内部的输入框仍然
  //     可聚焦（Tab 键会跳进一个看不见的输入框），且仍在无障碍树里。
  //   · overflow 在收起态是 hidden：防止任何溢出的东西把 56px 撑破。
  // 展开态（.on）：升到 92dvh——它此时是**独立的 sheet**（盖住面板，
  //   而不是继续挤计划树），这样「看答案 / 做选择」有整屏可用，
  //   收起后计划树的滚动位置、展开态、筛选一处都不丢。
  //
  // 安全区在两种状态下都要留（安卓手势条 / iOS home indicator）。
  '.dsh-wb-dockai{flex:none;display:flex;flex-direction:column;gap:var(--wb-sp-2);overflow:hidden;padding:var(--wb-sp-3) var(--wb-sp-4) calc(var(--wb-sp-3) + env(safe-area-inset-bottom,0px));border-top:1px solid var(--wb-line);background:var(--wb-bg);}',
  // 收起态：只显示输入行。
  //
  // **选择器必须下探到 .dsh-wb-aiwrap 里面**（第一版写成 `.dsh-wb-dockai > .dsh-wb-aibar`
  // 是错的）：aiBlock() 返回的是**一个** .dsh-wb-aiwrap 容器，输入行是它的**孙子**而不是
  // dock 的直接子元素。所以
  //     `.dsh-wb-dockai > *`            → 只命中 .dsh-wb-aiwrap（整块）
  //     `.dsh-wb-dockai > .dsh-wb-aibar` → **永远命中 0 个元素**
  // 后果比"没生效"更糟：收起态会把整块（含输入框）一起藏掉，用户连输入框都找不到。
  // 现在按「容器照常显示、只隐藏容器里除输入行以外的每一块」来写。
  //
  // 用 display:none 而不是 max-height:0：后者会让内部的输入框仍然可聚焦
  // （Tab 键会跳进一个看不见的输入框），且仍留在无障碍树里。
  '.dsh-wb-dockai .dsh-wb-aiwrap{display:flex;flex-direction:column;gap:var(--wb-sp-2);}',
  '.dsh-wb-dockai .dsh-wb-aiwrap > *{display:none;}',
  '.dsh-wb-dockai .dsh-wb-aiwrap > .dsh-wb-aibar{display:flex;align-items:center;gap:var(--wb-sp-2);}',
  // 展开态：整块放出来，升成 sheet 自己滚（此时它占的是屏幕，不是计划树的高度）。
  '.dsh-wb-dockai.on{max-height:92dvh;overflow-y:auto;overscroll-behavior:contain;}',
  '.dsh-wb-dockai.on .dsh-wb-aiwrap > *{display:block;}',
  '.dsh-wb-dockai.on .dsh-wb-aiwrap > .dsh-wb-aibar{display:flex;}',
  '.dsh-wb-dockai .dsh-wb-aiinput{flex:1 1 auto;min-width:0;}',
  // 问答与草稿卡在底部块里不该再撑满整宽（那里比浮层窄不了多少，但要留出边距）。
  '.dsh-wb-dockai .dsh-wb-msg{max-width:92%;}',
  '.dsh-wb-dockai .dsh-wb-aipics{display:flex;flex-wrap:wrap;gap:var(--wb-sp-2);}',
  // 触屏没有 hover：行内动作按钮必须常驻，否则永远够不到；同时把为密度压到 2px 的
  // 行内边距放回 6px，让触摸目标重新够大。鼠标要密、手指要好点中，两者诉求相反，
  // 所以按输入方式分开配，而不是取一个两边都不满意的中间值。
  '@media (hover:none){.dsh-wb-act{opacity:1;}.dsh-wb-task,.dsh-wb-focus{padding:var(--wb-sp-3) var(--wb-sp-2);}}',
  // 窄屏（手机）：标题占住第一行，后面那串徽章与行内动作整体折到第二行。
  // 不动 DOM 是因为病根就在 flex 本身——标题是 `flex:1`（basis 0，可被压到 0），
  // 而它后面跟着最多 5 个徽章 + 截止日期 + 6 个 `flex:none` 的动作按钮：窄屏上
  // 标题只剩一个字宽，中文又能任意断行，于是标题**竖着排下来**（手机上实测如此）。
  // 给标题一个 60% 的 flex-basis 并允许换行，一行装不下的自然落到下一行。
  // 窄屏（手机）：标题独占第一行，后面的徽章与动作整体折到第二行——**确定性**版式，
  // 不再取决于标题多长。标题本身太长时自然折成两行，元信息仍在它下面。
  // 手机档把字号整体抬一档：与宿主手机界面对齐（宿主手机正文是 s-14/base-16 那两档，
  // 面板原来最高只到 xs-13，所以一直显得小一号）。
  '@media (max-width:767px){.dsh-wb-wrap,.dsh-wb-fab{'
  + '--wb-f1:var(--dsw-font-s-14);--wb-f1s:var(--dsw-font-s-strong-14);'
  + '--wb-f2:var(--dsw-font-xs-13);--wb-f2s:var(--dsw-font-xs-strong-13);'
  + '--wb-f3:var(--dsw-font-xxs-12);--wb-f3s:var(--dsw-font-xxs-strong-12);}}',
  // 窄屏：行内折行。**只对待办行强制折**（`.dsh-wb-task`）——待办行里徽章与动作
  // 多，标题长短又不一，不强制的话版式会随标题长度飘。
  // 计划行（`.dsh-wb-planhead`）不强制：它的元信息就三样（重要程度 / 进度 / ＋），
  // 短标题（「计划一」）完全放得下一行，硬折成两行反而难看。放不下时
  // head 上的 flex-wrap 会自然把它推到第二行，且第二行从最左边开始——
  // 与标题对齐（这正是把展开箭头挪到标题后面换来的）。
  '@media (max-width:640px){'
  + '.dsh-wb-task,.dsh-wb-planhead{flex-wrap:wrap;row-gap:var(--wb-sp-1);}'
  + '.dsh-wb-tasktitle{flex:1 1 auto;min-width:0;}'
  + '.dsh-wb-task .dsh-wb-taskmeta{flex:1 1 100%;flex-wrap:wrap;row-gap:var(--wb-sp-1);}'
  + '}',
  // 尊重系统的「减少动态效果」。
  '@media (prefers-reduced-motion:reduce){.dsh-wb-wrap *,.dsh-wb-wrap *:before,.dsh-wb-wrap *:after{transition-duration:.01ms !important;animation-duration:.01ms !important;}}',
  // ── 「正在算」的等待块 ─────────────────────────────────────────────────
  //
  // 用户原话：「模型在计算的时候时间还是很长，然后那个空白的框一直在那里，
  // 人家不知道你干嘛。」——所以这里要说清**三件事**：在转（看得见活着）、
  // 在干什么（阶段文字）、多久了（秒数）。
  //
  // 为什么秒数重要：模型跑十几秒时，一个静止的「…」和卡死没有区别；把已用
  // 时间摆出来，用户才知道「它在跑，只是慢」，而不是「是不是坏了」。
  '.dsh-wb-wait{display:flex;align-items:center;gap:var(--wb-sp-2);padding:var(--wb-sp-3) var(--wb-sp-3);border:1px solid var(--wb-line-2);border-radius:var(--wb-r-3);background:var(--wb-bg);color:var(--wb-fg-2);font:var(--wb-f2);}',
  // ── 建议向导（手机档：一次一张，逐步下一步）──────────────────────────
  //
  // 用户原话：「能不能一个建议一个框，然后不停地下一步下一步，这样子更好。」
  //
  // 头部的进度是**这个形态成立的关键**：一次只给一张卡，如果没有「第 2 / 5 条」，
  // 用户永远不知道还剩多少、该不该继续点——有终点才叫流程，否则像在无底洞里走。
  '.dsh-wb-wiz{display:flex;flex-direction:column;gap:var(--wb-sp-3);}',
  '.dsh-wb-wizhead{display:flex;align-items:baseline;gap:var(--wb-sp-2);}',
  '.dsh-wb-wizstep{font:var(--wb-f2s);color:var(--wb-fg);}',
  '.dsh-wb-wizkind{font:var(--wb-f3);color:var(--wb-fg-2);}',
  // 正文限高 + 自己滚：图片清单那种一轮十几条时，单张卡本身也可能很长
  // （意见 + 依据 + 归位候选），不能让它把底部按钮顶出屏幕。
  '.dsh-wb-wizbody{min-height:0;}',
  '.dsh-wb-wizfoot{display:flex;align-items:center;gap:var(--wb-sp-2);flex-wrap:wrap;}',
  // ── 总览屏 ────────────────────────────────────────────────────────────
  //
  // 一张**可扫读**的列表：每行「编号 + 类别 + 标题 + 日期/⚠」。比七张带徽章与
  // 按钮的大卡短得多——这正是「8 秒看都看不完、界面还在滚动」的解法：
  // 先给一屏能一眼扫完的全局，细节留给逐条。
  '.dsh-wb-ovlist{display:flex;flex-direction:column;gap:2px;}',
  '.dsh-wb-ovrow{display:flex;align-items:center;gap:var(--wb-sp-2);width:100%;min-height:36px;padding:var(--wb-sp-1) var(--wb-sp-2);border:0;border-radius:var(--wb-r-2);background:transparent;color:var(--wb-fg);font:var(--wb-f2);text-align:left;cursor:pointer;}',
  '.dsh-wb-ovrow:hover{background:var(--wb-hover);}',
  // 编号用等宽数字：一列数字对齐了才叫列表，否则每一行的缩进都在飘。
  '.dsh-wb-ovnum{flex:none;width:1.6em;font-variant-numeric:tabular-nums;color:var(--wb-fg-2);}',
  '.dsh-wb-ovkind{flex:none;font:var(--wb-f3);color:var(--wb-fg-2);}',
  '.dsh-wb-ovtitle{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
  '.dsh-wb-ovmeta{flex:none;font:var(--wb-f3);color:var(--wb-fg-2);}',
  // ⚠ 只用 accent 色而不用红：它是「需要你定」，不是「出错了」。
  '.dsh-wb-ovwarn{flex:none;color:var(--wb-accent);font:var(--wb-f3s);}',
  // 有疑问的行左侧加一道细线：扫列表时先看到要动脑的那几条（它们排在最前）。
  '.dsh-wb-ovrow.dum{box-shadow:inset 2px 0 0 var(--wb-accent);}',
  '.dsh-wb-wait .dsh-wb-spin{flex:none;width:14px;height:14px;border:2px solid var(--wb-line-2);border-top-color:var(--wb-accent);border-radius:50%;animation:dsh-wb-spin .8s linear infinite;}',
  '@keyframes dsh-wb-spin{to{transform:rotate(360deg);}}',
  '.dsh-wb-wait .dsh-wb-waittxt{flex:1;min-width:0;}',
  // 秒数是等宽数字：否则每次跳动都会让整行宽度变一下，看着像在抖。
  '.dsh-wb-wait .dsh-wb-waittime{flex:none;font-variant-numeric:tabular-nums;color:var(--wb-fg-2);}',
  // 中断入口。做成**文字**而不是一个 ✕ 图标：等待中的用户正在盯着这一块看，
  // 文字「算了」比一个需要辨认的小叉更容易在焦虑时一眼找到。
  // 触摸目标给足 40px 高（手指点得中），但不是主按钮的视觉重量——它是个退路。
  '.dsh-wb-wait .dsh-wb-waitcancel{flex:none;min-height:32px;padding:0 var(--wb-sp-3);border:1px solid var(--wb-line-2);border-radius:var(--wb-pill);background:transparent;color:var(--wb-fg-2);font:var(--wb-f3);cursor:pointer;}',
  '.dsh-wb-wait .dsh-wb-waitcancel:hover{color:var(--wb-fg);border-color:var(--wb-fg-2);}',
  // 尊重「减少动态效果」：转圈换成一圈静止的环，但**文字照常**——
  // 状态信息不该因为动效偏好而消失。
  '@media (prefers-reduced-motion:reduce){.dsh-wb-wait .dsh-wb-spin{animation:none;border-top-color:var(--wb-line-2);}}',
  // ── 文件库关联（Obsidian）─────────────────────────────────────────────
  // 节点上的「做这件事要看的资料」。与证据（⎘）刻意区分：资料是文件夹也能挂的
  // 开放式清单，不进「无证据完成项」那条审查线。
  '.dsh-wb-files{display:flex;flex-direction:column;gap:var(--wb-sp-2);margin:var(--wb-sp-2) 0 0;padding-left:var(--wb-sp-3);}',
  '.dsh-wb-file{display:flex;align-items:center;gap:var(--wb-sp-2);font:var(--wb-f3);color:var(--wb-fg-2);}',
  '.dsh-wb-file a{color:var(--wb-accent);text-decoration:none;word-break:break-word;}',
  '.dsh-wb-file a:hover{text-decoration:underline;}',
  '.dsh-wb-file .dsh-wb-fkind{flex:none;color:var(--wb-fg-2);}',
  // 关联不存在时标红（host 已核验过 vault 内找不到了），提示用户文件可能被挪走。
  '.dsh-wb-file.missing a,.dsh-wb-file.missing .dsh-wb-fref{color:var(--wb-danger);}',
  '.dsh-wb-file .dsh-wb-fref{word-break:break-word;}',
  '.dsh-wb-file .dsh-wb-fnote{flex:none;color:var(--wb-fg-2);font-style:italic;}',
  '.dsh-wb-file .dsh-wb-fx{flex:none;border:none;background:transparent;color:var(--wb-fg-2);cursor:pointer;padding:0 var(--wb-sp-1);border-radius:var(--wb-r-1);line-height:1.4;}',
  '.dsh-wb-file .dsh-wb-fx:hover{background:var(--wb-hover);color:var(--wb-danger);}',
  // 添加关联的内联表单：复用 .dsh-wb-add 的输入框观感，单独再写避免耦合。
  '.dsh-wb-fadd{display:flex;gap:var(--wb-sp-2);align-items:center;margin:var(--wb-sp-2) 0 0;padding-left:var(--wb-sp-3);}',
  '.dsh-wb-fadd input{flex:1;min-width:0;font:inherit;padding:var(--wb-sp-1) var(--wb-sp-2);border-radius:var(--wb-r-2);border:1px solid var(--wb-line-2);background:transparent;color:var(--wb-fg);}',
  '.dsh-wb-fadd input:focus{border-color:var(--wb-accent);}',
  '.dsh-wb-fadd select{flex:none;font:inherit;padding:var(--wb-sp-1) var(--wb-sp-2);border-radius:var(--wb-r-2);border:1px solid var(--wb-line-2);background:transparent;color:var(--wb-fg);}',
  '.dsh-wb-fadd button{border:1px solid var(--wb-line-2);background:transparent;color:var(--wb-fg-2);border-radius:var(--wb-r-2);cursor:pointer;font:var(--wb-f2);padding:var(--wb-sp-1) var(--wb-sp-3);white-space:nowrap;}',
  '.dsh-wb-fadd button:hover:not(:disabled){background:var(--wb-hover);color:var(--wb-fg);}',
  '.dsh-wb-fadd button:disabled{opacity:.4;cursor:default;}',
  // 「关联」按钮：平时藏起来，hover 整行时才出现，和行内动作（↳ × 等）一致。
  '.dsh-wb-fbtn{flex:none;border:none;background:transparent;color:var(--wb-fg-2);cursor:pointer;font:var(--wb-f3);padding:0 var(--wb-sp-1);border-radius:var(--wb-r-1);line-height:1.6;opacity:0;}',
  '.dsh-wb-task:hover .dsh-wb-fbtn,.dsh-wb-planhead:hover .dsh-wb-fbtn,.dsh-wb-task:focus-within .dsh-wb-fbtn,.dsh-wb-planhead:focus-within .dsh-wb-fbtn{opacity:1;}',
  '.dsh-wb-fbtn:hover{background:var(--wb-hover);color:var(--wb-fg);}',
  // ── vault 配置块 ──────────────────────────────────────────────────────
  '.dsh-wb-vault{display:flex;flex-direction:column;gap:var(--wb-sp-2);padding:var(--wb-sp-4) var(--wb-sp-5);border-top:1px dashed var(--wb-line-2);flex:none;}',
  '.dsh-wb-vaulthead{display:flex;align-items:center;gap:var(--wb-sp-2);font:var(--wb-f2s);}',
  '.dsh-wb-vaulthead .dsh-wb-vpath{flex:1;font:var(--wb-f3);font-family:var(--ds-font-family-code);color:var(--wb-fg-2);word-break:break-word;}',
  '.dsh-wb-vault .dsh-wb-add{margin:0;}',
  '.dsh-wb-vaultempty{font:var(--wb-f3);color:var(--wb-fg-2);line-height:1.6;}',
  // ── 详情编辑页 ────────────────────────────────────────────────────────
  // 面板整体换成一张表单：节点字段有十几个，塞进抽屉或行内都放不下，
  // 而「所有信息都能改」这件事一旦要靠滚动+折叠去找，就等于没做。
  '.dsh-wb-formhead{display:flex;align-items:center;gap:var(--wb-sp-3);padding:var(--wb-sp-4) var(--wb-sp-5);border-bottom:1px solid var(--wb-line);flex:none;}',
  '.dsh-wb-formhead .dsh-wb-formtitle{font:var(--wb-f1s);}',
  '.dsh-wb-formhead .dsh-wb-formsub{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:var(--wb-f3);color:var(--wb-fg-2);}',
  '.dsh-wb-form{flex:1;min-height:0;overflow-y:auto;padding:var(--wb-sp-4) var(--wb-sp-5) var(--wb-sp-5);display:flex;flex-direction:column;}',
  // 详情页内容给一个合理的阅读宽度：桌面上面板约 1000px 宽，而「标题」「负责人」
  // 这类标量输入拉满整屏既难读也显得散。手机是 390px，这条对手机是空操作。
  '.dsh-wb-form > *{max-width:680px;}',
  '.dsh-wb-field{display:flex;flex-direction:column;gap:var(--wb-sp-1);margin-bottom:var(--wb-sp-4);}',
  '.dsh-wb-label{font:var(--wb-f3);color:var(--wb-fg-2);}',
  '.dsh-wb-inp{width:100%;font:inherit;padding:var(--wb-sp-2) var(--wb-sp-3);border-radius:var(--wb-r-2);border:1px solid var(--wb-line-2);background:transparent;color:var(--wb-fg);transition:border-color var(--wb-dur) var(--wb-ease);}',
  '.dsh-wb-inp:focus{border-color:var(--wb-accent);}',
  '.dsh-wb-inp::placeholder{color:var(--wb-fg-2);}',
  '.dsh-wb-inp[type=date]{width:auto;}',
  // 拆掉外框：一个套着边框的「格子控件」在手机上一眼看就是网页表单，不像宿主的东西。
  // 改成无框 + 选中项软底胶囊。
  '.dsh-wb-seg{display:inline-flex;gap:var(--wb-sp-1);border:0;border-radius:0;overflow:visible;align-self:flex-start;flex-wrap:wrap;}',
  '.dsh-wb-seg button{border:0;background:transparent;color:var(--wb-fg-2);font:var(--wb-f2);padding:var(--wb-sp-2) var(--wb-sp-3);border-radius:var(--wb-pill);cursor:pointer;transition:background var(--wb-dur) var(--wb-ease),color var(--wb-dur) var(--wb-ease);}',
  '.dsh-wb-seg button.on{background:var(--wb-accent-soft);color:var(--wb-fg);font-weight:600;}',
  '.dsh-wb-seg button:disabled{opacity:.4;cursor:default;}',
  // 固定 1fr 1fr / 1fr 1fr 1fr 在窄屏上会把每格压到 120px 上下（日期框放不下），
  // 改成按可用宽度自动折行：宽屏仍是多列，手机自动落到一两列。
  '.dsh-wb-grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:var(--wb-sp-4);}',
  '.dsh-wb-grid3{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:var(--wb-sp-4);}',
  '.dsh-wb-formnote{font:var(--wb-f3);color:var(--wb-fg-2);line-height:1.6;}',
  '.dsh-wb-formerr{font:var(--wb-f3);color:var(--wb-danger);line-height:1.6;}',
  // 保存放在**头栏**里：头栏是 flex:none、不参与滚动，表单区才是会滚的那块。
  // 手机上输入法弹出时盖住的正是滚动区底部——保存留在最底下，等于要求人先把
  // 键盘收起来才能点它（真机反馈）。
  '.dsh-wb-formacts{margin-left:auto;display:flex;align-items:center;gap:var(--wb-sp-2);flex:none;}',
  // 「更多」折叠条：文左对齐、无框，靠 hover 下划线提示可点——窄面板里不再多一个胶囊。
  '.dsh-wb-morebtn{align-self:flex-start;margin-top:var(--wb-sp-2);border:1px solid transparent;background:transparent;color:var(--wb-fg-2);font:var(--wb-f3);padding:var(--wb-sp-1) 0;cursor:pointer;}',
  '.dsh-wb-morebtn:hover{color:var(--wb-fg);text-decoration:underline;}',
  '.dsh-wb-formlist{display:flex;flex-direction:column;gap:var(--wb-sp-1);margin-top:var(--wb-sp-2);}',
  '.dsh-wb-formrow{display:flex;align-items:center;gap:var(--wb-sp-2);font:var(--wb-f2);padding:var(--wb-sp-1) var(--wb-sp-2);border-radius:var(--wb-r-2);}',
  '.dsh-wb-formrow:hover{background:var(--wb-hover);}',
  '.dsh-wb-formrow .dsh-wb-fref{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
  '.dsh-wb-formrow .dsh-wb-fmeta{flex:none;color:var(--wb-fg-2);font:var(--wb-f3);}',
  // ── AI 助手（第一入口） ──────────────────────────────────────────────
  // 常驻一行：它是「记」与「问」的共同入口，不该藏在按钮后面。
  '.dsh-wb-aiwrap{display:flex;flex-direction:column;gap:var(--wb-sp-2);padding:var(--wb-sp-3) var(--wb-sp-5);border-bottom:1px solid var(--wb-line);flex:none;}',
  '.dsh-wb-aibar{display:flex;align-items:center;gap:var(--wb-sp-2);}',
  '.dsh-wb-aiinput{flex:1;min-width:0;font:inherit;padding:var(--wb-sp-2) var(--wb-sp-3);border-radius:var(--wb-r-2);border:1px solid var(--wb-line-2);background:transparent;color:var(--wb-fg);transition:border-color var(--wb-dur) var(--wb-ease);}',
  '.dsh-wb-aiinput:focus{border-color:var(--wb-accent);}',
  '.dsh-wb-aiinput::placeholder{color:var(--wb-fg-2);}',
  '.dsh-wb-quick{display:flex;align-items:center;gap:var(--wb-sp-2);flex-wrap:wrap;}',
  // 打开浮层时助手先说一句「现在什么情况」——一行按钮，点一下就跳到面板对应的筛选。
  // 数字全部来自面板同一份派生量（summarize().filters），所以两边永远对得上。
  '.dsh-wb-aibrief{display:flex;align-items:center;gap:var(--wb-sp-2);flex-wrap:wrap;}',
  '.dsh-wb-aibrieflabel{font:var(--wb-f3);color:var(--wb-fg-2);}',
  // 对话：自己的话靠右、助手的靠左，靠**位置**而不是颜色区分（颜色要留给语义色）。
  '.dsh-wb-chat{display:flex;flex-direction:column;gap:var(--wb-sp-2);max-height:180px;overflow-y:auto;}',
  '.dsh-wb-msg{font:var(--wb-f2);line-height:1.6;padding:var(--wb-sp-2) var(--wb-sp-3);border-radius:var(--wb-r-3);max-width:88%;white-space:pre-wrap;}',
  '.dsh-wb-msg.me{align-self:flex-end;background:var(--wb-accent-soft);}',
  '.dsh-wb-msg.ai{align-self:flex-start;border:1px solid var(--wb-line);}',
  '.dsh-wb-advice{font:var(--wb-f3);color:var(--wb-fg-2);line-height:1.6;margin-top:var(--wb-sp-1);}',
  '.dsh-wb-aihist{font:var(--wb-f3);color:var(--wb-fg-2);line-height:1.6;margin-top:var(--wb-sp-1);}',
  '.dsh-wb-persona{display:flex;flex-direction:column;gap:var(--wb-sp-2);}',
  '.dsh-wb-atextarea{width:100%;font:var(--wb-f3);line-height:1.7;padding:var(--wb-sp-2) var(--wb-sp-3);border-radius:var(--wb-r-2);border:1px solid var(--wb-line-2);background:transparent;color:var(--wb-fg);resize:vertical;}',
  '.dsh-wb-atextarea:focus{border-color:var(--wb-accent);}',
  // ── 执行清单（MLO 的 TODO 视图） ─────────────────────────────────────
  '.dsh-wb-todoseq{flex:none;min-width:18px;font:var(--wb-f3);font-variant-numeric:tabular-nums;color:var(--wb-fg-2);text-align:right;}',
  '.dsh-wb-act.star{color:var(--wb-fg-2);}',
  '.dsh-wb-act.star.on{color:var(--wb-accent);font-weight:700;}',
  '.dsh-wb-task.starred{background:var(--wb-accent-soft);}',
  '.dsh-wb-ailist{display:flex;flex-direction:column;gap:var(--wb-sp-2);border:1px solid var(--wb-line);border-radius:var(--wb-r-3);padding:var(--wb-sp-3);}',
  '.dsh-wb-formrow.miss{opacity:.55;}',
  '.dsh-wb-customview{display:flex;flex-direction:column;gap:var(--wb-sp-2);}',
].join('')

/**
 * 折叠状态读写。绑在浏览器上而不是计划里：它是「这台机器上这个人现在想看到
 * 什么」，不是计划数据——写进 plan.json 会污染 diff、占版本快照，还会跟着
 * git 提交跑到别人机器上（别人打开就发现几层是收着的，完全莫名其妙）。
 * localStorage 在隐私/受限环境下会抛异常，所以两头都吞掉：存不下就退化成
 * 「每次打开都是全展开」，这在可用性上是可接受的降级。
 *
 * COLLAPSE_KEY 来自 logic.cjs（它被内联进同一个闭包，见文件头）——两处各写
 * 一份的话，改了一处就静默读到另一处的旧值。
 */
function loadCollapsed() {
  try { return parseCollapsed(window.localStorage.getItem(COLLAPSE_KEY)) } catch (e) { return [] }
}
function saveCollapsed(ids) {
  try { window.localStorage.setItem(COLLAPSE_KEY, serializeCollapsed(ids)) } catch (e) { /* 忽略 */ }
}

/**
 * 视图切换（树 / 看板）的本地偏好，和折叠一样只属于这一台浏览器的这次浏览，
 * 不进 plan.json。用单独的键，避免和折叠那串 id 混在一起解析出错。
 */
const VIEW_KEY = 'dsh-workbench:view'
function loadView() {
  try {
    const v = window.localStorage.getItem(VIEW_KEY)
    return v === 'tree' || v === 'todo' || v === 'board' ? v : 'tree'
  } catch (e) { return 'tree' }
}
function saveView(v) {
  try { window.localStorage.setItem(VIEW_KEY, v) } catch (e) { /* 忽略 */ }
}

function injectStyles(css) {
  const el = document.createElement('style')
  el.textContent = css
  document.head.appendChild(el)
  return () => { el.remove() }
}

/**
 * 「正在加子项」的父节点 id 用一个哨兵值表示顶层。节点 id 由 host 生成的
 * `n`/`g`/`k`/`t` 前缀加数字组成，`__root__` 不可能撞上——用一个不可能
 * 撞上的字符串，比再加一份 `addingRoot: true` 状态要少一个可能不同步的字段。
 */
/**
 * AI 助手的快捷问法。它们同时承担两件事：① 最短的使用路径（不用想怎么问）；
 * ② 告诉用户这个助手**能回答什么**——「AI 能干什么」不演示一遍是看不出来的。
 */
/**
 * 快捷问法。**最多三条**——这条限制是量出来的，不是审美：浮层在手机上宽
 * `min(520px, 100vw − 24px)`，390px 的手机里只剩约 350px 内容宽，四个按钮
 * （每个 5–7 个汉字 + 内边距）加上右边的「清空 / 收起」就会折成两行，
 * 而这一行折行会直接把浮层顶高一行（真机反馈：「3 条就好了，4 条就变成两行了」）。
 * 想加第四条，先回去量一遍宽度。
 */
const QUICK_ASKS = ['我今天该做什么', '哪些逾期了', '总结一下进展']

/** 极简可订阅 store：只在 set 时替换整个 state 对象，getSnapshot 引用稳定。 */
function createStore() {
  let listeners = []
  let state = {
    plan: null, cwd: '', dir: '', loading: false, error: null, flash: '',
    filter: 'all',
    // 交互态：一次只展开一个。moving = 正在归位的待办 id，adding = 正在加子项的父节点 id。
    moving: null, adding: null,
    // 当前激活的自定义视图名（AI 清单存下来的）。null = 没在看自定义视图。
    custom: null,
    // 设置页（Obsidian vault + AI 人设……）：整块替换面板，与详情页同模式。
    showSettings: false,
  }
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
  // DSH 官方右侧栏的两个服务（0.1.5-rc.2 起自带，不再依赖 dsh-better-sidebar）：
  //   · sidebarRightTabs —— tab 类型注册表（阶段一：静态声明这个类型是什么）
  //   · sidebarRight     —— 导航控制器（openTab / close / focus …）
  // 正文（阶段二）走 slots 的 'sidebar.right.pane.tab' keyed slot，key 用注册的 id。
  const sidebarRightTabs = ctx.get('sidebarRightTabs')
  if (sidebarRightTabs === undefined) return
  const sidebarRight = ctx.get('sidebarRight')
  if (sidebarRight === undefined) return

  const store = createStore()
  ctx.effect(() => injectStyles(CSS))

  function useSnapshot() {
    return React.useSyncExternalStore(store.subscribe, store.get)
  }

  async function api(method, args, signal) {
    const res = await fetch('/api/workbench/' + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args || {}),
      // signal 可选：只有 AI 那条路会传（见 runAi 的取消）。
      //
      // 为什么必须能取消：Nielsen 的三条阈值里，超过 10 秒的等待**必须**有一个
      // 「清楚标示的中断方式」；而用户实测过「模型在计算的时候时间还是很长，
      // 然后那个空白的框一直在那里」——不能中断，就只能干等。
      signal: signal === undefined ? undefined : signal,
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
    // 手机档还是桌面档——决定「记一条」的入口形态（见 bottomComposerBar 与 fab）。
    const isMobile = useIsMobile()
    // 输入框用组件本地状态：不放进 store，否则每敲一个字都要重渲整棵计划树。
    // 现在只剩「按需」那一个（在某条计划下加子项），一次只会有它一个——
    // 收件箱那个常驻输入框已经删掉，录入只有浮球那一个入口（见 fab()）。
    const [nodeDraft, setNodeDraft] = React.useState('')
    // 就地编辑的三份状态也放本地，理由同上：拖拽时鼠标每动一下都要更新落点，
    // 放进全局 store 会让 tab 角标跟着重算（它订阅 store.get），白烧一遍整棵树。
    const [collapsed, setCollapsed] = React.useState(() => loadCollapsed())
    // 宿主没有模型服务时，浮层里的输入行退化成**纯输入框**（直接 /node-add 进收件箱）。
    // 没有它，删掉收件箱常驻输入框之后，那种机器上的面板会「只能看、不能记」。
    const [plainDraft, setPlainDraft] = React.useState('')
    // 视图切换（树 / 看板）：和折叠一样是这台浏览器的显示偏好，持久化到 localStorage。
    const [view, setView] = React.useState(() => loadView())
    const setViewPersist = (v) => { setView(v); saveView(v) }
    const [editing, setEditing] = React.useState(null)   // { id, original } | null
    const [editDraft, setEditDraft] = React.useState('')
    const [dragId, setDragId] = React.useState(null)
    const [hint, setHint] = React.useState(null)         // { id, place } | null（id=null 表示落在空白处）
    const [shutdownOpen, setShutdownOpen] = React.useState(false)   // 收尾复盘面板开关
    // 文件库关联的内联表单：正在关联哪个节点、填了一半的路径与类型。放进本地
    // 状态——每次敲字都重渲整棵计划树太浪费，且输入框会丢焦点。
    const [linking, setLinking] = React.useState(null)   // 正在加关联的节点 id | null
    const [linkRef, setLinkRef] = React.useState('')
    const [linkKind, setLinkKind] = React.useState('file')
    // vault 配置的内联编辑态（vaultPath 是机器相关配置，存 plan.json 顶层）。
    const [vaultEditing, setVaultEditing] = React.useState(false)
    const [vaultDraft, setVaultDraft] = React.useState('')
    // 详情编辑页：整个面板换成这一个节点/新建项的表单。
    // `{ mode: 'edit' | 'new', id?, draft }`——打开期间树与看板都不渲染，
    // 所以「有未保存改动」这件事不可能悄悄发生，也不用再挂一层脏检查。
    const [form, setForm] = React.useState(null)
    const [formSaving, setFormSaving] = React.useState(false)
    // 详情页里「加一条证据 / 加一个关联」的输入行。单独一份状态而不是复用
    // 行内的 linking/linkRef——那三个是绑在树上的（按节点 id 展开），
    // 详情页不在树里，复用会出现「从详情页加的关联，回到树上看不到输入框」。
    const [formEvKind, setFormEvKind] = React.useState('file')
    const [formEvRef, setFormEvRef] = React.useState('')
    const [formFileKind, setFormFileKind] = React.useState('file')
    const [formFileRef, setFormFileRef] = React.useState('')
    const [formParent, setFormParent] = React.useState('')
    // 依赖添加行的选中值（同上：绑定详情页，不与树上的 moving/adding 混用）。
    const [formDepPick, setFormDepPick] = React.useState('')
    // 详情页「更多」：低频 / 复杂项默认收起。新建时反向（要一次填完，默认展开），
    // 由 openEdit / openDraft 各自设定。
    const [moreOpen, setMoreOpen] = React.useState(false)
    // AI 草稿队列：「全部采纳」时不直接落库，而是逐条填进表单让人过一遍。
    const [aiQueue, setAiQueue] = React.useState([])
    // 单击「切换完成」与双击「改名」抢的是同一个元素，单击因此必须延后执行。
    const clickTimer = React.useRef(null)
    React.useEffect(() => () => {
      if (clickTimer.current !== null) clearTimeout(clickTimer.current)
    }, [])

    // ============================================================ 语音输入
    // 边界划得很死：语音**只把识别结果写进输入框**，别的什么都不做。于是「怎么说」
    // 与「怎么建」各管各的——提交仍走原来那条 /node-add，不必为新功能加工具或路由。
    //
    // 用浏览器原生的 Web Speech API，不引入任何依赖、不经过本插件。宿主和这个插件
    // 都没有语音能力（查过 dsh 的客户端包，一处 speech/mic 都没有），所以只能落在
    // 面板这一层。支持性：Chromium 系可用；不支持的浏览器**干脆不渲染这个按钮**，
    // 而不是给一个永远点不亮的灰按钮。
    const SR = typeof window !== 'undefined'
      ? (window.SpeechRecognition || window.webkitSpeechRecognition || null)
      : null
    const [listening, setListening] = React.useState(false)
    const recRef = React.useRef(null)
    React.useEffect(() => () => {
      const rec = recRef.current
      recRef.current = null
      if (rec !== null) { try { rec.stop() } catch (e) { /* 已经结束了 */ } }
    }, [])

    /**
     * 收声：把中间结果实时灌进输入框，最后一段也是。
     *
     * 三道前置，各说各的原因，别混成一句「语音失败」：
     *
     * ① **不是安全上下文**（明文 HTTP + 局域网 IP）：录音能力被浏览器整个拿掉，
     *    报的却是 `not-allowed`——那句话会把人引去翻「麦克风权限」设置，真正的原因
     *    是**地址**（见坑 #33）。
     * ② **优先端上识别**：Chrome 的 Web Speech 不是本地跑的，它把录音发给
     *    **Google 的语音服务器**；国内连不上，于是必回 `network`。Chrome 138 起有
     *    个绕开的办法——`processLocally`：用设备上的语音包在本地识别，一次网络都
     *    不碰。有就一定要用（见坑 #35）。
     * ③ 都不行时，别只说「失败」：告诉用户**换键盘上输入法自带的那颗话筒**——
     *    那是系统级的能力，不受这些限制，中文通常还更准。
     */
    const startVoice = (setter) => {
      if (typeof window !== 'undefined' && window.isSecureContext === false) {
        flash('当前是 HTTP 地址，浏览器不允许用麦克风——换 HTTPS 打开就能用；也可以用键盘上输入法自带的话筒')
        return
      }
      const lang = typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'zh-CN'
      /** local=是否走端上识别；packState 只用于把「为什么不行」说清楚。 */
      const begin = (local, packState) => {
        let rec = null
        try {
          rec = new SR()
        } catch (e) {
          flash('这个浏览器起不了语音识别')
          return
        }
        rec.lang = lang
        rec.continuous = false
        rec.interimResults = true
        // 端上识别：必须在 start() 之前设。它不联网，所以国内也能用。
        if (local === true) {
          try { rec.processLocally = true } catch (e) { /* 老浏览器没这个属性，忽略 */ }
        }
        rec.onresult = (ev) => {
          let text = ''
          for (let i = 0; i < ev.results.length; i++) text += ev.results[i][0].transcript
          setter(text.trim())
        }
        // 失败必须说出来。「没听见」「没授权」「连不上 Google」是三种不同的事，
        // 混成一句「语音失败」等于什么都没说。
        rec.onerror = (ev) => {
          const code = ev && ev.error ? String(ev.error) : ''
          if (code === 'not-allowed' || code === 'service-not-allowed') {
            flash('麦克风没有授权，请允许后再试')
          } else if (code === 'no-speech') {
            flash('没听到声音，再试一次')
          } else if (code === 'network') {
            // 这条最容易被误判成「插件坏了」：其实是 Chrome 的识别要连 Google，
            // 而国内连不上。把出路直接写出来——键盘上输入法的话筒。
            flash('这个浏览器的语音识别要连 Google 服务器（国内连不上）——请用键盘上输入法自带的话筒；'
              + (packState === 'downloadable' ? '端上语音包还没下载，下载同样要连 Google' : ''))
          } else if (code !== 'aborted') {
            flash('语音识别失败：' + (code || '未知原因'))
          }
        }
        rec.onend = () => { recRef.current = null; setListening(false) }
        recRef.current = rec
        setListening(true)
        try {
          rec.start()
        } catch (e) {
          // 重复 start 会抛。别让它把整块面板带崩。
          recRef.current = null
          setListening(false)
          flash('语音识别启动失败，稍后再试')
        }
      }
      // 有 available() 就先问一句「端上语音包什么状态」。它是异步的，但只在
      // Chrome 138+ 存在；老浏览器/替身没有这个方法，走同步直连云端（测试替身
      // 就是靠这条保持同步行为的）。
      if (typeof SR.available === 'function') {
        let p = null
        try { p = SR.available({ langs: [lang], processLocally: true }) } catch (e) { p = null }
        if (p !== null && typeof p.then === 'function') {
          p.then((state) => {
            const st = String(state)
            // 'available' → 本地包已就绪，直接用；其余（downloadable/downloading/
            // unavailable）先用云端试一次，失败时那句提示会带上 st 说明原因。
            begin(st === 'available', st)
          }).catch(() => begin(false, null))
          return
        }
      }
      begin(false, null)
    }

    const stopVoice = () => {
      const rec = recRef.current
      recRef.current = null
      setListening(false)
      if (rec !== null) { try { rec.stop() } catch (e) { /* onend 会兜底 */ } }
    }

    /** 语音按钮。不支持语音时返回 null，三个输入行都靠它保持行为一致。 */
    const micButton = (setter, key) => {
      if (SR === null) return null
      return h('button', {
        key,
        // 同时挂 dsh-wb-aibtn：麦克风与旁边那颗「＋」「↑」是同一排控件，
        // 必须共用同一套外观。只写 dsh-wb-mic 的话，它那份样式只定义在
        // .dsh-wb-add 之下——在顶部这行里它会退回浏览器默认按钮（灰底+描边，
        // 真机反馈：「话筒不该有个框，应该跟旁边的加号一样」）。
        className: 'dsh-wb-aibtn dsh-wb-mic' + (listening ? ' on' : ''),
        title: listening
          ? '正在听，点一下停止'
          : '点一下开始说话；说完自动填进输入框（可以改），改完点「确认」',
        onClick: () => { if (listening) stopVoice(); else startVoice(setter) },
      }, listening ? icon('stop') : icon('mic'))
    }

    // ============================================================== AI 助手
    //
    // 它是**第一入口**，而入口只有一个：底部那颗浮球。点开是一块输入浮层，
    // 既能问（「哪些逾期了」「这个计划有哪些资料」），也能记（说一件事 →
    // 拆成草稿 → 人确认才落库）。问答与录入是同一次调用的两种产出，
    // 模型回 `{ reply, tasks }`，浮层两种都渲染。
    //
    // 「面板顶部原来那行常驻输入」已经撤掉：同一件事有两个入口，人就得先想
    // 「我该用哪个」，而那个问题的答案对用户毫无价值。
    //
    // 三件不改的事：
    //   ① **解析不写入**——中途改主意没有任何副作用，也就不需要「撤销 AI 导入」；
    //   ② **草稿先进表单**——AI 给的是草稿不是决定；
    //   ③ **对话只活在这次会话**——它是「接着聊」用的，不是档案（不进 plan.json）。
    const [fabOpen, setFabOpen] = React.useState(false)
    // 手机档底部块的展开态：**只有真的产生了结果才升起来**。
    //
    // 与 fabOpen 分开是刻意的：fabOpen 是桌面浮层的开关（用户手动点开/收起），
    // 而这个是「底部输入条要不要变成 sheet」——它由提交结果驱动（见 runAi /
    // submitPlain 的落点），用户不直接控制它，所以不能共用一个状态，
    // 否则桌面浮球的开合会莫名其妙地影响手机 dock 的高度。
    const [aiExpanded, setAiExpanded] = React.useState(false)
    const [fabGap, setFabGap] = React.useState(0)     // 键盘占掉的高度
    // 浮球点开就把焦点交给输入行——**这是「语音」在手机上的正道**。
    //
    // 为什么不是自己录：手机上真正好用的语音是**输入法自带**的那颗话筒（豆包、讯飞…）。
    // 它是系统输入法的一部分，网页**够不到**——没有任何 API 能让网页按下输入法的
    // 话筒。网页唯一能做的「唤起输入法」就是 focus() 一个输入框；剩下的那一下必须
    // 由人点。所以浮球能给的极限是：一点 → 键盘（连着话筒）立刻在手边。
    //
    // 而浏览器自带的那套 Web Speech 只在**安全上下文**里有：明文 HTTP + 局域网 IP
    // 访问时 `navigator.mediaDevices` 直接是 undefined，`start()` 只会回
    // `not-allowed`（见 startVoice 里的前置判断）。
    //
    // autoFocus 是主路径：React 把它实现成挂载时的一次 `focus()`，而这次挂载就在
    // **点击的同一个任务里**——iOS 只认「用户手势里」的 focus，晚一个 tick 就不弹
    // 键盘了。下面这个 effect 只是兜底（真跑起来键盘通常已经弹出来了）。
    const aiInputRef = React.useRef(null)
    React.useEffect(() => {
      if (fabOpen !== true) return
      const el = aiInputRef.current
      if (el !== null && typeof el.focus === 'function') el.focus()
    }, [fabOpen])
    // 输入浮层 / 底部块跟着键盘走：键盘一弹就抬那么高，别再被输入法盖住。
    // 放在面板自己身上（而不是浮球子组件）：面板本来就常驻，多一个 effect
    // 比多一个只为拿键盘高度而存在的子组件便宜。
    //
    // **依赖数组是 `[]`，不是 `[fabOpen]`**——这是原来的一半病根：
    // 监听只在桌面浮球打开时才挂上，手机档的底部块从头到尾**零避让**，
    // 键盘一弹就把输入框盖住（用户抱怨「键盘弹出很挤」有一半来自这里）。
    // 面板本来就是常驻的，监听也没有理由只在某一种形态下存在。
    React.useEffect(() => {
      const vv = typeof window === 'undefined' ? undefined : window.visualViewport
      if (vv === undefined || vv === null) return undefined
      const onShift = () => setFabGap(Math.max(0, window.innerHeight - vv.height - vv.offsetTop))
      vv.addEventListener('resize', onShift)
      vv.addEventListener('scroll', onShift)
      onShift()
      return () => { vv.removeEventListener('resize', onShift); vv.removeEventListener('scroll', onShift) }
    }, [])
    const [aiText, setAiText] = React.useState('')
    // 当前输入框里的字（ref 而非 state）：自动收起要判断「用户是不是正在打字」，
    // 而那个定时器回调拿到的必须是**最新值**——用 state 会闭包捕获旧值，
    // 在「提交后立刻又打字」的时序下会误判成空、把用户打断。
    const aiTextRef = React.useRef('')
    // 单一同步点：不管 aiText 从哪条路被改（提交后清空、粘贴图片、点快捷问法），
    // ref 都跟着走。散在各个 setAiText 调用点去手写 ref 赋值迟早漏一个。
    React.useEffect(() => { aiTextRef.current = aiText }, [aiText])
    // 当前那次 AI 请求的 AbortController（没有请求时为 null）。
    // 存 ref 而不是 state：取消是个「读一次就动作」的命令，不需要触发重渲。
    const aiAbortRef = React.useRef(null)
    const [aiPics, setAiPics] = React.useState([])    // [{ mediaType, data, name }]
    const [aiBusy, setAiBusy] = React.useState(false)
    // 模型已经跑了多久（秒）。用户抱怨「模型在计算的时候时间还是很长，然后那个
    // 空白的框一直在那里，人家不知道你干嘛」——一个静止的「…」和卡死没有区别，
    // 把秒数摆出来，用户才知道「它在跑，只是慢」。
    const [aiWaited, setAiWaited] = React.useState(0)
    const [aiTasks, setAiTasks] = React.useState([])  // 解析出的草稿（新建），逐条采纳
    // 对**已有**任务的产出：edits 改字段、merges 合并。与 tasks 一样是建议，
    // 落库前都要经过人（edits 走表单，merges 走卡片上那句「会删掉哪条」）。
    const [aiEdits, setAiEdits] = React.useState([])
    const [aiMerges, setAiMerges] = React.useState([])
    // 删除建议：AI 提议删掉哪几条。**只是提议**——用户点确认才真的删。
    const [aiDeletes, setAiDeletes] = React.useState([])
    // 被忽略掉的「标题重复」组（客户端查出来的，本地记住即可——它每次都由计划派生）。
    const [dupHidden, setDupHidden] = React.useState([])
    const [aiTurns, setAiTurns] = React.useState([])  // [{ role, text }] 本次会话的问答
    // 计时：只在忙的时候走，闲下来归零（下次提问从 0 重新数，而不是接着上次）。
    React.useEffect(() => {
      if (aiBusy !== true) { setAiWaited(0); return undefined }
      const started = Date.now()
      const timer = window.setInterval(() => setAiWaited(Math.floor((Date.now() - started) / 1000)), 1000)
      return () => window.clearInterval(timer)
    }, [aiBusy])
    // AI 动态生成的清单卡（「明天在家能做的」）。它不是数据——是一个**视图建议**。
    const [aiList, setAiList] = React.useState(null)
    // ── 手机档的建议向导：**一次只给一张卡，逐步下一步** ──────────────────
    //
    // 用户原话：「那个输入之后的那对话框跟这个建议就在一起，能不能一个建议一个框，
    // 然后不停地下一步下一步，这样子更好。」
    //
    // 原来四类卡片（新任务 / 改动 / 合并 / 删除）**一次性全铺出来**，一次提问可能
    // 生成七八张卡，手机上就是一列长长的东西，既看不出「总共有几条待办」，
    // 也不知道「我处理到第几个了」。改成向导后：
    //   · 头部显示进度「第 2 / 5 条」——有终点才叫流程，否则永远不知道还剩多少；
    //   · 一次只渲染当前那张卡——它的选项因此有整屏可用，不再被挤成一条缝；
    //   · 「就这么办」采纳后自动前进到下一条，处理完给出「都处理完了」的收尾。
    //
    // 桌面档不走向导（浮球里空间小、卡片本来就是一列），保持原样——
    // 两边共享同一批卡片函数，只是**排版策略**不同，不各自漂移。
    const [aiStep, setAiStep] = React.useState(0)
    // 多条建议时，进来先给**总览屏**（还没进逐条）。
    //
    // 依据移动端调研：GOV.UK 的「Complete multiple tasks」模式是**先给任务清单页**
    // （每条带状态），用户再点进去做单条；NN/g 也要求 wizard「用步骤列表表达心智
    // 模型」——而「第 1 / 7 条」只说了进度，没说**这 7 条都是什么**。
    //
    // 更实际的理由：用户抱怨过「8 秒看都看不完，而且那个界面还在滚动」。一张
    // 可扫读的总览（编号 + 标题 + 日期 + ⚠）比七张带徽章的大卡短得多，
    // 而且它先回答了「总共有几件、都有哪些」——这正是焦虑的来源。
    const [aiShowOverview, setAiShowOverview] = React.useState(true)
    const [aiPersona, setAiPersona] = React.useState('')
    const [aiPersonaDraft, setAiPersonaDraft] = React.useState('')
    const [aiDefault, setAiDefault] = React.useState('')

    /** 首次打开 AI 区时拉一次人设（plan/agents.md 不存在时 host 给默认人设）。 */
    const loadPersona = React.useCallback(() => {
      return api('persona', { sessionId })
        .then((r) => {
          setAiPersona(typeof r.text === 'string' ? r.text : '')
          setAiPersonaDraft(typeof r.text === 'string' ? r.text : '')
          setAiDefault(typeof r.default === 'string' ? r.default : '')
          return r
        })
        .catch((e) => { store.set({ error: e instanceof Error ? e.message : String(e) }); return null })
    }, [sessionId])

    /** 选图：读成 base64 存进本地状态，超上限的直接丢掉并说明丢了几张。 */
    /**
     * 「＋」上传：图片走 base64（多模态识别），其它文件读成文本追加进输入框——
     * 一条通路两种形态，host 的 /ai-parse 不用为「文件」开新字段。
     * 读失败（权限/格式）不要拖垮整个面板，跳过即可。
     */
    const addFiles = async (fileList) => {
      const files = []
      for (const f of fileList || []) files.push(f)
      const room = AI_MAX_IMAGES - aiPics.length
      const picked = files.slice(0, Math.max(room, 0))
      const out = []
      const textDrops = []
      for (const file of picked) {
        const isImage = typeof file.type === 'string' && file.type.startsWith('image/')
        let buf = null
        try { buf = await file.arrayBuffer() } catch (e) { buf = null }
        if (buf === null) continue
        if (isImage) {
          out.push({
            mediaType: typeof file.type === 'string' && file.type !== '' ? file.type : 'image/png',
            data: bytesToBase64(new Uint8Array(buf)),
            name: typeof file.name === 'string' && file.name !== '' ? file.name : '图片',
          })
        } else {
          // 非图片按文本读（截断 100KB），以「附件」段落追加——模型从上下文里看它。
          const text = new TextDecoder('utf-8', { fatal: false }).decode(buf.slice(0, 100 * 1024))
          textDrops.push('【附件：' + (file.name || '文件') + '】\n' + text)
        }
      }
      setAiPics(aiPics.concat(out))
      if (textDrops.length > 0) setAiText((aiText === '' ? '' : aiText + '\n\n') + textDrops.join('\n\n'))
      const dropped = files.length - picked.length
      if (dropped > 0) flash('一次最多 ' + AI_MAX_IMAGES + ' 个文件，多的 ' + dropped + ' 个没带上')
    }

    /**
     * 问一句 / 记一件事：都走 /ai-parse。
     * 带上会话内的前几轮，模型才接得住「那它的截止呢」这类追问。
     */
    const runAi = (preset) => {
      const ask = (typeof preset === 'string' ? preset : aiText).trim()
      if (ask === '' && aiPics.length === 0) {
        flash('问一句，或说点什么、贴个文件')
        return
      }
      setAiBusy(true)
      setAiText('')
      // 可取消：用户点等待块上的「算了」时中止这次请求。
      //
      // 为什么必须有：Nielsen 三条阈值里，>10 秒的等待**必须**配一个「清楚标示的
      // 中断方式」。模型跑十几秒时用户唯一能做的就是干等——而等的过程里他可能
      // 已经发现自己问错了。abort 之后 fetch 会 reject（AbortError），
      // 下面的 catch 认得它，不当作错误处理（见 catch 段）。
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      aiAbortRef.current = controller
      api('ai-parse', { sessionId, text: ask, images: aiPics, history: aiTurns }, controller === null ? undefined : controller.signal)
        .then((r) => {
          setAiBusy(false)
          aiAbortRef.current = null
          setAiPics([])
          const reply = typeof r.reply === 'string' ? r.reply : ''
          const list = Array.isArray(r.tasks) ? r.tasks : []
          setAiList(r.list !== null && r.list !== undefined && typeof r.list === 'object' ? r.list : null)
          // 先把这一轮记进会话：回答与草稿都留在屏幕上，随手可回看。
          setAiTurns((prev) => prev.concat(
            [{ role: 'user', text: ask }],
            reply === '' ? [] : [{ role: 'assistant', text: reply }],
          ))
          setAiTasks((prev) => prev.concat(list.map((t, i) => {
            const fresh = (Array.isArray(t.candidates) ? t.candidates : []).find((c) => c.kind === 'new')
            return Object.assign({}, t, {
              key: 'ai' + Date.now() + '-' + i,
              newTitle: fresh !== undefined && typeof fresh.title === 'string' ? fresh.title : '',
            })
          })))
          // 「改已有的」与「合并已有的」：host 已经把标题匹配回真实节点（含 ok 标记），
          // 面板只管渲染与采纳——匹配不上的那几条要**显示成没对上**，不能悄悄丢。
          setAiEdits((prev) => prev.concat((Array.isArray(r.edits) ? r.edits : []).map((e, i) => Object.assign({}, e, { key: 'ed' + Date.now() + '-' + i }))))
          setAiMerges((prev) => prev.concat((Array.isArray(r.merges) ? r.merges : []).map((m, i) => Object.assign({}, m, { key: 'mg' + Date.now() + '-' + i }))))
          setAiDeletes((prev) => prev.concat((Array.isArray(r.deletes) ? r.deletes : []).map((d, i) => Object.assign({}, d, { key: 'dl' + Date.now() + '-' + i }))))
          const gotEdits = Array.isArray(r.edits) ? r.edits.length : 0
          const gotMerges = Array.isArray(r.merges) ? r.merges.length : 0
          const gotDeletes = Array.isArray(r.deletes) ? r.deletes.length : 0
          if (reply === '' && list.length === 0 && gotEdits === 0 && gotMerges === 0 && gotDeletes === 0) {
            flash('没解析出待办，换个说法试试')
          } else {
            // 真的产出了结果，底部块这时才升起来——**由结果驱动，不由用户点按钮**。
            // 没有结果就保持一条输入行（「记一条」失败时屏幕不该被一块空结果区占住）。
            //
            // **没有自动收起**（曾经有过 8 秒 / 30 秒两版，都删了）。
            // 用户的话点破了要害：「收不收不是关键，主要是你这个界面非常清晰简洁。
            // 那如果我读完了之后，我点下一条或者点确认也行啊，对不对？」
            //
            // 计时器替用户做主，本质上是在赌他读完了——而内容一长（要滚动）
            // 这个赌注必输。**收起该是他的动作**：读完了自己点「下一条」或「确认」。
            // 界面只要足够清晰，他本来就知道该怎么往下走，不需要谁替他决定时机。
            setAiExpanded(true)
            // 新一轮结果到达 → 回到总览、回到第 1 条。
            //
            // 不重置的话，上一轮停在第 5 条，这一轮新来的建议会直接从第 5 条开始
            // 显示——用户看到的是「第 5 / 2 条」这种对不上的进度（因为新的队列
            // 可能只有两条）。每轮建议都是**独立的一轮**，索引必须跟着重置。
            setAiStep(0)
            setAiShowOverview(true)
          }
        })
        .catch((e) => {
          setAiBusy(false)
          aiAbortRef.current = null
          // 用户主动取消不是错误——别把「你自己按的算了」渲染成一条红色报错。
          // AbortError 是这个平台上中止 fetch 的固定名字。
          if (e !== null && e !== undefined && e.name === 'AbortError') {
            flash('已取消')
            return
          }
          store.set({ error: e instanceof Error ? e.message : String(e) })
        })
    }

    /** 清空这次会话（不写盘——它本来就只在内存里）。 */
    const aiClear = () => { setAiTurns([]); setAiTasks([]); setAiEdits([]); setAiMerges([]); setAiDeletes([]); setAiList(null) }

    /** 把 AI 清单存成自定义视图（localStorage，与折叠 / 视图偏好同类：本机偏好）。 */
    const saveAiView = () => {
      if (aiList === null || aiList === undefined) return
      const ids = (Array.isArray(aiList.items) ? aiList.items : [])
        .filter((x) => x !== null && typeof x === 'object' && x.ok === true && x.id !== null)
        .map((x) => String(x.id))
      if (ids.length === 0) { flash('清单里没有能对上的任务，存不了'); return }
      const name = (typeof aiList.title === 'string' && aiList.title.trim() !== '')
        ? aiList.title.trim() : ('AI 清单 ' + new Date().toISOString().slice(5, 10))
      saveViews(loadViews().filter((v) => v.name !== name).concat([{ name, ids }]))
      store.set({ custom: name })
      flash('已存为视图「' + name + '」，在筛选条上点它随时回看')
    }

    /**
     * 点草稿卡上的一个选项：把它的 patch 并进草稿，再打开新建表单。
     * 选项**不直接建**——与「AI 草稿先进表单」是同一条纪律，只是预填得更多一点。
     */
    const aiApplyOption = (task, option) => {
      const draft = aiDraftOf(task, '')
      const patch = option !== null && option !== undefined && typeof option.patch === 'object'
        ? option.patch : {}
      if (typeof patch.due === 'string' && patch.due !== '') draft.due = patch.due
      if (typeof patch.priority === 'string' && patch.priority !== '') draft.priority = patch.priority
      if (typeof patch.note === 'string' && patch.note !== '') draft.note = patch.note
      if (typeof patch.plan === 'string' && patch.plan !== '') {
        // 选项给的也是**计划名**，不给 id——与模型点名的 plan 同一条纪律。
        const hit = planByName(plan, patch.plan)
        if (hit !== null) draft.parent = String(hit.id)
        else flash('没找到叫「' + patch.plan + '」的计划，位置请在表单里选')
      }
      setAiTasks((prev) => prev.filter((t) => t.key !== task.key))
      setAiQueue([])
      // 交给表单就**把浮层关掉**：表单是整块替换面板、浮层本来就不渲染，留着 fabOpen
      // 只会让「保存完回到树上」时浮层又自己弹回来——用户还得再点一次收起。
      setFabOpen(false)
      openDraft(draft)
      flash('已按「' + String(option.label) + '」填好，改完点保存')
    }

    /** 保存人设（整篇改写）。 */
    const savePersona = () => {
      api('persona-set', { sessionId, text: aiPersonaDraft })
        .then((r) => {
          setAiPersona(typeof r.text === 'string' ? r.text : '')
          flash('人设已保存，下次提问就生效')
        })
        .catch((e) => store.set({ error: e instanceof Error ? e.message : String(e) }))
    }

    /**
     * 采纳一条：**不直接落库**，把 AI 草稿填进表单让人过一遍再存。
     * AI 给的是草稿——标题可能不对、归属可能猜错，「AI 帮我记」不等于
     * 「AI 替我决定」。
     */
    const aiApply = async (task, choice) => {
      let parent = ''
      let where = '顶层'
      if (choice.kind === 'plan') {
        parent = choice.id
        where = choice.title
      } else if (choice.kind === 'new') {
        const title = String(choice.title === undefined ? '' : choice.title).trim()
        // 名字是空的就先别动：拿任务标题去当计划名会造出一堆同名的空壳计划，
        // 那比不建更糟（它还会进完成度统计）。
        if (title === '') { flash('给新计划起个名字再建'); return }
        // 这一步建的是「容器」而不是任务本体：草稿还没定稿，但计划得先存在
        // 才能挂在它下面。任务本身仍然等人点保存。
        const res = await write('node-add', { title, type: 'plan' })
        if (res === null || res === undefined || res.node === null || res.node === undefined) return
        parent = res.node.id
        where = title
      }
      setAiTasks((prev) => prev.filter((t) => t.key !== task.key))
      setAiQueue([])
      // 同 aiApplyOption：交给表单就把浮层关掉，免得保存完它又弹回来。
      setFabOpen(false)
      openDraft(aiDraftOf(task, parent))
      flash('AI 草稿已填进表单（将放进「' + where + '」），改完点保存')
    }

    /**
     * 全部按首选建议**逐条过一遍表单**，而不是一键全存。
     * 逐个 await：建新计划那一步要拿回 id 才能挂下一条。
     */
    /**
     * **一条草稿，直接落库**——AI 的首选建议 + 人的一次点击 = 一次写入。
     *
     * 为什么要有这条路（用户原话：「你反馈出来的东西没有可以让我选择确定，然后确定
     * 之后你就帮我做」）：原来三条路都要过表单——按钮把你送进详情页，你还得再点保存。
     * 「AI 草稿必经表单」那条纪律的本意是「AI 不替你决定」，而**点这一下就是你的决定**；
     * 卡片上已经写着标题、截止、归入哪条，按下去就是它写的那个意思。
     * 想改一改再存的人走按钮那条路（进表单），两条路并存。
     *
     * 去重/顺序说明：选「新建计划」时先建计划（要拿它的 id 当 parent），再建待办——
     * 与表单那条路完全一样，只是不经过人眼。
     */
    const aiAddNow = async (task) => {
      const pick = Array.isArray(task.candidates) && task.candidates.length > 0
        ? task.candidates[0] : { kind: 'inbox' }
      let parent = ''
      let where = '顶层'
      if (pick.kind === 'plan') {
        parent = String(pick.id)
        where = String(pick.title)
      } else if (pick.kind === 'new') {
        const title = String(pick.title === undefined ? '' : pick.title).trim()
        if (title === '') { flash('这条要新建计划，但还没有名字——点下面的按钮进去填'); return false }
        const made = await write('node-add', { title, type: 'plan' })
        if (made === null || made === undefined || made.node === null || made.node === undefined) return false
        parent = String(made.node.id)
        where = title
      }
      const input = { title: String(task.title) }
      if (typeof task.due === 'string' && task.due !== '') input.due = task.due
      if (typeof task.priority === 'string' && task.priority !== '') input.priority = task.priority
      if (typeof task.note === 'string' && task.note !== '') input.note = task.note
      if (parent !== '') input.parent = parent
      const res = await write('node-add', input)
      if (res === null || res === undefined) return false
      setAiTasks((prev) => prev.filter((t) => t.key !== task.key))
      flash('已加入「' + where + '」：' + String(task.title))
      return true
    }

    /**
     * **全部按首选建议加入**——真的全部落库，不再逐条开表单。
     *
     * 它原来的名字这么写、行为却是「打开第一条的表单，让你逐条过」，名不副实（用户就是
     * 被这个坑住的）。想逐条改的人有的是入口：每张卡上的按钮会把你送进表单。
     * 逐条 await：建计划那一步要拿回 id 才能挂下一条。
     */
    const aiApplyAll = async () => {
      const todo = aiTasks.slice()
      let added = 0
      for (const task of todo) if (await aiAddNow(task) === true) added++
      setFabOpen(false)
      flash(added === 0 ? '没有可加入的条目' : '已按首选建议加入 ' + added + ' 条')
    }

    /**
     * **改动已有任务**：把 AI 的 patch 盖在那条任务的**现状**上，打开详情表单。
     *
     * 与「AI 草稿」同一条纪律：**不直接落库**。而且这里更该过表单——改的是你已经在
     * 用的那条，标题/截止被改错了比新建一条错得难受得多。
     * 表单保存走的还是 `/node-set`，所以**零新增通路**。
     */
    const openAiEdit = (edit) => {
      const node = nodeById(edit.id)
      if (node === null) { flash('这条任务不在了（刚被改过？），刷新再看看'); return }
      const draft = draftFromPatch(node, edit.patch)
      setFormEvRef('')
      setFormFileRef('')
      setFormDepPick('')
      setFormParent(draft.parent === undefined ? '' : draft.parent)
      setMoreOpen(false)                 // 编辑：与 openEdit 一致，低频项收起
      setAiEdits((prev) => prev.filter((e) => e.key !== edit.key))
      setFabOpen(false)                  // 交给表单就把浮层关掉（同 aiApply）
      setForm({ mode: 'edit', id: node.id, draft })
      flash('改动已填进表单（原「' + String(node.title) + '」），确认后点保存')
    }

    /**
     * **合并**：keep 留下、fold 并进去。两种 mode 走两条路：
     *
     * · `children`——**保留为子任务**：keep 变成计划，fold 里的每一条都挪到它下面当子项，
     *   **一条都不删**（用户原话：「我要的就是要把一些任务进行合并，然后作为计划，
     *   然后其他的作为它的子计划。」）。只挪标题（模型给了合并稿才挪）+ `/node-move`。
     * · `merge`（默认）——**并进去然后删掉**，给「这两条是一件事」用。走既有的四个写入口：
     *   ① keep 改标题（模型给了合并稿才改）      → /node-set
     *   ② fold 的子项逐个移到 keep 下（追加）    → /node-move
     *   ③ fold 的证据与关联**追加**到 keep       → /node-set / todo-set
     *   ④ 删掉 fold                             → /node-remove
     *
     * 顺序是有意的：**先搬干净再删**，所以任何一步失败都不会丢掉子项或证据
     * （最坏情况是留下一条空了但还在的节点，再合一次即可）。每一步 host 都会自动
     * 归档版本，所以合错了能回滚。结果用 flash 说清楚并了哪些、删了哪条。
     *
     * 两种 mode **都没有新增写入口**：都是 /node-set、/node-move、/node-remove 这几条。
     */
    /**
     * **执行删除**：AI 提议的删除，用户确认后走这里。
     *
     * 用户原话：「我需要可以删除任务和合并任务，你要增加，在里面增加这个权限。」
     * 在加这条之前，模型被要求删一条时只能回答「我不能直接执行，schema 里也没有
     * 删除字段，我不会用改标题之类的动作伪装成删除」——它说得对，那时确实没有这条路。
     *
     * 为什么必须**点确认**才删：删除是不可逆的重动作（有子项时连整棵子树一起没）。
     * 所以它和其它三类建议一样只是「提议」，绝不因为模型说了就自动落库。
     *
     * 走既有的 /node-remove（与面板上的「×」同一个入口），**零新增写通路**；
     * host 侧每次改动前都会留档，所以删错了还能 plan_restore 回滚——这一点
     * 卡片上也照实说，不吓唬人也不隐瞒。
     */
    const applyDelete = async (item) => {
      const node = nodeById(item.id)
      if (node === null) { flash('这条不在了（刚被改过？），刷新再看看'); return }
      setAiDeletes((prev) => prev.filter((d) => d.key !== item.key))
      await write('node-remove', { node: node.id })
      flash('已删除「' + String(node.title) + '」')
    }

    const applyMerge = async (merge) => {
      const keep = nodeById(merge.keepId)
      if (keep === null) { flash('保留的那条不在了（刚被改过？），刷新再看看'); return }
      setAiMerges((prev) => prev.filter((m) => m.key !== merge.key))
      const keepTitle = merge.title !== undefined && merge.title !== '' ? merge.title : String(keep.title)
      const patch = merge.patch === null || merge.patch === undefined ? {} : merge.patch
      if (keepTitle !== String(keep.title) || Object.keys(patch).length > 0) {
        // patch 是「保留那条缺、重复那条有」的字段（截止/重要程度/备注）——只搬子项
        // 与证据的话，这些会**静默丢掉**：合并完发现截止没了，而谁也没提醒过。
        await write('node-set', Object.assign({ node: keep.id, title: keepTitle }, patch))
      }
      if (merge.mode === 'children') {
        // 保留为子任务：只挪位置，不删东西。挪不动的（成环、被别人抢先改了）逐条跳过，
        // 并在 flash 里说清成功了几条——静默少挪一条，用户回头看计划只会以为是自己记错了。
        const moved = []
        const stuck = []
        for (const f of (Array.isArray(merge.folds) ? merge.folds : [])) {
          const node = nodeById(f.id)
          if (node === null) { stuck.push(String(f.title)); continue }
          const r = await doMove(node.id, keep.id)
          if (r === null) stuck.push(String(node.title))
          else moved.push(String(node.title))
        }
        setFabOpen(false)
        flash(moved.length === 0
          ? '没有归组成功的条目（' + (stuck.join('、') || '都被跳过了') + '）'
          : '已归为一个计划：「' + keepTitle + '」下面 ' + moved.length + ' 条：'
            + moved.map((t) => '「' + t + '」').join('、')
            + (stuck.length === 0 ? '' : '（' + stuck.join('、') + ' 没能挪过去）'))
        return
      }
      const done = []
      for (const f of merge.folds) {
        const node = nodeById(f.id)
        if (node === null) continue
        for (const kid of childrenOf(node)) await doMove(kid.id, keep.id)
        for (const ev of (Array.isArray(node.evidence) ? node.evidence : [])) {
          await write('node-set', { node: keep.id, evidenceKind: ev.kind, evidenceRef: ev.ref, evidenceNote: ev.note })
        }
        for (const file of (Array.isArray(node.files) ? node.files : [])) {
          await write('node-set', { node: keep.id, fileKind: file.kind, fileRef: file.ref, fileNote: file.note })
        }
        await write('node-remove', { node: node.id })
        done.push(String(node.title))
      }
      setFabOpen(false)
      flash(done.length === 0
        ? '没有可合并的条目'
        : '已合并：' + done.map((t) => '「' + t + '」').join('、') + ' → 「' + keepTitle + '」')
    }

    /**
     * 把一份 patch 盖在某个节点的**现状**上，得到表单草稿。
     *
     * 抽出来是因为有三条路要用同一套：改动卡、改动卡上的可选项、合并时改标题。
     * 字段清单与 ai.js 的白名单一一对应——那边放宽一个字段，这里就得能接住，
     * 否则「模型给了但界面没填」会静默变成「没改」。
     */
    const draftFromPatch = (node, patch) => {
      const p = patch === null || patch === undefined ? {} : patch
      const draft = Object.assign(formDraftOf(node), {})
      if (typeof p.title === 'string') draft.title = p.title
      if (typeof p.due === 'string') draft.due = p.due
      if (typeof p.priority === 'string') draft.priority = p.priority
      if (typeof p.note === 'string') draft.note = p.note
      if (typeof p.owner === 'string') draft.owner = p.owner
      if (typeof p.start === 'string') draft.start = p.start
      if (typeof p.end === 'string') draft.end = p.end
      // 状态要落在**该类型合法的那几个**上：计划与待办的状态集合不一样，
      // 塞一个非法值进去，表单会显示成没选中，保存时又静默写回别的档。
      if (typeof p.status === 'string' && statusListOf(draft.type).indexOf(p.status) >= 0) draft.status = p.status
      if (typeof p.plan === 'string') {
        // plan 也是**名字**不是 id（同草稿那条纪律）；找不到就让用户在表单里自己选。
        // 「收件箱」「顶层」这类说法 = 移回顶层（不传 parent）。
        const name = p.plan.trim()
        if (name === '收件箱' || name === '顶层' || name === '无') draft.parent = ''
        else {
          const hit = planByName(plan, name)
          if (hit !== null) draft.parent = String(hit.id)
          else flash('没找到叫「' + name + '」的计划，位置请在表单里选')
        }
      }
      return draft
    }

    /**
     * **改动，直接落库**——与草稿卡那颗「就这么办」同一个道理：一次点击 = 一次写入。
     *
     * 走的是既有的 `/node-set`（计划与待办同一条路由，host 按 node 定位），
     * 所以**零新增通路**；`plan` 那个字段是**名字**，在这里换成 parent id
     * （与表单里的做法一致：找不到就让用户进表单自己选，而不是猜一个）。
     */
    const aiEditNow = async (edit) => {
      const node = nodeById(edit.id)
      if (node === null) { flash('这条任务不在了（刚被改过？），刷新再看看'); return }
      const p = edit.patch === null || edit.patch === undefined ? {} : edit.patch
      const args = { node: node.id }
      if (typeof p.title === 'string') args.title = p.title
      if (typeof p.due === 'string') args.due = p.due
      if (typeof p.priority === 'string') args.priority = p.priority
      if (typeof p.note === 'string') args.note = p.note
      if (typeof p.owner === 'string') args.owner = p.owner
      if (typeof p.start === 'string') args.start = p.start
      if (typeof p.end === 'string') args.end = p.end
      if (typeof p.status === 'string') args.status = p.status
      if (typeof p.plan === 'string') {
        const name = p.plan.trim()
        if (name === '收件箱' || name === '顶层' || name === '无') args.parent = ''
        else {
          const hit = planByName(plan, name)
          if (hit === null) { flash('没找到叫「' + name + '」的计划——点「按这个改」进表单自己选'); return }
          args.parent = String(hit.id)
        }
      }
      const res = await write('node-set', args)
      if (res === null || res === undefined) return
      setAiEdits((prev) => prev.filter((e) => e.key !== edit.key))
      flash('已改「' + String(node.title) + '」')
    }

    /** 一条改动的摘要（用在按钮上）：改了哪几项，一眼看得出。 */
    const editSummary = (edit) => {
      const p = edit.patch === null || edit.patch === undefined ? {} : edit.patch
      const parts = []
      if (typeof p.plan === 'string' && p.plan !== '') parts.push('归入「' + p.plan + '」')
      if (typeof p.due === 'string') parts.push('截止 ' + p.due)
      if (typeof p.status === 'string') parts.push('状态 ' + statusLabel(p.status))
      if (typeof p.title === 'string') parts.push('改标题')
      if (typeof p.note === 'string') parts.push('改备注')
      if (typeof p.priority === 'string') parts.push('重要程度 ' + priorityLabel(p.priority))
      if (typeof p.owner === 'string') parts.push('负责人 ' + p.owner)
      if (typeof p.start === 'string') parts.push('开始 ' + p.start)
      if (typeof p.end === 'string') parts.push('结束 ' + p.end)
      return parts.length === 0 ? '（没有要改的字段）' : parts.join(' · ')
    }

    /**
     * 改动卡上挑一个可选项：把它的 patch 并进这条改动，再走同一个表单。
     * 与草稿卡的选项**同一个姿势**——选项不直接建，只是「预填得更多一点」。
     */
    const aiEditOption = (edit, option) => {
      const node = nodeById(edit.id)
      if (node === null) { flash('这条任务不在了（刚被改过？），刷新再看看'); return }
      const merged = Object.assign({}, edit.patch, option.patch === undefined ? {} : option.patch)
      const draft = draftFromPatch(node, merged)
      setFormEvRef('')
      setFormFileRef('')
      setFormDepPick('')
      setFormParent(draft.parent === undefined ? '' : draft.parent)
      setMoreOpen(false)
      setAiEdits((prev) => prev.filter((e) => e.key !== edit.key))
      setFabOpen(false)
      setForm({ mode: 'edit', id: node.id, draft })
      flash('已按「' + String(option.label) + '」填好，确认后点保存')
    }

    /**
     * **改动卡**：`改：<任务>` + 每个字段的「旧 → 新」。
     *
     * 让用户看见**从什么变成什么**，而不是只说「要改这条」——改了截止 / 重要程度这种，
     * 光看新值没法判断该不该点。对不上的那条（ok=false）压暗并列出来，不隐藏。
     */
    const aiEditCard = (edit, onDone) => {
      const node = edit.ok === true && edit.id !== null ? nodeById(edit.id) : null
      const p = edit.patch === null || edit.patch === undefined ? {} : edit.patch
      const rows = []
      if (typeof p.title === 'string') rows.push(['标题', node === null ? '' : String(node.title), p.title])
      if (typeof p.due === 'string') rows.push(['截止', node === null ? '' : (node.due === '' || node.due === undefined ? '（无）' : String(node.due)), p.due])
      if (typeof p.priority === 'string') rows.push(['重要程度', node === null ? '' : priorityLabel(node.priority === '' || node.priority === undefined ? 'normal' : node.priority), priorityLabel(p.priority)])
      if (typeof p.note === 'string') rows.push(['备注', node === null ? '' : (node.note === '' || node.note === undefined ? '（无）' : String(node.note)), p.note])
      if (typeof p.plan === 'string') rows.push(['归属', '', p.plan])
      if (typeof p.owner === 'string') rows.push(['负责人', node === null ? '' : (node.owner === '' || node.owner === undefined ? '（无）' : String(node.owner)), p.owner])
      if (typeof p.status === 'string') rows.push(['状态', node === null ? '' : statusLabel(node.status), statusLabel(p.status)])
      if (typeof p.start === 'string') rows.push(['开始', node === null || node.start === undefined ? '（无）' : String(node.start), p.start])
      if (typeof p.end === 'string') rows.push(['结束', node === null || node.end === undefined ? '（无）' : String(node.end), p.end])
      return h('div', { className: 'dsh-wb-aitask' + (edit.ok === true ? '' : ' miss'), key: edit.key },
        h('div', { className: 'dsh-wb-aititle', key: 't' },
          h('span', null, '改：' + String(edit.target)
            + (edit.exists === true ? '（已经在计划里，不用再建）' : '')
            + (edit.ok === true ? '' : '（没对上这条任务）')),
          h('button', {
            key: 'x',
            className: 'dsh-wb-aibtn',
            title: '丢掉这条改动',
            onClick: () => setAiEdits((prev) => prev.filter((e) => e.key !== edit.key)),
          }, icon('close')),
        ),
        edit.why === '' || edit.why === undefined ? null : h('div', { className: 'dsh-wb-advice', key: 'w' }, '※ ' + edit.why),
        h('div', { className: 'dsh-wb-formlist', key: 'd' },
          rows.map((r, i) => h('div', { className: 'dsh-wb-formrow', key: 'r' + i },
            h('span', { className: 'dsh-wb-fmeta' }, r[0]),
            h('span', { className: 'dsh-wb-fref' }, (r[1] === '' ? '' : r[1] + ' → ') + r[2])))),
        // **主动作**：直接改（一次 /node-set），不经过表单。
        // 上面那行「旧 → 新」就是它要写的东西——按下去之前看得见自己会得到什么。
        rows.length === 0 && edit.exists !== true
          ? null
          : h('div', { className: 'dsh-wb-aiact', key: 'now' },
            h('button', {
              className: 'dsh-wb-aibtn primary',
              title: '就这么办：直接写入（' + editSummary(edit) + '）。想先改再存，点「按这个改」进表单',
              onClick: () => { aiEditNow(edit); if (typeof onDone === 'function') onDone() },
            }, '就这么办：' + editSummary(edit))),
        Array.isArray(edit.options) && edit.options.length > 0
          ? h('div', { className: 'dsh-wb-movepick', key: 'opts' },
            h('span', { className: 'dsh-wb-movepicklabel' }, '可以这样：'),
            edit.options.map((o, i) => h('button', {
              key: 'o' + i,
              className: 'dsh-wb-chip' + (i === 0 ? ' sug' : ''),
              title: o.why === '' ? '按这个来' : o.why,
              onClick: () => { aiEditOption(edit, o); if (typeof onDone === 'function') onDone() },
            }, o.label)))
          : null,
        node === null ? null : h('div', { className: 'dsh-wb-aiact', key: 'a' },
          h('button', {
            className: 'dsh-wb-aibtn',
            title: '打开这条任务的表单（改动已填好，你可以再改），确认后保存',
            onClick: () => openAiEdit(edit),
          }, '按这个改')),
      )
    }

    /**
     * **合并卡**：并哪几条、留下哪条、**最后那几条去哪**——三件事写在同一张卡上。
     *
     * 两种 mode 写不同的「去向」行，因为它们的代价完全不同：
     *   · children（保留为子任务）：「不会删任何条目：这 N 条会挪到「X」下面成为子项」；
     *   · merge（并进去删掉）：「会删掉：X、Y（子项、证据、关联会先并进保留的那条）」。
     * 合并卡的全部风险就在这一行上，所以它是**固定的一行**（不是 tooltip）。
     * 按钮也不叫「采纳」而叫「按这个合并」——这一次点击就是人的确认。
     */
    /**
     * 删除建议卡。与合并卡同形，但把「不可逆」写在最显眼处——
     * 合并丢的是重复的那条（信息已被 keep 吸收），删除丢的是整条。
     */
    const aiDeleteCard = (item, onDone) => {
      const name = item.title === '' || item.title === undefined ? String(item.target) : String(item.title)
      return h('div', { className: 'dsh-wb-aitask' + (item.ok === true ? '' : ' miss'), key: item.key },
        h('div', { className: 'dsh-wb-aititle', key: 't' },
          h('span', null, '删除：「' + name + '」'),
          h('button', {
            key: 'x',
            className: 'dsh-wb-aibtn',
            title: '这条不删（只是这次不看了）',
            onClick: () => setAiDeletes((prev) => prev.filter((d) => d.key !== item.key)),
          }, icon('close')),
        ),
        item.why === '' || item.why === undefined ? null : h('div', { className: 'dsh-wb-advice', key: 'w' }, '※ ' + item.why),
        h('div', { className: 'dsh-wb-aihist', key: 'warn' },
          item.children > 0
            ? '会连同 ' + item.children + ' 个子项一起删掉；每次改动前都有版本留档，删错了能回滚。'
            : '删除后可用版本留档回滚（每条改动前都会自动留档）。'),
        item.ok === true ? null : h('div', { className: 'dsh-wb-aihist', key: 'miss' },
          '没对上：全貌里没有叫「' + String(item.target) + '」的条目'),
        item.ok !== true ? null : h('div', { className: 'dsh-wb-aiact', key: 'a' },
          h('button', {
            className: 'dsh-wb-aibtn primary',
            title: '确认删除「' + name + '」',
            onClick: () => { applyDelete(item); if (typeof onDone === 'function') onDone() },
          }, '确认删除'),
        ),
      )
    }

    const aiMergeCard = (merge, onDismiss, onDone) => {
      const folds = Array.isArray(merge.folds) ? merge.folds : []
      const missing = Array.isArray(merge.missing) ? merge.missing : []
      const skipped = Array.isArray(merge.skipped) ? merge.skipped : []
      const keepName = '「' + (merge.keepTitle === '' || merge.keepTitle === undefined ? String(merge.keep) : String(merge.keepTitle)) + '」'
      // 归组模式：一条都不删，代价只是「挪位置」——所以卡上不写删除，写的是去向。
      const asChildren = merge.mode === 'children'
      const foldNames = folds.length === 0 ? '（没有能对上的）' : folds.map((f) => '「' + String(f.title) + '」').join('、')
      return h('div', { className: 'dsh-wb-aitask' + (merge.ok === true ? '' : ' miss'), key: merge.key },
        h('div', { className: 'dsh-wb-aititle', key: 't' },
          h('span', null, asChildren
            ? '合并成计划：把 ' + foldNames + ' 都挂到 ' + keepName + '下面'
            : '合并：' + foldNames + ' → ' + keepName),
          h('button', {
            key: 'x',
            className: 'dsh-wb-aibtn',
            title: merge.local === true ? '这条不用合并（只是这次不看了）' : '丢掉这条合并',
            onClick: () => {
              if (typeof onDismiss === 'function') onDismiss()
              else setAiMerges((prev) => prev.filter((m) => m.key !== merge.key))
            },
          }, icon('close')),
        ),
        merge.why === '' || merge.why === undefined ? null : h('div', { className: 'dsh-wb-advice', key: 'w' }, '※ ' + merge.why),
        merge.title === '' || merge.title === undefined ? null : h('div', { className: 'dsh-wb-formrow', key: 'tt' },
          h('span', { className: 'dsh-wb-fmeta' }, '标题'),
          h('span', { className: 'dsh-wb-fref' }, keepName + ' → 「' + String(merge.title) + '」')),
        asChildren
          ? h('div', { className: 'dsh-wb-aihist', key: 'del' },
            '不会删任何条目：这 ' + folds.length + ' 条会挪到 ' + keepName + '下面成为子项'
            + (merge.keepKids > 0 ? '（它下面现在有 ' + merge.keepKids + ' 个子项）' : '')
            + '；' + keepName + '变成一个计划。')
          : h('div', { className: 'dsh-wb-aihist', key: 'del' },
            '会删掉：' + foldNames + '（子项、证据、关联会先并进保留的那条）'),
        missing.length === 0 ? null : h('div', { className: 'dsh-wb-aihist', key: 'miss' },
          '没对上：' + missing.map((t) => '「' + String(t) + '」').join('、')),
        skipped.length === 0 ? null : h('div', { className: 'dsh-wb-aihist', key: 'skip' },
          '这些没动：' + skipped.map((s) => '「' + String(s.title) + '」' + (s.why ? '（' + String(s.why) + '）' : '')).join('、')),
        merge.ok !== true ? null : h('div', { className: 'dsh-wb-aiact', key: 'a' },
          h('button', {
            className: 'dsh-wb-aibtn primary',
            title: asChildren
              ? '确认：把这些挪到 ' + keepName + '下面当子项（不删除任何条目，每一步都有版本留档）'
              : '按这个合并；上面列出的条目会被删掉（每一步都有版本留档，合错了能回滚）',
            onClick: () => { applyMerge(merge); if (typeof onDone === 'function') onDone() },
          }, asChildren ? '按这个合并成计划' : '按这个合并')),
      )
    }

    /** 改某条草稿的新建计划名。用函数式更新，避免连着改几条时互相覆盖。 */
    const setNewTitle = (key, value) => {
      setAiTasks((prev) => prev.map((t) => (t.key === key ? Object.assign({}, t, { newTitle: value }) : t)))
    }

    /** 「＋」上传文件。三个入口共用同一份上限与提示逻辑。 */
    const picButton = (key) => h('label', {
      key,
      // dsh-wb-pic 是稳定钩子（同 dsh-wb-send）：图标换成 SVG 后按钮里没有文字了。
      className: 'dsh-wb-aibtn dsh-wb-pic',
      title: '上传文件：图片识别内容，文本直接随问题带上',
    },
      icon('plus'),
      h('input', {
        type: 'file',
        multiple: true,
        style: { display: 'none' },
        onChange: (e) => {
          addFiles(e.target.files)
          // 清空 value：否则连着选同一个文件不会触发 change。
          if (e.target !== null && e.target !== undefined) e.target.value = ''
        },
      }))

    /**
     * AI 助手的**内容块**——渲染在浮球浮层里，不再占面板的一行。
     *
     * 形态：一行输入（问一句 / 说件事 / 贴一张图都能进），下面接着这次会话的
     * 问答、草稿卡与清单卡。宿主没有模型服务时退化成**纯输入框**而不是消失：
     * 「零摩擦把事收进来」是这个插件的立身之本，不能依赖模型在不在。
     */
    /**
     * **打开浮层时，助手先说话**（用户原话：「我点开它，你就应该要给我所有的一些建议」）。
     *
     * 这一版是**本地算的**：数字来自 summarize() 里那份和面板筛选按钮同源的派生量，
     * 所以零模型成本、离线也在、而且**永远和面板上的数字一致**（重算就会出现
     * 「浮层说 2 条、面板说 3 条」而没人知道哪个对——见「派生量不重算」那条纪律）。
     *
     * 它只回答「现在有什么值得动一下」，不给判断。想要模型的判断，接口就在上面那排
     * 快捷问法（「我今天该做什么」）——那是**一次点击**的事，不该每次打开都替你花掉。
     *
     * 一行为限：浮层在手机上就 366px 宽、还压着键盘，多一行就少一条输入的空间。
     * 没什么可说的时候也要说一句「眼下没有…」，否则「点开就有建议」这件事会时灵时不灵。
     */
    /**
     * 「正在算」的等待块。
     *
     * 用户原话：「你这样子输入的时候可以点确认，确认完了之后，你在模型在计算的时候，
     * 时间还是很长。然后那个空白的框一直在那里，人家不知道你干嘛。」
     *
     * 所以这里要说清三件事，缺一件都会让人以为卡死：
     *   ① **在转**（转圈）——证明它活着，不是一个渲染坏掉的空框；
     *   ② **在干什么**（文案）——「正在理解你说的…」比「加载中」有用得多；
     *   ③ **多久了**（秒数）——模型跑十几秒时，这一条是「慢」与「坏了」的唯一区别。
     *      到 15 秒再加一句宽慰，因为那时用户多半已经开始怀疑了。
     *
     * 文案随耗时**演进**而不是一成不变：一开始说「正在理解」，超过 8 秒说
     * 「在对照你已有的计划」——后者才是真正花时间的那一步（要把上下文读完）。
     * 这比从头到尾一句「加载中」诚实，也更像一个人在干活时该说的话。
     */
    /**
     * 「正在算」的等待块。
     *
     * 用户原话：「你这样子输入的时候可以点确认，确认完了之后，你在模型在计算的时候，
     * 时间还是很长。然后那个空白的框一直在那里，人家不知道你干嘛。」
     *
     * 移动端调研给出的硬性要求（Nielsen 三条阈值）：
     *   · **>10 秒必须给「清楚标示的中断方式」**——所以这一块上有「算了」；
     *   · 无法预估总量时，**给「已完成多少」式的滚动反馈**——所以文案分阶段推进，
     *     而不是从头到尾一句「加载中」；
     *   · 2–10 秒不需要真进度条（那是过度设计），但要有不显眼的进行感——转圈够了。
     *
     * 阶段文案是**按耗时推断**的，不是真进度：模型是一次性返回的，客户端拿不到
     * 中间态。所以这里的诚实做法是把「正常大概卡在哪一步」说出来，而不是假装
     * 有百分比。到 15 秒承认「比平时慢」，比一直说「马上就好」可信。
     */
    const aiWaiting = () => {
      const text = aiWaited < 3 ? '正在理解你说的…'
        : aiWaited < 8 ? '正在对照你已有的计划…'
          : aiWaited < 15 ? '正在安排时间和归位…'
            : aiWaited < 30 ? '比平时慢一点，还在算…'
              : '它还在跑——可以继续等，也可以取消了自己写一条'
      return h('div', { className: 'dsh-wb-wait', key: 'wait' },
        h('span', { className: 'dsh-wb-spin' }),
        h('span', { className: 'dsh-wb-waittxt' }, text),
        // 秒数用等宽数字（CSS 里 tabular-nums），否则每跳一次整行宽度都会变，看着像在抖。
        h('span', { className: 'dsh-wb-waittime' }, aiWaited + ' 秒'),
        // 中断入口。Nielsen：超过 10 秒的等待**必须**能被中断——用户等的过程里
        // 可能已经发现自己问错了，或者只是想改个说法重来。
        h('button', {
          className: 'dsh-wb-waitcancel',
          title: '取消这次请求（已经等的时间不算白等——你可以改个说法再来）',
          onClick: () => {
            const c = aiAbortRef.current
            if (c !== null && c !== undefined && typeof c.abort === 'function') c.abort()
          },
        }, '算了'),
      )
    }

    const aiBriefing = () => {
      const sum = summarize(plan)
      const f = sum.filters === undefined ? {} : sum.filters
      const items = []
      if (f.overdue > 0) items.push({ id: 'overdue', label: '逾期', n: f.overdue })
      if (f.behind > 0) items.push({ id: 'behind', label: '落后', n: f.behind })
      if (f.unverified > 0) items.push({ id: 'unverified', label: '待核验', n: f.unverified })
      if (f.delegated > 0) items.push({ id: 'delegated', label: '委派', n: f.delegated })
      // 「顶层」而不是「收件箱」：两栏已合并，这个数是「还没往下拆的顶层待办」。
      // 筛选 id 仍是 inbox（filterCounts 的键，改名会牵动 logic.cjs 与测试）。
      if (sum.inboxOpen > 0) items.push({ id: 'inbox', label: '顶层', n: sum.inboxOpen })
      // 标题重复的组数也报出来：它是最该动手的一类（见 duplicateGroupsOf）。
      // 点它只是把浮层留在这儿不动——卡片就在下面，点那张卡才是动作。
      const dups = duplicateGroupsOf(plan).length
      if (dups > 0) items.push({ id: 'dup', label: '重复', n: dups })
      if (items.length === 0) {
        return h('div', { className: 'dsh-wb-aibrief', key: 'brief' },
          h('span', { className: 'dsh-wb-aibrieflabel' }, '眼下没有逾期、落后或待核验的东西——要我记点什么，直接说。'))
      }
      return h('div', { className: 'dsh-wb-aibrief', key: 'brief' },
        h('span', { className: 'dsh-wb-aibrieflabel' }, '现在：'),
        items.map((it) => h('button', {
          key: it.id,
          className: 'dsh-wb-chip',
          // 收件箱没有对应的筛选按钮，点了就只是收起浮层让人看面板——title 里说清差别。
          title: it.id === 'inbox'
            ? '收件箱里有 ' + it.n + ' 条还没归位（在面板最上面）'
            : '点一下：面板切到筛选「' + it.label + '」',
          onClick: () => {
            // 重复没有对应的筛选按钮，点了只是把卡片留在眼前（卡片就在这一行下面）。
            if (it.id === 'dup') { flash('下面的卡片可以一键合并'); return }
            if (it.id !== 'inbox') store.set({ filter: it.id })
            setFabOpen(false)
            flash(it.id === 'inbox' ? '收件箱在面板最上面' : '面板已切到「' + it.label + '」')
          },
        }, it.label + ' ' + it.n)),
      )
    }

    const aiBlock = () => {
      const ai = state.ai === null || state.ai === undefined ? { available: false } : state.ai
      // 没有模型服务：不整块消失，退化成「记一条待办」的纯输入框。
      // 记仍然要走得通——「零摩擦把事收进来」是这个插件的立身之本，不能依赖模型。
      if (ai.available !== true) {
        const submitPlain = () => {
          const title = plainDraft.trim()
          if (title === '') return
          addNode({ title }, () => {
            setPlainDraft('')
            // 记完就收起：这一步已经结束了，不该再让用户点一次「收起」。
            // 两个都要关——桌面浮层（fabOpen）与手机底部块（aiExpanded）。
            setFabOpen(false)
            setAiExpanded(false)
            flash('已记下')
          })
        }
        return h('div', { className: 'dsh-wb-aiwrap', key: 'ai' },
          h('div', { className: 'dsh-wb-aibar' },
            h('input', {
              className: 'dsh-wb-aiinput',
              placeholder: '记一条待办，回车入收件箱…',
              value: plainDraft,
              ref: aiInputRef,
              autoFocus: true,
              onChange: (e) => setPlainDraft(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); submitPlain() } },
            }),
            micButton(setPlainDraft, 'mic'),
            h('button', {
              className: 'dsh-wb-iconbtn',
              title: '确认：记下这一条（回车同样有效）',
              disabled: plainDraft.trim() === '',
              onClick: submitPlain,
            }, icon('plus'),
              // 与发送键同一条纪律：有字可确认时把「确认」显出来（见发送键那段注释）。
              plainDraft.trim() === '' ? null : h('span', { className: 'dsh-wb-sendlabel' }, '确认')),
          ))
      }
      const model = typeof ai.model === 'string' && ai.model !== '' ? ai.model : ''

      const rows = []
      rows.push(h('div', { className: 'dsh-wb-aibar', key: 'bar' },
        h('input', {
          className: 'dsh-wb-aiinput',
          placeholder: '问一句（「哪些逾期了」），或直接说要做什么…',
          value: aiText,
          ref: aiInputRef,
          // 点开浮球就把键盘叫起来（手机上用输入法自带的话筒说话，见 fabOpen 那段）。
          autoFocus: true,
          onFocus: () => { if (aiPersona === '') loadPersona() },
          onChange: (e) => setAiText(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); runAi() } },
        }),
        micButton(setAiText, 'mic'),
        picButton('pic'),
        h('button', {
          // dsh-wb-send 是给测试用的稳定钩子：图标换成 SVG 之后按钮里没有文字了，
          // 靠字形找它的断言会全军覆没。
          className: 'dsh-wb-aibtn dsh-wb-send primary',
          title: '确认：把这句话交给助手（拆成待办 / 回答），回车同样有效',
          disabled: aiBusy === true,
          onClick: () => runAi(),
        }, aiBusy === true ? '…' : icon('send'),
          // **有字可确认时，把「确认」两个字显出来。**
          //
          // 真机反馈：「语音识别是识别成功了，但是没有可以让我选择确认的一个按钮」
          // ——识别的字已经躺在输入框里了，可提交键只有一个 ↑ 图标，说完话的人不知道
          // 按哪个键算数（纯输入框那半边是个 ＋，同样没有字）。这里补上名字；
          // **没字的时候不显示**：那时没有东西要确认，多两个字只是噪音。
          aiText.trim() === '' ? null : h('span', { className: 'dsh-wb-sendlabel' }, '确认')),
      ))

      // 快捷问法：把「助手能干什么」直接摆在眼前，它同时是最短的那条学习路径。
      //
      // **但只在「手里还没有东西」时给**——这是「清晰简洁」的核心一条：
      // 已经有问答或建议卡在屏幕上时，再摆一排「我今天该做什么 / 哪些逾期了」
      // 就是同一屏里重复问同样的事。用户读完答案正要动手，那排问法只是噪音。
      // 空手时给才有意义：那时他正想着「我该问点什么」，这排问法就是答案。
      const hasContent = aiTurns.length > 0 || aiTasks.length > 0 || aiEdits.length > 0
        || aiMerges.length > 0 || aiDeletes.length > 0 || aiBusy === true
      if (hasContent !== true) {
        rows.push(h('div', { className: 'dsh-wb-quick', key: 'quick' },
          QUICK_ASKS.map((q) => h('button', {
            key: q,
            className: 'dsh-wb-chip',
            title: '问一句：' + q,
            disabled: aiBusy === true,
            onClick: () => runAi(q),
          }, q)),
        ))
      }

      // 一条薄薄的工具行：模型名、清空、收起。
      //
      // 它们都**不是内容**，所以只在真的用得上时出现：
      //   · 模型名 —— 只在空手时露一眼（「用的是哪个模型」是个偶尔才关心的问题，
      //     不该在每次读完答案时都占着视线）；
      //   · 清空 / 收起 —— 只在有东西可清、有块可收时才有意义。
      const tools = []
      if (hasContent !== true && model !== '') tools.push(h('span', { className: 'dsh-wb-aimodel', key: 'm' }, model))
      if (hasContent === true) {
        tools.push(h('button', {
          key: 'clear',
          className: 'dsh-wb-aibtn',
          title: '清空这一轮：把问答与草稿都抹掉，重新说（不写盘，它本来只在内存里）',
          onClick: aiClear,
        }, '清空'))
      }
      // 手机档专属：把升起来的块收回成一条输入行。
      //
      // 桌面档不渲染它——桌面是浮球形态，收起由浮层自己的 ✕ 负责
      // （AGENTS.md 那条「同一个动作不摆两个控件」的纪律仍然有效）。
      //
      // 文案用「收起」而不是 ✕ 图标：它和「清空」并排，两个纯图标会分不清
      // 哪个是抹掉内容、哪个只是把块收小——而这两件事的后果差别很大。
      if (isMobile === true && aiExpanded === true) {
        tools.push(h('button', {
          key: 'collapse',
          className: 'dsh-wb-aibtn',
          title: '收起这块，回到计划树（内容都还在，随时可以再展开）',
          onClick: () => setAiExpanded(false),
        }, '收起'))
      }
      if (tools.length > 0) rows.push(h('div', { className: 'dsh-wb-quick', key: 'tools' }, tools))

      // 助手先说话（本地摘要，见 aiBriefing）：它排在快捷问法之后、问答之前——
      // 输入框和问法属于「我要说」，摘要是「它先说」，顺序上先听后说。
      //
      // **同样只在空手时给**：它的数字（逾期 2 / 落后 1 / 收件箱 3）在面板的
      // 筛选按钮上本来就写着，而且那些按钮还能点。有内容在屏幕上时再报一遍，
      // 就是同一屏里的第二份同样数字——两份并存还会引出「以哪个为准」的疑问。
      if (hasContent !== true) rows.push(aiBriefing())

      // **标题重复的，直接给一张一键合并的卡。**
      // 这就是用户说的「你现在做的是要进行一些合并删减」：不用等模型看出来，也不用
      // 重新解析——计划里现在就摆着四条（两条重复），客户端一眼能查出来。
      // 纯客户端派生（duplicateGroupsOf），所以**刷新即生效**，与 host 半身的重启无关。
      for (const dup of duplicateGroupsOf(plan)) {
        if (dupHidden.indexOf(dup.key) >= 0) continue
        rows.push(aiMergeCard(dup, () => setDupHidden((prev) => prev.concat([dup.key]))))
      }

      // 这次会话的问答。助手的答复与「它读了哪些文件」都留在这里，
      // 人可以随时回看刚才那句建议到底依据什么。
      if (aiTurns.length > 0) {
        rows.push(h('div', { className: 'dsh-wb-chat', key: 'chat' },
          aiTurns.map((t, i) => h('div', {
            key: 'm' + i,
            className: 'dsh-wb-msg ' + (t.role === 'assistant' ? 'ai' : 'me'),
          }, t.text)),
        ))
      }
      // 等待块**独立于问答之外**渲染——这是一个真 bug 的修复。
      //
      // 原来它被写在 `if (aiTurns.length > 0)` 的**里面**，而第一次提问时
      // aiTurns 还是空的（要等回复到了才写进去）——于是**第一次提问永远看不到
      // 任何等待反馈**，屏幕上就是用户说的「那个空白的框一直在那里，人家不知道
      // 你干嘛」。第二次之后才有，所以这个问题很容易在自测时漏掉。
      //
      // 等待是「正在发生的事」，不依赖已有内容；它必须无条件渲染。
      if (aiBusy === true) rows.push(aiWaiting())

      if (aiPics.length > 0) {
        rows.push(h('div', { className: 'dsh-wb-aipics', key: 'pics' },
          aiPics.map((p, i) => h('span', { className: 'dsh-wb-aipic', key: 'p' + i },
            '▢ ' + p.name,
            h('button', {
              title: '去掉这张',
              onClick: () => setAiPics(aiPics.filter((_, j) => j !== i)),
            }, icon('close')),
          ))))
      }

      // AI 动态生成的清单卡：「明天在家能做的」「先做哪三件」。可一键存为视图。
      if (aiList !== null && aiList !== undefined) {
        rows.push(h('div', { className: 'dsh-wb-ailist', key: 'ailist' },
          h('div', { className: 'dsh-wb-aihead', key: 'h' },
            h('span', null, '清单 · ' + (aiList.title === '' ? 'AI 生成' : aiList.title)),
            h('button', {
              className: 'dsh-wb-aibtn',
              title: '存成自定义视图（出现在筛选条上，随时回看）',
              onClick: saveAiView,
            }, '存为视图'),
          ),
          h('div', { className: 'dsh-wb-formlist', key: 'items' },
            (Array.isArray(aiList.items) ? aiList.items : []).map((it, i) => {
              const n = it.ok === true && it.id !== null ? nodeById(it.id) : null
              return h('div', { className: 'dsh-wb-formrow' + (it.ok === true ? '' : ' miss'), key: 'i' + i },
                h('span', { className: 'dsh-wb-fmeta' }, String(i + 1)),
                h('span', { className: 'dsh-wb-fref' }, String(it.title) + (it.ok === true ? '' : '（没对上任务）')),
                n !== null
                  ? h('button', { className: 'dsh-wb-fbtn', title: '打开这条任务', onClick: () => openEdit(n) }, icon('edit'))
                  : null,
              )
            })),
        ))
      }

      // ── 建议汇总 ────────────────────────────────────────────────────────
      //
      // 用户原话：「你要有一个下面有你解读出来的工作建议，是要增加任务，还是需要
      // 修改任务，还是要总结。你要下面要有建议的，然后让我选择。」
      //
      // 所以这里**先给一张分类汇总**，再排具体卡片：一眼能看清「这次它读出了几件
      // 事、分别是哪一类」，然后决定全采纳还是逐条看。四类对应 AI 返回的四个字段：
      //   · 增加 → tasks（草稿卡）  · 修改 → edits（改动卡）
      //   · 合并 → merges（合并卡） · 总结/清单 → reply 与 list
      //
      // **只有「增加」给一键全采纳**：新建一条待办错了删掉即可，而改动与合并动的
      // 是已经在用的数据（改错标题、并错条目比新建错难受得多），所以那两类刻意
      // 只给「逐条看」——点进表单/确认框，一条一条确认。这不是遗漏，是纪律。
      const summaryParts = []
      if (aiTasks.length > 0) summaryParts.push(aiTasks.length + ' 条新任务')
      if (aiEdits.length > 0) summaryParts.push(aiEdits.length + ' 条改动')
      // 两种合并分开报：归组（保留为子任务）与并掉（删重复）是用户完全不同的两件事，
      // 混成一个「N 处可合并」会让人以为都是要删东西的。
      const groupCount = aiMerges.filter((m) => m.mode === 'children').length
      if (groupCount > 0) summaryParts.push(groupCount + ' 处合并成计划')
      if (aiMerges.length - groupCount > 0) summaryParts.push((aiMerges.length - groupCount) + ' 处可合并')
      if (aiDeletes.length > 0) summaryParts.push(aiDeletes.length + ' 条可删除')

      // 最近一条助手回答的首行——汇总栏用它指路（「结论见上方『…』」），
      // 不重复整段：回答本身就在上面的问答区里，重复会把面板撑长。
      const lastTurn = aiTurns.length > 0 ? aiTurns[aiTurns.length - 1] : null
      const rawReply = lastTurn !== null && lastTurn.role === 'assistant' && typeof lastTurn.text === 'string'
        ? lastTurn.text.trim() : ''
      const firstLine = rawReply.split('\n')[0].replace(/^[·\s]+/, '').trim()
      const lastAiReply = firstLine.length > 40 ? firstLine.slice(0, 40) + '…' : firstLine

      if (summaryParts.length > 0) {
        rows.push(h('div', { className: 'dsh-wb-aisummary', key: 'summary' },
          h('div', { className: 'dsh-wb-aisummaryhead' }, '建议：' + summaryParts.join(' · ')),
          h('div', { className: 'dsh-wb-movepick' },
            // 总结：模型的回答已经作为问答留在上面（aiTurns），这里只给一行定位提示，
            // **不重复整段文字**——那会把面板撑得很长，而它就在上方看得见。
            lastAiReply !== ''
              ? h('span', { className: 'dsh-wb-aisummarynote' }, '结论见上方「' + lastAiReply + '」')
              : null,
            aiTasks.length > 0
              ? h('button', {
                className: 'dsh-wb-aibtn primary',
                disabled: aiBusy === true,
                title: '把 ' + aiTasks.length + ' 条新任务都按首选建议加入（改动与合并仍需逐条确认）',
                onClick: aiApplyAll,
              }, '全部增加（' + aiTasks.length + '）')
              : null,
            aiEdits.length > 0 || aiMerges.length > 0 || aiDeletes.length > 0
              ? h('span', { className: 'dsh-wb-aisummarynote' }, '改动与合并请逐条点开确认')
              : null,
          ),
        ))
      }

      // ── 建议卡：手机档一次一张，桌面档保持一列 ──────────────────────────
      //
      // 把四类建议汇成**一条队列**，两类形态读的是同一份队列——所以「第几条」
      // 在两边指的都是同一件事，不会出现手机说 2/5、桌面另算一套。
      const queue = []
      for (const t of aiTasks) queue.push({ kind: 'task', item: t })
      for (const e of aiEdits) queue.push({ kind: 'edit', item: e })
      for (const m of aiMerges) queue.push({ kind: 'merge', item: m })
      for (const d of aiDeletes) queue.push({ kind: 'delete', item: d })

      if (isMobile === true && queue.length === 1) {
        // **单条不进向导**（移动端调研的核心结论之一）。
        //
        // 「语音说一句」是最常见的一档：它只产出**一条**建议。这时候队列反而是
        // 纯噪音——「第 1 / 1 条」不含任何信息，「跳过」对唯一一条没有意义
        // （跳过了就什么都不剩），而用户还得多点一次才看得到结果。
        //
        // 单条直接给那一张卡：看完点「就这么办」，一次点击结束。
        // 用户原话「正常来说说一句话就选一个就好了」正是这个意思——
        // 说的是**别给一堆东西**，不是「给我一个有一个条目的队列」。
        const only = queue[0]
        rows.push(only.kind === 'task' ? aiTaskCard(only.item)
          : only.kind === 'edit' ? aiEditCard(only.item)
            : only.kind === 'merge' ? aiMergeCard(only.item)
              : aiDeleteCard(only.item))
      } else if (isMobile === true && queue.length > 1) {
        // 多条（图片清单那种一次拆出十几条）才走向导：这时「第 N / M 条」
        // 才真的在传达信息，逐条才有意义。
        rows.push(aiWizard(queue))
      } else {
        for (const task of aiTasks) rows.push(aiTaskCard(task))
        // 「改已有的」与「合并」的卡片。它们和草稿卡是同一层东西（都是**建议**），
        // 所以排在一起；差别只在采纳之后走哪条路。
        for (const edit of aiEdits) rows.push(aiEditCard(edit))
        for (const merge of aiMerges) rows.push(aiMergeCard(merge))
        // 删除建议：与合并卡同层（都是「动已有数据」的提议），也必须逐条确认。
        for (const item of aiDeletes) rows.push(aiDeleteCard(item))
      }

      return h('div', { className: 'dsh-wb-aiwrap', key: 'ai' }, rows)
    }

    /**
     * 建议向导（手机档）：**一次一张卡，逐步下一步**。
     *
     * 为什么不是一列卡片（原来的做法）：一次提问常常拆出好几条建议，
     * 全铺出来在手机上就是一整屏的卡片瀑布——没有进度、没有终点、
     * 每张卡的选项还被挤成窄窄一条。
     *
     * 现在：头部一条进度 + 当前那一张卡 + 底部的步进按钮。
     * 处理完（采纳或跳过）自动前进；到末尾给一句收尾，让人知道「没有漏的」。
     *
     * 卡片本体**复用桌面档那几个函数**（aiTaskCard / aiEditCard / aiMergeCard /
     * aiDeleteCard），不另写一套——两边对同一条建议的呈现与操作必须一致，
     * 否则「手机上能办、桌面上办不了」这种漂移迟早出现。
     */
    /**
     * 「不是这件事」：把一条建议从这一轮里**移除**（区别于「先放着」）。
     *
     * 为什么这个动作必须存在（移动端调研指出的缺口）：模型偶尔会读出不存在的
     * 条目——OCR 把「合计 128 元」当成一条任务、把一句寒暄当成一件要做的事。
     * 只有「跳过」的话，这类垃圾会永远留在队列里，用户每一轮都得再跳过一次，
     * 而队列的「第 N / M 条」还把它算在内，进度因此永远对不上。
     *
     * 移除之后**停在原地**（不前进）：用户刚清掉一条，下一张卡自然顶上来；
     * 如果还要他再点一次「下一条」，等于清垃圾要两步。
     */
    const aiDrop = (at) => {
      if (at === null || at === undefined) return
      if (at.kind === 'task') setAiTasks((prev) => prev.filter((t) => t.key !== at.item.key))
      else if (at.kind === 'edit') setAiEdits((prev) => prev.filter((e) => e.key !== at.item.key))
      else if (at.kind === 'merge') setAiMerges((prev) => prev.filter((m) => m.key !== at.item.key))
      else setAiDeletes((prev) => prev.filter((d) => d.key !== at.item.key))
      flash('已去掉这条')
    }

    /**
     * 总览屏：**先让用户看清这一轮总共有几件、都是什么，再决定怎么处理**。
     *
     * 依据移动端调研（GOV.UK「Complete multiple tasks」先给任务清单页；NN/g 要求
     * wizard 用步骤列表表达心智模型）。它解决两个具体问题：
     *
     *   ① **「12 条要点 12 次下一步」**——不是的。总览上直接可以「全部就这么定」
     *      （GOV.UK check-answers 的「汇总 + 一次提交」），只有带 ⚠ 的那几条才需要
     *      逐条看。图片清单里大部分条目都是明确的，「全部定」才是常见路径。
     *   ② **「8 秒看都看不完，界面还在滚动」**——一张编号列表（每条一行：标题 +
     *      日期/归位）比七张带徽章和按钮的大卡短得多，一屏能扫完。
     *
     * 每行的 ⚠ 表示「这条我拿不准，需要你定」——判据是模型没给 due 的新任务。
     * 有疑问的排前面：先把要动脑的解决掉，剩下的一键收尾。
     */
    const aiOverview = (queue) => {
      // 「拿不准」的判据：新任务没有截止日期。归位有候选的不算疑问——
      // 模型已经选了第一个候选作为默认，用户不点头也说得过去（进收件箱/进该计划）。
      const unsure = (it) => it.kind === 'task'
        && (typeof it.item.due !== 'string' || it.item.due === '')
      const rows = queue.map((q, i) => ({ q, i, dum: unsure(q) }))
      // 稳定的两段：带 ⚠ 的在前（要用户动脑），确定的在后（可以一键过）。
      const ordered = rows.filter((r) => r.dum).concat(rows.filter((r) => r.dum !== true))
      const unsureCount = rows.filter((r) => r.dum).length
      // 「全部就这么定」的两个前提（见下方按钮处的注释）：这一轮没有疑问项、
      // 且全是新任务（aiApplyAll 只新建 tasks，混了改动/合并就不能叫「全部」）。
      const otherKinds = queue.filter((q) => q.kind !== 'task').length
      const canApplyAll = unsureCount === 0 && otherKinds === 0
      const line = (r) => {
        const isTask = r.q.kind === 'task'
        // 归组（合并成计划、不删东西）在总览上要与「并掉重复」分开标——
        // 一个是重新组织结构，一个是删除数据，代价差着量级。
        const isGroup = r.q.kind === 'merge' && r.q.item.mode === 'children'
        const title = isTask ? String(r.q.item.title) : (r.q.kind === 'edit'
          ? '改：' + String(r.q.item.target)
          : (r.q.kind === 'merge'
            ? (isGroup
              ? String(r.q.item.keepTitle || r.q.item.keep) + ' ← ' + (Array.isArray(r.q.item.folds) ? r.q.item.folds.length : 0) + ' 条'
              : '合并 ' + String(r.q.item.keep))
            : '删：' + String(r.q.item.target)))
        const meta = isTask && typeof r.q.item.due === 'string' && r.q.item.due !== ''
          ? r.q.item.due.slice(5) : ''
        return h('button', {
          key: 'ov' + r.i,
          className: 'dsh-wb-ovrow' + (r.dum ? ' dum' : ''),
          title: '跳到第 ' + (r.i + 1) + ' 条（看细节再定）',
          onClick: () => { setAiStep(r.i); setAiShowOverview(false) },
        },
          h('span', { className: 'dsh-wb-ovnum' }, String(r.i + 1)),
          h('span', { className: 'dsh-wb-ovkind' }, isGroup ? '归组' : KIND_LABEL[r.q.kind]),
          h('span', { className: 'dsh-wb-ovtitle' }, title),
          r.dum ? h('span', { className: 'dsh-wb-ovwarn', title: '这条我没把握——没说时间，需要你定' }, '⚠')
            : h('span', { className: 'dsh-wb-ovmeta' }, meta),
        )
      }
      return h('div', { className: 'dsh-wb-wiz', key: 'wiz' },
        h('div', { className: 'dsh-wb-wizhead' }, h('span', { className: 'dsh-wb-wizstep' },
          '我读出 ' + queue.length + ' 件')),
        h('div', { className: 'dsh-wb-wizbody' },
          h('div', { className: 'dsh-wb-ovlist' }, ordered.map(line)),
        ),
        h('div', { className: 'dsh-wb-wizfoot' },
          // 「全部就这么定」只在**这一轮全是新任务、且没有疑问项**时才当主按钮。
          //
          // 两个限制都是刻意的：
          //   · **有 ⚠** → 主按钮改成「先看有疑问的 N 件」。有疑问还主推「全部定」，
          //     等于鼓励用户跳过自己该定的那一部分（GOV.UK 的 check-answers 也是
          //     先逐项确认、最后才 Accept）。
          //   · **混了改动/合并/删除** → 「全部定」**不能用**，因为 aiApplyAll 只
          //     新建 tasks；改动与合并动的是已有数据（改错了比建错了难受得多），
          //     必须逐条确认。按钮写「全部」而实际只做了新建，是在骗用户。
          canApplyAll
            ? h('button', {
              className: 'dsh-wb-aibtn primary',
              title: '把这 ' + queue.length + ' 件都按我填好的加进去',
              onClick: () => aiApplyAll(),
            }, '全部就这么定（' + queue.length + ' 件）')
            : h('button', {
              className: 'dsh-wb-aibtn primary',
              title: unsureCount > 0
                ? '先处理这 ' + unsureCount + ' 件我没把握的'
                : '这一轮里有改动/合并/删除，那些动的是已有数据，得逐条过',
              onClick: () => {
                // 有疑问项就先跳第一条疑问的；否则从头逐条（因为里面有要确认的改动）。
                setAiStep(unsureCount > 0 ? ordered[0].i : 0)
                setAiShowOverview(false)
              },
            }, unsureCount > 0 ? '先看有疑问的 ' + unsureCount + ' 件' : '逐条确认这几件'),
          h('button', {
            className: 'dsh-wb-chip',
            title: '一条一条过（含已确定的那些）',
            onClick: () => { setAiStep(0); setAiShowOverview(false) },
          }, '逐条看'),
        ),
      )
    }

    const aiWizard = (queue) => {
      const total = queue.length
      // 总览阶段：还没开始逐条时先给列表（见 aiOverview）。
      if (aiShowOverview === true) return aiOverview(queue)
      // 越界（处理完最后一条之后）显示收尾，而不是空白——空白会让人以为卡住了。
      const at = aiStep >= total ? null : queue[aiStep]
      const head = h('div', { className: 'dsh-wb-wizhead', key: 'wh' },
        h('span', { className: 'dsh-wb-wizstep' },
          at === null ? '都处理完了' : '第 ' + (aiStep + 1) + ' / ' + total + ' 条'),
        // 分类说明：用户看到「改动」两个字就知道这条动的是已有数据，
        // 而不是又新建一条——两类建议的风险完全不同。
        at === null ? null : h('span', { className: 'dsh-wb-wizkind' }, KIND_LABEL[at.kind]),
      )
      const foot = h('div', { className: 'dsh-wb-wizfoot', key: 'wf' },
        // 上一步：允许回头改主意（采纳过的不会撤销，只改「看哪一条」）。
        h('button', {
          className: 'dsh-wb-chip',
          disabled: aiStep === 0,
          onClick: () => setAiStep((n) => Math.max(0, n - 1)),
        }, '上一条'),
        // 回总览：NN/g 要求 wizard「让用户知道还有多少、并表达心智模型」——
        // 逐条走到第 5 条时，用户常常想再看一眼全局（还有几件、都在哪）。
        h('button', {
          className: 'dsh-wb-chip',
          title: '回到总览：看这一轮一共有几件、都到哪儿了',
          onClick: () => setAiShowOverview(true),
        }, '看全部'),
        h('button', {
          className: 'dsh-wb-chip',
          disabled: at === null,
          title: '这条先放着，之后还能用「上一条」回来找它',
          onClick: () => setAiStep((n) => Math.min(total, n + 1)),
        }, '先放着'),
        // **区分「先放着」与「不是这件事」**（移动端调研指出的一个真缺口）。
        //
        // 原来只有「跳过」，于是一个被 OCR 误读出来的条目（比如把「合计 128 元」
        // 读成了一条任务）会永远留在队列里，用户每轮都得再跳过一次。
        //   · 「先放着」= 这件事对，但我现在不想定 → 留在队列，回总览标 ⚠；
        //   · 「不是这件事」= 你读错了 → 从队列里**移除**，别再占位置。
        // 两件事的后果不同，所以是两个按钮、两句文案，不是一个。
        h('button', {
          className: 'dsh-wb-chip',
          disabled: at === null,
          title: '这条我读错了（不是我要做的事）——把它从这轮建议里去掉',
          onClick: () => aiDrop(at),
        }, '不是这件事'),
        at === null
          ? h('button', {
            className: 'dsh-wb-chip',
            onClick: () => { setAiStep(0); setAiShowOverview(true) },
          }, '再看一遍')
          : null,
      )
      if (at === null) {
        return h('div', { className: 'dsh-wb-wiz', key: 'wiz' },
          head,
          h('div', { className: 'dsh-wb-wizbody' },
            h('div', { className: 'dsh-wb-msg ai' }, '这一轮的 ' + total + ' 条都过了一遍。没有落库的都被跳过了，随时可以用「上一条」回去找。')),
          foot,
        )
      }
      // 采纳后自动前进：这正是「下一步」的那一步，不必再多点一次按钮。
      const advance = () => setAiStep((n) => n + 1)
      // 合并卡的第二个参数是 onDismiss（忽略这条），第三个才是 onDone（采纳后前进）——
      // 它比别的卡多一个口子，所以这里显式传 undefined 占住第二位。
      const body = at.kind === 'task' ? aiTaskCard(at.item, advance)
        : at.kind === 'edit' ? aiEditCard(at.item, advance)
          : at.kind === 'merge' ? aiMergeCard(at.item, undefined, advance)
            : aiDeleteCard(at.item, advance)
      return h('div', { className: 'dsh-wb-wiz', key: 'wiz' }, head, h('div', { className: 'dsh-wb-wizbody' }, body), foot)
    }

    /**
     * 浮球：AI 的**唯一入口**。
     *
     * 收起时是一颗球，点开是一块输入浮层。选这个形态而不是面板里的一行，是因为
     * 面板住在一个又宽又矮的地方——常驻一行输入等于每屏少一条任务，而「问一句」
     * 是个低频动作，它不配占这种地方。手机与桌面同一个入口，不必各记一套。
     */
    /**
     * 打开浮层 = **开一个全新的**。
     *
     * 用户原话：「下次再点开的时候应该自动清空之前那个任务，不然话又堆在一起；
     * 每次点开那个应该是一个全新的。」——它是件**输入工具**，不是一本对话记录：
     * 上次没发出去的那句话（用输入法接着说话会**接在后面**）、上一轮的问答、
     * 上一轮拆出来的草稿卡，全部清掉，打开的永远是干净的一屏。
     *
     * 代价说清楚：**没处理的 AI 草稿也会一起清**。那是建议、不是数据（真正的数据
     * 只有点过保存才落库），要一次处理多条就用草稿区那颗「全部按首选建议加入」。
     */
    const openFab = () => {
      setPlainDraft('')
      setAiText('')
      setAiPics([])
      setAiTurns([])
      setAiTasks([])
      setAiEdits([])
      setAiMerges([])
      setAiDeletes([])
      setAiList(null)
      setFabOpen(true)
    }

    const fab = () => {
      if (fabOpen !== true) {
        return h('div', { className: 'dsh-wb-fab', key: 'fab' },
          h('button', {
            className: 'dsh-wb-fabball',
            // 说的是**键盘上那颗话筒**，不是本插件自己那颗（那颗要安全上下文，手机上
            // 走 HTTP 时用不了）。点一下就弹键盘，这是手机上最短的语音路径。
            title: '说一句或问一句——点一下弹出键盘，用输入法自带的话筒说话',
            onClick: openFab,
          }, icon('mic', 20)))
      }
      return h('div', { className: 'dsh-wb-fab', key: 'fab' },
        h('div', {
          className: 'dsh-wb-fabsheet',
          // 键盘弹起来时整块上移（visualViewport 差值），否则输入框被输入法盖住。
          style: { bottom: 'calc(' + (12 + fabGap) + 'px + env(safe-area-inset-bottom,0px))' },
        },
        h('div', { className: 'dsh-wb-fabrow' },
          h('span', { className: 'dsh-wb-fabhead' }, 'AI 助手'),
          // 浮层**只有一个关闭入口**，就是这个 ✕。
          //
          // 原来快捷行里还有一颗「收起」，两者调的是同一个 `setFabOpen(false)`
          // ——同一个动作摆两个控件，用户会先想「这俩有区别吗」，而那个问题的答案
          // 对他是零价值（真机反馈：「那个收取按钮跟下面那个打叉叉有什么不同吗？
          // 如果相同的就删掉」）。删掉文字那颗，留标题行这颗常规位置。
          // 它现在是唯一入口，点击区按宿主图标按钮的标尺给到 28×28。
          h('button', {
            className: 'dsh-wb-icon dsh-wb-fabclose',
            title: '收起浮层（再点浮球还在）',
            onClick: () => setFabOpen(false),
          }, icon('close')),
        ),
        aiBlock(),
      ))
    }

    /**
     * 一张草稿卡：标题 + **专家意见** + 历史依据 + 选项 + 归位候选。
     *
     * 意见与选项来自模型，历史依据（`history`）来自 store 的 `historyHints`
     * ——两者都给，是因为模型的意见是自然语言（说不清就别说），
     * 而历史是算出来的（有几条、花了几天，可以核对）。
     */
    // onDone：向导里采纳一条之后**自动前进到下一条**——「就这么办」点下去，
    // 这一步就已经结束了，不该再让用户点一次「下一步」。桌面档不传（那边是一列）。
    const aiTaskCard = (task, onDone) => h('div', { className: 'dsh-wb-aitask', key: task.key },
      h('div', { className: 'dsh-wb-aititle', key: 't' },
        h('span', null, task.title),
        typeof task.due === 'string' && task.due !== ''
          ? h('span', { className: 'dsh-wb-aimeta', key: 'd' }, task.due) : null,
        typeof task.priority === 'string' && task.priority !== ''
          ? h('span', { className: 'dsh-wb-aimeta', key: 'p' }, priorityLabel(task.priority)) : null,
        h('button', {
          key: 'x',
          className: 'dsh-wb-aibtn',
          title: '丢弃这条',
          onClick: () => setAiTasks((prev) => prev.filter((t) => t.key !== task.key)),
        }, icon('close')),
      ),
      typeof task.advice === 'string' && task.advice !== ''
        ? h('div', { className: 'dsh-wb-advice', key: 'adv' }, '※ ' + task.advice) : null,
      Array.isArray(task.history) && task.history.length > 0
        ? h('div', { className: 'dsh-wb-aihist', key: 'hist' },
          task.history.map((x, i) => h('div', { key: 'h' + i },
            '历史：' + x.title + '（' + (x.status === 'done' ? '已完成' : '已放弃')
            + (x.days !== null && x.days !== undefined ? '，用了 ' + x.days + ' 天' : '')
            + (x.evidence > 0 ? '，附 ' + x.evidence + ' 条证据' : '') + '）')))
        : null,
      // **主动作**：按首选建议**直接加入**，不经过表单。
      // 位置在按钮**之前**——它是这张卡最该被点的那一个；下面的按钮是「我想改改」的次要路径。
      (() => {
        const pick = Array.isArray(task.candidates) && task.candidates.length > 0
          ? task.candidates[0] : { kind: 'inbox' }
        const where = pick.kind === 'plan' ? '归入「' + String(pick.title) + '」'
          : (pick.kind === 'new'
            ? '新建计划「' + String(pick.title === undefined ? '' : pick.title) + '」'
            : '放顶层')
        return h('div', { className: 'dsh-wb-aiact', key: 'now' },
          h('button', {
            className: 'dsh-wb-aibtn primary',
            title: '就这么办：直接建这条待办（' + where + '，'
              + String(task.due === undefined || task.due === '' ? '无截止' : task.due)
              + '）。想先改再存，点下面的按钮进表单',
            onClick: () => { aiAddNow(task); if (typeof onDone === 'function') onDone() },
          }, '就这么办：' + where))
      })(),
      Array.isArray(task.options) && task.options.length > 0
        ? h('div', { className: 'dsh-wb-movepick', key: 'opts' },
          h('span', { className: 'dsh-wb-movepicklabel' }, '可以这样：'),
          task.options.map((o, i) => h('button', {
            key: 'o' + i,
            className: 'dsh-wb-chip' + (i === 0 ? ' sug' : ''),
            title: o.why === '' ? '按这个来' : o.why,
            onClick: () => aiApplyOption(task, o),
          }, o.label)))
        : null,
      h('div', { className: 'dsh-wb-movepick', key: 'pick' },
        h('span', { className: 'dsh-wb-movepicklabel' }, '归入：'),
        (Array.isArray(task.candidates) ? task.candidates : []).map((c, i) => {
          if (c.kind === 'plan') {
            return h('button', {
              key: 'c' + i,
              className: 'dsh-wb-chip' + (i === 0 ? ' sug' : ''),
              title: c.why,
              onClick: () => aiApply(task, c),
            }, (i === 0 ? '建议 ↳ ' : '↳ ') + c.title)
          }
          if (c.kind === 'inbox') {
            return h('button', {
              key: 'c' + i,
              className: 'dsh-wb-chip',
              title: c.why,
              onClick: () => aiApply(task, c),
            }, '顶层')
          }
          // 新建计划：输入框 + 按钮一组。它跟其它候选**平级**，
          // 所以放在同一行里，而不是另起一块表单。
          return h('span', { key: 'c' + i, className: 'dsh-wb-aipic' },
            h('input', {
              className: 'dsh-wb-ainew',
              placeholder: '新建计划…',
              value: task.newTitle === undefined ? '' : task.newTitle,
              onChange: (e) => setNewTitle(task.key, e.target.value),
            }),
            h('button', {
              className: 'dsh-wb-chip',
              title: c.why,
              onClick: () => aiApply(task, { kind: 'new', title: task.newTitle }),
            }, '＋建计划'),
          )
        }),
      ),
    )

    const refresh = React.useCallback(() => {
      if (sessionId === undefined || sessionId === null || sessionId === '') {
        store.set({ error: '拿不到当前会话 id，无法定位工作区', loading: false })
        return
      }
      store.set({ loading: true })
      api('get', { sessionId })
        .then((r) => store.set({
          plan: r.plan, cwd: r.cwd, dir: r.dir,
          // ai 是**派生量、不落盘**：宿主有没有模型服务、默认模型是谁，每次现问。
          // 面板据此决定要不要渲染那个入口——比「渲染出来点了才报错」强。
          ai: r.ai === null || r.ai === undefined ? { available: false } : r.ai,
          error: null, loading: false,
        }))
        .catch((e) => store.set({ error: e instanceof Error ? e.message : String(e), loading: false }))
    }, [sessionId])

    React.useEffect(() => { refresh() }, [refresh])

    /**
     * 所有写入都收敛到这一个函数：统一拿回新计划、统一清错。
     * **返回这个 Promise**：「先建计划、再把待办挂进去」这类两步写入要靠它串起来
     * （第二步要用到第一步返回的新计划 id）。出错时 resolve 成 null，
     * 因为错误已经进 store.error 了，不能让调用方再崩一次。
     */
    const write = React.useCallback((method, args, onOk) => {
      return api(method, Object.assign({ sessionId }, args))
        .then((r) => {
          store.set({ plan: r.plan, error: null, moving: null, adding: null })
          if (typeof onOk === 'function') onOk(r)
          return r
        })
        .catch((e) => {
          store.set({ error: e instanceof Error ? e.message : String(e) })
          return null
        })
    }, [sessionId])

    const setTodo = React.useCallback((id, status) => write('todo-set', { todo: id, status }), [write])
    // 行内「点徽章换重要程度」已去掉（理由见 priBadge）——换档统一走详情页，
    // 所以不再需要 setPriority 这条通路。
    // 换型：待办 ↔ 计划。原地换型而不是「新建一个再搬」——用户想说的是
    // 「这就是同一件事，只是现在要往下拆」，换个容器会多出一层没有意义的嵌套。
    const setNodeKind = React.useCallback((id, type) => write(
      'node-set',
      { node: id, type },
      () => flash(type === 'plan' ? '已提升为计划' : '已降回待办'),
    ), [write])
    const addNode = React.useCallback((input, onOk) => write('node-add', input, onOk), [write])

    // ============================================================ 文件库关联
    //
    // 把节点挂到 Obsidian vault 里的文件 / 文件夹。复用 node-set / todo-set 已有的
    // fileRef / fileRemove 参数——**不新增路由**。计划走 node-set、待办走 todo-set
    // （两条路由都接受同样的字段，host 按 node 类型定位）。面板读的是
    // state.plan.vaultPath（host 在 /get 里原样带下来），决定要不要渲染可点的
    // obsidian:// 链接、以及标不标「关联已失效」。
    const fileMethod = (node) => (nodeType(node) === 'plan' ? 'node-set' : 'todo-set')
    const linkFile = React.useCallback((node, ref, kind, note) => {
      const path = (ref || '').trim()
      if (path === '') return
      write(fileMethod(node), { node: node.id, fileRef: path, fileKind: kind, fileNote: note }, () => {
        flash('已关联' + (kind === 'folder' ? '文件夹' : '文件'))
        setLinking(null)
        setLinkRef('')
        setLinkKind('file')
      })
    }, [write])
    const unlinkFile = React.useCallback((node, ref) => write(
      fileMethod(node),
      { node: node.id, fileRemove: ref },
      () => flash('已移除关联'),
    ), [write])

    /** 配置 / 清除 vault 路径（机器相关，存 plan.json 顶层）。 */
    const setVault = React.useCallback((path) => {
      return api('config-set', { sessionId, vaultPath: path })
        .then((r) => {
          store.set({ plan: r.plan, error: null })
          flash(path === '' || path === null || path === undefined ? '已清除 vault 配置' : '已配置 vault')
          return r
        })
        .catch((e) => { store.set({ error: e instanceof Error ? e.message : String(e) }); return null })
    }, [sessionId])

    /**
     * 从一次写入的返回里取出「刚动的那个节点」——**要的是带派生字段的那份**。
     * 返回体里的 `node` 只有 { id, type, title }，而 `plan.nodes` 里那份带了
     * overdue / parentSuggestions 等派生字段（见 host 的 annotate）。所以按 id
     * 回查一次，别拿 `res.node` 当完整节点用。
     * 归位建议只挂顶层待办，所以这里只看 plan.nodes 就够。
     */
    const freshNode = (res) => {
      if (res === null || res === undefined || res.node === null || res.node === undefined) return null
      const nodes = res.plan !== null && res.plan !== undefined && Array.isArray(res.plan.nodes)
        ? res.plan.nodes : []
      for (const n of nodes) if (n.id === res.node.id) return n
      return null
    }
    const doMove = React.useCallback((id, parent, index) => {
      const args = { node: id, parent }
      // index 只在明确要给的时候才传。它的语义是「**先把自己摘掉**，再在这个
      // 下标插入」（见 host 的 moveNode / 拖拽落点的计算），不传表示追加到末尾
      // ——归位选择器就走「追加」，拖拽走「精确插入」。
      if (typeof index === 'number') args.index = index
      return write('node-move', args)
    }, [write])
    const doRemove = React.useCallback((node) => {
      const extra = nodeType(node) === 'plan' ? '（连同它下面的全部子项）' : ''
      if (!window.confirm('删除「' + String(node.title) + '」' + extra + '？')) return
      write('node-remove', { node: node.id }, () => flash('已删除'))
    }, [write])
    const snapshot = React.useCallback(() => {
      api('snapshot', { sessionId, reason: 'panel' })
        .then(() => flash('已留档一个版本'))
        .catch((e) => store.set({ error: e instanceof Error ? e.message : String(e) }))
    }, [sessionId])

    // ============================================================ 详情编辑页
    //
    // 「任务和计划的所有信息都要能编辑」的落点。它**没有新增工具也没有新增路由**：
    // 表单把节点摊平成一屏标量，保存时合成一次 /node-set（新建是 /node-add），
    // 字段清单由 logic.cjs 的 formRequest 统一产出——新建与编辑共用一份，
    // 否则迟早出现「新建支持某字段、编辑不支持」。
    const openEdit = (node) => {
      setEditing(null)                 // 关掉就地改名，两个编辑器不能同时开着
      setFormEvRef('')
      setFormFileRef('')
      setFormDepPick('')
      setFormParent('')
      setMoreOpen(false)               // 编辑：只给简单信息，低频项收在「更多」里
      setForm({ mode: 'edit', id: node.id, draft: formDraftOf(node) })
    }
    /** 关掉表单。顺手清掉 AI 队列——否则取消之后它会在下一次保存时突然冒出来。 */
    const closeForm = () => { setForm(null); setAiQueue([]) }
    /** 用一份现成的草稿打开新建表单（AI 草稿走这里）。 */
    const openDraft = (draft) => {
      setFormEvRef('')
      setFormFileRef('')
      setFormParent(draft.parent === undefined ? '' : draft.parent)
      setMoreOpen(true)                // 新建：要一次填完，默认全展开
      setForm({ mode: 'new', id: null, draft })
    }
    /**
     * AI 草稿 → 表单草稿。**不直接落库**：AI 给的是草稿，标题可能不对、
     * 归属可能猜错，先让人看一眼再存，才是「AI 帮我记」而不是「AI 替我决定」。
     */
    const aiDraftOf = (task, parent) => {
      const d = emptyDraft('todo', parent === null || parent === undefined ? '' : parent)
      d.title = typeof task.title === 'string' ? task.title : ''
      if (typeof task.due === 'string' && task.due !== '') d.due = task.due
      if (typeof task.priority === 'string' && task.priority !== '') d.priority = task.priority
      if (typeof task.note === 'string' && task.note !== '') d.note = task.note
      return d
    }
    const openNew = (type, parent) => {
      const p = parent === null || parent === undefined ? '' : parent
      openDraft(emptyDraft(type, p))
    }
    const patchForm = (key, value) => {
      setForm((prev) => {
        if (prev === null) return prev
        const draft = Object.assign({}, prev.draft)
        draft[key] = value
        // 换型时状态必须归一：`active` 只对计划合法、`todo`/`doing` 只对待办合法。
        // 不归一就会提交一个对该类型非法的状态，而服务端会直接拒绝——与其让它
        // 变成一条看不懂的报错，不如在这里把选项换掉。
        if (key === 'type') {
          const list = statusListOf(value)
          if (list.indexOf(draft.status) < 0) draft.status = list[0]
        }
        return Object.assign({}, prev, { draft })
      })
    }
    const nodeById = (id) => {
      const flat = flattenNodes(plan)
      for (const item of flat) if (String(item.node.id) === String(id)) return item.node
      return null
    }
    const saveForm = () => {
      if (form === null || formSaving) return
      const errs = formErrors(form.draft)
      if (errs.length > 0) { store.set({ error: errs.join('；') }); return }
      const original = form.mode === 'edit' ? nodeById(form.id) : null
      const req = formRequest(form.draft, original)
      setFormSaving(true)
      write(req.method, req.body).then((r) => {
        setFormSaving(false)
        // write 出错时 resolve null（错误已进 store.error），此时**保留表单**——
        // 把人填了半天的东西丢掉，是比报错本身更糟的体验。
        if (r === null) return
        // 队列里还有 AI 草稿：保存完接着看下一条，直到过完为止。
        if (aiQueue.length > 0) {
          const next = aiQueue[0]
          setAiQueue(aiQueue.slice(1))
          openDraft(next)
          flash('已保存，接着看下一条 AI 草稿（还剩 ' + (aiQueue.length - 1) + ' 条）')
          return
        }
        setForm(null)
        flash(form.mode === 'new' ? '已新建' : '已保存')
      })
    }
    /** 证据增删即时生效：追加式列表不适合攒到「保存」再一起发。 */
    const addEvidenceTo = (node, kind, ref, note) => {
      const r = (ref || '').trim()
      if (r === '') return
      write('node-set', { node: node.id, evidenceKind: kind, evidenceRef: r, evidenceNote: note }, () => flash('已加一条证据'))
    }
    const removeEvidenceFrom = (node, ref, kind) => {
      write('node-set', { node: node.id, evidenceRemove: ref, evidenceKind: kind }, () => flash('已删除证据'))
    }

    const plan = state.plan
    const sum = summarize(plan)

    // ============================================================ 依赖 / 星标 / 重复（即时写）
    //
    // 三个都是「列表式」改动，与证据 / 关联一样**即时生效**，不等「保存」——
    // 攒到保存按钮里反而要算 diff，而这三样天生一次一条。
    const setStarOn = (node, on) => write('node-set', { node: node.id, star: on === true })
    // 这里原本有 setFiledOn（纳入 / 退出「工作计划」）。
    // 该动作已随 `filed` 字段一起废弃——顶层不再分栏，没有「纳入」这回事了。
    // 一条待办记下来就在那儿，要往下拆就加子项（它会自动变成计划）。
    const setRecurOn = (node, kind) => write('node-set', { node: node.id, recur: kind })
    // 收尾复盘：把没做完的顺延到明天 / 下周（写 due），或清掉 due 退回收件箱。
    // 复用 /node-set，不加工具不加路由。清空走 `clear: ['due']`（空串在 applyFields 里等同不动）。
    const setDueOn = (node, due) => write('node-set', { node: node.id, due })
    const clearDueOn = (node) => write('node-set', { node: node.id, clear: ['due'] }, () => flash('已退回收件箱'))
    const addDepOn = (node, otherId) => write('node-set', { node: node.id, blockedAdd: otherId }, () => flash('已加依赖'))
    const removeDepOn = (node, otherId) => write('node-set', { node: node.id, blockedRemove: otherId }, () => flash('已移除依赖'))
    /**
     * 勾选完成一条**叶子计划**（下面没有子项的计划）。走 /node-set 的 status——
     * 它是计划，不走 /todo-set（那限定了类型）。若它是整条链的最后一环，
     * host 会级联把上面的父也自动完成。
     */
    const togglePlanDone = (node) => write(
      'node-set',
      { node: node.id, status: node.status === 'done' ? 'active' : 'done' },
    )
    const inbox = inboxOf(plan)
    const roots = planNodes(plan)
    const isTopLevel = (id) => roots.some((n) => n.id === id)

    // ============================================================ 折叠展开
    //
    // 折叠状态是本机的显示偏好，不落进 plan.json（见文件头）。默认全展开：
    // 自动收起虽然省点击，但会让人「看不见的东西等于不存在」，而计划漏看一条
    // 的代价远大于多点一下。想快速俯瞰就按头部的「全部收起」。

    const isCollapsed = (id) => collapsed.indexOf(String(id)) >= 0
    const applyCollapse = (ids) => { setCollapsed(ids); saveCollapsed(ids) }
    const toggleCollapse = (id) => {
      const key = String(id)
      applyCollapse(isCollapsed(key) ? collapsed.filter((x) => x !== key) : collapsed.concat([key]))
    }
    /** 展开（用在「往收着的计划里加子项」这类会让新内容立刻不可见的地方）。 */
    const expand = (id) => {
      const key = String(id)
      if (isCollapsed(key)) applyCollapse(collapsed.filter((x) => x !== key))
    }
    const collapseAll = () => {
      const ids = []
      // 只收**有子节点的**计划：收一个空计划没有任何视觉效果，却会往
      // localStorage 里堆一串永远不会被读到的 id。
      const visit = (n) => {
        const kids = childrenOf(n)
        if (kids.length === 0) return
        ids.push(String(n.id))
        for (const k of kids) visit(k)
      }
      for (const r of roots) visit(r)
      applyCollapse(ids)
    }

    /** 折叠控点。叶子留一个同宽的占位，保证同层计划的标题左边缘对齐。 */
    const caret = (node) => {
      if (childrenOf(node).length === 0) {
        return h('span', { className: 'dsh-wb-caret none', key: 'caret' }, '▾')
      }
      const open = !isCollapsed(node.id)
      return h('span', {
        key: 'caret',
        className: 'dsh-wb-caret',
        title: (open ? '收起' : '展开') + '（' + descendantCount(node) + ' 个子项）',
        onClick: (e) => { e.stopPropagation(); toggleCollapse(node.id) },
      }, open ? '▾' : '▸')
    }

    // ============================================================ 就地改名

    const startRename = (node) => {
      setEditing({ id: String(node.id), original: String(node.title) })
      setEditDraft(String(node.title))
    }

    const commitRename = () => {
      const cur = editing
      setEditing(null)
      if (cur === null) return
      const title = editDraft.trim()
      // 空标题与「没改」都不发请求。服务端对空标题本来就是忽略，但白走一趟会
      // 在版本历史里留下一条「改了但什么都没变」的快照，以后回看很费解。
      if (title === '' || title === cur.original) return
      write('node-set', { node: cur.id, title }, () => flash('已改名'))
    }

    /** 改名输入框：回车提交、Esc 放弃、失焦也按提交算（点到别处不白打一遍）。 */
    const renameInput = (key) => h('input', {
      key,
      className: 'dsh-wb-rename',
      autoFocus: true,
      value: editDraft,
      onChange: (e) => setEditDraft(e.target.value),
      onClick: (e) => e.stopPropagation(),
      onKeyDown: (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commitRename() } else if (e.key === 'Escape') { e.preventDefault(); setEditing(null) }
      },
      onBlur: commitRename,
    })

    // ============================================================ 拖拽排序

    /**
     * 落点判定的三档高度：上缘 30% = 插到它前面，下缘 30% = 插到它后面，
     * 中间 = 放进去（只有计划能当容器）。边带再窄就不好点，再宽则「放进去」
     * 几乎够不着——计划标题只有一行字那么高。
     */
    const PLACE_BAND = 0.3

    const placeAt = (e, isPlan) => {
      const rect = e.currentTarget.getBoundingClientRect()
      const ratio = rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0.5
      if (ratio < PLACE_BAND) return 'before'
      if (ratio > 1 - PLACE_BAND) return 'after'
      // 待办是叶子，中间那档降级成「按上下半插到前/后」。
      return isPlan ? 'inside' : (ratio < 0.5 ? 'before' : 'after')
    }

    /**
     * 拖拽源挂在**标题**上（不是整行）。整行可拖会顺手把复选框也变成拖拽把手，
     * 想勾选却拖了一下；标题是天然的「抓住这一条」的位置，落点则仍由整行接收。
     */
    const dragFrom = (node) => ({
      draggable: true,
      onDragStart: (e) => {
        setDragId(String(node.id))
        try {
          e.dataTransfer.setData('text/plain', String(node.id))
          e.dataTransfer.effectAllowed = 'move'
        } catch (err) { /* 个别环境禁写 dataTransfer，不影响内部拖拽 */ }
      },
      onDragEnd: () => { setDragId(null); setHint(null) },
    })

    /**
     * 拖拽目标：整行接收。**只有合法落点才 preventDefault**——非法时把
     * 决定权交给浏览器，它会显示禁止光标，比我们自己画一个「无效」标记
     * 更省事也更准确。合法性一律问 dropTarget，UI 不自己判一遍（判定逻辑要单份）。
     */
    const dragOnto = (node, isPlan) => ({
      onDragOver: (e) => {
        // 先无条件拦住冒泡：body 上挂着「拖到空白处 = 移回顶层」的接收器，
        // 只要有一次没拦（比如拖到自己身上提前 return 的那一支），指示器
        // 就会在正在拖的那一行上闪出「移到顶层」。
        e.stopPropagation()
        if (dragId === null || dragId === String(node.id)) return
        const place = placeAt(e, isPlan)
        if (dropTarget(plan, dragId, String(node.id), place) === null) {
          if (hint !== null) setHint(null)
          return
        }
        e.preventDefault()
        if (hint === null || hint.id !== String(node.id) || hint.place !== place) {
          setHint({ id: String(node.id), place })
        }
      },
      onDrop: (e) => {
        e.stopPropagation()
        const place = placeAt(e, isPlan)
        const target = dropTarget(plan, dragId, String(node.id), place)
        setDragId(null)
        setHint(null)
        if (target === null) return
        e.preventDefault()
        doMove(target.node, target.parent, target.index)
        flash('已移动')
      },
    })

    /** 这一行该挂的拖拽状态类名（拖起来的那行变淡，落点行画线或高亮）。 */
    const dragClass = (id) => {
      const key = String(id)
      let cls = ''
      if (dragId === key) cls += ' dsh-wb-dragging'
      if (hint !== null && hint.id === key) cls += ' dsh-wb-drop-' + hint.place
      return cls
    }

    /**
     * 标题上的三种手势：**单击打开详情**、双击就地改名、按住拖动排序。
     *
     * 单击**曾经**是「切换完成」——那是把高频低风险的「查看」让位给了低频高
     * 风险的「改状态」：误触的代价是改状态 + 写盘 + 多留一个版本快照，而「完成」
     * 本来就有明确的控件（复选框）。任务首先是**信息载体**，点它应当是查看 / 编辑。
     * 所以单击改为打开详情，完成只走复选框（想快就点框）。
     *
     * 单击同样延后 200ms：双击会先触发两次 click，立刻打开详情的话，一次改名
     * 会被详情盖住。双击时清掉定时器（见下），所以改名不会被盖。
     */
    const titleProps = (node, base, opts) => {
      const canToggle = opts.canToggle === true
      const props = { className: base }
      // 筛选视图里的顺序是按筛选条件算出来的，拖动它没有意义（也没有接收器），
      // 所以那里只给改名，不给拖拽手柄。
      if (opts.draggable !== false) Object.assign(props, dragFrom(node))
      props.onDoubleClick = () => {
        if (clickTimer.current !== null) { clearTimeout(clickTimer.current); clickTimer.current = null }
        startRename(node)
      }
      // 完成态的视觉（删线 / 灰字）只跟状态走，与「能不能点开」无关——
      // 所以这一段不再兼作「能不能点」的开关。
      if (canToggle) {
        if (node.status === 'done') props.className += ' done'
        else if (node.status === 'dropped') props.className += ' dropped'
      }
      if (opts.noOpen !== true) {
        props.onClick = () => {
          if (clickTimer.current !== null) return
          clickTimer.current = setTimeout(() => {
            clickTimer.current = null
            openEdit(node)
          }, 200)
        }
      }
      return props
    }

    /** 标题位：改名中显示输入框，否则显示可拖可双击的标题。 */
    const titleNode = (node, base, opts) => {
      if (editing !== null && editing.id === String(node.id)) return renameInput('rename')
      return h('span', titleProps(node, base, opts || {}), node.title)
    }

    /**
     * 重要程度徽章：**纯展示**。
     *
     * 以前点一下就在高 / 中 / 低之间循环——但 `priority` 在本项目是**管控强度**
     * （决定这个节点要走多少流程），不是「重要程度」标签。把它做成行内一点就换挡，
     * 等于把一个会改变流程要求的决定，藏在一个没有确认、也不在详情页里的角落，
     * 代价与它的低调外表完全不成比例。换档统一回详情页。
     */
    const priBadge = (node) => {
      const p = node.priority === 'high' || node.priority === 'low' ? node.priority : 'normal'
      return h('span', {
        className: 'dsh-wb-pri ' + p,
        title: '重要程度：' + priorityLabel(p) + '（在详情页里改）',
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
      if (d.overdueReceipt) lines.push('⚠︎ 已逾期未回执')
      else if (d.overdueWork) lines.push('⚠︎ 已逾期未完成')
      return h('span', { className: 'dsh-wb-deleg' + (d.overdueReceipt ? ' late' : ''), title: lines.join('\n') }, text)
    }

    /**
     * 管控缺口提示。**只在「高」档显示**：normal 档那条是「建议补一个截止日期」，
     * 而绝大多数待办本来就没有截止日期——于是它变成常驻噪声，反而没人看它
     * （真机反馈：「那个感叹号是什么意思」）。high 档才是显式承诺了完整流程的，
     * 缺周期 / 缺负责人 / 完成没证据都值得摆出来。
     */
    const warnBadge = (node) => {
      const p = node.priority === 'high' || node.priority === 'low' ? node.priority : 'normal'
      if (p !== 'high') return null
      const list = Array.isArray(node.warnings) ? node.warnings : []
      if (list.length === 0) return null
      return h('span', { className: 'dsh-wb-warn', title: list.join('\n') }, icon('warn', 12))
    }

    /**
     * 落后于周期：进度没跟上时间。只在服务端算过配速（有完整周期、周期正在走）
     * 且判定落后时出现——这里不重算，阈值语义只有一处实现。
     */
    const behindChip = (node) => {
      if (node.behind !== true) return null
      const p = node.pace || {}
      const gap = typeof p.gap === 'number' ? Math.round(p.gap * 100) : null
      const lines = ['进度落后于周期']
      const text = paceText(node)
      if (text !== null) lines.push(text)
      if (typeof node.start === 'string' || typeof node.end === 'string') {
        lines.push('周期 ' + (node.start || '?') + ' ~ ' + (node.end || '?'))
      }
      return h('span', {
        className: 'dsh-wb-behind',
        title: lines.join('\n'),
      }, gap === null ? '落后' : '落后 ' + gap + '%')
    }

    /**
     * 完成证据。两种形态，回答的是同一个问题——「这条完成，凭什么信」：
     *   ⎘n  附了 n 条证据，悬停列出来；文件类证据若服务端核验不存在，标红
     *   ⊘    已完成但没有证据 → 会进「无证据的完成项」筛选，等人核验
     * 这里没有「补证据」的输入框：证据的自然生产者是 agent（它才知道自己
     * 产出了哪个文件、跑过什么命令），手填一份的代价高于让 agent 补。
     */
    const evidChip = (node) => {
      const list = evidenceList(node)
      const bad = Array.isArray(node.evidenceWarnings) ? node.evidenceWarnings : []
      if (list.length === 0) {
        if (unverifiedOf(node) !== true) return null
        return h('span', {
          className: 'dsh-wb-unverif',
          title: '已完成，但没有证据\n（AI 标的完成需要能核验的凭据；用「无证据的完成项」筛选可一次看全）',
        }, '⊘')
      }
      const lines = list.map((e) => evidenceLabel(e.kind) + '：' + String(e.ref) + (e.note ? '\n  ' + e.note : ''))
      return h('span', {
        className: 'dsh-wb-evid' + (bad.length > 0 ? ' bad' : ''),
        title: '证据 ' + list.length + ' 条\n' + lines.join('\n')
          + (bad.length > 0 ? '\n⚠︎ ' + bad.join('\n⚠︎ ') : ''),
      },       (bad.length > 0 ? '⚠︎' : '⎘') + list.length)
    }

    /**
     * 文件库关联块：列出节点挂到 Obsidian vault 的资料（文件 / 文件夹）。
     * 与证据（⎘）刻意分开——资料是「做这件事要看的」，文件夹也行，跟完没完成
     * 无关，也不进「无证据的完成项」那条审查线。
     * vault 已配置时渲染可点的 obsidian:// 链接；host 算好的 fileWarnings 命中
     * 则标红（文件可能被挪走了）。
     * **没有关联时整块不渲染**——「加一条」的入口在行内的 .dsh-wb-act 组里，
     * 不在这里；否则这个块会为每条待办留下一条看不见的 22px 空白。
     */
    const filesBlock = (node) => {
      const vaultPath = plan !== null && plan !== undefined ? plan.vaultPath : ''
      const files = filesList(node)
      // 没有任何关联、也没在「添加关联」态时，整块不渲染：块里剩下的只是一个
      // 悬停才可见的「＋关联」按钮（.dsh-wb-fbtn 是 opacity:0），而块本身实打实
      // 占掉 18px + 4px 边距——于是每个待办、每个展开的计划下面都压着一条看不见
      // 的空白，计划之间就被撑得很空。入口改挂在行内的 .dsh-wb-act 组（与 ✎/× 同级，
      // 同样悬停才出现，但完全不占纵向空间）。
      if (files.length === 0 && linking !== String(node.id)) return null
      // fileWarnings 是字符串数组（"文件不存在：<ref>"），从「：」后取出 ref 做匹配。
      const missing = Array.isArray(node.fileWarnings) ? node.fileWarnings : []
      const missingRefs = new Set(missing.map((w) => {
        const s = String(w)
        const i = s.indexOf('：')
        return i >= 0 ? s.slice(i + 1) : s
      }))
      const rows = []
      for (const f of files) {
        const ref = String(f.ref)
        const isFolder = f.kind === 'folder'
        const link = obsidianLink(vaultPath, ref)
        const label = ref.split(/[\\/]/).pop() || ref
        const inner = link !== null
          ? h('a', {
            href: link,
            target: '_blank',
            rel: 'noopener',
            title: (isFolder ? '打开文件夹：' : '打开文件：') + ref,
            onClick: (e) => e.stopPropagation(),
          }, label)
          : h('span', { className: 'dsh-wb-fref', title: (isFolder ? '文件夹：' : '文件：') + ref }, label)
        rows.push(h('div', {
          key: 'f-' + ref,
          className: 'dsh-wb-file' + (missingRefs.has(ref) ? ' missing' : ''),
        },
          h('span', { className: 'dsh-wb-fkind' }, isFolder ? '▤' : '▢'),
          inner,
          f.note ? h('span', { className: 'dsh-wb-fnote', title: f.note }, '· ' + f.note) : null,
          h('button', {
            className: 'dsh-wb-fx',
            title: '移除这条关联',
            onClick: (e) => { e.stopPropagation(); unlinkFile(node, ref) },
          }, icon('close')),
        ))
      }
      // 内联「添加关联」表单：仅在该节点处于 linking 态时展开。
      if (linking === String(node.id)) {
        rows.push(h('div', { className: 'dsh-wb-fadd', key: 'fadd' },
          h('input', {
            type: 'text',
            autoFocus: true,
            placeholder: '相对 vault 根的路径，如 项目A/需求.md',
            value: linkRef,
            onChange: (e) => setLinkRef(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); linkFile(node, linkRef, linkKind, '') } },
          }),
          h('select', { value: linkKind, onChange: (e) => setLinkKind(e.target.value) },
            h('option', { value: 'file' }, '文件'),
            h('option', { value: 'folder' }, '文件夹'),
          ),
          h('button', { onClick: () => linkFile(node, linkRef, linkKind, ''), disabled: linkRef.trim() === '' }, '关联'),
          h('button', { onClick: () => { setLinking(null); setLinkRef('') } }, '取消'),
        ))
      }
      return h('div', { className: 'dsh-wb-files', key: 'files' }, rows)
    }

    const dueSpan = (node) => {
      if (typeof node.due !== 'string' || node.due === '') return null
      return h('span', { className: 'dsh-wb-taskdue' + (node.overdue === true ? ' overdue' : '') }, node.due)
    }

    /** 归位选择器：把这条待办移进哪个计划。 */
    const movePick = (node) => {
      const targets = moveTargets(plan, node)
      // 建议是**服务端算好的派生字段**（见 host 的 suggestParent / annotate），
      // 不是客户端自己推的：这样面板和 agent 看到的建议是同一个，agent 想改判
      // 归属时不必再开一条通路。字段只挂在顶层待办上，别处取不到、也不会误用。
      const sug = Array.isArray(node.parentSuggestions) ? node.parentSuggestions : []
      const suggested = new Set(sug.map((s) => String(s.id)))
      const chips = []
      if (!isTopLevel(node.id)) {
        chips.push(h('button', {
          key: '__top__',
          className: 'dsh-wb-chip',
          onClick: () => doMove(node.id, null),
        }, '顶层（收件箱）'))
      }
      // 建议排在前面并标出来，理由挂在 title 上——用户要能看懂**为什么**推荐它，
      // 才敢一键接受；只给一个名字就成了黑箱。
      for (const s of sug) {
        chips.push(h('button', {
          key: 'sug-' + s.id,
          className: 'dsh-wb-chip sug',
          title: '建议归到「' + s.title + '」：' + s.why,
          onClick: () => doMove(node.id, s.id),
        }, '建议 ↳ ' + s.title))
      }
      for (const t of targets) {
        if (suggested.has(String(t.id))) continue
        chips.push(h('button', {
          key: t.id,
          className: 'dsh-wb-chip',
          title: '移到 ' + t.path,
          onClick: () => doMove(node.id, t.id),
        }, '↳ ' + t.title))
      }
      if (chips.length === 0) chips.push(h('span', { key: '__none__', className: 'dsh-wb-movepicklabel' }, '还没有可归位的计划'))
      chips.push(h('button', {
        key: '__cancel__',
        className: 'dsh-wb-chip',
        onClick: () => store.set({ moving: null }),
      }, '取消'))
      return h('div', { className: 'dsh-wb-movepick', key: 'pick' },
        h('span', { className: 'dsh-wb-movepicklabel' },
          // 有建议时把首要理由摊在标签上，而不是只藏在 tooltip 里——建议的说服力
          // 全在理由上，藏起来等于没给。
          sug.length > 0 ? '建议归到（' + sug[0].why + '）：' : '移到：'),
        chips)
    }

    /** 一条待办。 */
    const renderTodo = (node, depth) => {
      const done = node.status === 'done'
      const rows = [h('div', Object.assign({
        className: 'dsh-wb-task' + dragClass(node.id),
        key: 'row',
        style: { marginLeft: 'min(' + (10 + depth * 16) + 'px, 14%)' },
        title: statusLabel(node.status) + (node.note ? '\n' + node.note : '')
          + '\n（单击切换完成 · 双击改名 · 拖动可排序或归位）',
      }, dragOnto(node, false)),
        h('input', {
          type: 'checkbox',
          checked: done,
          onChange: () => setTodo(node.id, toggleStatus(node.status)),
        }),
        titleNode(node, 'dsh-wb-tasktitle', { canToggle: true }),
        // 标题之后的一切（徽章 / 日期 / 纳入计划 / 动作按钮）包成一块：
        // 窄屏时整块折到第二行，行与行之间才有一致的版式（真机反馈：
        // 不包的话「折到哪一行」取决于标题多长，看起来每行都不一样）。
        h('div', { className: 'dsh-wb-taskmeta', key: 'meta' },
        delegChip(node),
        warnBadge(node),
        behindChip(node),
        evidChip(node),
        priBadge(node),
        dueSpan(node),
        Array.isArray(node.blocked) && node.blocked.length > 0
          ? h('span', {
            className: 'dsh-wb-taskdue',
            title: '被挡住：等 ' + node.blocked.join('、'),
          }, icon('lock', 12)) : null,
        // 「纳入计划」按钮已删——顶层不再分栏，没有「纳不纳入」这个中间态。
        // 一行上少一颗常显按钮之后，待办行也更清爽（它原本每行都占一格）。
        h('button', {
          className: 'dsh-wb-act star' + (node.starred === true ? ' on' : ''),
          title: node.starred === true ? '取消星标' : '星标：接下来做（执行清单置顶）',
          onClick: (e) => { e.stopPropagation(); setStarOn(node, node.starred !== true) },
        }, icon('star')),
        // 这里不再有「编辑 / 关联资料 / 删除」按钮：单击标题就是打开详情编辑页，
        // 资料关联与删除都在详情页里（见 titleProps），
        // 原标题：
        // 行内再放一个 ✎ 是同一个入口的第二遍，还白占窄屏上宝贵的宽度。
        h('button', {
          className: 'dsh-wb-act',
          title: '归位到某个计划下',
          onClick: (e) => { e.stopPropagation(); store.set({ moving: state.moving === node.id ? null : node.id }) },
        }, icon('move')),
        h('button', {
          className: 'dsh-wb-act',
          title: '加子项：往下拆，它会自动变成计划',
          onClick: (e) => { e.stopPropagation(); expand(node.id); setNodeDraft(''); store.set({ adding: state.adding === node.id ? null : node.id }) },
        }, icon('plus')),
        ),
      )]
      if (state.moving === node.id) rows.push(movePick(node))
      rows.push(filesBlock(node))
      // 加子项：挂上第一个子项，这条待办就自动变成计划（结构决定形态）。
      if (state.adding === node.id) {
        rows.push(h('div', { className: 'dsh-wb-add', key: 'add', style: { marginLeft: 'min(' + (10 + depth * 16) + 'px, 14%)' } },
          h('input', {
            type: 'text',
            autoFocus: true,
            placeholder: '加到「' + node.title + '」下…',
            value: nodeDraft,
            onChange: (e) => setNodeDraft(e.target.value),
            onKeyDown: (e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                const title = nodeDraft.trim()
                if (title === '') return
                addNode({ title, parent: node.id }, () => { setNodeDraft(''); flash('已加待办——它现在是一条计划了') })
              }
            },
          }),
          micButton(setNodeDraft, 'mic'),
          h('button', {
            disabled: nodeDraft.trim() === '',
            onClick: () => {
              const title = nodeDraft.trim()
              if (title === '') return
              addNode({ title, parent: node.id }, () => { setNodeDraft(''); flash('已加待办——它现在是一条计划了') })
            },
          }, '记作子项'),
        ))
      }
      return h('div', { className: 'dsh-wb-todowrap', key: node.id }, rows)
    }

    /**
     * 计划的完成 / 放弃状态改用**标题样式**（删除线 + 次级色）表达，不再单占一行
     * 文字。待办早就是这么标的，计划跟着统一：省一行纵向空间，也不再和「负责人 /
     * 周期」挤在同一行里。
     */
    const titleStateClass = (node) => {
      if (node.status === 'done') return ' done'
      if (node.status === 'dropped') return ' dropped'
      return ''
    }

    /** 一个计划节点（递归）。 */
    const renderPlan = (node, depth) => {
      const kids = sortNodes(childrenOf(node))
      const meta = []
      if (node.owner) meta.push('负责人 ' + node.owner)
      if (node.start || node.end) meta.push((node.start || '?') + ' ~ ' + (node.end || '?'))
      // 状态不再进 meta：它改由标题的删除线表达（见 titleStateClass），
      // 否则「已完成」会独自占掉一整行。
      const m = node.metric
      const q = m !== null && m !== undefined && typeof m === 'object' && typeof m.target === 'number' && m.target > 0
        ? (m.current || 0) + '/' + m.target + (m.unit ? ' ' + m.unit : '')
        : null
      const progress = progressOf(node)

      const head = h('div', Object.assign({
        className: 'dsh-wb-planhead' + dragClass(node.id),
        key: 'head',
        style: { marginLeft: 'min(' + (depth * 16) + 'px, 12%)' },
        // id 不再显示出来：它是等宽不定的（`n3` 与 `n12` 宽度不同），摆在标题前
        // 会让**每条计划的标题起始位置都不一样**，看着就是「上下没对齐」。
        // 保留成 data-id，定位/排查时仍然拿得到。
        'data-id': node.id,
      }, dragOnto(node, true)),
        // 展开箭头**跟在标题后面**，不放前面。放前面时标题被顶右，而折到第二行的
        // 元信息是顶格的——两行左边缘对不齐（真机反馈「两行看起来不美观」）。
        // 挪到后面之后，标题与元信息都从最左边开始，两行是一条竖线。
        // 包一层 wrap 是为了让箭头**贴着标题**（而不是被 flex:1 顶到行尾）：
        // 标题在 wrap 里不伸张，箭头就紧跟在最后一个字后面。
        h('span', { className: 'dsh-wb-planwrap', key: 'tt' },
          titleNode(node, 'dsh-wb-plantitle' + titleStateClass(node), { canToggle: kids.length === 0 }),
          caret(node)),
        h('div', { className: 'dsh-wb-taskmeta', key: 'meta' },
        delegChip(node),
        warnBadge(node),
        behindChip(node),
        evidChip(node),
        priBadge(node),
        q !== null ? h('span', { className: 'dsh-wb-planq' }, q) : null,
        h('span', { className: 'dsh-wb-planpct' }, pct(progress)),
        // 与待办行同理：点标题即打开详情。行内也不再放「关联资料」与「删除」——
        // 这两件都在详情页里（破坏性与资料关联不该在列表里误触）。
        h('button', {
          className: 'dsh-wb-act',
          title: '在这个计划下加一项',
          // 往收着的计划里加子项要顺手展开：不展开的话新加的东西立刻不可见，
          // 看起来就像「加了但没加上」。
          onClick: (e) => { e.stopPropagation(); expand(node.id); setNodeDraft(''); store.set({ adding: state.adding === node.id ? null : node.id }) },
        }, icon('plus')),
        // 「退回收件箱」按钮也已删（同一条线：顶层不再分栏）。
        ),
      )

      // 收起来时只留标题行：进度百分比已经在标题行里，进度条与元信息属于
      // 「展开了才看」的细节。这样「全部收起」得到的是一份紧凑的主线清单。
      const open = !isCollapsed(node.id)
      const body = [head]
      if (open) {
        if (meta.length > 0) {
          body.push(h('div', { className: 'dsh-wb-planmeta', key: 'meta', style: { marginLeft: 'min(' + (depth * 16) + 'px, 12%)' } },
            meta.map((x, i) => h('span', { key: i }, x))))
        }
        // 不再画计划进度条。它横贯整行，紧贴在计划标题下面、子计划上面，读起来
        // 就是一条「下划线」——而完成度在标题行右侧已经用百分比说清楚了，这条线
        // 是重复信息，还每次吃掉 2px + 6px 边距。层级关系改由缩进表达。
      }

      // 加子项：只记「待办」这一种——它下面要是再挂东西，它会自动成为计划。
      if (open && state.adding === node.id) {
        const submit = () => {
          const title = nodeDraft.trim()
          if (title === '') return
          addNode({ title, parent: node.id }, () => { setNodeDraft(''); flash('已加待办') })
        }
        body.push(h('div', { className: 'dsh-wb-add', key: 'add', style: { marginLeft: 'min(' + (10 + depth * 16) + 'px, 14%)' } },
          h('input', {
            type: 'text',
            autoFocus: true,
            placeholder: '加到「' + node.title + '」下…',
            value: nodeDraft,
            onChange: (e) => setNodeDraft(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); submit() } },
          }),
          micButton(setNodeDraft, 'mic'),
          h('button', { onClick: () => submit(), disabled: nodeDraft.trim() === '' }, '记作待办'),
        ))
      }

      // 文件库关联：展开态才显示整块清单（和加子项、进度条一致，收起时只留标题行）。
      if (open) body.push(filesBlock(node))

      if (open) {
        for (const kid of kids) {
          body.push(nodeType(kid) === 'plan' ? renderPlan(kid, depth + 1) : renderTodo(kid, depth + 1))
        }
      }

      return h('div', { className: 'dsh-wb-plan', key: node.id }, body)
    }

    // ============================================================ 看板视图
    //
    // 看板是树形之外另一种读法：每个顶层计划（含收件箱）占一列，待办摊成卡片。
    // 它**只读** state.plan 这一份 payload，不新增任何工具或路由——和树形共用
    // 同一份 /get 下发的数据，只是换了一种二维铺法。筛选器同样生效：state.filter
    // 不是 all 时，只把命中的待办放进列里（boardColumns 内部复用 focusList 的口径）。
    //
    // 列顺序 = 顶层节点顺序（计划在前、收件箱垫后）；没有任何待办的计划列会被丢弃。
    // 列头显示计划标题 + 完成度 + 「未完成/总数」；卡片显示标题、所属子计划路径、
    // 重要程度、委派 / 落后 / 证据 / 截止等标记；已完成卡片整体淡出。
    // 写入路径与树形完全一致：勾选走 /todo-set、点标题切换完成、双击改名、徽章换档。

    /** 一张看板卡片。复用树形里那些已经写好的标记组件，避免两套实现漂移。 */
    const renderCard = (node, path) => {
      const done = node.status === 'done'
      return h('div', { className: 'dsh-wb-card' + (done ? ' done' : ''), key: String(node.id) },
        h('div', { className: 'dsh-wb-cardtop' },
          h('input', {
            type: 'checkbox',
            checked: done,
            onChange: () => setTodo(node.id, toggleStatus(node.status)),
          }),
          titleNode(node, 'dsh-wb-cardtitle', { canToggle: true, draggable: false }),
          priBadge(node),
        ),
        path !== '' && path !== undefined && path !== null
          ? h('div', { className: 'dsh-wb-cardpath', key: 'path' }, path)
          : null,
        h('div', { className: 'dsh-wb-cardmeta', key: 'meta' },
          delegChip(node),
          behindChip(node),
          evidChip(node),
          dueSpan(node),
        ),
        // 看板卡片上也要能进详情：看板是「俯瞰」视图，但看到一条要改的时候
        // 不该先切回树去找它。
        h('button', {
          className: 'dsh-wb-act',
          key: 'edit',
          title: '编辑全部信息',
          onClick: () => openEdit(node),
        }, icon('edit')),
      )
    }

    /**
     * 执行清单（MLO 的 TODO 视图）。
     *
     * 回答的问题只有一个：「**下一个动作是什么**」。树和看板展示结构，
     * 这里把结构抹平：跨所有分支把「现在能做的」排成一张清单
     * （星标 > 重要度 > 逾期/本周 > 截止），被依赖挡住的单独折叠在下面——
     * 它们不是没做，是做不了，混在一起会让人误以为拖延了。
     */
    const renderTodoList = () => {
      const { open, blocked } = todoList(plan, todayStr())
      const rows = []
      if (open.length === 0 && blocked.length === 0) {
        rows.push(h('div', { className: 'dsh-wb-empty', key: 'empty' },
          h('div', null, '没有待办。在顶部跟 AI 说一句，或直接记一条。')))
        return h('div', { className: 'dsh-wb-body', key: 'body' }, rows)
      }
      const row = (x, i) => {
        const node = x.node
        return h('div', { className: 'dsh-wb-task' + (x.starred ? ' starred' : ''), key: node.id },
          h('span', { className: 'dsh-wb-todoseq' }, String(i + 1)),
          h('input', {
            type: 'checkbox',
            checked: node.status === 'doing',
            title: node.status === 'doing' ? '进行中（点框标成完成）' : '点框直接标完成',
            onChange: () => setTodo(node.id, node.status === 'doing' ? 'done' : 'doing'),
          }),
          titleNode(node, 'dsh-wb-tasktitle', { canToggle: true }),
          // 不显示树路径：执行视图的本意就是「结构抹平」，路径属于树和看板。
          delegChip(node),
          warnBadge(node),
          priBadge(node),
          dueSpan(node),
          h('button', {
            className: 'dsh-wb-act star' + (x.starred ? ' on' : ''),
            title: x.starred ? '取消星标' : '星标：接下来做（清单置顶）',
            onClick: () => setStarOn(node, x.starred !== true),
          }, icon('star')),
          // 行尾不放「编辑」：**点标题就是打开详情**（单击统一 openEdit，见
          // titleProps）。多给一颗 ✎ 等于把同一件事说两遍，而这一行本来就窄。
        )
      }
      rows.push(h('div', { className: 'dsh-wb-aihead', key: 'oh' },
        h('span', null, '现在能做（' + open.length + '）'),
        h('span', { className: 'dsh-wb-formnote' }, '星标 > 重要度 > 逾期/本周 > 截止'),
      ))
      rows.push(h('div', { className: 'dsh-wb-formlist', key: 'open' }, open.map((x, i) => row(x, i))))
      if (blocked.length > 0) {
        rows.push(h('div', { className: 'dsh-wb-aihead', key: 'bh' },
          h('span', null, '⊠ 被挡住的（' + blocked.length + '）'),
          h('span', { className: 'dsh-wb-formnote' }, '它们等的前置还没做完'),
        ))
        rows.push(h('div', { className: 'dsh-wb-formlist', key: 'blocked' }, blocked.map((x, i) =>
          h('div', { className: 'dsh-wb-task', key: x.node.id },
            h('span', { className: 'dsh-wb-todoseq' }, '⊠'),
            titleNode(x.node, 'dsh-wb-tasktitle', { canToggle: false }),
            h('span', { className: 'dsh-wb-path' }, '等 ' + x.blockers.join('、')),
          ))))
      }
      return h('div', { className: 'dsh-wb-body', key: 'body' }, rows)
    }

    /** 一整块看板（横向铺开的列）。无内容时给一个空状态，而不是白屏。 */
    const renderBoard = () => {
      const cols = boardColumns(plan, state.filter, todayStr())
      if (cols.length === 0) {
        const label = (FILTERS.find((f) => f.id === state.filter) || {}).label || ''
        return h('div', { className: 'dsh-wb-body', key: 'body' },
          h('div', { className: 'dsh-wb-empty' },
            state.filter !== 'all'
              ? h('div', null, '「' + label + '」下没有可看的任务。')
              : h('div', null, '这个工作区还没有计划，也没有待办。'),
          ),
        )
      }
      const colsView = cols.map((col) => {
        const head = h('div', { className: 'dsh-wb-colhead', key: 'h' },
          col.kind === 'inbox'
            ? h('span', { className: 'dsh-wb-coltitle' }, '▤ 收件箱')
            : h('span', { className: 'dsh-wb-coltitle' }, String(col.title)),
          col.kind === 'plan'
            ? h('span', { className: 'dsh-wb-colpct' }, pct(col.progress))
            : null,
          h('span', { className: 'dsh-wb-colcount' }, col.open + '/' + col.total),
        )
        const cards = col.cards.map((card) => renderCard(card.node, card.path))
        return h('div', { className: 'dsh-wb-col', key: col.id },
          head,
          h('div', { className: 'dsh-wb-cards', key: 'cards' }, cards),
        )
      })
      return h('div', { className: 'dsh-wb-body dsh-wb-board', key: 'body' }, colsView)
    }

    /**
     * vault 配置块：对接 Obsidian 的入口。vaultPath 是机器相关配置，存 plan.json
     * 顶层（节点只记相对 vault 根的逻辑路径，换机器不读到对不上的绝对路径）。
     * 没配置时给「配置」按钮；配了显示路径，可改 / 可清。配置态展开内联输入框。
     */
    const vaultBlock = () => {
      const vaultPath = plan !== null && plan !== undefined ? plan.vaultPath : ''
      if (vaultEditing) {
        return h('div', { className: 'dsh-wb-vault', key: 'vault' },
          h('div', { className: 'dsh-wb-vaulthead' }, '配置 Obsidian vault 路径'),
          h('div', { className: 'dsh-wb-add' },
            h('input', {
              type: 'text',
              autoFocus: true,
              placeholder: 'vault 的绝对根目录，如 /Users/me/vault',
              value: vaultDraft,
              onChange: (e) => setVaultDraft(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); setVault(vaultDraft); setVaultEditing(false) } },
            }),
            h('button', { onClick: () => { setVault(vaultDraft); setVaultEditing(false) }, disabled: vaultDraft.trim() === '' }, '保存'),
            h('button', { onClick: () => { setVaultEditing(false); setVaultDraft('') } }, '取消'),
          ),
        )
      }
      return h('div', { className: 'dsh-wb-vault', key: 'vault' },
        h('div', { className: 'dsh-wb-vaulthead' },
          h('span', null, 'Obsidian vault'),
          vaultPath
            ? h('span', { className: 'dsh-wb-vpath', title: vaultPath }, vaultPath)
            : h('span', { className: 'dsh-wb-vpath' }, '未配置'),
        ),
        vaultPath
          ? h('div', { className: 'dsh-wb-vaultempty' },
            h('button', { className: 'dsh-wb-aibtn', onClick: () => { setVaultDraft(vaultPath); setVaultEditing(true) } }, '更改'),
            ' · ',
            h('button', { className: 'dsh-wb-aibtn', onClick: () => setVault('') }, '清除配置'),
          )
          : h('button', { className: 'dsh-wb-aibtn primary', onClick: () => { setVaultDraft(''); setVaultEditing(true) } }, '配置 vault 路径'),
        vaultPath ? h('div', { className: 'dsh-wb-vaultempty', key: 'hint' }, '文件关联会生成可点击的打开链接；AI 也能直接读库里的笔记。') : null,
      )
    }

    /**
     * 设置页（渲染）：**一个入口收拢所有工作区级配置**——Obsidian vault、
     * AI 人设，以后再加的也进这里。整块替换面板（与详情页同模式），
     * 不做成弹窗：设置是低频动作，但改的时候值得一块完整的、可滚动的版面。
     */
    const settingsPage = () => {
      const rows = [h('div', { className: 'dsh-wb-header', key: 'h' },
        h('button', {
          className: 'dsh-wb-icon',
          title: '返回',
          onClick: () => store.set({ showSettings: false }),
        }, '← 返回'),
        h('span', { className: 'dsh-wb-title' }, '设置'),
      )]
      rows.push(vaultBlock())
      rows.push(h('div', { className: 'dsh-wb-persona', key: 'persona' },
        h('div', { className: 'dsh-wb-aihead', key: 'h' },
          h('span', null, 'AI 人设（存在工作区 plan/agents.md）'),
          h('button', {
            className: 'dsh-wb-aibtn',
            title: '把「记住的事」清空，其余恢复默认',
            onClick: () => setAiPersonaDraft(aiDefault === '' ? aiPersona : aiDefault),
          }, '默认'),
          h('button', {
            className: 'dsh-wb-aibtn',
            onClick: () => setAiPersonaDraft(aiPersona),
          }, '还原'),
        ),
        h('textarea', {
          key: 'ta',
          className: 'dsh-wb-atextarea',
          rows: 14,
          value: aiPersonaDraft,
          onChange: (e) => setAiPersonaDraft(e.target.value),
        }),
        h('div', { className: 'dsh-wb-airow', key: 'row' },
          h('button', { className: 'dsh-wb-aibtn primary', onClick: savePersona }, '保存'),
          h('span', { className: 'dsh-wb-formnote' },
            '定义助手的性格、专业与边界；对它说「记住：…」会追加到「记住的事」。'),
        ),
      ))
      return rows
    }

    // ============================================================ 详情编辑页（渲染）
    //
    // 打开时**整块替换**面板：树 / 看板 / 筛选都不渲染，只留这一张表单。
    // 这样「有未保存改动」不可能悄悄发生（返回就是放弃），也用不着脏检查。
    const detailPage = () => {
      const d = form.draft
      const node = form.mode === 'edit' ? nodeById(form.id) : null
      const isNew = node === null
      const isPlan = d.type === 'plan'
      const errs = formErrors(d)
      const kids = node === null ? 0 : childrenOf(node).length
      // 未完成的子项数：> 0 时计划不能手动标 done（它的完成由子项派生）。
      const openKids = node === null
        ? 0
        : childrenOf(node).filter((c) => c.status !== 'done' && c.status !== 'dropped').length
      const vaultPath = plan !== null && plan !== undefined ? plan.vaultPath : ''

      const field = (key, label, opts) => h('div', { className: 'dsh-wb-field', key: 'f-' + key },
        h('span', { className: 'dsh-wb-label' }, label),
        h('input', Object.assign({
          className: 'dsh-wb-inp',
          value: d[key] === undefined || d[key] === null ? '' : d[key],
          onChange: (e) => patchForm(key, e.target.value),
        }, opts || {})),
      )
      const seg = (key, label, options) => h('div', { className: 'dsh-wb-field', key: 'f-' + key },
        h('span', { className: 'dsh-wb-label' }, label),
        h('div', { className: 'dsh-wb-seg' }, options.map((o) => h('button', {
          key: o.value,
          className: d[key] === o.value ? 'on' : '',
          disabled: o.disabled === true,
          title: o.title,
          onClick: () => patchForm(key, o.value),
        }, o.label))),
      )

      // 渐进披露：body = 一级（简单信息，默认可见）；more = 二级（低频 / 复杂，
      // 收在「更多」里）。点开一条任务不该像开工单——高频项与低频项不能平权重。
      const body = []
      const more = []

      body.push(h('div', { className: 'dsh-wb-field', key: 'title' },
        h('span', { className: 'dsh-wb-label' }, '标题'),
        h('input', {
          className: 'dsh-wb-inp',
          value: d.title,
          placeholder: isPlan ? '这个计划要达成什么' : '要做什么',
          onChange: (e) => patchForm('title', e.target.value),
        })))

      body.push(h('div', { className: 'dsh-wb-grid3', key: 'kinds' },
        // 类型段没有了：类型由结构派生（有子项=计划、叶子=待办），不能也不必手选。
        // 「往下拆」用行内的 ＋ 按钮，拆完空了它自己变回待办。
        seg('status', '状态', statusListOf(d.type).map((s) => ({
          value: s,
          label: statusLabel(s),
          // 计划下面还有没做完的子项时，「已完成」点不了：完成是子项派生的，
          // 做完它们它会自动完成。前端禁用 + 服务端拦截，同一个规则两层表达。
          disabled: s === 'done' && isPlan && openKids > 0,
          title: s === 'done' && isPlan && openKids > 0
            ? '下面还有 ' + openKids + ' 个未完成的子项，做完它们它会自动完成'
            : undefined,
        }))),
        seg('priority', '重要程度', PRIORITIES.map((p) => ({ value: p, label: priorityLabel(p) }))),
      ))

      // 一级只留「什么时候到期」——这是点开一条任务最想确认的；负责人是低频项，进「更多」。
      body.push(isPlan
        ? h('div', { className: 'dsh-wb-field', key: 'f-period' },
          h('span', { className: 'dsh-wb-label' }, '周期'),
          h('div', { className: 'dsh-wb-seg' },
            h('input', { className: 'dsh-wb-inp', type: 'date', value: d.start, onChange: (e) => patchForm('start', e.target.value) }),
            h('input', { className: 'dsh-wb-inp', type: 'date', value: d.end, onChange: (e) => patchForm('end', e.target.value) })))
        : field('due', '截止日期', { type: 'date' }))
      more.push(field('owner', '负责人', { placeholder: '谁负责（可空）' }))

      more.push(h('div', { className: 'dsh-wb-field', key: 'metric' },
        h('span', { className: 'dsh-wb-label' }, '量化进度（可空：留空就按子项 / 状态算）'),
        h('div', { className: 'dsh-wb-grid3' },
          h('input', { className: 'dsh-wb-inp', type: 'number', placeholder: '目标', value: d.target, onChange: (e) => patchForm('target', e.target.value) }),
          h('input', { className: 'dsh-wb-inp', type: 'number', placeholder: '当前', value: d.current, onChange: (e) => patchForm('current', e.target.value) }),
          h('input', { className: 'dsh-wb-inp', placeholder: '单位，如 个 / 篇', value: d.unit, onChange: (e) => patchForm('unit', e.target.value) }))))

      body.push(h('div', { className: 'dsh-wb-field', key: 'note' },
        h('span', { className: 'dsh-wb-label' }, '备注'),
        h('textarea', {
          className: 'dsh-wb-inp',
          rows: 3,
          value: d.note,
          onChange: (e) => patchForm('note', e.target.value),
        })))

      more.push(h('div', { className: 'dsh-wb-grid2', key: 'deleg' },
        field('to', '委派给', { placeholder: '人名 / agent（可空）' }),
        field('expectAt', '期望完成', { type: 'date' }),
      ))

      // ---- 以下三段（证据 / 关联资料 / 位置）只在编辑已有节点时出现：
      // 新建时还没有 id，追加式列表无从挂起——先建、再回来补，比在表单里
      // 攒一批「待创建」的草稿要简单，也不会出现「建了一半失败」的中间态。
      // 位置（编辑）/ 放在哪（新建）：同一个选择器，两种后果——新建时它是
      // 保存的一部分，编辑时它是即时的一次 node-move（移动不该等「保存」）。
      {
        const inboxOpt = { id: '', title: '收件箱（顶层）', depth: 0 }
        const options = isNew
          ? [inboxOpt].concat(flattenNodes(plan)
            .filter((it) => it.type === 'plan')
            .map((it) => ({ id: it.node.id, title: it.node.title, depth: it.depth })))
          : [inboxOpt].concat(moveTargets(plan, node).map((t) => ({ id: t.id, title: t.title, depth: t.depth })))
        more.push(h('div', { className: 'dsh-wb-field', key: 'move' },
          h('span', { className: 'dsh-wb-label' }, isNew ? '放在' : '位置'),
          h('div', { className: 'dsh-wb-fadd' },
            h('select', {
              value: formParent,
              onChange: (e) => {
                setFormParent(e.target.value)
                if (isNew) patchForm('parent', e.target.value)
              },
            }, options.map((t) => h('option', { key: String(t.id), value: t.id }, '　'.repeat(t.depth) + String(t.title)))),
            isNew
              ? null
              : h('button', { onClick: () => doMove(node.id, formParent === '' ? null : formParent) }, '移到此处'),
          )))
      }

      // ---- 证据与关联资料只在编辑已有节点时出现：新建时还没有 id，
      // 追加式列表无从挂起——先建、再回来补，比在表单里攒一批「待创建」的
      // 草稿要简单，也不会出现「建了一半失败」的中间态。
      if (!isNew) {
        const evs = evidenceList(node)
        more.push(h('div', { className: 'dsh-wb-field', key: 'ev' },
          evs.length > 0
            ? h('div', { className: 'dsh-wb-formlist' }, evs.map((e, i) => h('div', { className: 'dsh-wb-formrow', key: 'ev' + i },
              h('span', { className: 'dsh-wb-fmeta' }, evidenceLabel(e.kind)),
              h('span', { className: 'dsh-wb-fref', title: String(e.ref) }, String(e.ref)),
              e.note ? h('span', { className: 'dsh-wb-fmeta', title: String(e.note) }, String(e.note)) : null,
              h('button', {
                className: 'dsh-wb-fbtn',
                title: '删除这条证据',
                // 补 title：这个按钮原先没有可读名称（图标按钮必须自述），
                // 而且测试也不该再按字形找它。
                title: '删除这条证据',
                onClick: () => removeEvidenceFrom(node, e.ref, e.kind),
              }, icon('close')),
            )))
            : null,
          h('div', { className: 'dsh-wb-fadd' },
            h('select', { value: formEvKind, onChange: (e) => setFormEvKind(e.target.value) },
              EVIDENCE_KINDS.map((k) => h('option', { key: k, value: k }, evidenceLabel(k)))),
            h('input', {
              type: 'text',
              placeholder: '文件路径 / 会话 id / 命令 / 链接 / 说明',
              value: formEvRef,
              onChange: (e) => setFormEvRef(e.target.value),
            }),
            h('button', {
              onClick: () => { addEvidenceTo(node, formEvKind, formEvRef); setFormEvRef('') },
              disabled: formEvRef.trim() === '',
            }, '添加'),
          )))

        const files = filesList(node)
        more.push(h('div', { className: 'dsh-wb-field', key: 'files' },
          h('span', { className: 'dsh-wb-label' }, '关联资料（' + files.length + '）'),
          files.length > 0
            ? h('div', { className: 'dsh-wb-formlist' }, files.map((f, i) => {
              const href = obsidianLink(vaultPath, f.ref)
              return h('div', { className: 'dsh-wb-formrow', key: 'fl' + i },
                h('span', { className: 'dsh-wb-fmeta' }, fileLabel(f.kind)),
                href !== null
                  ? h('a', { className: 'dsh-wb-fref', href, title: '在 Obsidian 里打开' }, String(f.ref))
                  : h('span', { className: 'dsh-wb-fref' }, String(f.ref)),
                h('button', { className: 'dsh-wb-fbtn', title: '移除关联', onClick: () => unlinkFile(node, f.ref) }, icon('close')),
              )
            }))
            : null,
          h('div', { className: 'dsh-wb-fadd' },
            h('select', { value: formFileKind, onChange: (e) => setFormFileKind(e.target.value) },
              FILE_KINDS.map((k) => h('option', { key: k, value: k }, fileLabel(k)))),
            h('input', {
              type: 'text',
              placeholder: '相对 vault 根的路径，如 项目A/周会.md',
              value: formFileRef,
              onChange: (e) => setFormFileRef(e.target.value),
            }),
            h('button', {
              onClick: () => { linkFile(node, formFileRef, formFileKind); setFormFileRef('') },
              disabled: formFileRef.trim() === '',
            }, '关联'),
          ),
          vaultPath === '' || vaultPath === null || vaultPath === undefined
            ? h('div', { className: 'dsh-wb-formnote' }, '还没配置 vault 路径，链接不会可点。')
            : null))

        // 依赖：这条要等哪些任务做完才能做（MLO 的 blockedBy，单向阻塞）。
        const deps = Array.isArray(node.blockedBy) ? node.blockedBy : []
        const depNodes = deps.map((id) => nodeById(id)).filter((n) => n !== null)
        const depChoices = flattenNodes(plan).filter((it) => it.type === 'todo'
          && String(it.node.id) !== String(node.id)
          && !deps.includes(String(it.node.id)))
        more.push(h('div', { className: 'dsh-wb-field', key: 'deps' },
          h('span', { className: 'dsh-wb-label' }, '依赖（这些做完才能做这条）'),
          depNodes.length > 0
            ? h('div', { className: 'dsh-wb-formlist' }, depNodes.map((d) => h('div', { className: 'dsh-wb-formrow', key: d.id },
              h('span', { className: 'dsh-wb-fmeta' }, d.status === 'done' ? '✓ 已完成' : '◷ 未完成'),
              h('span', { className: 'dsh-wb-fref' }, String(d.title)),
              h('button', { className: 'dsh-wb-fbtn', title: '移除依赖', onClick: () => removeDepOn(node, d.id) }, icon('close')),
            )))
            : null,
          h('div', { className: 'dsh-wb-fadd' },
            h('select', {
              value: formDepPick,
              onChange: (e) => setFormDepPick(e.target.value),
            },
              h('option', { value: '' }, '要等哪条任务…'),
              depChoices.map((it) => h('option', { key: String(it.node.id), value: String(it.node.id) }, '　'.repeat(it.depth) + String(it.node.title)))),
            h('button', {
              disabled: formDepPick === '',
              onClick: () => { addDepOn(node, formDepPick); setFormDepPick('') },
            }, '添加'),
          )))

        // 星标是高频（「我正在做 / 接下来做」），留在一级；重复是低频，进「更多」。
        // 两者都即时写（列表式改动不等保存，与证据 / 关联一致）。
        body.push(h('div', { className: 'dsh-wb-field', key: 'star' },
          h('span', { className: 'dsh-wb-label' }, '标记'),
          h('div', { className: 'dsh-wb-seg' },
            h('button', {
              className: node.starred === true ? 'on' : '',
              title: '星标：执行清单里置顶',
              onClick: () => setStarOn(node, node.starred !== true),
            }, '★ 我正在做 / 接下来做'))))
        more.push(h('div', { className: 'dsh-wb-field', key: 'recur' },
          h('span', { className: 'dsh-wb-label' }, '重复（完成时自动生成下一条并顺推截止）'),
          h('div', { className: 'dsh-wb-seg' },
            [['', '不重复'], ['week', '每周'], ['month', '每月']].map(([k, label]) => h('button', {
              key: k,
              className: ((node.recur !== null && node.recur !== undefined && node.recur.kind) || '') === k ? 'on' : '',
              onClick: () => setRecurOn(node, k === '' ? 'none' : k),
            }, label)))))

      }

      // 删除：破坏性操作，不和「保存 / 取消」并排（误触代价太高），收进「更多」。
      if (node !== null) {
        more.push(h('div', { className: 'dsh-wb-field', key: 'del' },
          h('span', { className: 'dsh-wb-label' }, '危险操作'),
          h('button', {
            className: 'dsh-wb-aibtn',
            title: '删除这个节点',
            onClick: () => {
              const extra = nodeType(node) === 'plan' ? '（连同它下面的全部子项）' : ''
              if (!window.confirm('删除「' + String(node.title) + '」' + extra + '？')) return
              write('node-remove', { node: node.id }, () => { flash('已删除'); closeForm() })
            },
          }, '删除')))
      }

      // 「更多」折叠条。窄面板放不下长标签，所以按钮上只写「更多 ▾」，
      // 具体含哪些项交给 title 悬停——既省宽度又不丢信息。
      if (more.length > 0) {
        const moreLabel = '负责人 / 量化进度 / 委派 / 位置 / 证据 / 关联资料 / 依赖 / 重复 / 删除'
        body.push(h('button', {
          className: 'dsh-wb-morebtn',
          key: 'morebtn',
          title: (moreOpen ? '收起：' : '展开：') + moreLabel,
          onClick: () => setMoreOpen((v) => !v),
        }, moreOpen ? '收起更多 ▴' : '更多 ▾'))
        if (moreOpen) for (let mi = 0; mi < more.length; mi++) body.push(more[mi])
      }

      const rows = []
      rows.push(h('div', { className: 'dsh-wb-formhead', key: 'fh' },
        h('button', { className: 'dsh-wb-icon', title: '返回（不保存）', onClick: closeForm }, '← 返回'),
        h('span', { className: 'dsh-wb-formtitle' },
          isNew ? (isPlan ? '新建计划' : '新建待办') : (isPlan ? '编辑计划' : '编辑待办')),
        node !== null ? h('span', { className: 'dsh-wb-formsub' }, String(node.title)) : null,
        // 保存紧跟头栏（不随表单滚动）。理由见 CSS 里 .dsh-wb-formacts 的注释：
        // 手机上输入法会盖住滚动区底部，保存在底部等于要求人先收键盘再点。
        h('div', { className: 'dsh-wb-formacts', key: 'acts' },
          h('button', {
            className: 'dsh-wb-aibtn primary',
            disabled: formSaving || errs.length > 0,
            title: errs.length > 0 ? errs.join('；') : '保存全部改动',
            onClick: saveForm,
          }, formSaving ? '保存中…' : '保存'),
        ),
      ))
      if (state.flash !== '') rows.push(h('div', { className: 'dsh-wb-flash', key: 'flash' }, state.flash))
      if (state.error !== null && state.error !== undefined) {
        rows.push(h('div', { className: 'dsh-wb-err', key: 'err' }, state.error))
      }
      rows.push(h('div', { className: 'dsh-wb-form', key: 'form' },
        // 校验错误挪到表单**顶部**：保存按钮现在在头栏，而它被禁用时原因要立刻
        // 看得见；留在滚动区最底下就等于让人自己去翻。
        errs.length > 0 ? h('div', { className: 'dsh-wb-formerr', key: 'errs' }, errs.join('；')) : null,
        body,
      ))
      return h('div', { className: 'dsh-wb-wrap' }, rows)
    }

    // 详情编辑页与设置页优先：打开时它们本身就是一屏，不必再往下走树 / 看板的组装。
    // （浮球只在主视图那一个 return 里挂——详情页/设置页是整屏，浮球压在上面
    //   既不合适、也会挡住表单底部的字段。）
    if (form !== null) return detailPage()
    if (state.showSettings === true) return h('div', { className: 'dsh-wb-wrap' }, settingsPage())

    const rows = []
    const today = todayStr()
    // 收尾复盘的对象：今天组里的未做完项 = 逾期 + 今天到期（upcomingByDay 已把逾期滚入今日组）。
    const unfinished = (upcomingByDay(plan, today).days.find((d) => d.date === today) || { items: [] }).items
    rows.push(h('div', { className: 'dsh-wb-header', key: 'h' },
      // 视图切换兼作表头标题：左上角原来那个「工作计划」标题是重复的——分段控件
      // 的第一个按钮就叫「工作计划」，它本身就是这块面板的名字，再写一遍是噪音。
      h('div', { className: 'dsh-wb-viewtoggle', key: 'vt' },
        h('button', {
          className: 'dsh-wb-vbtn' + (view === 'tree' ? ' on' : ''),
          title: '工作计划：按层级展开计划与子计划',
          onClick: () => setViewPersist('tree'),
        }, '工作计划'),
        h('button', {
          className: 'dsh-wb-vbtn' + (view === 'todo' ? ' on' : ''),
          title: '当前任务：跨所有分支把「现在能做的」汇成一张清单（被挡住的单独折叠）',
          onClick: () => setViewPersist('todo'),
        }, '当前任务'),
        h('button', {
          className: 'dsh-wb-vbtn' + (view === 'board' ? ' on' : ''),
          title: '看板：每个计划占一列，待办摊成卡片',
          onClick: () => setViewPersist('board'),
        }, '看板'),
      ),
      h('div', { className: 'dsh-wb-headright' },
        // 这里不再有「＋ 新建」：新建的入口就是顶部那行 AI 输入（说一句，模型给草稿，
        // 计划与待办都在草稿里成形），表头只留「看/管」这类控件。
        // 折叠控点只在真有嵌套时出现：一层都没有的时候，两个按钮做什么都不发生。
        // 收起 / 展开合成**一个**按钮：同一个位子按当前状态切换，图标与提示都跟着变
        // （还折着东西时给「全部展开」，否则给「全部收起」）。表头按钮已经够多了。
        sum.depth >= 2 ? h('button', {
          className: 'dsh-wb-icon',
          title: collapsed.length > 0 ? '全部展开' : '全部收起（只看主线）',
          onClick: () => (collapsed.length > 0 ? applyCollapse([]) : collapseAll()),
        }, collapsed.length > 0 ? icon('expand') : icon('collapse')) : null,
        // 表头不再显示整体完成度，也不放「留档一个版本」——版本留档是自动的
        // （每次写入前都会归档），要手动留档让 agent 调 plan_snapshot 即可。
        h('button', { className: 'dsh-wb-icon', title: '刷新', onClick: refresh, disabled: state.loading }, icon('refresh')),
        // 设置：工作区级配置收拢到一个界面（vault、AI 人设……）。
        h('button', {
          className: 'dsh-wb-icon',
          title: '设置：Obsidian vault、AI 人设',
          onClick: () => {
            store.set({ showSettings: true })
            setFabOpen(false)
            if (aiPersona === '') loadPersona()
          },
        }, icon('gear')),
        // 收尾复盘（Sunsama 式）：每天收工前把没做完的顺延，而非留着堆。
        // 只在真有未做完项时才出现——没东西要复盘时它不该占一行。
        unfinished.length > 0 ? h('button', {
          className: 'dsh-wb-icon' + (shutdownOpen ? ' on' : ''),
          key: 'shutdown',
          title: '收尾复盘：把没做完的重新规划，而非留着堆',
          onClick: () => setShutdownOpen((v) => !v),
        }, '收尾 ' + unfinished.length) : null,
      ),
    ))
    rows.push(h('div', { className: 'dsh-wb-bar', key: 'bar' },
      h('div', { className: 'dsh-wb-bar-fill', style: { width: barWidth(sum.progress) } }),
    ))

    // 收尾复盘面板：把未做完项逐条重新规划，而非留着堆。复用到期的写通道，
    // 顺延走 deferDate（明天 / 下周），「稍后」清掉 due 退回收件箱。
    const shutdownRow = (item) => {
      const node = item.node
      const isLeaf = item.type === 'todo'
      return h('div', { className: 'dsh-wb-shrow', key: item.path },
        titleNode(node, 'dsh-wb-tasktitle', { canToggle: isLeaf, draggable: false }),
        h('div', { className: 'dsh-wb-shact' },
          h('button', { className: 'dsh-wb-act', onClick: () => { setDueOn(node, deferDate(today, 'tomorrow')); flash('顺延到明天') } }, '明天'),
          h('button', { className: 'dsh-wb-act', onClick: () => { setDueOn(node, deferDate(today, 'nextweek')); flash('顺延到下周') } }, '下周'),
          h('button', { className: 'dsh-wb-act', onClick: () => clearDueOn(node) }, '稍后'),
          isLeaf
            ? h('button', { className: 'dsh-wb-act done', onClick: () => setTodo(node.id, 'done') }, '完成')
            : h('button', { className: 'dsh-wb-act done', onClick: () => togglePlanDone(node) }, '完成'),
        ),
      )
    }
    if (shutdownOpen && unfinished.length > 0) {
      rows.push(h('div', { className: 'dsh-wb-shutdown', key: 'shutdown' },
        h('div', { className: 'dsh-wb-shutdown-head' },
          h('span', null, '收尾复盘 · 没做完 ' + unfinished.length + ' 条'),
          h('button', { className: 'dsh-wb-act', title: '收工', onClick: () => setShutdownOpen(false) }, '完成')),
        unfinished.map(shutdownRow)))
    }

    // (AI 入口不在这里——它整体搬到了底部那颗浮球上，见 fab()。
    //  面板顶部不再有一个常驻输入行：又把纵向空间还给了任务列表。)

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

    // 自定义视图（AI 清单存下来的）：和筛选按钮同一行语义——点了切换「看什么」。
    const savedViews = loadViews()
    if (savedViews.length > 0) {
      rows.push(h('div', { className: 'dsh-wb-filters', key: 'views' },
        savedViews.map((v) => h('button', {
          key: v.name,
          className: 'dsh-wb-chip' + (state.custom === v.name ? ' on' : ''),
          title: '自定义视图：' + v.name + '（点击开关）',
          onClick: () => store.set({ custom: state.custom === v.name ? null : v.name }),
        }, '视图 · ' + v.name))))
    }

    if (state.flash !== '') rows.push(h('div', { className: 'dsh-wb-flash', key: 'flash' }, state.flash))
    if (state.error !== null && state.error !== undefined) {
      rows.push(h('div', { className: 'dsh-wb-err', key: 'err' }, state.error))
    }
    const body = []

    // 执行清单（MLO 的 TODO 视图）：一眼看到下一个动作是什么。
    if (view === 'todo') {
      body.push(renderTodoList())
    }

    // 自定义视图（AI 清单存下来的）：按保存时的顺序列出，做完的自动消失。
    if (state.custom !== null && state.custom !== undefined && state.custom !== '') {
      const v = loadViews().find((x) => x.name === state.custom)
      if (v === undefined) {
        // 视图定义被删了：**不要在渲染里 store.set**（渲染期副作用会级联重渲），
        // 画一句空状态，让下一次交互自然把 custom 清掉。
        body.push(h('div', { className: 'dsh-wb-empty', key: 'cv-gone' }, '这个视图不存在了。'))
      } else {
        const items = viewItems(plan, v.ids)
        body.push(h('div', { className: 'dsh-wb-customview', key: 'cv' },
          h('div', { className: 'dsh-wb-aihead' },
            h('span', null, '≡ ' + v.name + '（' + items.length + '）'),
            h('button', {
              className: 'dsh-wb-aibtn',
              title: '删除这个视图（只删本机的视图定义，不动任务）',
              onClick: () => {
                saveViews(loadViews().filter((x) => x.name !== v.name))
                store.set({ custom: null })
              },
            }, '删除视图'),
          ),
          items.length === 0
            ? h('div', { className: 'dsh-wb-empty' }, '清单里的任务都做完（或被删）了。')
            : h('div', { className: 'dsh-wb-formlist' }, items.map((n, i) => h('div', { className: 'dsh-wb-formrow', key: n.id },
              h('span', { className: 'dsh-wb-fmeta' }, String(i + 1)),
              titleNode(n, 'dsh-wb-tasktitle', { canToggle: true, draggable: false }),
              h('button', { className: 'dsh-wb-fbtn', title: '打开详情', onClick: () => openEdit(n) }, icon('edit')),
            ))),
        ))
      }
    }

    if (view === 'board') {
      rows.push(renderBoard())
      if (state.cwd !== '') rows.push(h('div', { className: 'dsh-wb-footer', key: 'f', title: state.cwd }, state.cwd))
      return h('div', { className: 'dsh-wb-wrap' }, rows)
    }

    if (state.filter !== 'all') {
      // 聚焦行：扁平列表与未来日程共用（两处各画一遍，迟早会长出不一致）。
      const focusRow = (item) => {
        const node = item.node
        const isLeaf = item.type === 'todo'
        // 完成语义一体化：叶子计划（无子项）也能勾选完成，只是通路不同
        // （计划走 /node-set 的 status，待办走 /todo-set）。
        const canCheck = isLeaf || childrenOf(node).length === 0
        return h('div', { className: 'dsh-wb-focus', key: item.path },
          canCheck
            ? h('input', {
              type: 'checkbox',
              checked: node.status === 'done',
              onChange: () => (isLeaf
                ? setTodo(node.id, toggleStatus(node.status))
                : togglePlanDone(node)),
            })
            : null,
          titleNode(node, 'dsh-wb-tasktitle', { canToggle: isLeaf, draggable: false }),
          h('span', { className: 'dsh-wb-path' }, (isLeaf ? '' : typeLabel(item.type) + ' ') + item.path),
          delegChip(node),
          warnBadge(node),
          behindChip(node),
          evidChip(node),
          priBadge(node),
          isLeaf ? dueSpan(node) : (node.end ? h('span', { className: 'dsh-wb-taskdue' + (node.overdue === true ? ' overdue' : '') }, node.end) : null),
          h('button', {
            className: 'dsh-wb-act',
            title: '编辑全部信息',
            onClick: () => openEdit(node),
          }, icon('edit')),
        )
      }

      // 「未来 7 天」是一个**时间视角**，不是一个筛选结果：同一批事项按天摊开
      // 才回答得了「下周三我有什么事」。所以这一档走按天分组；逾期项按 TeuxDeux
      // 顺延滚入「今天」组（红标区分），不单独置顶成段。其余筛选器仍是扁平列表。
      if (state.filter === 'week') {
        const up = upcomingByDay(plan, todayStr())
        if (up.days.length === 0) {
          body.push(h('div', { className: 'dsh-wb-empty', key: 'noup' },
            h('div', null, '未来 7 天没有安排。')))
        }
        for (const d of up.days) {
          const isToday = d.date === todayStr()
          body.push(h('div', { className: 'dsh-wb-daygroup', key: d.date },
            h('div', { className: 'dsh-wb-dayhead' + (isToday ? ' today' : '') },
              d.label + (isToday ? ' · 今天' : '')),
            d.items.map(focusRow)))
        }
        rows.push(h('div', { className: 'dsh-wb-body', key: 'body' }, body))
        if (state.cwd !== '') rows.push(h('div', { className: 'dsh-wb-footer', key: 'f', title: state.cwd }, state.cwd))
        return h('div', { className: 'dsh-wb-wrap' }, rows)
      }

      const items = focusList(plan, state.filter, todayStr())
      const label = (FILTERS.find((f) => f.id === state.filter) || {}).label || ''
      if (items.length === 0) {
        body.push(h('div', { className: 'dsh-wb-empty', key: 'nofocus' },
          h('div', null, '「' + label + '」下没有未完成的事项。')))
      }
      for (const item of items) body.push(focusRow(item))
      rows.push(h('div', { className: 'dsh-wb-body', key: 'body' }, body))
      if (state.cwd !== '') rows.push(h('div', { className: 'dsh-wb-footer', key: 'f', title: state.cwd }, state.cwd))
      return h('div', { className: 'dsh-wb-wrap' }, rows)
    }

    // 当前任务视图到此为止：它只回答「下一个动作是什么」。收件箱与工作计划是
    // **结构视图**的内容，跟着铺进来就等于把刚抹平的结构又原样铺回去，切视图白切。
    if (view === 'todo') {
      rows.push(h('div', { className: 'dsh-wb-body', key: 'body' }, body))
      if (state.cwd !== '') rows.push(h('div', { className: 'dsh-wb-footer', key: 'f', title: state.cwd }, state.cwd))
      return h('div', { className: 'dsh-wb-wrap' }, rows)
    }

    // ── 顶层：一条平铺的列表，**不再分「收件箱」与「工作计划」两栏** ──────
    //
    // 用户原话：「不要分收件箱和工作计划了，那是直接全部变成了这个工作计划。」
    //
    // 合并是对的：那个区分制造了一个**用户并不关心的中间态**——刚记下的一条待办
    // 既不属于哪个计划、又还不算「工作计划」，于是界面要分两栏、每行还要挂一颗
    // 「纳入计划」催他决定。真正该回答的只有一个问题：**它是什么、要不要往下拆**，
    // 而这个由结构派生（有子项=计划、没有=待办）已经答了（见 nodeType）。
    //
    // 所以现在读作：**待办与计划平铺在一起**，勾选框、徽章、动作都按各自的类型来。
    // 一条待办想往下拆，直接给它加子项——它自己就变成计划了，不需要先「纳入」什么。
    // 顺序仍走 sortNodes（未完成在前、已完成沉底），与过去一致。
    const tops = sortNodes(planNodes(plan))
    // 标题栏保留一行：它现在只报数量，起「这里是你全部的顶层条目」的作用。
    // 没有它，一屏待办会不知道自己在看什么层级。
    if (tops.length > 0) {
      body.push(h('div', { className: 'dsh-wb-secthead', key: 'sh' },
        h('span', { className: 'dsh-wb-secttitle' }, '全部'),
        h('span', { className: 'dsh-wb-count' }, tops.length + ' 项'),
      ))
    }
    for (const node of tops) {
      // 类型决定用哪个渲染器——这正是「类型由结构派生」在界面上的落点：
      // 有子项的走 renderPlan（带进度条与折叠），没有的走 renderTodo。
      body.push(nodeType(node) === 'plan' ? renderPlan(node, 0) : renderTodo(node, 0))
    }

    if (!sum.hasPlan) {
      body.push(h('div', { className: 'dsh-wb-empty', key: 'empty' },
        // 文案跟着入口走：手机档的入口是底部输入条，桌面档是浮球。
        // （原来无条件写「点右下角那颗浮球」，而浮球在手机档已经没有了——
        //   用户会照着找一颗根本不存在的球。）
        h('div', null, isMobile ? '在下面的输入条说一句就行——' : '点右下角那颗浮球，跟 AI 说一句就行——'),
        h('div', { style: { marginTop: '6px', color: 'rgba(127,127,127,.95)' } },
          '「帮我把这个季度的工作拆成计划」'),
        h('div', { style: { marginTop: '8px', fontSize: '11px' } },
          '计划会落在 ' + (state.dir || '<工作区>/plan') + '；需要 vault / AI 人设请点右上角「设置」'),
      ))
    }

    // （原来的「工作计划」独立一栏已合并进上面的顶层平铺列表。）

    // vault / AI 人设配置统一收进右上角「设置」，不再在各视图里平铺。
    // 落在空白处 = 移回顶层（收件箱）。与 ↳ 选择器并存：选择器适合跨很远的目标，
    // 拖动适合挪到眼前的位置。接收器挂在 body 上，所以行内必须先 stopPropagation。
    if (hint !== null && hint.id === null) body.push(h('div', { className: 'dsh-wb-rootdrop', key: 'rootdrop' }))


    rows.push(h('div', {
      className: 'dsh-wb-body',
      key: 'body',
      onDragOver: (e) => {
        if (dragId === null) return
        if (dropTarget(plan, dragId, null, 'after') === null) {
          if (hint !== null) setHint(null)
          return
        }
        e.preventDefault()
        if (hint === null || hint.id !== null) setHint({ id: null, place: 'root' })
      },
      onDrop: (e) => {
        if (dragId === null) return
        const target = dropTarget(plan, dragId, null, 'after')
        setDragId(null)
        setHint(null)
        if (target === null) return
        e.preventDefault()
        doMove(target.node, target.parent, target.index)
        flash('已移到顶层')
      },
    }, body))
    if (state.cwd !== '') rows.push(h('div', { className: 'dsh-wb-footer', key: 'f', title: state.cwd }, state.cwd))

    // 手机档：底部常驻输入条（借宿主输入框预填），**不要浮球**——用户明确要求
    // 「手机版不需要浮球，直接用现在的输入框」。桌面档保持原样（浮球是那里唯一的
    // AI 入口，面板住在一个又宽又矮的地方，常驻一行会每屏少一条任务）。
    //
    // 两者是**互斥**的结构（不是同一元素的两套样式）：留着浮球会和常驻输入条
    // 抢同一份 nodeDraft，出现「在下面打字、浮球里也跟着变」这种怪状。
    // 手机档：**插件自己的小 composer 常驻面板底部**——输入框 + 图片 + 语音 + 确认，
    // 有模型时走 /ai-parse 把文字/图片拆成任务草稿（这是用户要的「输入图片，让它
    // 识别，然后做成任务」），没模型时直接落库。不要浮球。
    //
    // 手机档的底部常驻块：**收起时只有一条输入行，展开时才是那一整块 AI 内容**。
    //
    // 这是对「常驻」的修正（设计结论）：常驻的应该是**输入条本身**，不是
    // 「输入条 + 结果区」。原来的实现把 aiBlock() 整块（问答、草稿卡、清单卡、
    // 建议汇总栏…）一次性常驻在底部，于是：
    //   · 提交前就占满 60% 屏高（390×780 的屏上约 470px）；
    //   · 和上面的计划树形成**两个 overflow-y:auto 容器争手势**，面板里
    //     出现两条互不相干的滚动条；
    //   · 计划树实际可见不足 180px，只剩两三条待办。
    //
    // 现在按 `aiExpanded` 分两态：
    //   · 收起（默认）：只渲染输入行，56px 一条，不预渲染任何结果；
    //   · 展开：把 aiBlock() 整块放出来（用户按了发送/问了问题之后才需要它）。
    // 判定「该不该展开」不交给用户点按钮——由提交结果决定（见 runAi / submitPlain）：
    // 只有 reply 或草稿卡真的产生了，才升起来。这样「记一条」这种高频动作提完即落库，
    // 屏幕不会被一块没人看的结果区长期占住。
    //
    // 仍然复用 aiBlock()：手机与桌面共享同一份 AI 逻辑，不各自漂移。
    const mobileDock = () => h('div', {
      className: 'dsh-wb-dockai' + (aiExpanded === true ? ' on' : ''),
      key: 'dockai',
      // 键盘避让：键盘弹起时把它整体抬 fabGap 那么高。
      //
      // 这里用 margin-bottom 而不是像浮层那样改 `bottom`：dock 是**文档流里的
      // 最后一行**（flex 列），不是 fixed 定位——给它 bottom 是不生效的，
      // 而 margin 会把这个盒子往上推，同时 flex 的 body 自动让出高度，
      // 视觉上就是「整块连同上面的计划树一起抬高」。
      //
      // 展开时（sheet）再加一点额外间距，免得贴着键盘顶边太局促。
      style: fabGap > 0 ? { marginBottom: 'calc(' + fabGap + 'px + var(--wb-sp-2))' } : undefined,
    }, aiBlock())

    return h('div', { className: 'dsh-wb-wrap' }, rows, isMobile ? mobileDock() : fab())
  }

  /**
   * 侧栏页脚入口：一个「工作计划」按钮。
   *
   * 它有两个用处，而且**第二个是白拿的**：
   *   ① 桌面：侧栏页脚多一个进入工作台的入口（工作台 tab 本身还在）；
   *   ② 手机：手机外壳插件 `dsh-zen-remote` 会扫描
   *      `[data-slot="sidebar.footer.action"]` 的**每个直接子节点**，把第三方
   *      插件的入口**自动收成主屏的一颗 chip**（它的 `scanHarvest`）。于是这个
   *      按钮自动出现在手机主屏的 chips 行里，我们一行 zen 的代码都不用改。
   *
   * 所以这个组件的形态是被收割规则**约束**的，不是随便写的：
   *   · 根节点必须是 `<button>`（`scanHarvest` 取「直接子节点里第一个
   *     可点元素」，返回 Fragment 多根会让第二个根也变成一颗 chip）；
   *   · 必须有**可见文字**——chip 的名字取 `textContent`，空了整条被丢掉；
   *     由此还有一条：**chip 的名字里不许混进计数**——它是 `textContent`，
   *     所以计数只能挂在 CSS 伪元素上（见 `.dsh-wb-entry::after`）；
   *   · 带一个 `<svg>`——chip 的图标是从它深拷贝出来的；
   *   · **不能**带 `data-mobile-nav` 属性（那是 zen 自己的标记，它据此跳过
   *     自己渲染的节点）。
   */
  const WorkbenchEntry = () => {
    const st = useSnapshot()
    const sum = summarize(st.plan)
    return h('button', {
      type: 'button',
      className: 'dsh-wb-entry',
      title: '工作计划：打开工作台面板',
      'data-dsh-workbench-entry': 'true',
      // 未完成数走 data-* + 伪元素，不进 textContent（否则会变成手机 chip 的名字）。
      'data-count': sum.open > 0 ? String(sum.open) : undefined,
      onClick: () => {
        // 走官方右侧栏的**服务**，而不是去代点某个按钮。
        //
        // 官方 openTab **只收 kind 字符串**，不收 better-sidebar 那种 `{ type }` 对象；
        // 也没有底部工作台，所以 better-sidebar 时代那条「不传 target:'bottom'」
        // 的分叉纪律在这里不存在——`ctx.sidebarRight.openTab(kind)` 就是打开右栏。
        // 类型未注册时它会 throw（官方契约：那是接线错误，不是用户错误）。
        try {
          sidebarRight.openTab(TAB_KIND)
        } catch (e) {
          console.error('[dsh-workbench] 打开工作面板失败', e)
        }
      },
    },
    icon('target', 16),
    h('span', { className: 'dsh-wb-entrylabel' }, '工作计划'))
  }
  ctx.effect(() => slots.inject('sidebar.footer.action', () => slots.register({
    name: 'sidebar.footer.action',
    id: 'dsh-workbench-entry',
  }, WorkbenchEntry)), 'dsh-workbench: sidebar footer entry')

  // ── 官方右侧栏的 tab 类型：两阶段注册 ─────────────────────────────────
  //
  // 阶段一（静态声明）：这个类型**是什么**——id 是它在 tab 系统里的身份（也是阶段二
  // 注册正文时的 key），kind 是类型判别符（openTab 用它），guide 决定新面板引导页上
  // 的入口胶囊。本插件是**页面类型**（不是文件预览器），所以不给 patterns。
  //
  // 官方 title 的签名是 `(address: string) => string`（better-sidebar 是
  // `string | (() => string)`）——它接受一个参数，这里忽略即可。
  ctx.effect(() => sidebarRightTabs.register({
    id: TAB_ID,
    kind: TAB_KIND,
    title: () => '工作计划',
    guide: [{
      order: 40,
      title: () => '工作计划',
      // 引导页只在**条目 ≤ 4** 时渲染 description（上游 MAX_DESCRIBED_ENTRIES=4，
      // 且宿主的终端条目也占一行），所以这行是锦上添花，关键信息不写这里。
      description: () => '计划树 · 进度跟踪 · 委派回执',
      icon: TargetIcon,
    }],
  }), 'dsh-workbench: tab type')

  // 阶段二（正文）：把面板挂到该类型的每个 tab 实例上。
  //
  // `key` 必须是阶段一注册的 `id`（不是 kind）。正文里能通过 useTabInfo() 读到
  // `{ sidebar, panel, tab }`——本插件只用 `tab.visible`（面板收起或非激活 tab 时为
  // false，用来暂停轮询/重算）。
  //
  // **sessionId 不再由宿主给**：better-sidebar 的 tabProps.scope.sessionId 在官方
  // 正文里没有对应物。而 WorkbenchPanel 的 sessionId 本来就是可选 prop，host 半的
  // resolveCwd 在缺省时有自己的兜底，所以这里不传、让 host 走兜底路径。
  ctx.effect(() => slots.inject('sidebar.right.pane.tab', () => slots.register({
    name: 'sidebar.right.pane.tab',
    key: TAB_ID,
  }, WorkbenchTabBody)), 'dsh-workbench: tab body')

  /**
   * 官方右侧栏 tab 正文。
   *
   * 与 better-sidebar 时代唯一的差别是状态来源：那时 `visible` 由 tabProps 传进来，
   * 现在从 useTabInfo() 读。数据面（/api/workbench/*）与 WorkbenchPanel 本身不变。
   *
   * useTabInfo 由 slot 框架经 hookContext 注入（官方契约：正文组件收到它），本组件
   * 只在**已注册的 seat 内**渲染，所以能安全调用——不要在组件里手写订阅。
   *
   * 定义在 apply 内部是**必须的**：WorkbenchPanel 是 apply 里的闭包组件，
   * 放到外面拿不到（会 ReferenceError）。
   */
  function WorkbenchTabBody(seatProps) {
    const sp = seatProps === undefined || seatProps === null ? {} : seatProps
    // visible：面板收起或本 tab 非激活时为 false（官方契约），用来暂停轮询/重算。
    const info = typeof sp.useTabInfo === 'function' ? sp.useTabInfo() : undefined
    const visible = info === undefined || info === null ? undefined : info.tab.visible
    // sessionId：**官方右栏不像 better-sidebar 那样把 scope.sessionId 交给正文**，
    // 而数据面要靠它定位工作区（host 侧 resolveCwd）。这里从宿主标准 session prop
    // `useSessions` 取当前会话——与 dsh-web-mobile 的 MobileDrawerFooter 同一读法
    // （`useSessions((state) => state.current)`），是官方认可的取法。
    //
    // 取不到时传 undefined：面板会显示「拿不到当前会话 id」，而不是静默空转。
    let sessionId
    if (typeof sp.useSessions === 'function') {
      sessionId = sp.useSessions((state) => (state === undefined || state === null ? undefined : state.current))
    }
    return h(WorkbenchPanel, { sessionId, visible })
  }
}

// 客户端模块必须无条件导出，并声明 name / inject：
//   - 无条件：本文件被内联进 C6 bundle 工厂，工厂的返回值就是这个 module.exports。
//     若写成 `typeof window === 'undefined'` 守卫，浏览器里条件为假，
//     apply 永远不会被导出，面板会静默不注册（logic.cjs 那种守卫只适用于
//     纯逻辑文件——它的函数由同闭包的 UI 代码直接引用，不依赖导出）。
//   - inject：Cordis 会等这些服务就绪后再调 apply。**必须声明官方右侧栏的两个
//     服务**（sidebarRight / sidebarRightTabs）——不声明时它们可能尚未挂载，
//     ctx.get 拿到 undefined，apply 会在开头静默 return，面板静默不注册。
//     （这正是 docs/PITFALLS.md 坑 #472 记的形态，只是宿主从 better-sidebar
//     换成了官方右栏。）
module.exports = {
  name: 'dsh-workbench-client',
  inject: ['slots', 'sidebarRight', 'sidebarRightTabs'],
  apply: apply,
}
