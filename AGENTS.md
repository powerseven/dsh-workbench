# AGENTS.md — dsh-workbench 开发手册

本文件是这个工作区的开发约定。在此目录打开会话时，agent 应先读本文件。

## 这个项目是什么

`dsh-workbench` 是一个 **DeepSeek Harness（dsh）Web 插件**，做「个人工作台」：
工作计划的**待办 / 计划 / 子计划 / 委派**四条主线，加**重要程度（管控强度）**与
**版本留档**；数据以 Markdown/JSON 落在用户自己的工作区里、纳入 git。

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
node --test test/*.test.mjs   # 跑测试（170 个）
npm test                      # 构建 + 测试

# 装到正在用的 web profile（首次或改动 manifest 后）
dsh plugin --profile web add /Users/tinyseven/Documents/DSH/dsh-workbench
```

**改完必须重启 `dsh web` 才能生效**——host 半身是组合树里的一行，不是热加载。
改 client 半身后至少也要刷新页面（client bundle 由 profile 启动时装配）。

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
  `high` 要求计划有周期与负责人、待办有截止；缺口由 `nodeWarnings()` 以**警告**
  形式指出而**不硬拦**——在捕获的那一刻硬拦，人会干脆不记。默认 `normal` 也是有意的：
  默认 `high` 会让人人标 `high`，管控机制立刻失效。
- `delegate`：`{ to, at, expectAt, status }`，`status` ∈ `pending` / `accepted` /
  `declined` / `returned`。两种逾期**分开算**：`overdueReceipt`（该去问一句「接不接」）
  与 `overdueWork`（该去催进度）。重新委派会重置回执——换人意味着上一轮作废。
- `doneAt` / `startedAt`：完成与开工时间戳，是所有时间维度统计（周报）的上游。
  离开 `done` 会**清掉** `doneAt`，否则被撤回的完成会一直出现在「本周完成」里。
- `metric`：`{ target, current, unit }`，可计数的节点按它算进度（原量化 KR 的字段）。

**`type` 可以改（换型）**：`plan_node_set` 传 `type` 就把节点在原位改成计划或待办——
随手记的待办后来发现要拆，提升为计划继续拆；拆完发现不必，降回待办。两条约束：
**有子节点的计划不能降级为待办**（待办是叶子，孩子们会变成孤儿，不可逆），
以及**跨类型时状态要重新归一**（`active` 只对计划合法，`todo`/`doing` 只对待办合法）。
后者尤其重要：不归一留下的是「对该类型非法的状态」，而它不会报错，只会让进度、
筛选、角标**静默错值**。

**写入路径唯一**：面板（HTTP 面）与 agent 工具都调用 `store.js` 的同一组函数
（`applyFields` / `setStatus` / `setNodeType` / `setPriority` / `setDelegate` / `setReceipt`），
谁都不另写一套；每一次写入都自动归档版本，所以没有「绕过留档」的路径。

**为什么 JSON 为真相、Markdown 为视图**：计划是需要程序增删改查的树（进度汇总、
按 id 定位、版本回滚），直接解析 Markdown 需要稳健解析器且格式漂移会静默丢数据；
但只存 JSON 又失去人可读、可 git diff、可被 agent 直接读懂的好处。双表示各取所长：
写入走结构化路径（有校验），阅读与 diff 走 Markdown。改数据结构时不要破坏这个分工。

进度是**派生量**，不落盘：`nodeProgress` 递归算——有 `metric` 按 `current/target`，
否则按子节点完成度的平均，叶子按 `done` 给 0 或 1；`planProgress` 取各**顶层计划**的
平均（**不含收件箱**——收件箱不是计划的一部分，它计入角标与统计，但不影响完成度）。

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

## 约定

- **零构建期依赖**。`scripts/build.mjs` 只做拷贝 + 文本内联，不压缩不转译。
  产物体积小，可读的产物更利于排查。客户端只用 `require('react')`。
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
- 新增工具时同步更新 `test/build.test.mjs` 里的工具清单断言（现在 13 个工具、
  9 条 HTTP 路由）。
- **跨半身重复的纯逻辑必须在测试里钉住一致性。** host 是 ESM、client 是 CJS，
  无法共享模块，像 `nextPriority` 这种映射只能各写一份——那就用断言把两份绑在一起
  （见 `test/logic.test.mjs`），否则改一侧忘另一侧，表现为「面板上点徽章跳到别的档」。
- **测行为优先用 `test/host.test.mjs` 的集成测试**，它用假 Cordis 上下文驱动
  **真实的工具定义与 HTTP 路由**，能挡住「工具接错函数、路由漏 sessionId、参数名写错」
  这一类产物断言抓不到的错。产物断言只用于守「静默失效」（见坑 #1）。

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
