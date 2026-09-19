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
  '.dsh-wb-wrap,.dsh-wb-fab{'
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
  '.dsh-wb-fabhead{font:var(--wb-f2s);flex:1;min-width:0;}',
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
  // 芯片的横向内边距只给 6px。这 6 个筛选芯片在窄宽（≈420px 的侧栏）下总宽 383px，
  // 加上 5 个 4px 间隙是 403px——筛选行可用宽只要低于这个数就会折成两行，而第二行
  // 只挂一个孤零零的芯片，整块高度还会从 37px 涨到 49px。用 sp-4(8px) 时 6 个芯片
  // 各宽 4px，实测就会折行。纵向补回 2px 是为了让 11px 的字有正常行高，不与折行冲突。
  '.dsh-wb-chip{border:1px solid var(--wb-line-2);background:transparent;color:var(--wb-fg-2);border-radius:var(--wb-pill);padding:var(--wb-sp-1) var(--wb-sp-3);font:var(--wb-f3);cursor:pointer;white-space:nowrap;max-width:14em;overflow:hidden;text-overflow:ellipsis;transition:background var(--wb-dur) var(--wb-ease),color var(--wb-dur) var(--wb-ease);}',
  '.dsh-wb-chip:hover{background:var(--wb-hover);color:var(--wb-fg);}',
  // 选中态用「填充 + 描边 + 加粗」三重区分，不靠颜色单独表意。
  '.dsh-wb-chip.on{background:var(--wb-accent-soft);border-color:var(--wb-accent);color:var(--wb-fg);font-weight:600;}',
  // 建议芯片：和「用户自己挑的目标」区分开——它是系统推断的。沿用强调色，
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
  // 段控：和筛选芯片同一套语言（填充 + 描边 + 加粗表示选中），不靠颜色单独表意。
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
  '.dsh-wb-aibtn,.dsh-wb-iconbtn{border:1px solid transparent;background:transparent;color:var(--wb-fg-2);border-radius:var(--wb-pill);cursor:pointer;font:var(--wb-f2);padding:var(--wb-sp-2) var(--wb-sp-3);white-space:nowrap;transition:background var(--wb-dur) var(--wb-ease),color var(--wb-dur) var(--wb-ease);}',
  '.dsh-wb-aibtn:hover:not(:disabled),.dsh-wb-iconbtn:hover:not(:disabled){background:var(--wb-hover);color:var(--wb-fg);}',
  '.dsh-wb-aibtn:disabled,.dsh-wb-iconbtn:disabled{opacity:.4;cursor:default;}',
  // 「解析」是这一块的主动作，给它实心感（描边 + 软底 + 加粗），与其它次要按钮区分。
  '.dsh-wb-aibtn.primary{background:var(--wb-accent-soft);color:var(--wb-fg);font-weight:600;}',
  '.dsh-wb-aibtn.mic.on{background:var(--wb-accent-soft);color:var(--wb-fg);}',
  '.dsh-wb-aipics{display:flex;gap:var(--wb-sp-2);flex-wrap:wrap;align-items:center;margin:var(--wb-sp-3) 0 0;font:var(--wb-f3);color:var(--wb-fg-2);}',
  '.dsh-wb-aipic{display:inline-flex;align-items:center;gap:var(--wb-sp-1);max-width:14em;overflow:hidden;}',
  '.dsh-wb-aipic > button{border:none;background:transparent;color:inherit;cursor:pointer;font:inherit;padding:0 var(--wb-sp-1);}',
  '.dsh-wb-aitask{padding:var(--wb-sp-3) 0;border-top:1px dashed var(--wb-line-2);}',
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
  '@media (max-width:640px){.dsh-wb-task,.dsh-wb-planhead{flex-wrap:wrap;row-gap:var(--wb-sp-1);}.dsh-wb-tasktitle{flex:1 1 auto;min-width:0;}.dsh-wb-taskmeta{flex:1 1 100%;flex-wrap:wrap;row-gap:var(--wb-sp-1);}}',
  // 尊重系统的「减少动态效果」。
  '@media (prefers-reduced-motion:reduce){.dsh-wb-wrap *,.dsh-wb-wrap *:before,.dsh-wb-wrap *:after{transition-duration:.01ms !important;animation-duration:.01ms !important;}}',
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
const QUICK_ASKS = ['我今天该做什么', '哪些逾期了', '总结一下进展', '哪个方向没动']

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

    /** 收声：把中间结果实时灌进输入框，最后一段也是。 */
    const startVoice = (setter) => {
      let rec = null
      try {
        rec = new SR()
      } catch (e) {
        flash('这个浏览器起不了语音识别')
        return
      }
      rec.lang = typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'zh-CN'
      rec.continuous = false
      rec.interimResults = true
      rec.onresult = (ev) => {
        let text = ''
        for (let i = 0; i < ev.results.length; i++) text += ev.results[i][0].transcript
        setter(text.trim())
      }
      // 失败必须说出来。「没听见」和「没授权」要分开——前者再试一次就行，
      // 后者得去改浏览器设置，混成一句「语音失败」等于什么都没说。
      rec.onerror = (ev) => {
        const code = ev && ev.error ? String(ev.error) : ''
        if (code === 'not-allowed' || code === 'service-not-allowed') {
          flash('麦克风没有授权，请允许后再试')
        } else if (code === 'no-speech') {
          flash('没听到声音，再试一次')
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
        title: listening ? '正在听，点一下停止' : '点一下开始说话，说完自动填进输入框',
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
    const [fabGap, setFabGap] = React.useState(0)     // 键盘占掉的高度
    // 输入浮层跟着键盘走：键盘一弹就把浮层抬那么高，别再被输入法盖住。
    // 放在面板自己身上（而不是浮球子组件）：面板本来就常驻，多一个 effect
    // 比多一个只为拿键盘高度而存在的子组件便宜。
    React.useEffect(() => {
      const vv = typeof window === 'undefined' ? undefined : window.visualViewport
      if (vv === undefined || vv === null) return undefined
      const onShift = () => setFabGap(Math.max(0, window.innerHeight - vv.height - vv.offsetTop))
      vv.addEventListener('resize', onShift)
      vv.addEventListener('scroll', onShift)
      onShift()
      return () => { vv.removeEventListener('resize', onShift); vv.removeEventListener('scroll', onShift) }
    }, [fabOpen])
    const [aiText, setAiText] = React.useState('')
    const [aiPics, setAiPics] = React.useState([])    // [{ mediaType, data, name }]
    const [aiBusy, setAiBusy] = React.useState(false)
    const [aiTasks, setAiTasks] = React.useState([])  // 解析出的草稿，逐条采纳
    const [aiTurns, setAiTurns] = React.useState([])  // [{ role, text }] 本次会话的问答
    // AI 动态生成的清单卡（「明天在家能做的」）。它不是数据——是一个**视图建议**。
    const [aiList, setAiList] = React.useState(null)
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
      api('ai-parse', { sessionId, text: ask, images: aiPics, history: aiTurns })
        .then((r) => {
          setAiBusy(false)
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
          if (reply === '' && list.length === 0) flash('没解析出待办，换个说法试试')
        })
        .catch((e) => {
          setAiBusy(false)
          store.set({ error: e instanceof Error ? e.message : String(e) })
        })
    }

    /** 清空这次会话（不写盘——它本来就只在内存里）。 */
    const aiClear = () => { setAiTurns([]); setAiTasks([]); setAiList(null) }

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
      let where = '收件箱'
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
      openDraft(aiDraftOf(task, parent))
      flash('AI 草稿已填进表单（将放进「' + where + '」），改完点保存')
    }

    /**
     * 全部按首选建议**逐条过一遍表单**，而不是一键全存。
     * 逐个 await：建新计划那一步要拿回 id 才能挂下一条。
     */
    const aiApplyAll = async () => {
      const queue = []
      for (const task of aiTasks) {
        const pick = Array.isArray(task.candidates) && task.candidates.length > 0
          ? task.candidates[0] : { kind: 'inbox' }
        let parent = ''
        if (pick.kind === 'plan') {
          parent = pick.id
        } else if (pick.kind === 'new') {
          const title = String(pick.title === undefined ? '' : pick.title).trim()
          if (title === '') continue
          const res = await write('node-add', { title, type: 'plan' })
          if (res === null || res === undefined || res.node === null || res.node === undefined) continue
          parent = res.node.id
        }
        queue.push(aiDraftOf(task, parent))
      }
      setAiTasks([])
      setFabOpen(false)
      if (queue.length === 0) return
      setAiQueue(queue.slice(1))
      openDraft(queue[0])
      flash('逐条确认 AI 草稿（共 ' + queue.length + ' 条），改完点保存')
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
    const aiBlock = () => {
      const ai = state.ai === null || state.ai === undefined ? { available: false } : state.ai
      // 没有模型服务：不整块消失，退化成「记一条待办」的纯输入框。
      // 记仍然要走得通——「零摩擦把事收进来」是这个插件的立身之本，不能依赖模型。
      if (ai.available !== true) {
        const submitPlain = () => {
          const title = plainDraft.trim()
          if (title === '') return
          addNode({ title }, () => { setPlainDraft(''); flash('已记入收件箱') })
        }
        return h('div', { className: 'dsh-wb-aiwrap', key: 'ai' },
          h('div', { className: 'dsh-wb-aibar' },
            h('input', {
              className: 'dsh-wb-aiinput',
              placeholder: '记一条待办，回车入收件箱…',
              value: plainDraft,
              onChange: (e) => setPlainDraft(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); submitPlain() } },
            }),
            micButton(setPlainDraft, 'mic'),
            h('button', {
              className: 'dsh-wb-iconbtn',
              title: '记入收件箱',
              disabled: plainDraft.trim() === '',
              onClick: submitPlain,
            }, icon('plus')),
          ))
      }
      const model = typeof ai.model === 'string' && ai.model !== '' ? ai.model : ''

      const rows = []
      rows.push(h('div', { className: 'dsh-wb-aibar', key: 'bar' },
        h('input', {
          className: 'dsh-wb-aiinput',
          placeholder: '问一句（「哪些逾期了」），或直接说要做什么…',
          value: aiText,
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
          title: '发送（回车同样有效）',
          disabled: aiBusy === true,
          onClick: () => runAi(),
        }, aiBusy === true ? '…' : icon('send')),
      ))

      // 快捷问法：把「助手能干什么」直接摆在眼前。它同时是最短的那条学习路径。
      rows.push(h('div', { className: 'dsh-wb-quick', key: 'quick' },
        QUICK_ASKS.map((q) => h('button', {
          key: q,
          className: 'dsh-wb-chip',
          title: '问一句：' + q,
          disabled: aiBusy === true,
          onClick: () => runAi(q),
        }, q)),
        h('span', { className: 'dsh-wb-aimodel', key: 'm' }, model),
        h('button', {
          key: 'clear',
          className: 'dsh-wb-aibtn',
          title: '清空这次会话（不写盘，它本来只在内存里）',
          onClick: aiClear,
        }, '清空'),
        h('button', {
          key: 'fold',
          className: 'dsh-wb-aibtn',
          title: '收起浮层（会话不会丢，再点浮球还在）',
          onClick: () => setFabOpen(false),
        }, '收起'),
      ))

      // 这次会话的问答。助手的答复与「它读了哪些文件」都留在这里，
      // 人可以随时回看刚才那句建议到底依据什么。
      if (aiTurns.length > 0) {
        rows.push(h('div', { className: 'dsh-wb-chat', key: 'chat' },
          aiTurns.map((t, i) => h('div', {
            key: 'm' + i,
            className: 'dsh-wb-msg ' + (t.role === 'assistant' ? 'ai' : 'me'),
          }, t.text)),
          aiBusy === true ? h('div', { className: 'dsh-wb-msg ai', key: 'wait' }, '…') : null,
        ))
      }

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

      if (aiTasks.length > 0) {
        rows.push(h('div', { className: 'dsh-wb-aipics', key: 'all' },
          h('span', null, '待确认 ' + aiTasks.length + ' 条，逐条挑去处，或'),
          h('button', { className: 'dsh-wb-aibtn', disabled: aiBusy === true, onClick: aiApplyAll },
            '全部按首选建议加入'),
        ))
        for (const task of aiTasks) rows.push(aiTaskCard(task))
      }

      return h('div', { className: 'dsh-wb-aiwrap', key: 'ai' }, rows)
    }

    /**
     * 浮球：AI 的**唯一入口**。
     *
     * 收起时是一颗球，点开是一块输入浮层。选这个形态而不是面板里的一行，是因为
     * 面板住在一个又宽又矮的地方——常驻一行输入等于每屏少一条任务，而「问一句」
     * 是个低频动作，它不配占这种地方。手机与桌面同一个入口，不必各记一套。
     */
    const fab = () => {
      if (fabOpen !== true) {
        return h('div', { className: 'dsh-wb-fab', key: 'fab' },
          h('button', {
            className: 'dsh-wb-fabball',
            title: '说一句或问一句——点一下打开输入框，里面也有语音',
            onClick: () => setFabOpen(true),
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
          h('button', { className: 'dsh-wb-icon', title: '关闭', onClick: () => setFabOpen(false) }, icon('close')),
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
    const aiTaskCard = (task) => h('div', { className: 'dsh-wb-aitask', key: task.key },
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
            }, '收件箱')
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
    /**
     * 纳入 / 退出「工作计划」。纳入 = 它不再待在收件箱，而是以独立条目出现在
     * 下面的工作计划栏（不作为谁的子项）；退出 = 回到收件箱。写的是同一个
     * `/node-set`，不新增任何通路。
     */
    const setFiledOn = (node, on) => write(
      'node-set',
      { node: node.id, filed: on === true },
      () => flash(on === true ? '已纳入工作计划' : '已退回收件箱'),
    )
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
        // 「纳入工作计划」只在**收件箱那一层**（depth 0）出现，而且做得常显而不是
        // 悬停才出：它的意义就是催人把收件箱清空，藏起来等于不做。措辞用「纳入计划」
        // 而不是「提升为计划」——它并不改变节点的形态，只是不再待在收件箱。
        depth === 0 && !filedOf(node)
          ? h('button', {
            className: 'dsh-wb-adopt',
            title: '纳入工作计划：它不再待在收件箱，而是作为独立条目出现在下面的工作计划栏',
            onClick: (e) => { e.stopPropagation(); setFiledOn(node, true) },
          }, '纳入计划')
          : null,
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
        // 只有「已纳入工作计划的叶子」才有这一手：把它退回收件箱。纳入不该是单向门。
        filedOf(node)
          ? h('button', {
            className: 'dsh-wb-act',
            title: '退回收件箱（它不再是工作计划栏里的独立条目）',
            onClick: (e) => { e.stopPropagation(); setFiledOn(node, false) },
          }, icon('move'))
          : null,
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

    // 自定义视图（AI 清单存下来的）：和筛选芯片同一行语义——点了切换「看什么」。
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

    const inboxRows = []
    // 分栏标题前**不放图标**：下面「工作计划」那一段没有图标，两段标题只差一个
    // 图标会显得一段比另一段「更重要」，而它们本来是并列的两段。层级交给字重与
    // 留白，与面板里其它地方一致（见「文字只留两级」）。
    inboxRows.push(h('div', { className: 'dsh-wb-inboxhead', key: 'ih' },
      h('span', { className: 'dsh-wb-inboxtitle' }, '收件箱'),
      h('span', { className: 'dsh-wb-count' }, inbox.length > 0
        ? inbox.length + ' 条' + (sum.inboxOpen > 0 ? '（未完成 ' + sum.inboxOpen + '）' : '')
        : '空'),
    ))
    for (const todo of sortNodes(inbox)) inboxRows.push(renderTodo(todo, 0))
    body.push(h('div', { className: 'dsh-wb-inbox', key: 'inbox' }, inboxRows))

    if (!sum.hasPlan) {
      body.push(h('div', { className: 'dsh-wb-empty', key: 'empty' },
        h('div', null, '点右下角那颗浮球，跟 AI 说一句就行——'),
        h('div', { style: { marginTop: '6px', color: 'rgba(127,127,127,.95)' } },
          '「帮我把这个季度的工作拆成计划」'),
        h('div', { style: { marginTop: '8px', fontSize: '11px' } },
          '计划会落在 ' + (state.dir || '<工作区>/plan') + '；需要 vault / AI 人设请点右上角「设置」'),
      ))
    }

    // 「工作计划」栏：顶层计划 + 已纳入工作计划的顶层待办。它与收件箱**互补**——
    // 一个顶层节点要么还在收件箱、要么已经在这里，不会两边都出现。
    // 分栏标题是必要的：没有它，就分不清下面这些和上面收件箱的区别。
    const works = workPlans(plan)
    body.push(h('div', { className: 'dsh-wb-secthead', key: 'wh' },
      h('span', { className: 'dsh-wb-secttitle' }, '工作计划'),
      h('span', { className: 'dsh-wb-count' }, works.length > 0 ? works.length + ' 项' : '空'),
    ))
    for (const node of works) body.push(renderPlan(node, 0))

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

    return h('div', { className: 'dsh-wb-wrap' }, rows, fab())
  }

  ctx.effect(() => betterSidebar.registerTab({
    id: 'dsh-workbench:plan',
    title: '工作计划',
    icon: (size) => icon('target', Math.max(14, Number(size) || 16)),
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
