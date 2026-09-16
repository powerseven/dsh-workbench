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
 *   · 完成证据标记（📎n 已附证据 / ⊘ 已完成但无证据，等人核验）
 *   · 筛选条（重要度高 / 我委派出去的 / 本周到期 / 逾期 / 落后 / 无证据的完成项）
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
  '.dsh-wb-wrap{'
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
  // 语义色里只有 danger 在白底够 4.5:1，可以直接上文字；warn 只有 2.8:1、
  // success 只有 2.3:1，所以它俩只做软底，文字一律走中性。
  + '--wb-danger:var(--dsw-alias-state-error-primary);'
  + '--wb-danger-soft:var(--dsw-alias-interactive-bg-hover-danger);'
  + '--wb-warn-soft:var(--dsw-alias-state-warn-tertiary);'
  // 间距与圆角取宿主侧栏组件的既有标尺（间距 2/4/6/8/12，圆角 4/6/8/999）。
  // 命名出来是为了让「不许写随手值」这条能被一眼检查。
  + '--wb-sp-1:2px;--wb-sp-2:4px;--wb-sp-3:6px;--wb-sp-4:8px;--wb-sp-5:12px;'
  + '--wb-r-1:4px;--wb-r-2:6px;--wb-r-3:8px;--wb-pill:999px;'
  + '--wb-dur:var(--ds-transition-duration);--wb-ease:var(--ds-ease-in-out);'
  + 'display:flex;flex-direction:column;height:100%;min-height:0;'
  + 'font:var(--dsw-font-xs-13);color:var(--wb-fg);}',
  // 焦点环。此前全表没有一条 :focus-visible，键盘用户完全看不出停在哪。
  // outline 不参与布局，所以出现时行不会跳。
  '.dsh-wb-wrap :focus-visible{outline:2px solid var(--wb-accent);outline-offset:1px;}',
  // 宿主对 * 施加了 corner-shape:superellipse(1.5)（方角更耐看），但把胶囊压得
  // 走形，所以整圆形状要按宿主约定显式配回 round。
  '.dsh-wb-chip,.dsh-wb-pri,.dsh-wb-deleg,.dsh-wb-behind,.dsh-wb-planbar,.dsh-wb-rootdrop{corner-shape:round;}',
  // ── 表头 ────────────────────────────────────────────────────────────────
  '.dsh-wb-header{display:flex;align-items:center;gap:var(--wb-sp-4);padding:var(--wb-sp-4) var(--wb-sp-5);border-bottom:1px solid var(--wb-line);flex:none;}',
  '.dsh-wb-title{font:var(--dsw-font-xs-strong-13);}',
  '.dsh-wb-headright{margin-left:auto;display:flex;align-items:center;gap:var(--wb-sp-1);}',
  // 总进度是最重要的一个数，所以给它最高层级（近黑 + 等宽数字）。以前是蓝色
  // 小字：既压不过标题，又在白底只有 4.2:1。把强调色让给「可交互」之后，
  // 数字回到中性反而更醒目。
  '.dsh-wb-pct{font:var(--dsw-font-xs-strong-13);font-variant-numeric:tabular-nums;color:var(--wb-fg);}',
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
  '.dsh-wb-chip{border:1px solid var(--wb-line-2);background:transparent;color:var(--wb-fg-2);border-radius:var(--wb-pill);padding:var(--wb-sp-1) var(--wb-sp-3);font:var(--dsw-font-xxxs-11);cursor:pointer;white-space:nowrap;max-width:14em;overflow:hidden;text-overflow:ellipsis;transition:background var(--wb-dur) var(--wb-ease),color var(--wb-dur) var(--wb-ease);}',
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
  '.dsh-wb-coltitle{flex:1;font:var(--dsw-font-xs-strong-13);word-break:break-word;}',
  '.dsh-wb-colpct{flex:none;font:var(--dsw-font-xxxs-11);font-variant-numeric:tabular-nums;color:var(--wb-fg-2);}',
  '.dsh-wb-colcount{flex:none;font:var(--dsw-font-xxxs-11);font-variant-numeric:tabular-nums;color:var(--wb-fg-2);}',
  '.dsh-wb-cards{display:flex;flex-direction:column;gap:var(--wb-sp-2);}',
  // 卡片：复用行密度思路——纵向内边距给很小，靠 hover 底色连成一片。
  '.dsh-wb-card{border:1px solid var(--wb-line-2);border-radius:var(--wb-r-2);padding:var(--wb-sp-2) var(--wb-sp-3);transition:background var(--wb-dur) var(--wb-ease),border-color var(--wb-dur) var(--wb-ease);}',
  '.dsh-wb-card:hover{background:var(--wb-hover);border-color:var(--wb-line);}',
  '.dsh-wb-card.done{opacity:.55;}',
  '.dsh-wb-cardtop{display:flex;align-items:flex-start;gap:var(--wb-sp-2);}',
  '.dsh-wb-cardtop input{margin:var(--wb-sp-1) 0 0;flex:none;cursor:pointer;accent-color:var(--wb-accent);}',
  '.dsh-wb-cardtitle{flex:1;word-break:break-word;cursor:pointer;}',
  '.dsh-wb-cardtitle.done{text-decoration:line-through;color:var(--wb-fg-2);}',
  // 卡片上的上下文路径：说明这张卡属于哪个子计划（列只代表顶层计划）。
  '.dsh-wb-cardpath{font:var(--dsw-font-xxxs-11);font-family:var(--ds-font-family-code);color:var(--wb-fg-2);word-break:break-word;margin-top:2px;}',
  '.dsh-wb-cardmeta{display:flex;gap:var(--wb-sp-2);flex-wrap:wrap;align-items:center;margin-top:var(--wb-sp-2);}',
  // ── 视图切换（树 / 看板）───────────────────────────────────────────────
  // 段控：和筛选芯片同一套语言（填充 + 描边 + 加粗表示选中），不靠颜色单独表意。
  '.dsh-wb-viewtoggle{display:flex;border:1px solid var(--wb-line-2);border-radius:var(--wb-pill);overflow:hidden;flex:none;}',
  '.dsh-wb-vbtn{border:none;background:transparent;color:var(--wb-fg-2);cursor:pointer;font:var(--dsw-font-xxxs-11);padding:var(--wb-sp-1) var(--wb-sp-3);line-height:1.6;}',
  '.dsh-wb-vbtn.on{background:var(--wb-accent-soft);color:var(--wb-fg);font-weight:600;}',
  // ── 计划节点（递归，深度用 margin-left 表达）────────────────────────────
  '.dsh-wb-plan{margin-bottom:var(--wb-sp-4);}',
  // 标题与紧跟其后的进度条是一个视觉单元，所以下边距收到 0：让进度条贴住标题，
  // 「谁属于谁」靠贴合表达，比靠留白表达更省纵向空间，也更清楚。
  '.dsh-wb-planhead{display:flex;align-items:baseline;gap:var(--wb-sp-3);margin:var(--wb-sp-1) 0 0;}',
  '.dsh-wb-planid{flex:none;font:var(--dsw-font-xxxs-11);font-family:var(--ds-font-family-code);color:var(--wb-fg-2);}',
  '.dsh-wb-plantitle{flex:1;font:var(--dsw-font-xs-strong-13);word-break:break-word;}',
  '.dsh-wb-planpct{flex:none;font:var(--dsw-font-xxxs-11);font-variant-numeric:tabular-nums;color:var(--wb-fg-2);}',
  '.dsh-wb-planq{flex:none;font:var(--dsw-font-xxxs-11);color:var(--wb-fg-2);}',
  '.dsh-wb-planmeta{display:flex;gap:var(--wb-sp-3);flex-wrap:wrap;font:var(--dsw-font-xxxs-11);color:var(--wb-fg-2);margin:0 0 var(--wb-sp-2);}',
  '.dsh-wb-planbar{height:2px;background:var(--wb-line);border-radius:var(--wb-pill);margin-bottom:var(--wb-sp-3);overflow:hidden;}',
  '.dsh-wb-planbar > div{height:100%;background:var(--wb-accent);}',
  // ── 待办行 ──────────────────────────────────────────────────────────────
  // 待办行按「密」来配：这个面板住在底部工作台里，纵向空间是最稀缺的资源，
  // 一行省 3px、11 行就能多露出一条半任务。所以纵向内边距只给 2px、行间距给 0，
  // 行与行的分隔交给 hover 底色——顺带得到「整列连成一片」的列表观感。
  // 行高不在这里写死，直接吃 .dsh-wb-wrap 的 var(--dsw-font-xs-13)（13px/20px），
  // 与宿主自己的列表同一套行高标尺。
  '.dsh-wb-task{display:flex;align-items:flex-start;gap:var(--wb-sp-3);padding:var(--wb-sp-1) var(--wb-sp-2);border-radius:var(--wb-r-2);margin:0;transition:background var(--wb-dur) var(--wb-ease);}',
  '.dsh-wb-task:hover{background:var(--wb-hover);}',
  '.dsh-wb-task input{margin:var(--wb-sp-1) 0 0;flex:none;cursor:pointer;accent-color:var(--wb-accent);}',
  '.dsh-wb-tasktitle{flex:1;word-break:break-word;cursor:pointer;}',
  // 完成态用「变灰」而不是 opacity：叠透明度会把对比度一起压下去。
  '.dsh-wb-tasktitle.done{text-decoration:line-through;color:var(--wb-fg-2);}',
  '.dsh-wb-tasktitle.dropped{text-decoration:line-through;color:var(--wb-fg-2);}',
  '.dsh-wb-taskdue{flex:none;font:var(--dsw-font-xxxs-11);font-variant-numeric:tabular-nums;color:var(--wb-fg-2);white-space:nowrap;}',
  // 逾期日期是全表唯一「红字」——有意保留，但要说清它的真实数字：宿主的 error
  // token 在浅色下是 #ec1313，对面板底色 4.49:1，严格按不四舍五入的算法差 0.01
  // 不到 AA 的 4.5:1（这里底色是纯底，没有软底再往下压，所以比胶囊那两处好）。
  // 之所以接受：它是每行里唯一需要立刻行动的信号，换成中性色就被埋掉了；
  // 而且宿主的 token 集里找不到「明暗两态都能安全当文字」的第二个红。
  '.dsh-wb-taskdue.overdue{color:var(--wb-danger);font-weight:600;}',
  // 行内动作按钮：以前 opacity:0 只在 hover 现身，键盘与触屏完全够不到。
  // 现在键盘用 :focus-within 揭示，触屏用 @media (hover:none) 常驻。
  '.dsh-wb-act{flex:none;border:none;background:transparent;color:var(--wb-fg-2);cursor:pointer;font:var(--dsw-font-xxxs-11);padding:0 var(--wb-sp-1);border-radius:var(--wb-r-1);line-height:1.6;opacity:0;transition:opacity var(--wb-dur) var(--wb-ease),background var(--wb-dur) var(--wb-ease);}',
  '.dsh-wb-task:hover .dsh-wb-act,.dsh-wb-planhead:hover .dsh-wb-act,.dsh-wb-task:focus-within .dsh-wb-act,.dsh-wb-planhead:focus-within .dsh-wb-act{opacity:1;}',
  '.dsh-wb-act:hover{background:var(--wb-hover);color:var(--wb-fg);}',
  // ── 重要程度徽章 ────────────────────────────────────────────────────────
  '.dsh-wb-pri{flex:none;font:var(--dsw-font-xxxs-strong-11);padding:0 var(--wb-sp-3);border-radius:var(--wb-r-3);cursor:pointer;border:1px solid transparent;user-select:none;}',
  // 「中/低」都不换更浅的灰（那会掉到 AA 以下），改用描边与留白区分。
  '.dsh-wb-pri.normal{color:var(--wb-fg-2);border-color:var(--wb-line-2);}',
  '.dsh-wb-pri.low{color:var(--wb-fg-2);}',
  // 「高」的红只走描边 + 软底，文字保持中性。两个方向都试算过、都不安全：
  // 浅色下的红是 #ec1313，对纯白 4.49:1，再叠一层 5% 红软底就掉到 4.45:1
  // （AA 要 4.5:1）；暗色下换成 #f25a5a，实心红配白字只有 3.29:1。
  // 既然红两个方向都当不了安全的文字色，就让它只承担「形状 + 底色」的信息，
  // 顺带把「三行红字」的噪声降成「三个红边小胶囊」。
  '.dsh-wb-pri.high{color:var(--wb-fg);background:var(--wb-danger-soft);border-color:var(--wb-danger);font-weight:600;}',
  '.dsh-wb-pri:hover{filter:brightness(.95);}',
  // ── 委派标记 ────────────────────────────────────────────────────────────
  // 以前用紫色（#8250df）——宿主的语义色里没有紫，所以它一眼就不像宿主的一部分。
  // 委派是「进行中」，归到强调色的软底；逾期才转 danger。
  '.dsh-wb-deleg{flex:none;font:var(--dsw-font-xxxs-11);padding:0 var(--wb-sp-3);border-radius:var(--wb-r-3);border:1px solid transparent;background:var(--wb-accent-soft);color:var(--wb-fg);white-space:nowrap;max-width:11em;overflow:hidden;text-overflow:ellipsis;}',
  // 逾期仍然由红来表意，但同样只落在底色与描边上——理由同上面的「高」：
  // 红字叠在红软底上是 4.45:1，达不到 4.5:1。基础态先声明透明描边是为了让这里
  // 只改颜色、不改盒子尺寸，胶囊不会因逾期与否而变宽一像素。
  '.dsh-wb-deleg.late{background:var(--wb-danger-soft);border-color:var(--wb-danger);color:var(--wb-fg);font-weight:600;}',
  // ── 管控缺口 ────────────────────────────────────────────────────────────
  '.dsh-wb-warn{flex:none;font:var(--dsw-font-xxxs-11);color:var(--wb-fg-2);cursor:help;}',
  // ── 落后于周期 ──────────────────────────────────────────────────────────
  // 琥珀在白底只有 2.8:1，所以颜色只上软底，文字走中性。
  '.dsh-wb-behind{flex:none;font:var(--dsw-font-xxxs-strong-11);padding:0 var(--wb-sp-3);border-radius:var(--wb-r-3);background:var(--wb-warn-soft);color:var(--wb-fg);cursor:help;white-space:nowrap;}',
  // ── 完成证据：📎n = 已附证据；⊘ = 已完成但无证据（待核验）──────────────
  // 两者都自带符号，颜色是冗余信息，所以文字统一走中性——顺带绕开
  // 「绿 2.3:1 / 琥珀 2.8:1 在浅色下达不到 AA」这个坑。
  '.dsh-wb-evid{flex:none;font:var(--dsw-font-xxxs-11);color:var(--wb-fg-2);cursor:help;}',
  '.dsh-wb-evid.bad{color:var(--wb-danger);font-weight:600;}',
  '.dsh-wb-unverif{flex:none;font:var(--dsw-font-xxxs-strong-11);border-radius:var(--wb-r-1);padding:0 var(--wb-sp-1);background:var(--wb-warn-soft);color:var(--wb-fg);cursor:help;}',
  // ── 收件箱 ──────────────────────────────────────────────────────────────
  '.dsh-wb-inbox{margin-bottom:var(--wb-sp-5);padding-bottom:var(--wb-sp-4);border-bottom:1px dashed var(--wb-line-2);}',
  '.dsh-wb-inboxhead{display:flex;align-items:baseline;gap:var(--wb-sp-3);margin:var(--wb-sp-1) 0 var(--wb-sp-3);}',
  '.dsh-wb-inboxtitle{font:var(--dsw-font-xs-strong-13);}',
  '.dsh-wb-count{font:var(--dsw-font-xxxs-11);font-variant-numeric:tabular-nums;color:var(--wb-fg-2);}',
  '.dsh-wb-add{display:flex;gap:var(--wb-sp-2);margin:0 0 var(--wb-sp-2);}',
  '.dsh-wb-add input{flex:1;min-width:0;font:inherit;padding:var(--wb-sp-2) var(--wb-sp-3);border-radius:var(--wb-r-2);border:1px solid var(--wb-line-2);background:transparent;color:var(--wb-fg);transition:border-color var(--wb-dur) var(--wb-ease);}',
  '.dsh-wb-add input::placeholder{color:var(--wb-fg-2);}',
  '.dsh-wb-add input:focus{border-color:var(--wb-accent);}',
  '.dsh-wb-add button{border:1px solid var(--wb-line-2);background:transparent;color:var(--wb-fg-2);border-radius:var(--wb-r-2);cursor:pointer;font:var(--dsw-font-xxs-12);padding:var(--wb-sp-2) var(--wb-sp-4);white-space:nowrap;transition:background var(--wb-dur) var(--wb-ease),color var(--wb-dur) var(--wb-ease);}',
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
  '.dsh-wb-movepicklabel{font:var(--dsw-font-xxxs-11);color:var(--wb-fg-2);}',
  // ── AI 入口 ─────────────────────────────────────────────────────────────
  // 整块用「强调色虚线框 + 软底」：这一区的内容**不是用户手打的**，是模型给的，
  // 一眼要能分辨。虚线也顺带说明「还没落定」——点过采纳才会真写进计划。
  '.dsh-wb-ai{margin:0 var(--wb-sp-5) var(--wb-sp-4);padding:var(--wb-sp-4);border:1px dashed var(--wb-accent);border-radius:var(--wb-r-2);background:var(--wb-accent-soft);}',
  '.dsh-wb-aihead{display:flex;align-items:center;gap:var(--wb-sp-3);margin:0 0 var(--wb-sp-3);font:var(--dsw-font-xxs-strong-12);}',
  // 模型名摆在标题行右端：建议是谁给的、用的是哪个模型，不应该藏起来。
  '.dsh-wb-aimodel{margin-left:auto;font:var(--dsw-font-xxxs-11);color:var(--wb-fg-2);max-width:16em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
  '.dsh-wb-airow{display:flex;gap:var(--wb-sp-2);align-items:flex-start;}',
  // 多行文本域：口述转写往往是一整段，一行输入框装不下也不好改。
  '.dsh-wb-aitext{flex:1;min-width:0;font:inherit;color:var(--wb-fg);background:transparent;border:1px solid var(--wb-line-2);border-radius:var(--wb-r-2);padding:var(--wb-sp-2) var(--wb-sp-3);min-height:48px;resize:vertical;}',
  '.dsh-wb-aitext::placeholder{color:var(--wb-fg-2);}',
  '.dsh-wb-aitext:focus{border-color:var(--wb-accent);}',
  '.dsh-wb-aibtn{border:1px solid var(--wb-line-2);background:transparent;color:var(--wb-fg-2);border-radius:var(--wb-r-2);cursor:pointer;font:var(--dsw-font-xxs-12);padding:var(--wb-sp-2) var(--wb-sp-4);white-space:nowrap;transition:background var(--wb-dur) var(--wb-ease),color var(--wb-dur) var(--wb-ease);}',
  '.dsh-wb-aibtn:hover:not(:disabled){background:var(--wb-hover);color:var(--wb-fg);}',
  '.dsh-wb-aibtn:disabled{opacity:.4;cursor:default;}',
  // 「解析」是这一块的主动作，给它实心感（描边 + 软底 + 加粗），与其它次要按钮区分。
  '.dsh-wb-aibtn.primary{border-color:var(--wb-accent);background:var(--wb-accent-soft);color:var(--wb-fg);font-weight:600;}',
  '.dsh-wb-aipics{display:flex;gap:var(--wb-sp-2);flex-wrap:wrap;align-items:center;margin:var(--wb-sp-3) 0 0;font:var(--dsw-font-xxxs-11);color:var(--wb-fg-2);}',
  '.dsh-wb-aipic{display:inline-flex;align-items:center;gap:var(--wb-sp-1);max-width:14em;overflow:hidden;}',
  '.dsh-wb-aipic > button{border:none;background:transparent;color:inherit;cursor:pointer;font:inherit;padding:0 var(--wb-sp-1);}',
  '.dsh-wb-aitask{padding:var(--wb-sp-3) 0;border-top:1px dashed var(--wb-line-2);}',
  '.dsh-wb-aititle{display:flex;gap:var(--wb-sp-3);align-items:baseline;}',
  '.dsh-wb-aititle > span{flex:1;word-break:break-word;}',
  '.dsh-wb-aimeta{font:var(--dsw-font-xxxs-11);color:var(--wb-fg-2);white-space:nowrap;}',
  // 新建计划的输入框就放在候选行里：它是「候选之一」，不是另一块表单——
  // 用户的心智是「挑一个去处」，不是「先选模式再填表」。
  '.dsh-wb-ainew{flex:none;width:9em;min-width:0;font:var(--dsw-font-xxxs-11);color:var(--wb-fg);background:transparent;border:1px solid var(--wb-line-2);border-radius:var(--wb-r-3);padding:var(--wb-sp-1) var(--wb-sp-3);}',
  '.dsh-wb-ainew::placeholder{color:var(--wb-fg-2);}',
  '.dsh-wb-ainew:focus{border-color:var(--wb-accent);}',
  // ── 折叠控点（无子节点时占位不可点，让同层标题左边缘对齐）──────────────
  '.dsh-wb-caret{flex:none;width:12px;text-align:center;cursor:pointer;color:var(--wb-fg-2);user-select:none;font:var(--dsw-font-xxxs-11);border-radius:var(--wb-r-1);}',
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
  // ── 新建顶层计划（空工作区时它是唯一的建计划入口）──────────────────────
  '.dsh-wb-rootadd{display:block;width:100%;margin-top:var(--wb-sp-5);border:1px dashed var(--wb-line-2);background:transparent;color:var(--wb-fg-2);border-radius:var(--wb-r-2);padding:var(--wb-sp-3) var(--wb-sp-4);font:inherit;cursor:pointer;transition:background var(--wb-dur) var(--wb-ease),color var(--wb-dur) var(--wb-ease),border-color var(--wb-dur) var(--wb-ease);}',
  '.dsh-wb-rootadd:hover{background:var(--wb-hover);color:var(--wb-fg);border-color:var(--wb-accent);}',
  // ── 聚焦列表 ────────────────────────────────────────────────────────────
  '.dsh-wb-focus{display:flex;align-items:flex-start;gap:var(--wb-sp-3);padding:var(--wb-sp-1) var(--wb-sp-2);border-radius:var(--wb-r-2);margin:0;transition:background var(--wb-dur) var(--wb-ease);}',
  '.dsh-wb-focus:hover{background:var(--wb-hover);}',
  '.dsh-wb-focus input{margin:var(--wb-sp-1) 0 0;flex:none;cursor:pointer;accent-color:var(--wb-accent);}',
  '.dsh-wb-focus .dsh-wb-tasktitle{flex:1;}',
  '.dsh-wb-path{flex:none;font:var(--dsw-font-xxxs-11);font-family:var(--ds-font-family-code);color:var(--wb-fg-2);}',
  '.dsh-wb-empty{padding:var(--wb-sp-5);text-align:center;color:var(--wb-fg-2);line-height:1.8;}',
  '.dsh-wb-err{margin:var(--wb-sp-4) var(--wb-sp-5);padding:var(--wb-sp-4) var(--wb-sp-5);border-radius:var(--wb-r-2);background:var(--wb-danger-soft);color:var(--wb-danger);line-height:1.6;word-break:break-word;}',
  '.dsh-wb-footer{padding:var(--wb-sp-3) var(--wb-sp-5);border-top:1px solid var(--wb-line);font:var(--dsw-font-xxxs-11);color:var(--wb-fg-2);flex:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
  '.dsh-wb-flash{padding:var(--wb-sp-2) var(--wb-sp-5);font:var(--dsw-font-xxxs-11);color:var(--wb-fg-2);flex:none;}',
  // 触屏没有 hover：行内动作按钮必须常驻，否则永远够不到；同时把为密度压到 2px 的
  // 行内边距放回 6px，让触摸目标重新够大。鼠标要密、手指要好点中，两者诉求相反，
  // 所以按输入方式分开配，而不是取一个两边都不满意的中间值。
  '@media (hover:none){.dsh-wb-act{opacity:1;}.dsh-wb-task,.dsh-wb-focus{padding:var(--wb-sp-3) var(--wb-sp-2);}}',
  // 尊重系统的「减少动态效果」。
  '@media (prefers-reduced-motion:reduce){.dsh-wb-wrap *,.dsh-wb-wrap *:before,.dsh-wb-wrap *:after{transition-duration:.01ms !important;animation-duration:.01ms !important;}}',
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
    return v === 'tree' || v === 'board' ? v : 'tree'
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
const ROOT_ADD = '__root__'

