# AGENTS.md — dsh-workbench 开发手册

本文件是这个工作区的开发约定。在此目录打开会话时，agent 应先读本文件。

## 这个项目是什么

`dsh-workbench` 是一个 **DeepSeek Harness（dsh）Web 插件**，做「个人工作台」：
工作计划的**待办 / 计划 / 子计划 / 委派**四条主线，加**重要程度（管控强度）**
——它决定这个节点要走多少流程：周期与负责人、逾期提醒、落后预警、完成证据——
再加**版本留档**；数据以 Markdown/JSON 落在用户自己的工作区里、纳入 git。

它不是独立 web 应用。它跑在 `dsh web` 里，作为侧边栏的一个 tab 存在。

**载体是硬约束：一切能力都必须落成 DSH 插件的两个面**——agent 工具 + 侧边栏面板。
不做独立服务、不自建 LLM 通道、不自造会话与权限。需求侧只描述「要什么」，
实现侧一律回答「怎么在插件的两个面上实现」。这条写在这里是为了防止需求漂移成
「再起一个 web app」——那会丢掉本项目最大的优势：agent 天然在场、能自己读写计划。
（需求方案见 [docs/PRD.md](./docs/PRD.md)，范围与模型见 [docs/SCOPE.md](./docs/SCOPE.md)。）

## 架构：一个包，两个半身

DSH 插件的扩展单元是 npm 包，一个包同时挂两个面：

| 半身 | 源码 | 挂载方式 | 职责 |
|---|---|---|---|
| Host | `src/index.js`、`src/store.js` | `dsh.bundle.patch` → `cordis.patch.yml` | 注册 agent 工具（`ctx.tools.register`）、暴露 HTTP 数据面 |
| Client | `src/client/index.js`、`src/client/logic.cjs` | `dsh.client.inject` + `platform: web` | React UI，注册成 better-sidebar 的 tab |

**关键差异点**：host 半身暴露 `plan_*` 工具，所以 **agent 能自己读写计划**。
AI 干完活可以自己把任务标完成，进度不需要人工同步。任何新功能都要问：
「这件事该让 agent 也能做吗？」如果答案是「是」，就必须同时给工具和 UI。

## 常用命令

```sh
node scripts/build.mjs        # 构建（产物在 lib/，lib/ 不入库）
node --test test/*.test.mjs   # 跑测试（436 个，分五层见下）
npm test                      # 构建 + 测试

# 装到正在用的 web profile（首次或改动 manifest 后）
dsh plugin --profile web add /Users/tinyseven/Documents/DSH/dsh-workbench
```

**测试分层**（每层能看见上层看不见的错，不要合并）：

| 文件 | 驱动什么 | 挡住哪类错 |
|---|---|---|
| `store.test.mjs` | 数据层纯函数 | 算法与校验本身 |
| `host.test.mjs` | 假 Cordis + **真**工具与 HTTP 路由 | 工具接错函数、路由漏参数、**两层相接处**的错 |
| `logic.test.mjs` | 客户端纯逻辑 + 跨半身一致性断言 | 两侧重复实现漂移 |
| `client.test.mjs` | **假 React + 真构建产物里的面板组件** | 面板打不开、手势接错、改名的请求参数不对 |
| `build.test.mjs` | 产物字符串 | 静默失效（见坑 #1）、清单不同步 |

**改完必须重启 `dsh web` 才能生效**——host 半身是组合树里的一行，不是热加载。
改 client 半身后至少也要刷新页面（client bundle 由 profile 启动时装配）。
注意 `client.test.mjs` 与 `build.test.mjs` 读的是 `lib/`，所以**先构建再跑测试**
（`npm test` 已经这么排）。

## 数据模型

计划落在**当前会话工作区**之下，不落在插件目录、也不落在 `~/.dsh`：

```
<workspace>/plan/plan.json      结构化真相（唯一可写源）
<workspace>/plan/PLAN.md        从 plan.json 生成的只读视图
<workspace>/plan/.versions/     每次变更前的快照（版本留档）
```

**一棵递归树**（schema 2，结构细节见 `src/store.js` 顶部注释）：

```
plan.nodes[]                      顶层节点；其中 type=todo 的顶层节点就是**收件箱**
  node.type      'plan' | 'todo'  plan 可挂 children（深度不限），todo 是叶子
  node.children[]                 只有 plan 有；子计划 = plan 嵌 plan
```

**为什么要从固定三层改成递归树**：三层表达不了「年度 → 季度 → 月度 → 周」这类链条，
也放不下「子计划里再分子计划」——而这正是「可以分级」的诉求。递归树是同一个模型的
自然表达：进度、定位、留档的算法都退化成同一个递归，特例反而更少（原来分散在
`krProgress` / `goalProgress` 里的两套算法，现在合成一个 `nodeProgress`）。

**老数据怎么办**：schema 1（`goals`/`krs`/`tasks` + `inbox`）在**读取时**自动迁移、
写入时落成新格式，用户不需要跑任何迁移脚本，也不会有一刻看到坏数据。迁移是**无损**的
——老 id（`g1` / `k1` / `t1`）原样保留，因为历史会话消息与 `.versions/` 里的快照都还在
引用它们；新节点统一用 `n` 前缀，与老 id 不冲突。`restore` 回滚到老格式快照时同样迁移
后落盘：回滚要的是「内容回到那一刻」，不是「格式回到那一刻」。

**收件箱 = 顶层待办**（`type: 'todo'` 的顶层节点）。它是针对「收不进来」这个问题的解：
记一条事的成本必须趋近于零，所以允许先记下来、之后再归位（`plan_node_move`）。

每个节点都可以带这几个**可选**字段（缺省行为与加字段之前完全一致）：

- `priority`：`high` / `normal`（默认） / `low` —— **管控强度开关，不是彩色标签**。
  `high` 要求计划有周期与负责人、待办有截止、完成要有证据；缺口由 `nodeWarnings()`
  以**警告**形式指出而**不硬拦**——在捕获的那一刻硬拦，人会干脆不记。默认 `normal`
  也是有意的：默认 `high` 会让人人标 `high`，管控机制立刻失效。
- `delegate`：`{ to, at, expectAt, status }`，`status` ∈ `pending` / `accepted` /
  `declined` / `returned`。两种逾期**分开算**：`overdueReceipt`（该去问一句「接不接」）
  与 `overdueWork`（该去催进度）。重新委派会重置回执——换人意味着上一轮作废。
- `doneAt` / `startedAt`：完成与开工时间戳，是所有时间维度统计（周报）的上游。
  离开 `done` 会**清掉** `doneAt`，否则被撤回的完成会一直出现在「本周完成」里。
- `metric`：`{ target, current, unit }`，可计数的节点按它算进度（原量化 KR 的字段）。
  写入是**逐字段合并**，不是整体替换：只传 `current` 不能把 `target` 抹掉（见坑 #10）。
- `evidence`：`[{ kind, ref, note?, at }]`，**追加式**（不是覆盖）。`kind` ∈
  `file` / `session` / `command` / `link` / `note`，缺省按 `note`。同 `kind` + 同 `ref`
  视为同一条，不重复追加。只有 `file` 会被核验（查文件是否存在，相对工作区根解析），
  其余四种只记录、不假装能验。
- `files`：`[{ kind, ref, note?, at }]`，**关联资料**，与 `evidence` 语义彻底分开——
  evidence 是「做完了的凭证」（绑「无证据完成项」审查线），files 是「做这件事要看
  的资料」（跟完没完成无关）。`kind` ∈ `file` / `folder`，`ref` 是**相对 vault 根**
  的路径（不是相对工作区根！），同样追加式、同 `kind` + 同 `ref` 去重。核验（存在性）
  与 obsidian:// 链接都按 `plan.vaultPath` 拼——所以 `fileWarnings` 在没配 vault 时
  返回空（不假装能验），配了才逐条查。vaultPath 是**机器相关配置**，存 `plan.json`
  顶层而非节点里（整个工作区共用一个 vault），换机器换人重配一次即可。
