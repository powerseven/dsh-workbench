# AGENTS.md — dsh-workbench 开发手册

本文件是这个工作区的开发约定。在此目录打开会话时，agent 应先读本文件。

## 这个项目是什么

`dsh-workbench` 是一个 **DeepSeek Harness（dsh）Web 插件**，做「个人工作台」：
工作计划的**目标拆解、进度跟踪与版本留档**，数据以 Markdown/JSON 落在用户
自己的工作区里、纳入 git。

它不是独立 web 应用。它跑在 `dsh web` 里，作为侧边栏的一个 tab 存在。

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
node --test test/*.test.mjs   # 跑测试（54 个）
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

三层结构：`goal（目标）→ kr（关键结果）→ task（任务）`（叶子）。

**为什么 JSON 为真相、Markdown 为视图**：计划是需要程序增删改查的树（进度汇总、
按 id 定位、版本回滚），直接解析 Markdown 需要稳健解析器且格式漂移会静默丢数据；
但只存 JSON 又失去人可读、可 git diff、可被 agent 直接读懂的好处。双表示各取所长：
写入走结构化路径（有校验），阅读与 diff 走 Markdown。改数据结构时不要破坏这个分工。

进度是**派生量**，不落盘：`krProgress` 量化 KR 按 `current/target`，清单 KR 按任务
完成比例；`goalProgress` 取各 KR 平均；`planProgress` 取各目标平均。

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

## 约定

- **零构建期依赖**。`scripts/build.mjs` 只做拷贝 + 文本内联，不压缩不转译。
  产物体积小，可读的产物更利于排查。客户端只用 `require('react')`。
- **Host 半身是纯 ESM，client 半身是 CommonJS**（因为要包进 C6 bundle 工厂）。
  这个不对称是平台要求，不是笔误。
- **`lib/` 不入库**，一切从 `src/` 生成。
- **纯逻辑抽到 `logic.cjs` / `store.js`** 以便 Node 里单测；React 组件里不留可测逻辑。
- 注释和面向用户的文案用中文，标识符用英文。
- 新增工具时同步更新 `test/build.test.mjs` 里的工具清单断言。

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