/** 极简可订阅 store：只在 set 时替换整个 state 对象，getSnapshot 引用稳定。 */
function createStore() {
  let listeners = []
  let state = {
    plan: null, cwd: '', dir: '', loading: false, error: null, flash: '',
    filter: 'all',
    // 交互态：一次只展开一个。moving = 正在归位的待办 id，adding = 正在加子项的父节点 id。
    moving: null, adding: null,
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
    // 一个常驻（收件箱）+ 一个按需（节点下加子项），一次只会有后者一个。
    const [draft, setDraft] = React.useState('')
    const [nodeDraft, setNodeDraft] = React.useState('')
    // 就地编辑的三份状态也放本地，理由同上：拖拽时鼠标每动一下都要更新落点，
    // 放进全局 store 会让 tab 角标跟着重算（它订阅 store.get），白烧一遍整棵树。
    const [collapsed, setCollapsed] = React.useState(() => loadCollapsed())
    // 视图切换（树 / 看板）：和折叠一样是这台浏览器的显示偏好，持久化到 localStorage。
    const [view, setView] = React.useState(() => loadView())
    const setViewPersist = (v) => { setView(v); saveView(v) }
    const [editing, setEditing] = React.useState(null)   // { id, original } | null
    const [editDraft, setEditDraft] = React.useState('')
    const [dragId, setDragId] = React.useState(null)
    const [hint, setHint] = React.useState(null)         // { id, place } | null（id=null 表示落在空白处）
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
        className: 'dsh-wb-mic' + (listening ? ' on' : ''),
        title: listening ? '正在听，点一下停止' : '点一下开始说话，说完自动填进输入框',
        onClick: () => { if (listening) stopVoice(); else startVoice(setter) },
      }, listening ? '■' : '🎤')
    }

    // ============================================================== AI 入口
    //
    // 只做三件事：① 收集素材（说话 / 打字 / 选图）→ ② 交给 host 解析成结构化待办
    // → ③ 让用户挑去处，点了才写。**解析不写入**，所以中途改主意没有任何副作用，
    // 也不用给「撤销一次 AI 导入」再想一套机制。
    //
    // 语音沿用上面的 Web Speech（只把识别结果写进这个文本域），图片走 file input
    // 读成 base64；两者最终都是发给 /ai-parse 的普通字段，host 那边再决定怎么问模型。
    const [aiOpen, setAiOpen] = React.useState(false)
    const [aiText, setAiText] = React.useState('')
    const [aiPics, setAiPics] = React.useState([])    // [{ mediaType, data, name }]
    const [aiBusy, setAiBusy] = React.useState(false)
    const [aiTasks, setAiTasks] = React.useState([])  // 解析出的草稿，逐条采纳

    /** 选图：读成 base64 存进本地状态，超上限的直接丢掉并说明丢了几张。 */
    const addPics = async (fileList) => {
      const files = []
      for (const f of fileList || []) files.push(f)
      const room = AI_MAX_IMAGES - aiPics.length
      const picked = files.slice(0, Math.max(room, 0))
      const out = []
      for (const file of picked) {
        // arrayBuffer 是标准 API；读失败（权限/格式）不要拖垮整个面板，跳过即可。
        let buf = null
        try { buf = await file.arrayBuffer() } catch (e) { buf = null }
        if (buf === null) continue
        out.push({
          mediaType: typeof file.type === 'string' && file.type !== '' ? file.type : 'image/png',
          data: bytesToBase64(new Uint8Array(buf)),
          name: typeof file.name === 'string' && file.name !== '' ? file.name : '图片',
        })
      }
      setAiPics(aiPics.concat(out))
      const dropped = files.length - picked.length
      if (dropped > 0) flash('一次最多 ' + AI_MAX_IMAGES + ' 张图片，多的 ' + dropped + ' 张没带上')
    }

    const runAi = () => {
      if (aiText.trim() === '' && aiPics.length === 0) {
        flash('说点什么、贴一段文字，或选一张图片')
        return
      }
      setAiBusy(true)
      api('ai-parse', { sessionId, text: aiText.trim(), images: aiPics })
        .then((r) => {
          setAiBusy(false)
          const list = Array.isArray(r.tasks) ? r.tasks : []
          // newTitle 单独存一份：候选里的那个只是**默认值**，用户要能改。
          setAiTasks(list.map((t, i) => {
            const fresh = (Array.isArray(t.candidates) ? t.candidates : []).find((c) => c.kind === 'new')
            return Object.assign({}, t, {
              key: 'ai' + i,
              newTitle: fresh !== undefined && typeof fresh.title === 'string' ? fresh.title : '',
            })
          }))
          if (list.length === 0) flash('没解析出待办，换个说法试试')
        })
        .catch((e) => {
          setAiBusy(false)
          store.set({ error: e instanceof Error ? e.message : String(e) })
        })
    }

    /** 采纳一条：把草稿落成真节点。choice 直接来自候选列表，不加中间层。 */
    const aiApply = async (task, choice) => {
      const args = { title: task.title, type: 'todo' }
      if (typeof task.due === 'string' && task.due !== '') args.due = task.due
      if (typeof task.priority === 'string' && task.priority !== '') args.priority = task.priority
      if (typeof task.note === 'string' && task.note !== '') args.note = task.note
      let where = '收件箱'
      if (choice.kind === 'plan') {
        args.parent = choice.id
        where = choice.title
      } else if (choice.kind === 'new') {
        const title = String(choice.title === undefined ? '' : choice.title).trim()
        // 名字是空的就先别动：拿任务标题去当计划名会造出一堆同名的空壳计划，
        // 那比不建更糟（它还会进完成度统计）。
        if (title === '') { flash('给新计划起个名字再建'); return }
        const res = await write('node-add', { title, type: 'plan' })
        if (res === null || res === undefined || res.node === null || res.node === undefined) return
        args.parent = res.node.id
        where = title
      }
      const res = await write('node-add', args)
      if (res === null || res === undefined) return
      setAiTasks((prev) => prev.filter((t) => t.key !== task.key))
      flash('已加入「' + where + '」')
    }

    /** 全部按首选建议采纳。逐个 await：每步都要拿回新计划才能渲染下一步。 */
    const aiApplyAll = async () => {
      for (const task of aiTasks) {
        const pick = Array.isArray(task.candidates) && task.candidates.length > 0
          ? task.candidates[0] : { kind: 'inbox' }
        await aiApply(task, pick)
      }
    }

    /** 改某条草稿的新建计划名。用函数式更新，避免连着改几条时互相覆盖。 */
    const setNewTitle = (key, value) => {
      setAiTasks((prev) => prev.map((t) => (t.key === key ? Object.assign({}, t, { newTitle: value }) : t)))
    }

    /** AI 块。只在宿主真有模型服务时才渲染入口——点不亮的按钮不如不给。 */
    const aiBlock = () => {
      const ai = state.ai === null || state.ai === undefined ? { available: false } : state.ai
      if (ai.available !== true) return null
      const model = typeof ai.model === 'string' && ai.model !== '' ? ai.model : ''
      const head = h('div', { className: 'dsh-wb-aihead', key: 'ah' },
        h('span', null, '✨ AI 导入'),
        model === '' ? null : h('span', { className: 'dsh-wb-aimodel', title: '用这个模型解析' }, model),
        h('button', {
          className: 'dsh-wb-aibtn',
          style: { marginLeft: 'auto' },
          onClick: () => { setAiOpen(false); setAiText(''); setAiPics([]); setAiTasks([]) },
        }, '收起'),
      )
      if (aiOpen !== true) {
        return h('div', { className: 'dsh-wb-ai', key: 'ai' },
          head,
          h('button', {
            className: 'dsh-wb-aibtn primary',
            onClick: () => setAiOpen(true),
            title: '把一段口述或一张截图变成待办，并建议该放到哪个计划下',
          }, '语音 / 图片转任务'),
        )
      }
      const pics = aiPics.length === 0 ? null : h('div', { className: 'dsh-wb-aipics', key: 'pics' },
        aiPics.map((p, i) => h('span', { className: 'dsh-wb-aipic', key: 'p' + i },
          '🖼 ' + p.name,
          h('button', {
            title: '去掉这张',
            onClick: () => setAiPics(aiPics.filter((_, j) => j !== i)),
          }, '×'),
        )),
      )
      const composer = h('div', { className: 'dsh-wb-ai', key: 'ai' },
        head,
        h('div', { className: 'dsh-wb-airow', key: 'row' },
          h('textarea', {
            className: 'dsh-wb-aitext',
            placeholder: '把口述内容、会议纪要粘在这里，或直接说话 / 选一张截图…',
            value: aiText,
            onChange: (e) => setAiText(e.target.value),
          }),
          micButton(setAiText, 'mic'),
          h('label', { className: 'dsh-wb-aibtn', title: '选一张截图（白板 / 清单 / 聊天记录）' },
            '🖼 图片',
            h('input', {
              type: 'file',
              accept: 'image/png,image/jpeg,image/webp,image/gif',
              multiple: true,
              style: { display: 'none' },
              onChange: (e) => {
                addPics(e.target.files)
                // 清空 value：否则连着选同一个文件不会触发 change。
                if (e.target !== null && e.target !== undefined) e.target.value = ''
              },
            }),
          ),
          h('button', {
            className: 'dsh-wb-aibtn primary',
            disabled: aiBusy === true,
            onClick: runAi,
          }, aiBusy === true ? '解析中…' : '解析'),
        ),
        pics,
        aiTasks.length === 0 ? null : h('div', { key: 'tasks' },
          h('div', { className: 'dsh-wb-aipics', key: 'all' },
            h('span', null, '解析出 ' + aiTasks.length + ' 条，逐条挑去处，或'),
            h('button', { className: 'dsh-wb-aibtn', disabled: aiBusy === true, onClick: aiApplyAll },
              '全部按首选建议加入'),
          ),
          aiTasks.map((task) => h('div', { className: 'dsh-wb-aitask', key: task.key },
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
              }, '×'),
            ),
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
          )),
        ),
      )
      return composer
    }

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
    const setPriority = React.useCallback((id, priority) => write('node-set', { node: id, priority }), [write])
    // 换型：待办 ↔ 计划。原地换型而不是「新建一个再搬」——用户想说的是
    // 「这就是同一件事，只是现在要往下拆」，换个容器会多出一层没有意义的嵌套。
    const setNodeKind = React.useCallback((id, type) => write(
      'node-set',
      { node: id, type },
      () => flash(type === 'plan' ? '已提升为计划' : '已降回待办'),
    ), [write])
    const addNode = React.useCallback((input, onOk) => write('node-add', input, onOk), [write])

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

    const plan = state.plan
    const sum = summarize(plan)
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
     * 标题上的三种手势：单击切换完成、双击就地改名、按住拖动排序。
     *
     * 单击必须**延后执行**：双击会先触发两次 click，立刻切换的话，一次改名
     * 会顺带把事办了（还留下两个版本快照）。延迟只加在这条便利路径上，
     * 复选框依旧是即时的——想快就点框。
     * 计划标题不参与切换（它没有「完成」这个单击语义），所以只延后待办。
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
      if (!canToggle) return props
      if (node.status === 'done') props.className += ' done'
      else if (node.status === 'dropped') props.className += ' dropped'
      props.onClick = () => {
        if (clickTimer.current !== null) return
        clickTimer.current = setTimeout(() => {
          clickTimer.current = null
          setTodo(node.id, toggleStatus(node.status))
        }, 200)
      }
      return props
    }

    /** 标题位：改名中显示输入框，否则显示可拖可双击的标题。 */
    const titleNode = (node, base, opts) => {
      if (editing !== null && editing.id === String(node.id)) return renameInput('rename')
      return h('span', titleProps(node, base, opts || {}), node.title)
    }

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
     *   📎n  附了 n 条证据，悬停列出来；文件类证据若服务端核验不存在，标红
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
          + (bad.length > 0 ? '\n⚠ ' + bad.join('\n⚠ ') : ''),
      }, (bad.length > 0 ? '⚠' : '📎') + list.length)
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
        style: { marginLeft: (10 + depth * 12) + 'px' },
        title: statusLabel(node.status) + (node.note ? '\n' + node.note : '')
          + '\n（单击切换完成 · 双击改名 · 拖动可排序或归位）',
      }, dragOnto(node, false)),
        h('input', {
          type: 'checkbox',
          checked: done,
          onChange: () => setTodo(node.id, toggleStatus(node.status)),
        }),
        titleNode(node, 'dsh-wb-tasktitle', { canToggle: true }),
        delegChip(node),
        warnBadge(node),
        behindChip(node),
        evidChip(node),
        priBadge(node),
        dueSpan(node),
        h('button', {
          className: 'dsh-wb-act',
          title: '归位到某个计划下',
          onClick: (e) => { e.stopPropagation(); store.set({ moving: state.moving === node.id ? null : node.id }) },
        }, '↳'),
        h('button', {
          className: 'dsh-wb-act',
          title: '提升为计划（之后可以继续往下拆）',
          onClick: (e) => { e.stopPropagation(); setNodeKind(node.id, 'plan') },
        }, '⇧'),
        h('button', {
          className: 'dsh-wb-act',
          title: '删除',
          onClick: (e) => { e.stopPropagation(); doRemove(node) },
        }, '×'),
      )]
      if (state.moving === node.id) rows.push(movePick(node))
      return h('div', { className: 'dsh-wb-todowrap', key: node.id }, rows)
    }

    /** 一个计划节点（递归）。 */
    const renderPlan = (node, depth) => {
      const kids = sortNodes(childrenOf(node))
      const meta = []
      if (node.owner) meta.push('负责人 ' + node.owner)
      if (node.start || node.end) meta.push((node.start || '?') + ' ~ ' + (node.end || '?'))
      if (node.status === 'done' || node.status === 'dropped') meta.push(statusLabel(node.status))
      const m = node.metric
      const q = m !== null && m !== undefined && typeof m === 'object' && typeof m.target === 'number' && m.target > 0
        ? (m.current || 0) + '/' + m.target + (m.unit ? ' ' + m.unit : '')
        : null
      const progress = progressOf(node)

      const head = h('div', Object.assign({
        className: 'dsh-wb-planhead' + dragClass(node.id),
        key: 'head',
        style: { marginLeft: (depth * 12) + 'px' },
      }, dragOnto(node, true)),
        caret(node),
        h('span', { className: 'dsh-wb-planid' }, node.id),
        titleNode(node, 'dsh-wb-plantitle', { canToggle: false }),
        delegChip(node),
        warnBadge(node),
        behindChip(node),
        evidChip(node),
        priBadge(node),
        q !== null ? h('span', { className: 'dsh-wb-planq' }, q) : null,
        h('span', { className: 'dsh-wb-planpct' }, pct(progress)),
        h('button', {
          className: 'dsh-wb-act',
          title: '在这个计划下加一项',
          // 往收着的计划里加子项要顺手展开：不展开的话新加的东西立刻不可见，
          // 看起来就像「加了但没加上」。
          onClick: (e) => { e.stopPropagation(); expand(node.id); setNodeDraft(''); store.set({ adding: state.adding === node.id ? null : node.id }) },
        }, '＋'),
        // 降回待办只在空计划上出现：有子节点的计划降级会让孩子们变成孤儿，
        // host 会拒绝。与其让用户点了再看到报错，不如不给这个按钮。
        childrenOf(node).length === 0 ? h('button', {
          className: 'dsh-wb-act',
          title: '降回待办（这是一个空计划）',
          onClick: (e) => { e.stopPropagation(); setNodeKind(node.id, 'todo') },
        }, '⇩') : null,
        h('button', {
          className: 'dsh-wb-act',
          title: '删除这个计划（连同子项）',
          onClick: (e) => { e.stopPropagation(); doRemove(node) },
        }, '×'),
      )

      // 收起来时只留标题行：进度百分比已经在标题行里，进度条与元信息属于
      // 「展开了才看」的细节。这样「全部收起」得到的是一份紧凑的主线清单。
      const open = !isCollapsed(node.id)
      const body = [head]
      if (open) {
        if (meta.length > 0) {
          body.push(h('div', { className: 'dsh-wb-planmeta', key: 'meta', style: { marginLeft: (depth * 12) + 'px' } },
            meta.map((x, i) => h('span', { key: i }, x))))
        }
        body.push(h('div', { className: 'dsh-wb-planbar', key: 'bar', style: { marginLeft: (depth * 12) + 'px' } },
          h('div', { style: { width: barWidth(progress) } })))
      }

      // 加子项：两个提交按钮区分「待办」与「子计划」，不让用户猜默认值。
      if (open && state.adding === node.id) {
        const submit = (type) => {
          const title = nodeDraft.trim()
          if (title === '') return
          addNode({ title, type, parent: node.id }, () => {
            setNodeDraft('')
            flash(type === 'plan' ? '已加子计划' : '已加待办')
          })
        }
        body.push(h('div', { className: 'dsh-wb-add', key: 'add', style: { marginLeft: (10 + depth * 12) + 'px' } },
          h('input', {
            type: 'text',
            autoFocus: true,
            placeholder: '加到「' + node.title + '」下…',
            value: nodeDraft,
            onChange: (e) => setNodeDraft(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); submit('todo') } },
          }),
          micButton(setNodeDraft, 'mic'),
          h('button', { onClick: () => submit('todo'), disabled: nodeDraft.trim() === '' }, '记作待办'),
          h('button', { onClick: () => submit('plan'), disabled: nodeDraft.trim() === '' }, '记作子计划'),
        ))
      }

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
      )
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
            ? h('span', { className: 'dsh-wb-coltitle' }, '📥 收件箱')
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

    const rows = []
    rows.push(h('div', { className: 'dsh-wb-header', key: 'h' },
      h('span', { className: 'dsh-wb-title' }, '工作计划'),
      h('div', { className: 'dsh-wb-headright' },
        // 视图切换：树形（默认）与看板各擅其场——节点一多，树越缩越深，
        // 看板把每个计划横向铺成一列、待办摊成卡片，俯瞰当前全貌更省力。
        h('div', { className: 'dsh-wb-viewtoggle', key: 'vt' },
          h('button', {
            className: 'dsh-wb-vbtn' + (view === 'tree' ? ' on' : ''),
            title: '树形：按计划的层级一层层展开',
            onClick: () => setViewPersist('tree'),
          }, '树'),
          h('button', {
            className: 'dsh-wb-vbtn' + (view === 'board' ? ' on' : ''),
            title: '看板：每个计划占一列，待办摊成卡片',
            onClick: () => setViewPersist('board'),
          }, '看板'),
        ),
        h('span', { className: 'dsh-wb-pct' }, pct(sum.progress)),
        // 折叠控点只在真有嵌套时出现：一层都没有的时候，两个按钮做什么都不发生。
        sum.depth >= 2 ? h('button', { className: 'dsh-wb-icon', title: '全部收起（只看主线）', onClick: collapseAll }, '⊟') : null,
        sum.depth >= 2 ? h('button', { className: 'dsh-wb-icon', title: '全部展开', onClick: () => applyCollapse([]) }, '⊞') : null,
        h('button', { className: 'dsh-wb-icon', title: '留档一个版本', onClick: snapshot, disabled: !sum.hasPlan }, '⤓'),
        h('button', { className: 'dsh-wb-icon', title: '刷新', onClick: refresh, disabled: state.loading }, '⟳'),
        // AI 入口。宿主没有模型服务时（state.ai.available=false）**不渲染**——
        // 给一个点了就报错的按钮，等于把「这里不能用」这件事藏到点之后。
        state.ai !== null && state.ai !== undefined && state.ai.available === true
          ? h('button', {
            className: 'dsh-wb-icon',
            title: 'AI 导入：用语音或图片建任务，并建议归到哪个计划',
            onClick: () => setAiOpen(true),
          }, '✨ AI')
          : null,
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
    // AI 块插在**错误条之后、列表之前**：它是「往这个计划里加东西」的入口，
    // 位置要在内容之上，但不能越过错误提示（那会把报错顶下去看不见）。
    {
      const block = aiBlock()
      if (block !== null) rows.push(block)
    }

    const body = []

    if (view === 'board') {
      rows.push(renderBoard())
      if (state.cwd !== '') rows.push(h('div', { className: 'dsh-wb-footer', key: 'f', title: state.cwd }, state.cwd))
      return h('div', { className: 'dsh-wb-wrap' }, rows)
    }

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
        const isLeaf = item.type === 'todo'
        body.push(h('div', { className: 'dsh-wb-focus', key: item.path },
          isLeaf
            ? h('input', {
              type: 'checkbox',
              checked: node.status === 'done',
              onChange: () => setTodo(node.id, toggleStatus(node.status)),
            })
            : null,
          titleNode(node, 'dsh-wb-tasktitle', { canToggle: isLeaf, draggable: false }),
          h('span', { className: 'dsh-wb-path' }, (isLeaf ? '' : typeLabel(item.type) + ' ') + item.path),
          delegChip(node),
          warnBadge(node),
          behindChip(node),
          evidChip(node),
          priBadge(node),
          isLeaf ? dueSpan(node) : (node.end ? h('span', { className: 'dsh-wb-taskdue' }, node.end) : null),
        ))
      }
      rows.push(h('div', { className: 'dsh-wb-body', key: 'body' }, body))
      if (state.cwd !== '') rows.push(h('div', { className: 'dsh-wb-footer', key: 'f', title: state.cwd }, state.cwd))
      return h('div', { className: 'dsh-wb-wrap' }, rows)
    }

    // 收件箱：先记下来，之后再归位（↳）。没有它，「收不进来」这条就一直成立。
    //
    // 记入收件箱走这一个函数。回车与「记下」按钮原来各写了一遍提交逻辑——两份就会
    // 有一份漏掉后面的「展开建议」，于是键盘记的没有建议、点按钮记的才有。
    const submitInbox = () => {
      const title = draft.trim()
      if (title === '') return
      addNode({ title, type: 'todo' }, (res) => {
        setDraft('')
        // 记完立刻把「该归到哪」摊开。它是**行内**的（不是弹窗），不打断连着记几条
        // 的节奏；没有够格的建议就不弹，免得白占一行。
        const fresh = freshNode(res)
        const sug = fresh !== null && Array.isArray(fresh.parentSuggestions) ? fresh.parentSuggestions : []
        if (sug.length > 0) {
          store.set({ moving: fresh.id })
          flash('已记入收件箱 · 建议归到「' + sug[0].title + '」')
        } else {
          flash('已记入收件箱')
        }
      })
    }
    const inboxRows = []
    inboxRows.push(h('div', { className: 'dsh-wb-inboxhead', key: 'ih' },
      h('span', { className: 'dsh-wb-planid' }, '📥'),
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
          if (e.key === 'Enter') {
            e.preventDefault()
            submitInbox()
          }
        },
      }),
      micButton(setDraft, 'mic'),
      h('button', {
        onClick: submitInbox,
        disabled: draft.trim() === '',
        title: '记入收件箱',
      }, '记下'),
    ))
    for (const todo of sortNodes(inbox)) inboxRows.push(renderTodo(todo, 0))
    body.push(h('div', { className: 'dsh-wb-inbox', key: 'inbox' }, inboxRows))

    if (!sum.hasPlan) {
      body.push(h('div', { className: 'dsh-wb-empty', key: 'empty' },
        h('div', null, '这个工作区还没有计划。'),
        h('div', null, '点下面的「＋ 新建顶层计划」开始，或在对话里对 agent 说：'),
        h('div', { style: { marginTop: '6px', color: 'rgba(127,127,127,.95)' } },
          '「帮我把这个季度的工作计划拆成计划和子计划」'),
        h('div', { style: { marginTop: '8px', fontSize: '11px' } }, '计划会落在 ' + (state.dir || '<工作区>/plan')),
      ))
    }

    for (const node of roots) {
      if (nodeType(node) === 'plan') body.push(renderPlan(node, 0))
    }

    // 落在空白处 = 移回顶层（收件箱）。与 ↳ 选择器并存：选择器适合跨很远的目标，
    // 拖动适合挪到眼前的位置。接收器挂在 body 上，所以行内必须先 stopPropagation。
    if (hint !== null && hint.id === null) body.push(h('div', { className: 'dsh-wb-rootdrop', key: 'rootdrop' }))

    // 新建顶层计划。空工作区时这是**唯一**的建计划入口——不能为了建第一个计划
    // 就被迫去开一个对话，「让 agent 也能做」不等于「只能靠 agent 做」。
    if (state.adding === ROOT_ADD) {
      const submitRoot = () => {
        const title = nodeDraft.trim()
        if (title === '') return
        addNode({ title, type: 'plan' }, () => { setNodeDraft(''); flash('已新建计划') })
      }
      body.push(h('div', { className: 'dsh-wb-add', key: 'rootadd' },
        h('input', {
          type: 'text',
          autoFocus: true,
          placeholder: '新建一个顶层计划…',
          value: nodeDraft,
          onChange: (e) => setNodeDraft(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); submitRoot() } },
        }),
        micButton(setNodeDraft, 'mic'),
        // 这里只有「建计划」一个提交口：顶层的待办就是收件箱，而收件箱的输入框
        // 就在上面常驻着，再放一个「记作待办」等于把同一个动作做两遍。
        h('button', { onClick: submitRoot, disabled: nodeDraft.trim() === '' }, '建计划'),
        h('button', { onClick: () => { setNodeDraft(''); store.set({ adding: null }) } }, '取消'),
      ))
    } else {
      body.push(h('button', {
        key: 'rootadd',
        className: 'dsh-wb-rootadd',
        onClick: () => { setNodeDraft(''); store.set({ adding: ROOT_ADD }) },
      }, '＋ 新建顶层计划'))
    }

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