- `blockedBy`：`[id]`，**任务依赖**（MLO 的单向阻塞语义）。里面的 id 有任何一个
  未完成，这个节点就是「被挡住」的；完成对方自动解锁（完成**不删**依赖——
  留着历史，撤回完成会重新挡住）。层级不是依赖：挂在计划下是归属，跟做不做得成
  无关。`blockedAdd` / `blockedRemove` 按 **id** 不按标题（依赖是精确的工程关系，
  标题匹配留给建议类功能）。环 / 自依赖 / 目标不存在在 `addBlockedBy` 一处拦。
- `starred`：`true`（可选布尔），「我正在做 / 接下来做」，只影响执行清单排序。
  故意不做成状态：进行中已经在 `status` 里有（doing），两套语义会打架。
  关掉就删键——磁盘上不出现 `starred:false` 的噪音。
- `filed`：`true`（可选布尔），**已纳入工作计划**。收件箱里的顶层待办有两条出路：
  **归位**到某个已有计划下当子项（`plan_node_move`），或者**纳入工作计划**——
  不作为谁的子项，而是以独立条目出现在「工作计划」栏里（面板上那个常显的
  「纳入计划」按钮走 `/node-set` 的 `filed`，agent 走 `plan_node_set` 的同名参数，
  两者都走 DEP_PARAMS 通道——**零新增工具、零新增路由**）。由此 `inboxOf` 与
  `workPlans` 互补：一个顶层节点要么在收件箱、要么在工作计划栏，不会两边都出现。
  **只在顶层有意义**：`appendChild` 挂到别人下面时会清掉它，`normalizePlan` 读盘时
  对非顶层节点也清一遍——留着的话，将来把这条挪回顶层会**凭空回到工作计划栏**，
  静默发生且从界面上无从解释。关掉同样删键。
- `recur`：`{ kind: 'week' | 'month' }`，重复任务。完成带 recur 的待办时
  `spawnRecurring` 克隆一条新的挂回原处，截止顺推一期（month 落到月末截断）。
  克隆**要**：标题 / 负责人 / 优先级 / 备注 / 重复规则；克隆**不要**：
  完成时间 / 证据 / 关联 / 星标 / 依赖——那些说的是「上一次」。
  只在「非 done → done」那一下触发，重复保存不刷克隆。

**四个派生量不落盘**（与 `progress` 同理，避免两个真相源漂移）：

- `pace` / `behind`：配速 = `(今天 − start) / (end − start)` 与 `nodeProgress` 比，
  差 ≥ `PACE_THRESHOLD`（0.15）算落后。只在「有完整周期 + 周期正在走」时才算，
  四种情况一律返回 `null`：没周期 / `start` 还没到 / 已过 `end`（那是**逾期**，
  两种信号分开才能触发不同动作）/ 已完成或已放弃。
- `unverified`：已完成且 `evidence` 为空。它是本插件**独有的议题**——人类工具不需要
  防自己，但一个会自己打勾的 agent 需要。与 `nodeWarnings` **分开**：警告是「补元信息」，
  它是「去核验」，混在一个 ⚠ 里两个信号都会变糊；它靠「筛选 + 清单」暴露，
  不靠 ⚠。`⚠` 里只对 `high` 档加了一条「完成但没有证据」——那一档才是承诺了完整流程的。
- `ai`：`/get` 随计划一起下发的 AI 入口可用性，由宿主是否提供 `llm` 与
  `agentDefaultModel` 决定。它也是派生量——宿主装上模型插件后无需任何配置
  面板就亮起；插件没装时面板不渲染入口，避免点一个用不了的按钮。
  **派生量不落盘**这条对它同样成立：不存进 `plan.json`。
- `parentSuggestions`：归位建议——给每条**还没归位的顶层待办**推荐该放进哪个计划下
  （子计划也算）。在 `store.js` 的 `suggestParent` 里规则打分：计划标题用词重合 ×3、
  子项标题重合 ×1（封顶 3，免得子项多的大计划靠随机命中累积）、命中量化单位 /
  截止日期落在计划周期内 ×2、提到负责人 ×3，阈值 2。中文不分词，重合度用**字符
  二元组**近似，不引入词典也不引入模型——归位是高频小动作，等一次模型调用不划算，
  而且建议必须能解释（用户要看懂「为什么推荐它」才敢一键接受）。只算一次（host）、
  随 `plan_show` 下发，**客户端不重算**：于是面板和 agent 看到的是同一个建议，
  agent 想改判归属时不必再开一条通路。候选集复用 `isDescendantOf`（与 moveNode
  同一处合法性判定）。**没有够格的依据就返回空**——一条待办总能和某处碰巧共用一个
  二字词，把这种凑出来的建议显示出来，比不给建议更伤信任。

**未来日程（Things 3 式 Upcoming）**：客户端的 `upcomingByDay(plan, today)` 纯函数，
把「未来 7 天」从一句数字变成按天分组的清单（逾期单独置顶）。它的纪律是上面
「要算日期的一律只读服务端标注」的延伸：**判定读服务端的 `overdue` / `dueSoon`，
客户端只拿节点自身的 `due`（容器用 `end`）做分组**——所以窗口与 `dueSoon` 一致
（7 天），函数**不开放 `days` 参数**：开放了就等于逼客户端重算日期口径。
只含「有事项的天」：空天不占一行（面板空间很贵，空白列表会让真正有事的那些天
更难找）。逾期不混进「今天」——逾期（该做没做）与今天到期（正要做）是两种信号，
混在一起会让人误判，与「被挡的单独折叠」同一个思路。

**这些派生量的口径要在 `annotate`（host）和 `logic.cjs`（client）两边一致，**
`parentSuggestions` 是例外：它只在 host 算、client 只读（打分要看整棵树）。
不需要算数的（`unverified`）可以在客户端兜底；要算日期的（`behind`）**一律只读服务端标注**，
不在客户端重算——重算就会出现「面板与服务端算出不同答案」而没人知道哪个对。

**类型由结构派生（不落盘）**：**有子项的节点就是计划，没有子项的就是待办**——
用户原话「只有最后一级就是待办，如果下面还有级的就变成计划或子计划」。
由此推论：
- **没有「换型」这个动作**。待办发现要拆，直接往它下面挂子项（面板行内 ＋、
  `plan_node_add` 带 `parent`），挂上第一个子项它自动变成计划；
  删光子项它自动变回待办。`normalizeShape` 负责归一状态：
  `todo`/`doing` 挂子后归一成 `active`，`active` 删光子项后归一成 `todo`——
  不归一留下的是「对该形态非法的状态」，而它不会报错，只会让进度、筛选、
  角标**静默错值**。done / dropped 不动（完成与放弃是人的决定）。
- **工具与 HTTP 面不再接受 `type` 参数**（`makeNode` 忽略它，`normalizePlan`
  读盘时清掉旧字段）；详情页没有类型段，行内的 ⇧/⇩ 换型按钮删除。
- **任何节点都能当父**（挂在待办下是可以的——挂上就变成计划），只有自环
  与「移进自己的子孙」仍被 `moveNode` 拦。
- **归位建议的候选集仍是「容器」**（`collectNodes(plan, 'plan')`）：给叶子
  推荐子项没有意义，用户随时可以用行内 ＋ 手动拆。

