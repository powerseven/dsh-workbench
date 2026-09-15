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
node --test test/*.test.mjs   # 跑测试（303 个，分五层见下）
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

**这些派生量的口径要在 `annotate`（host）和 `logic.cjs`（client）两边一致，**
`parentSuggestions` 是例外：它只在 host 算、client 只读（打分要看整棵树）。
不需要算数的（`unverified`）可以在客户端兜底；要算日期的（`behind`）**一律只读服务端标注**，
不在客户端重算——重算就会出现「面板与服务端算出不同答案」而没人知道哪个对。

**`type` 可以改（换型）**：`plan_node_set` 传 `type` 就把节点在原位改成计划或待办——
随手记的待办后来发现要拆，提升为计划继续拆；拆完发现不必，降回待办。两条约束：
**有子节点的计划不能降级为待办**（待办是叶子，孩子们会变成孤儿，不可逆），
以及**跨类型时状态要重新归一**（`active` 只对计划合法，`todo`/`doing` 只对待办合法）。
后者尤其重要：不归一留下的是「对该类型非法的状态」，而它不会报错，只会让进度、
筛选、角标**静默错值**。

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

## 面板的本地状态（不进 plan.json）

面板上有一批状态**只属于这一台机器的这次浏览**，它们既不进 `plan.json`、也不走
版本归档：

| 状态 | 放在哪 | 为什么 |
|---|---|---|
| 折叠展开（`dsh-workbench:collapsed`） | `localStorage` | 是「我现在想看到什么」，不是计划数据。写进计划会污染 diff、占版本快照，还会跟着 git 提交跑到别人机器上 |
| 视图切换 树/看板（`dsh-workbench:view`） | `localStorage` | 和折叠同类：只是这台机器这个人想怎么看，不进 plan.json、不占写入路径 |
| 改名中的草稿、拖拽中的落点、正在归位/加子项的节点 | 组件本地 `useState` | 拖拽时鼠标每动一下都要更新落点，放全局 store 会让 tab 角标跟着重算 |
| 详情编辑页的草稿（`form`）与 AI 草稿队列（`aiQueue`） | 组件本地 `useState` | 整块替换面板期间树不渲染，「未保存」不可能悄悄发生，也就不需要脏检查 |

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
**AI 解析出的草稿也进这张表单**（`aiApply` 只填草稿、不落库，「全部采纳」是
逐条过一遍），所以「AI 帮我记」不等于「AI 替我决定」。

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