**完成语义一体化（用户原话：「计划和待办应该是一体的」）**：无论计划还是待办，
**叶子**（下面没有子项）都是一件能做完的事——面板给勾选框（计划走 `/node-set`
的 status，待办走 `/todo-set`），agent 走同一条写入。**有子项的节点不能手动
完成**：它的完成是子项派生出来的，`assertManualDoneAllowed` 在四个写入入口拦
（面板勾选框根本不出现、详情页禁用按钮、agent 收到可读报错）。子项全部完成时
`autoCompleteAncestors` **级联自动完成**父链（记 doneAt、reason 标 `auto-done`）；
撤回子项时 `reopenAncestors` 把自动完成的父链重新打开（清 doneAt）——否则
「父已完成、子还开着」是两个真相源打架。dropped 的父不被顺手复活：放弃的分支
不参与级联。手动标 `dropped`（放弃整个分支）不受影响。

**写入路径唯一**：面板（HTTP 面）与 agent 工具都调用 `store.js` 的同一组函数
（`applyFields` / `setStatus` / `setNodeType` / `setPriority` / `setDelegate` /
`setReceipt` / `addEvidence`），谁都不另写一套；每一次写入都自动归档版本，
所以没有「绕过留档」的路径。

**加能力的默认姿势是「不加工具、不加路由」**：落后预警是整个算出来的派生量，
完成证据与文件关联的**写入**都是 `plan_node_set` / `plan_todo_set` 上的可选参数
（`evidenceKind` / `evidenceRef` / `evidenceNote`、`fileKind` / `fileRef` / `fileNote` /
`fileRemove`，一次一条，要多条就调多次——正好契合追加语义）；**详情编辑页也没有
新增任何通路**：它把十几个字段合成一次 `/node-set`（新建是 `/node-add`），
字段清单由 `logic.cjs` 的 `formRequest` 统一产出。
两处**有意识的破例**都与文件系统有关：读 vault（`plan_config_set` / `plan_file_read`，
见上一段）与面板的 `/config-set` `/file-read`。现在 15 个工具、12 条路由。
**工具面按节点组织这条线要守住**：每冒出一个概念就长一套 API，agent 花在
「该用哪个」上的注意力迟早超过事情本身。

**两种写入语义，别混**：agent 工具是**增量**语义（`opt()` 把空串当「没传」，
不传的字段不动）；面板表单是**整块**语义（所见即所得，留空 = 清掉），
所以它额外提交 `clear: string[]`（白名单见 `store.CLEARABLE`），由 `clearFields`
执行。混用会两头出错：拿增量的口径做表单，用户清不掉任何字段；拿表单的口径做工具，
agent 少传一个参数就把数据抹了。

**为什么 JSON 为真相、Markdown 为视图**：计划是需要程序增删改查的树（进度汇总、
按 id 定位、版本回滚），直接解析 Markdown 需要稳健解析器且格式漂移会静默丢数据；
但只存 JSON 又失去人可读、可 git diff、可被 agent 直接读懂的好处。双表示各取所长：
写入走结构化路径（有校验），阅读与 diff 走 Markdown。改数据结构时不要破坏这个分工。

进度是**派生量**，不落盘：`nodeProgress` 递归算——有 `metric` 按 `current/target`，
否则按子节点完成度的平均，叶子按 `done` 给 0 或 1；`planProgress` 取各**顶层计划**的
平均（**不含收件箱**——收件箱不是计划的一部分，它计入角标与统计，但不影响完成度）。

## 侧栏页脚入口：一个按钮，两个平台

面板本身是 better-sidebar 的一个 tab。此外还向宿主的 **`sidebar.footer.action`** 插槽
注册了**一个 `<button>`**（`WorkbenchEntry`，带 `data-dsh-workbench-entry`）。

**为什么值得单独加一个入口**：手机外壳插件 `dsh-zen-remote` 会扫描
`[data-slot="sidebar.footer.action"]` 的**每个直接子节点**，把第三方插件的入口
**自动收成手机主屏 chips 行里的一颗 chip**（它的 `scanHarvest`）。我们一行 zen 的
代码都没改，主屏就多了一个「工作计划」。所以这个组件的形态是被它的收割规则
**约束**的，不是随便写的：

| 规则 | 为什么 |
| --- | --- |
| 根节点必须是 `<button>` | 收割按「直接子节点里第一个可点元素」取；返回 Fragment 多根，第二个根会变成**另一颗 chip** |
| 必须有**可见文字** | chip 的名字取自 `textContent`（其次 aria-label / title），取不到就整条丢掉 |
| 带一个 `<svg>` | chip 的图标是把它深拷贝、剥掉 id 之后用的 |
| **不能**带 `data-mobile-nav` | 那是 zen 自己的标记，它据此跳过自己渲染的节点 |
| 名字里**不能混进计数** | chip 的名字就是 `textContent`，未完成数一旦是个真实节点，名字会变成「工作计划5」；而 zen 的 chip 开关偏好按 `harvest:${name}` 存，**名字一变偏好就丢**。所以计数写成 `data-count` + CSS 伪元素（伪元素内容不进 `textContent`） |

**尺寸要跟页脚邻居同一把尺**：这个按钮跟宿主的「设置」、`dsh-context` 的
「Context Insights」并排站在同一个 `footerActions` 列里（宽侧栏下是横排）。
它第一版是按面板自己的字号配的（12/18、内边距 4×6、圆角 6），在 Mac 上一眼就
看出「这不是亲生的」。现在的值是**在真机上量邻居得到的**：高 42、内边距
`0 10px 0 8px`、圆角 12、间距 8、字号 14/22（宿主 token `--dsw-font-s-14`，
别名层里叫 `--wb-f-footer`），再照 `Context Insights` 补 `width:calc(100% + 4px)`
+ `margin:0 -2px` 抹掉 `footerActions` 的左右缩进。**页脚这一排不配
`corner-shape:round`**——宿主对 `*` 施加的 `superellipse(1.5)` 是这排按钮的共同
底子，三个邻居都没配回（坑 #19 管的是面板内部的胶囊）。见坑 #31。

**点击走服务，不代点 DOM**：`betterSidebar.openTab({ type: 'dsh-workbench:plan' })`。

**关键是「不传 `target`」**：`openTab` 里的分叉是

```js
if (surface !== undefined && seed.target !== 'bottom') { /* 走 surface = 官方右侧栏 */ }
// 否则 → 底部工作台
```

也就是说 `target: 'bottom'` 是**反过来**的开关——写了它就掉进底部工作台，
面板应该在**右侧栏**里长出来。这个字段很容易望文生义写错（我第一版就写错了，
真机反馈「要触发右侧栏，不是下栏」才发现）。

**这条纪律是被 zen 的 bug 教会的**（见坑 #30）：它那颗手机按钮就是「代点 DOM」，
锚在 `[data-dsh-better-sidebar] button[class$="_toggleButton"]` 上，宿主一改结构就
命中 0 个元素、点了没反应。服务调用不怕改类名。

## 面板的本地状态（不进 plan.json）

面板上有一批状态**只属于这一台机器的这次浏览**，它们既不进 `plan.json`、也不走
版本归档：

| 状态 | 放在哪 | 为什么 |
|---|---|---|
| 折叠展开（`dsh-workbench:collapsed`） | `localStorage` | 是「我现在想看到什么」，不是计划数据。写进计划会污染 diff、占版本快照，还会跟着 git 提交跑到别人机器上 |
| 视图切换 树/看板（`dsh-workbench:view`） | `localStorage` | 和折叠同类：只是这台机器这个人想怎么看，不进 plan.json、不占写入路径 |
| 改名中的草稿、拖拽中的落点、正在归位/加子项的节点 | 组件本地 `useState` | 拖拽时鼠标每动一下都要更新落点，放全局 store 会让 tab 角标跟着重算 |
| 详情编辑页的草稿（`form`）与 AI 草稿队列（`aiQueue`） | 组件本地 `useState` | 整块替换面板期间树不渲染，「未保存」不可能悄悄发生，也就不需要脏检查 |
| 浮球浮层的展开态（`fabOpen`）与键盘高度（`fabGap`） | 组件本地 `useState` | 连跨一次刷新都不需要——刷新后收起才是对的；键盘高度本来就是渲染期测量值 |

**判据**：这份状态换个浏览器打开还需要吗？需要 → 进计划；不需要 → 进 localStorage；
连跨一次刷新都不需要 → 进组件本地 state。

**就地编辑没有新增任何工具或路由**：改名复用 `/node-set` 的 `title`，排序复用
`/node-move` 的 `index`，新建顶层计划复用 `/node-add` 不传 `parent`。这是「加能力的
默认姿势」那一条的又一次执行——面板缺的从来不是新接口，是既有接口的入口。

**看板（Kanban）视图同样零新增通路**：树型目录节点一多就会越缩越深、越难俯瞰，
所以另给了一种二维读法——表头「树 / 看板」切换，看板把**每个顶层计划（含收件箱）
占一列、待办摊成卡片**，列头带完成度与「未完成/总数」、卡片带所属子计划路径与各类标记。
它**只读 `/get` 下发的同一份 payload**（分列逻辑在 `logic.cjs` 的纯函数 `boardColumns`，
被 `build.mjs` 内联进 bundle 闭包），不新增任何工具或路由；勾选/改名/换档写入与树形
共用 `/todo-set` `/node-set`。视图偏好（`dsh-workbench:view`）与折叠同类，只进 localStorage。
筛选芯片在看板里同样生效（`boardColumns` 内部复用 `focusList` 的口径）。

**详情编辑页同样零新增通路，而且刻意做成「整块替换」**：节点上的 ✎（或表头
「＋ 新建」）把整个面板换成这一个节点的表单——标题 / 类型 / 状态 / 重要程度 /
负责人 / 周期 / 截止 / 量化进度 / 备注 / 委派 / 证据增删 / 关联资料 / 归位 / 删除。
做成整块而不是抽屉或行内展开，是因为字段有十几个，塞进窄容器就得靠滚动去找，
「所有信息都能改」会变成「理论上都能改」；整块替换还顺带消灭了脏检查——
返回就是放弃，不存在悄悄未保存的改动。字段清单由 `logic.cjs` 的 `formRequest`
统一产出（新建与编辑共用一份，否则迟早出现「新建支持某字段、编辑不支持」），
保存合成一次 `/node-set`，清空另走 `clear: []`（见「两种写入语义」）。
**    AI 解析出的草稿也进这张表单**（`aiApply` 只填草稿、不落库，「全部采纳」是
  逐条过一遍），所以「AI 帮我记」不等于「AI 替我决定」。

## AI 助手：第一入口，也是处理信息的助手

**入口只有一个：底部那颗浮球**（`.dsh-wb-fabball`）。收起时是一颗球，点开是一块
输入浮层；手机与桌面**都渲染**（`props.touch` 那套门控已经删掉）。它**既能问也能记**：
`/ai-parse` 一次调用同时回 `{ reply, tasks }`——提问时给答复，报事时给草稿 +
一句风险提醒。宿主没模型服务时不消失，退化成纯输入框（直接走 `/node-add`）。

**浮球点开就聚焦输入框（`autoFocus`）**：手机上的语音**正道是输入法自带的那颗话筒**
（豆包 / 讯飞…），而输入法是系统的东西，网页够不到——没有任何 API 能让网页按下它。
网页唯一能做的「唤起输入法」就是聚焦一个输入框、让键盘连着话筒弹出来，剩下那一下
必须由人点。所以浮球能给的极限是「一点 → 键盘就在手边」。

`autoFocus` 是**主路径**，因为 React 把它实现成挂载时的一次 `focus()`，而这次挂载
就在**点击的同一个任务里**——iOS 只认「用户手势里」的 focus，晚一个 tick 就不弹键盘
（那个 `useEffect` 只是兜底）。改这里时别顺手改成 `setTimeout(() => focus(), 0)`。

插件自己那颗话筒走 Web Speech API，它只在**安全上下文**里可用（见坑 #33）：手机上
走明文 HTTP + 局域网 IP 时，点它会被 `startVoice` 的前置判断拦下来并说清原因，
而不是让它去撞 `not-allowed`、再报一句错的「麦克风没有授权」。

**「面板顶部常驻一行输入」是有意撤掉的**：同一件事有两个入口，人就得先想「我该用
哪个」，而那个问题的答案对用户毫无价值；面板又住在一个又宽又矮的地方，常驻一行
等于每屏少一条任务。问一句是低频动作，它不配占这种地方。要改回常驻之前先读这一段。

- **掌握「当前 + 归纳」的全部信息**：`ai.js` 的 `aiContext(plan)` 把整棵树压成
  人读得懂的几段（方向 / 手上的活 / 逾期与本周 / 委派 / 最近完成 / 待核验 /
  关联资料）。**只给标题与状态，不给 id**——与 `planOutline` 同一条理由：模型
  复述的 id 无从校验。
- **历史依据**：`store.historyHints` 按 bigram 相似度找出历史上做过的类似的事
  （带「从开工到完成几天」），新增任务时模型据此说「上次那条拖了 12 天」。
- **专家意见与选项**：模型给 `advice`（必须引用上下文里的具体名字，没有依据
  就留空）与 `options`（最多 3 个，patch 只认 due/priority/plan/note）。
  点选项**不直接建**，只把 patch 并进草稿再打开表单。
- **按需读 vault**：只有问题里点到了某个关联文件（文件名出现在提问里）才读它，
  单文件截 8KB。全读一遍既慢又撑爆上下文。
- **对话只活在这次会话**：`aiTurns` 是组件 state，最多回带 6 轮、每轮 1500 字。
  它是「接着聊」用的，不是档案——**不进 plan.json、不占版本快照**。
- **人设在工作区文件里**：`plan/agents.md`（与 plan.json 同目录，被 git 忽略），
  没有就用 `ai.js` 的 `DEFAULT_PERSONA`。读 `/persona`、写 `/persona-set`
  （`append` 只往「记住的事」一节末尾加一条）。**人设不写死在提示词里**——
  性格与专业是这个工作区的事，改一句不该发一版插件。

## 执行清单与依赖：MLO 的引擎，单向阻塞就够

对齐 MyLifeOrganized 后补的最后一共四件：依赖（blockedBy）、星标（starred）、
重复（recur）与**执行清单**（树 / 执行 / 看板三视图之一）。设计要点：

- **执行清单回答「下一个动作是什么」。** 树和看板展示结构，执行视图把结构抹平：
  跨所有分支聚合「现在能做的」（未完成 + 未被挡），排序 星标 > 重要度 > 逾期/本周
  > 截止。**被挡的单独折叠**——它们不是没做，是做不了，混在一起会让人误以为拖延。
- **单向阻塞，不做 MLO 的完整规则。** blockedBy 里有一条没完成就是被挡；MLO 的
  「同分支自动顺序」每加一条规则，「为什么被挡」就难解释一层，最后变成黑箱。
- **AI 动态组成清单**：模型回 `list: { title, items:[标题] }`，host 把标题匹配回
  真实节点（`matchListTitles`，对不上的 ok=false 让人看得见），面板渲染成清单卡，
  一键**存为自定义视图**（localStorage `dsh-workbench:views`，与折叠同类：本机
  偏好不进 plan.json）。视图完成后自动剔除做完的。
- **AI 的产出仍是草稿**：清单卡只是视图建议，存不存、做不做都由人点。

## 必须知道的坑（都踩过）

1. **client 半身必须无条件导出。**
   ```js
   module.exports = { name: 'dsh-workbench-client', inject: ['slots', 'betterSidebar'], apply }
   ```
   不要学 `logic.cjs` 写 `if (typeof window === 'undefined')` 守卫。浏览器里
   `window` 存在 → 条件为假 → `apply` 永远不导出 → **面板静默不注册，零报错**。
   `test/build.test.mjs` 专门守这条，别把它删了。
   `logic.cjs` 那种守卫是安全的，因为它的函数由同闭包的 UI 代码直接引用，不走导出。

2. **client 的 `inject` 决定 Cordis 何时调 `apply`。** 不声明 `betterSidebar`，
   `ctx.get('betterSidebar')` 可能拿到 `undefined`，同样静默跳过注册。

3. **`cordis.patch.yml` 必须是 `insert`，且不要重复声明同一个 id。**
   在 profile 自己的 patch 里再写一条顶层 `- id: dsh-workbench` 会让插件注册两次。

4. **悬空的 bundle 行会让整个 profile 起不来**（不只是插件失效，连 GUI 都打不开）。
   动 `package.json` 的 manifest 或装插件后，务必验证：
   ```sh
   dsh --profile web --dump-config >/dev/null && echo OK
   ```
   并且确认 `main` / `exports` / `cordis.patch.yml` 指向的文件真实存在
   （`test/build.test.mjs` 已覆盖）。

5. **`dsh-schedule` 这个名字在 npm 上被别人占了**（Wang-Lin-Chang 的持久调度器），
   不是那个「日程面板」插件。要装日程面板得从
   `github.com/magicOF2/dsh-schedule` 构建。命名时注意避开已占用的包名。

6. **改 host 半身后必须重启**才生效；只测 `--dump-config` 不足以证明插件逻辑正确。

7. **定位分两层，别混用。** `resolveNode` / `resolveAny` 按 id / 标题 / 唯一包含匹配
   找人（工具参数允许传标题）；`locate` **只按 id** 取「它在树里的位置」（父节点、
   兄弟数组、下标），因为位置必须唯一确定。移动与删除必须
   「先 `resolveAny` 再 `locate(node.id)`」——少了这一步，「按标题移动一个节点」
   会报「找不到节点 id：xxx」。这条是 `test/host.test.mjs` 真跑工具时抓出来的。

8. **DSH 工具的参数 schema 不接受 `null`。** `{ type: 'string' }` 收到 `null` 会直接抛
   `invalid arguments: "parent" must be a string`，根本进不到函数体。所以「移到顶层」
   这类语义只能用**省略参数**表达，不能用 `null` 占位——工具的参数描述里必须写清楚。
   给工具加可选参数时留意同类问题。

9. **递归结构里凡是「跨层找东西」的地方，都要写成递归。** `nextId` 扫 id、
   `todoCounts` 数计划与待办、`collectNodes` 定位节点，最初都只遍历了顶层——
   表现为「嵌套计划里的待办不计数」「新建节点与深层节点重号」。改数据结构后
   第一件事是把所有遍历改成递归，并用测试覆盖「第三层」这种深度。

10. **「不传就不动」对**每个**字段都要成立，包括嵌在对象里的。** `metric` 曾经是整体
    替换，于是 `plan_node_set { current: 10 }`（只想更新当前值）把 `target` 静默抹掉，
    进度从「10/12」变成「没有指标、按状态算」——看起来只是数字变小，想不到是丢了数据。
    现在 `metric` 逐字段合并。**加字段时顺手问一句：它是个对象吗？那合并还是替换？**
    这条是 `test/host.test.mjs` 的配速用例顺带抓出来的（想验「进度跟上后标记消失」，
    结果标记没消失，因为 `target` 没了）。

11. **`file` 类证据的核验基准是工作区根目录，不是插件目录、也不是进程 cwd。**
    `evidenceWarnings(node, root)` 要显式传 root——`withProgress(plan, store.root)`
    一路带下来，别再改成从别处取路径。另外 `path.join(root, '/abs')` 会把绝对路径
    拼成相对路径（`join('/a','/b')` → `/a/b`），所以绝对路径必须先判 `startsWith('/')`。

12. **客户端不重算要算日期的派生量。** `behind` 只读服务端标注（阈值/日期只在
    `store.js` 一处实现）；只有像 `unverified` 这种**不含阈值与日期运算**的判定
    才允许在 `logic.cjs` 里兜底。原因是重算会出现「面板显示落后、服务端说没落后」
    而没人知道哪个对——这正是 NFR-2「派生量不落盘」要避免的那类漂移。

13. **`/node-move` 的 `index` 是「**先把自己摘掉之后**」坐标系里的下标。**
    `moveNode` 的实现是「摘掉 → 在目标列表的下标处插入」，所以同层往后拖时，
    目标的下标会因为自己离场而前移一位。客户端算落点时必须在**同一个坐标系**里
    算（`dropTarget` 里那句 `if (sameParent && from.index < at) at -= 1` 就是它）。
    错了的表现是「拖完之后顺序差一格」——很像手滑，是最难从现象倒推回来的那类错，
    所以 `test/logic.test.mjs` 里不比对数字，而是**把客户端算的落点喂给真的
    `moveNode`，看树长成什么样**。

14. **单击和双击抢同一个元素时，单击必须延后执行。** 待办标题上单击 = 切换完成、
    双击 = 就地改名。真实浏览器会先发两次 `click` 再发 `dblclick`，若单击立即执行，
    一次改名会**顺手把事办了**（还留下两个版本快照）。做法是单击排一个 200ms 定时器，
    双击到来时把它清掉；`e.detail` 挡不住这个——第二次 `click` 就已经是 `detail: 2`，
    第一次早就落地了。**复选框不受影响，它是即时路径**——想快就点框。

15. **拖拽落点的合法性只判一处，UI 不自己再判一遍。** 面板用
    `dropTarget() === null` 同时回答两件事：要不要画指示器、要不要
    `preventDefault`（不 preventDefault，浏览器自己显示禁止光标）。服务端**仍会再拦**
    （不变量归数据层，UI 只是不让用户白拖一趟）。另外拖拽时行内的 `onDragOver`
    必须**无条件** `stopPropagation`——外层 body 上挂着「拖到空白处 = 移回顶层」的
    接收器，漏拦一次（比如拖到自己身上提前 return 的那一支）就会在正在拖的那一行上
    闪出「移到顶层」。

16. **`test/client.test.mjs` 的假 Cordis 上下文里，`ctx.effect` 必须真的执行回调。**
    注册 tab 的代码写在 `ctx.effect(() => betterSidebar.registerTab({...}))` 里，
    而 Cordis 的 effect 是**立即执行**回调（返回值当清理函数）。替身写成
    `effect: () => {}` 会让面板静默不注册，报错却是「面板应注册成一个 tab」，
    看不出是替身的问题。同理，假 React 的 hook 槽位要在**每次挂载时**重置
    （否则两块面板共用同一批 state），而每次**渲染**只重置游标。

17. **面板不自管主题，也别跟 `prefers-color-scheme`。** 宿主把解出的方案投影到
    `body[data-ds-dark-theme]` + `html{color-scheme}`，并在 **`body` 上重映射整个
    `--dsw-alias-*` 层**。所以面板里写 `@media (prefers-color-scheme: dark)` 是错的：
    它跟的是**系统偏好**，而宿主跟的是**用户在设置里选的**主题。在「系统深色 + 用户
    选浅色」时，面板会渲染成深色块，与宿主整体错位——不报错，只是那块不像亲生的。
    查 token 定义只需读一个文件：
    `$(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js`

18. **别名层必须声明在面板自己的根上（`.dsh-wb-wrap`），不能写 `:root`。**
    `var()` 是在「**声明它的那个元素**」上就完成替换的，不是在用到它的元素上。写在
    `:root`(html) 会按 html 的浅色取值算死，`body[data-ds-dark-theme]` 的暗色重映射
    传不下来——表现是「token 看着完全正常，只是切主题不翻色」。这是本次最容易被静默
    坑到的一处。`test/build.test.mjs` 有断言守它。

19. **别跟宿主抢两样全局约定。** ①宿主对 `*` 施加了 `corner-shape:superellipse(1.5)`，
    把胶囊压得走形，所以圆形状要按宿主约定显式配回 `corner-shape:round`；②
    `::-webkit-scrollbar` 全局归宿主，面板不要重新实现一套。

20. **量对比度时必须等过渡结束再读 computed style。** `--ds-transition-duration` 是
    .2s，切完主题**立刻**读拿到的是动画**起点**（即旧主题的值），会把「已经翻了」
    误判成「没翻」，然后你去修一个并不存在的 bug。务实做法是 `sleep 2` 再量。
    同理，真机验证别去驱动用户真实的面板（打开 tab 会把工作区解析到用户真实的
    `plan/`，可能改到他的数据）——往页面注入一个**合成的 `.dsh-wb-wrap` 演示块**
    更安全：它照样吃到已注入的真实 CSS 与真实宿主 token，等效验证且零数据风险。

21. **面板的行密度是量出来的，不是配出来的。** 这个面板住在底部工作台里，**纵向
    空间是最稀缺的资源**：行高从 24px 松到 27.5px，一屏就少一条半任务，而这种退化
    不报错、review 也看不出来。改任何纵向间距后，量 `.dsh-wb-body` 的 `scrollHeight`
    和 `.dsh-wb-task` 的 `getBoundingClientRect().height`，与改动前对比——参考基准：
    任务行 24px、筛选行 33px、内容总高 @1004px ≈ 581。
    另一个容易搞反的点：**面板真实宽度是 ~1000px**（底部工作台），不是侧栏那种 400px。
    想验窄宽健壮性，得手动把演示块压到 420px 再看筛选行折不折行。

22. **语义色不做行内胶囊的文字色。** 宿主的红在浅色下是 `#ec1313`，对纯底 4.49:1
    （恰在 AA 线上），**再叠一层 5% 红软底就掉到 4.45:1**——就不达标了。所以红的
    小胶囊（「高」、委派逾期）文字一律走 `--wb-fg`，红只承担描边与底色（实测 18.9:1）。
    写任何「语义色 + 软底 + 文字」的组合前，先把**白底 / 5% 软底 / 深色底**三种情况
    都算一遍。`test/build.test.mjs` 有断言守这条（注意断言里不能直接查
    `color:var(--wb-danger)`——`border-color:var(--wb-danger)` 含有同一子串，会误判）。

23. **`files[].ref` 是相对 vault 根的，不是相对工作区根——两套基准别混。** `evidence`
    的 file 类相对工作区根（坑 #11），`files` 相对 `plan.vaultPath`（Obsidian vault）。
    混用的表现是「核验说不存在，Obsidian 里明明有」。另外三条纪律：①`vaultPath` 是
    **机器相关配置**，存 `plan.json` 顶层而不是节点里，换机器重配；②`plan_file_read`
    的 ref 必须过 `resolveRef` 的**越界防护**（resolve 后必须仍落在 vault 根内），
    否则 `../` 能读到 vault 外任意文件——面板与工具共用 `readVaultEntry`，防护只写
    一处；③没配 vault 时 `fileWarnings` 返回空而不是报错——没配是「还不知道」，
    不是「关联失效」，报错会把整个面板的 ⚠ 变成噪音。

24. **表单保存时 `to` 会被原样提交，委派要分「换人」与「只挪时间」两种情况。**
    `setDelegate` 会把回执重置成 `pending`（换人意味着上一轮作废），而表单每次保存
    都把委派对象原样发回来——不判断就会在「改个备注」时把对方「已接受」打回
    「待接受」。所以 `/node-set` 里：`to` 变了 → `setDelegate`；`to` 没变只是
    `expectAt` 变了 → `setDelegateExpectAt`（不动回执状态与委派时间）。

25. **AI 相关的解析不许靠「没有待办」判失败。** `parseAiReply` 曾经在 `tasks`
    为空时报「没有给出任何待办标题」，于是助手**只回答不建任务**被判成失败——
    而「问一句」恰恰是最常用的形态。现在的判据是 `reply` 与 `tasks` **都空**
    才算失败。同类陷阱：给模型加新职责时，要回头检查旧的「成功判据」
    是否把新形态误判成错误。

26. **渲染里不做 `store.set`，测试里点过的元素不许复用。** 自定义视图曾把
    「视图不存在 → 清掉 custom」写在渲染分支里：渲染期副作用触发级联重渲，
    全量测试时序一变就偶发挂掉。渲染只画「现在的样子」，清理交给事件回调。
    同族坑：替身 React 里拿到的元素是**那一次渲染的快照**，点完一次再点同一个
    元素，它闭包里的 state 还是旧的——每次点击前重新 `byClass` 取最新元素
    （真浏览器每次渲染也会换新节点，替身只是把这件事变得更较真）。

27. **`node --check` 抓不到「引用了不存在的标识符」。** 面板里曾经有两处
    `setAiPersonaOpen(false)`（人设内联编辑被移除后留下的调用），而那个 setter
    **从来没有定义过**——它是语法合法的自由标识符，所以 `node --check` 通过、
    425 条测试也全绿，只有在用户真的点到那颗「收起」按钮时才抛
    `ReferenceError`。教训：**删掉一份 state 时，要连同它的 setter 一起全局搜一遍**
    （`grep -n setXxx`），别只看 `const [x, setX]` 那一行；顺手把「点了它会发生什么」
    写进测试——没被点到的分支等于没测。

28. **`<button>` 里的图标不会自动居中。** `.dsh-wb-svg` 是 `display:block`，而 button
    的默认 `text-align:center` **只对行内内容生效**——块级子元素会贴着内容盒的左边
    排。真机反馈「话筒要居中」，量出来图标比圆心偏左约 9px（上下也偏），就是这条。
    凡是要在按钮里放单个图标的（浮球、表头图标、行内动作），容器的
    `display:flex;align-items:center;justify-content:center` 才是可靠做法。
    **别靠肉眼判断「看着挺正」**：把截图按 DPR 放大后量中心点，或者直接
    `getBoundingClientRect` 比「容器的中心 vs 图标的中心」，两个偏差都该是 0。

29. **提示词要什么，输出额度就得给得起——这两处必须一起改。** 系统提示让模型
    「最多 MAX_TASKS(20) 条」，每条带 title / due / priority / note / plan / advice，
    再加 2–3 个 options（每个 label + why + patch），外面还有 4~6 行 reply；
    而 `maxTokens` 却写着 `2048`。20 条 × 约 180 token ≈ 3600，装不下。两处各写各的，
    谁也没跟谁对齐，于是**拍照 → 拆待办**这条路必炸：一张清单照片会让模型老实吐
    十几条，一撞上就是 `finish=max-tokens`。现在额度是 `MAX_OUTPUT_TOKENS = 8192`，
    定义就写在 `MAX_TASKS` 旁边、注释里点明两者的关系，改一个就得看另一个。
    另外 **`max-tokens` 不是失败**：模型把能说的说完了。旧版 `collectText` 直接抛错，
    等于把一份**往往已经能用**的回复整份丢掉（用户只看到一句「被截断」，照片里的
    待办一条都没出来）。现在是 `{ text, truncated }` + `extractJson` 的补括号兜底：
    截在某个完整对象之后就把前面那部分捞出来，并且在 reply 末尾**明说被截断**——
    悄悄少几条比报错更难发现。

30. **第三方插件的「代点 DOM」适配会随宿主的类名散列失效，而失效是静默的。**
    `dsh-zen-remote` 1.1.15 按 `dsh-better-sidebar` **0.15.0** 写的适配，锚在
    `[data-dsh-better-sidebar] button[class$="_toggleButton"]` 上；宿主升到 0.19.1 后
    开合控件搬出那个子树、类名也变了，于是选择器**命中 0 个元素**——而代码写的是
    `document.querySelector(SEL)?.click()`，`?.` 把「没命中」变成了**静默空操作**：
    不报错、不闪、控制台零输出，表现只是「点了没反应」。同一条 bug 还有第二层：
    zen 把宿主的入口 `display:none` 藏掉之后，用自己那颗（坏的）替代，于是手机上
    那个功能**彻底没有入口**。教训：① 适配第三方要锚**稳定标记**（`data-*`），不锚
    类名散列——zen 自己的 `docs/interface.md` 就是这么写的，只是代码没照做；
    ② `?.click()` 这类「找不到就算了」的写法必须配一条断言或一次日志，否则坏掉时
    界面上没有任何证据；③ 自己能控制的那一侧（本插件）**一律走服务调用**
    （`betterSidebar.openTab`），不跟着去代点 DOM。

31. **插进宿主既有位置的东西，尺寸要照邻居量，不能照自己的标尺配。** 侧栏页脚入口
    第一版用的是面板自己的字号（12/18）和内边距（4×6、圆角 6），因为它是「本插件的
    组件」，很自然地就按本插件的 token 写了。可它并排站在宿主的「设置」和
    `dsh-context` 的「Context Insights」中间，那两行是宿主页脚按钮的标尺
    （14/22、内边距 `0 10px 0 8px`、圆角 12、间距 8、高 42）——真机一眼就看出
    「大小和字体不一样」。教训：**凡是插进宿主既有排面的东西，唯一正确的参照物是
    它左右邻居量出来的数**，不是自己那一套别名层。量法就是
    `getComputedStyle` + `getBoundingClientRect` 把三个按钮逐项列出来对齐
    （盒、字号/行高、内边距、间距、圆角、图标墨迹范围），别靠肉眼。
    两个附带的坑：① 这一排**不配 `corner-shape:round`**——宿主对 `*` 施加的
    `superellipse(1.5)` 是页脚所有按钮的共同底子（坑 #19 只管面板内部的胶囊）；
    ② 同一个插槽里的兄弟是**横排**的（宽侧栏下 132+132 并排），所以右边挂角标要
    贴着标签走（标签 `flex:0 1 auto`，不是 `auto`），否则角标会被推到最右边、
    看起来像邻居的。

32. **插槽里的 `textContent` 是**对外契约**，不只是渲染。** 页脚入口的未完成数
    第一版是个真实 `<span>`——面板没打开时 store 还是空的，看不见问题；一打开面板、
    数据到位，那个数字就出现了。而 `dsh-zen-remote` 的 `harvestName()` 读的正是
    `el.textContent`，于是手机主屏那颗 chip 的名字当场从「工作计划」变成
    「工作计划5」；更坏的是它的开关偏好按 `harvest:${name}` 存，**名字一变偏好就丢**。
    这类「组件在自己家里渲染、却有人在别处按文本读它」的地方，要把
    **文字内容的形状当接口**来守：计数、角标、状态后缀一律走 `data-*` + CSS 伪元素
    （伪元素内容不进 `textContent`），并写进测试钉住。判据很简单：
    **这个节点的文字会不会被别人拿去做 key、做名字、做匹配？** 会 → 一个多余的
    字符都不能有。

33. **浏览器只把麦克风、摄像头、语音识别给「安全上下文」，而局域网 IP 上的明文 HTTP
    不是。** 手机访问的是 `http://192.168.31.231:3080`——明文 HTTP + 私有 IP。同一版
    Chromium 实测：`http://127.0.0.1:3079` → `isSecureContext:true`、
    `navigator.mediaDevices` 有；换到 `http://192.168.31.231:3080` →
    `isSecureContext:false`、`navigator.mediaDevices` **直接 undefined**（
    `127.0.0.1` / `localhost` 是特例，算可信来源；私有网段**不算**）。于是插件里那颗
    话筒在手机上是**死的**，而且死得不体面：它照样渲染，点下去 `SpeechRecognition`
    回的是 `not-allowed`，我们照着报了「麦克风没有授权」——**那句话是错的**，会把人
    引去翻权限设置，真正的原因却是地址。现在 `startVoice` 先用 `isSecureContext`
    拦一道、说清「换 HTTPS 就好」。
    教训：① 任何要设备能力的功能，**先问这个 origin 是不是安全上下文**，别等报错；
    ② 报错里出现「权限」两个字之前，先确认它真是权限问题——**错误的诊断比没有诊断
    更贵**，它会把排查送到完全错误的地方；③ 顺带记住，手机上真正好用的语音是
    **输入法自带的那颗话筒**（系统级、不受这个限制、中文更稳），网页够不到它，
    能做的只有聚焦输入框把键盘叫出来（见「AI 助手」一节）。

34. **别把「未来」写死在测试的日历上。** `expectAt: '2026-09-20'` 这种常量在写下它的
    那天是未来，过了那天就变成过去——于是「新建的委派不算逾期」这条断言在
    **某个早上突然变红**，而它跟当天任何改动都无关。这条真的发生了（9/21 早上，
    全量测试红 1 条，看名字完全联想不到）。凡是断言依赖「今天」的，一律按
    `dayFromToday(n)` 相对算（`test/host.test.mjs` 里有这个 helper）；同理，
    「周期正在走」这类用例要把周期写成**覆盖今天**的区间，而不是某年的固定日期。
    判据：**这个字符串过了某一天会不会换意思？** 会 → 必须相对算。

## 约定

- **零构建期依赖**。`scripts/build.mjs` 只做拷贝 + 文本内联，不压缩不转译。
  产物体积小，可读的产物更利于排查。客户端只用 `require('react')`。
- **加能力先问一句：「能不能不加工具、不加路由？」** 语音记待办就是这么落地的——
  麦克风只把识别结果写进输入框，提交仍走原来的 `/node-add`，所以**零新增通路**；
  顺带的约束是「语音只负责把话变成字」，说不说得上、记到哪都不受它影响。
  同理，归位建议做成了**服务端派生字段**（随 `plan_show` 下发）而不是新工具：面板和
  agent 读同一份，agent 想改判归属时不必再开一条通路。
  AI 入口给面板增加了一条 `/ai-parse` 路由，但**没有新增工具**——因为这件事的价值
  是「人手上有一张截图/一段口述，想快速转成结构化待办」，agent 自己就能看图/听写，
  不需要再绕一次本插件的模型调用。采纳阶段仍走既有 `/node-add`/`node-move`：
  解析只是派生建议，真正写数据的动作复用已有通路。
- **Host 半身是纯 ESM，client 半身是 CommonJS**（因为要包进 C6 bundle 工厂）。
  这个不对称是平台要求，不是笔误。
- **`lib/` 不入库**，一切从 `src/` 生成。
- **纯逻辑抽到 `logic.cjs` / `store.js`** 以便 Node 里单测；React 组件里不留可测逻辑。
- **面板交互：点标题 = 打开详情，不是「顺手把事办了」；详情一级只给简单信息。**
  单击标题曾经是切完成——那是把高频低风险的「查看」让位给了低频高风险的「改状态」
  （误触代价：改状态 + 写盘 + 多留一个版本快照），而「完成」本来就有明确控件
  （复选框）。现在单击统一 `openEdit`，完成只走复选框；双击就地改名保留（双击时
  清掉单击定时器）。详情页走**渐进披露**：一级 = 标题 / 状态 / 重要程度 /
  截止·周期 / 备注 / ★星标；「更多」= 负责人 / 量化进度 / 委派 / 位置 / 证据 /
  关联资料 / 依赖 / 重复 / 删除（编辑默认收起、新建默认展开）。删除是破坏性操作，
  不与「保存 / 取消」并排。**重要程度徽章是纯展示**（`priority` 是管控强度，不是
  重要程度标签），换档统一回详情页。改动落在 `titleProps` / `detailPage` / `priBadge`。
- 注释和面向用户的文案用中文，标识符用英文。
- **工具面按「节点」组织，不按「层级」组织。** 结构操作只有四个：
  `plan_node_add` / `plan_node_set` / `plan_node_move` / `plan_node_remove`，
  作用在任意节点上，`type` 决定它是计划还是待办。不要再按层级加
  `plan_goal_*` / `plan_kr_*` / `plan_task_*` 三套——三套 API 做同一件事，
  agent 每次都得先想「这东西算 goal 还是 kr」，而这些区分对人本就没有意义。
- 新增工具时同步更新 `test/build.test.mjs` 里的工具清单断言（现在 15 个工具、
  12 条 HTTP 路由）。
- **跨半身重复的纯逻辑必须在测试里钉住一致性。** host 是 ESM、client 是 CJS，
  无法共享模块，像 `nextPriority` 这种映射只能各写一份——那就用断言把两份绑在一起
  （见 `test/logic.test.mjs`），否则改一侧忘另一侧，表现为「面板上点徽章跳到别的档」。
- **测行为优先用 `test/host.test.mjs` 的集成测试**，它用假 Cordis 上下文驱动
  **真实的工具定义与 HTTP 路由**，能挡住「工具接错函数、路由漏 sessionId、参数名写错」
  这一类产物断言抓不到的错。产物断言只用于守「静默失效」（见坑 #1）。
- **改面板（`src/client/index.js`）时同步改 `test/client.test.mjs`。** 那里用
  「假 React + 真构建产物」驱动真组件，是唯一能在本地发现「面板打不开 / 手势接错」的
  一层。数据源不手写——先用真 host 建计划、调 `plan_show` 拿真 payload，手写的假
  payload 少一个派生字段，面板会静默走兜底分支，测试就悄悄退化成什么都没测。
  它测不了 CSS、真实 DnD 行为与 React 的调度语义，那部分只能在 `dsh web` 里实测。
- **折叠之类的显示偏好一律不进 `plan.json`**（判据见「面板的本地状态」一节）。
- **测试不要按图标字形找元素。** 按钮里的文字字形（emoji / Unicode 符号）在换成内联
  SVG 之后就没有文字了，`textOf(el) === '★'` 这类查找会静默变成 `null`（表现为「按钮
  不见了」而不是「图标变了」）。定位一律用 **`title`** 或给按钮加**稳定类名**
  （`dsh-wb-send` / `dsh-wb-pic` / `dsh-wb-act-star`…）。这条是拿 20 条红换来的：
  光把图标从 emoji 换成 SVG，就红了 17 条，全是按字形找元素。
- **行内不放破坏性操作与资料关联。** 删除、关联资料都收进详情页——列表里误触的代价
  太高（删除会连带子树，且不可逆）。行内只留高频、非破坏性的动作（星标 / 归位 / 加子项）。
- **面板样式只用宿主的 design token，不自造颜色。** 颜色一律映射 `--dsw-alias-*`
  成 `--wb-*` 短名（映射层在 `.dsh-wb-wrap` 上，见坑 #18），字号用 `var(--dsw-font-*-*)`，
  动效用 `--ds-transition-duration` / `--ds-ease-in-out`；**不写硬编码 hex / rgb**，
  间距与圆角对齐宿主侧栏组件的既有标尺（间距 2/4/6/8/12，圆角 4/6/8/999）。
  这样明暗两态、以及宿主将来换肤都自动跟随。`test/build.test.mjs` 有断言守这条。
- **文字只留两级**：`--wb-fg`（primary）与 `--wb-fg-2`（secondary，白底 5.8:1）。
  宿主更浅的那两级（tertiary 3.7:1 / caption 2.5:1）在面板的 11–13px 尺寸下**达不到
  AA 的 4.5:1**，所以层级改由字重、描边与留白表达。**语义色一律不做行内胶囊的文字色**
  ——danger 在 5% 软底上只有 4.45:1（见坑 #22），warn / success 连纯底都不达标。
  唯一保留的红字是**逾期日期**：它在纯底上 4.49:1，且是每行里最需要立刻行动的信号，
  换成中性色就被埋掉了。这条有断言守（`test/build.test.mjs`）。
- **纵向密度是面板的头等约束，因为它住在一个又宽又矮的地方。** 底部工作台实测约
  **1000px 宽**、高度有限，所以「横向宽松、纵向抠门」才对：行高、边距一律按最紧的
  合理值配，需要呼吸感的地方用横向留白换。改任何纵向间距都要量数（见坑 #21），
  别凭观感——行高松 3px 就是少一条半任务，而这种退化不报错、review 也看不出来。
- **一次改动的视觉部分要在真机验。** 内联 CSS 没有测试能覆盖——`test/client.test.mjs`
  测不了样式，`build.test.mjs` 只守字符串纪律。做法是起一个独立端口的 `dsh web`，
  用真实浏览器量 `getComputedStyle` + 算对比度（记得坑 #20）。

## 协作与版本控制

本项目是**共享开发仓库**：多位开发者 + agent 在此同步开发。

- **根说明/指令文件是 `AGENTS.md`**（不是 `README.md`）。任何 agent 或开发者打开本仓库，应先读本文件；`README.md` 仅作面向使用者的介绍。
- **远程**：`origin` = `git@github.com:powerseven/dsh-workbench.git`（SSH 形式）；`main` 跟踪 `origin/main`。
- **工作流**：开工前 `git pull --ff-only`；改动走 **feature 分支 + PR，勿直推 main**；收工 `git push` 后用 `gh pr create` 开 PR（`gh` 已登录 powerseven，带 `repo` 权限）。
- **本机开发环境是 WorkBuddy**：其本机数据目录 `.workbuddy/`（agent 记忆 / 笔记 / 状态）与 `plan/`（个人计划）均为**本地私有数据，严禁提交到 GitHub**，已在 `.gitignore` 忽略。改动 `.gitignore` 时不得移除这两行；也不要用 `git add -f` 强行加它们。

## 相关生态（可借鉴，勿重复造轮子）

- `dsh-better-sidebar`（本机 `~/.dsh/profiles/web/node_modules/`）——宿主，
  `ctx.betterSidebar.registerTab` / `registerFileViewer`，本插件挂它下面。
- `AKS1st/dock`——**另一个可选宿主：VSCode 风格工作台基座**，暴露 `ctx.workbench`
  开放注册表（`registerPanel` / `registerEditorView` / `registerStatusBarItem` /
  `registerCommand` / `registerSetting` / `registerActivityBarItem`），比 better-sidebar
  的单一 tab 更适合承载「个人工作台」多面板形态。要求 DSH ≥ `0.1.3-alpha.2`
  （本机 `0.1.5-rc.1` 满足）。**注意：整套很新（base ⭐7、无 release，2026-09 才建），
  API 可能变动**——目前仍以 better-sidebar 为宿主，dock 作为可选第二宿主 / 参照。
  系列兄弟：`dock-files` / `dock-editor` / `dock-images` / `dock-markdown` / `dock-git`。
- `sueqet/dsh-todo-board`——跨会话 TODO 板，三档执行模式（提醒／续跑／新开会话）。
- `lihang-lh/dsh-task-panel`——七列任务看板，子 agent 串行执行 + 复核 + 验收。
- `lsdt45/dsh-plan-plus`——计划版本回看/对比/编辑/留档，本项目「版本留档」的参照。
- `magicOF2/dsh-schedule`——日历/日程视图。
