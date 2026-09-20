# 待办 / 工作计划 App 参照基准（Todo-App Benchmarks）

> 用途：dsh-workbench 面板的设计参照库。三轮「参照互联网最新最好用的 app / 工具」的调研结论并排存档，
> 下次做 UI / 交互改动直接翻这里，不必重新联网。
> 维护纪律：结论进本文档；任何**数据模型 / 约定**的改动仍只进 `AGENTS.md`（本文档不抢权威源）。

---

## 0. 本插件的硬约束（判断「能不能搬」的尺子）

| 约束 | 含义 |
|---|---|
| 面板形状 | 面板主要挂在**右侧窗口**——窄而高，所以稀缺的是**宽度**（和手机一样），**高度不是问题**（之前写成「高度稀缺」是反的） |
| 字重 | 宿主只给 400 / 500 两档 |
| 数据模型 | 一棵递归树 + `priority` = **管控强度**（决定走多少流程），不是「重要程度」 |
| 派生纪律 | 要算日期的一律只读服务端标注（`overdue` / `dueSoon`），客户端只拿 `due`/`end` 做分组，不重算口径 |
| 通路纪律 | 优先「不加工具、不加路由」——纯函数派生（像 `behind` / `boardColumns` / `upcomingByDay`） |

---

## 1. 第一轮：web 版工作/待办 app（宽矮面板参照）

调研问题：现役最好用的 web 版工作计划 / 待办 app，哪些值得搬。

### 1.1 四家值得参照

| App | 最值得抄的点 | 本项目落地情况 |
|---|---|---|
| **Things 3** | 用**时间视角**重组同一批任务：Today / Upcoming / Anytime / Someday 全是同一批数据的过滤，零新增数据 | ✅ 已做 **Upcoming**（「未来 7 天」按天分组，PR #18） |
| **Todoist** | 自然语言快速添加（`明天下午3点 交周报 p1 @张三` 解析出日期/优先级/标签/负责人） | ✅ 已超越：`/ai-parse` 是模型理解，非正则匹配。但 Todoist「解析结果实时高亮确认」更轻——本项目走「先进表单再确认」，取舍正确 |
| **Linear** | 键盘优先 + 命令面板（`/` 或 Cmd+K：跳转、快速记一条、换档） | ⏸ 押后（纯客户端中等改动，随时可捡） |
| **TickTick** | 四象限（艾森豪威尔矩阵：重要 × 紧急） | ❌ **明确不做**：`priority` 在本项目是管控强度，再叠「紧急」抢同一条语义通道（AGENTS.md 反复警告的错） |

### 1.2 第一轮结论

> 四家里只有 **Things 3 的 Upcoming** 同时满足：零新增概念、零新增通路、补的是真缺口（「下周三我有什么事」三个结构视图都答不了）。其余三家要么已超越、要么明确不做、要么押后。

---

## 2. 第二轮：手机尺寸 / 小屏界面适配 Top 10

调研问题：适应手机 app 大小界面的 to-do 工具，世界 top 10。

### 2.1 Top 10（按小屏适配力 + 跨源共识排序）

| # | App | 小屏最强的一点 | 能否搬进面板 |
|---|---|---|---|
| 1 | **Todoist** | 极速捕获：底部单行输入 + 自然语言 + 锁屏/桌面 widget 一键记 | 自然语言已超越；widget≈「常驻 ＋」 |
| 2 | **TickTick** | 原生日历视图把任务铺进时间格（一站式：番茄+习惯+四象限+MCP） | 四象限不做；日历视图≈Upcoming 思路 |
| 3 | **Microsoft To Do** | 「我的一天」规划仪式：把无限 backlog 收敛成今日短清单 | 同「当前任务」视图，已做 |
| 4 | **Things 3** | Areas/Projects/Today/Upcoming 用时间视角重组同一批任务，零新增数据 | 即第一轮 Upcoming 来源 |
| 5 | **Google Tasks** | 一个框 + 拖拽排序，零装饰零设置 | 克制本身可借鉴 |
| 6 | **Apple Reminders** | 系统级快捷入口 + Siri 捕获 + 共享清单，零学习曲线 | 系统级捕获不适用（面板非 OS） |
| 7 | **Any.do** | 「My Day」每日规划仪式 + 家庭共享 + 日历合一 | 与 To Do 同思路 |
| 8 | **TeuxDeux** | 一周七列一眼扫完；**未完成自动顺延 (rollover)** 到下一天 | 「逾期单独置顶」已做；顺延逻辑可借鉴 |
| 9 | **Superlist** | 现代极简、快捕获、刻意留白不空 | 留白纪律可借鉴 |
| 10 | **Tweek** | 纸质感周计划，按周思考降低压迫感 | 周视角≈Upcoming 7 天窗口 |

### 2.2 小屏专项 honorable mentions

- **Structured** — 色块可视化时间轴
- **MinimaList / Do!** — 极简 widget 一眼看优先级
- **Sunsama** — 引导式每日规划 + shutdown 收尾仪式
- **Composed** — 语音优先 + 全 app 无「逾期」红标的平静设计

### 2.3 关键提醒：约束其实一样（都是宽度稀缺）

面板主要挂在**右侧窗口**——窄而高，所以稀缺的是**宽度**，和手机一样；**高度不是问题**（之前写成「高度稀缺」是反的）。因此能搬的不是「响应式断点」，而是手机那套**窄屏交互纪律**（单列、底部常驻主操作、渐进披露、单手可达）：

1. **底部常驻主操作**：＋捕获 / ↑发送 / ✎编辑 已聚在输入条——同 Todoist、Google Tasks 的「底部常驻输入框」，单手可达。
2. **用筛选/视图收敛无限列表**：芯片 + 视图切换把全量摊平成「今日/本周」——同 To Do 的 My Day、Things 的 Today；本轮 Upcoming「空天不占行」正是窄屏最忌「空白列表占位」的反面。
3. **顺延/置顶信号分离**：TeuxDeux 的 rollover——本期已落地为「逾期滚入今日组」（见 §1.1 对位表），不再单独置顶成段。

> **一处故意反潮流**：Composed 主张「全 app 不标逾期、不红色恐吓」。但本项目是**管控台（MLO 风格）**不是生活清单，`behind`/逾期提醒是有意为之的告警——这条不抄。

---

## 3. 第三轮：企业级协作工具（Worktile）

调研问题：国内企业级项目协作 SaaS（worktile.com，北京易成时代）的界面与功能，哪些能搬进这个**个人单用户 + 右侧窄窗**的面板。

### 3.1 Worktile 是什么

一体化工作协作平台：任务 / 项目 / 文档 / IM / 目标(OKR) / 日历 / 甘特图 / 工时 / 审批 / 轻办公(OA) 全收在一个工作空间。多视图（看板 / 列表 / 表格 / 甘特 / 日历 / 时间线）、任务标准字段（负责人 / 参与人 / 优先级 / 截止 / 子任务 / 检查清单 / 标签 / 依赖 / 自定义字段 / 附件）、工作台按角色定制部件（经理看异常、成员看今日）、自动化规则引擎（触发器→动作）、项目集汇总、数据仪表盘。

> **关键定位差**：Worktile 是**多用户、管理者视角、重平台**（"统一工作入口"）；本插件是**单用户、执行者视角、轻侧栏**。所以这一轮主旋律不是"抄它的界面"，而是**用它的覆盖面印证我们数据模型的对，并划清不能搬的企业级边界**——和 §0 的「宽度稀缺 / 派生纪律 / 通路纪律 / priority=管控强度」直接对账。

### 3.2 印证：我们已有的方向 Worktile 也这么做

| 我们的做法 | Worktile 对应 | 结论 |
|---|---|---|
| 视图切换 tree / todo / board + Upcoming | 多视图：看板 / 列表 / 表格 / 甘特 / 日历 | ✅ 多视图是主流标配 |
| 递归树（计划=项目，顶层计划=项目集） | 项目 → 项目集汇总；任务关联（父子 / 相关） | ✅ 顶层聚合 ≈ 项目集 |
| `delegate`(负责人) / `priority` / `due`(截止) / `blocked`(依赖) / 证据·文件(附件) | 负责人 / 参与人、优先级、截止、依赖、附件 | ✅ 任务标准字段高度一致 |
| Upcoming「未来 7 天按天分组、空天不占行」 | 日历视图按截止日期排布、时间线 | ✅ **窄屏下"日历"的正确形态就是按天列表，不画月历网格** |
| 详情页一次编辑全部字段（`openEdit` 表单） | 任务详情侧边抽屉 + 就地编辑 | ✅ 点开即编辑全部字段是标准交互 |
| upcoming 排序 星标 > 高优先 > 逾期 | 优先级队列 + 逾期对比报表 | ✅ 优先级 × 逾期关联排序是共识 |

### 3.3 明确不搬（企业级，与「单用户 + 窄窗 + 派生 / 通路纪律」冲突）

- **OKR 目标层**（目标→项目→任务→结果）：比当前任务层高一个抽象层，是**未来可选扩展**，但非当前范围（会引入新概念轴，撞 §0 的 priority 语义纪律）。
- **审批流 / 工时统计 / 简报·日报 / 轻办公 OA**：HR / 流程类，个人面板用不上。
- **IM 即时沟通 / 知识库 / 文件版本管理**：企业协作基础设施，非任务规划。
- **自动化规则引擎**（状态变更 / 到期→指派 / 通知 / 改字段）：本质是"客户端重算口径 + 写回"——直接撞 **派生纪律**（日期口径只信服务端标注）与 **通路纪律**（不新增写回规则）。**不做**。
- **细粒度角色权限 / 项目集报表仪表盘（燃尽图 / 工作量）**：管理者视角，个人面板只需单计划进度条（已有）。
- **私有化部署 / 开放平台 / Webhook 集成**：交付形态，与本插件无关。

### 3.4 值得记的一句

Worktile 自己的上手建议是"普通成员先从任务列表 + 看板起步，逐步启用甘特 / 项目集 / 报表"——这恰恰印证本插件「渐进披露、窄屏单列、留白纪律」的选择：连企业级工具都让普通用户从轻功能起步，个人侧栏更没有理由堆密度。

---

## 4. 可借鉴清单

- [x] **TeuxDeux 顺延**：逾期项滚入「今日」组（不再单独置顶成段），保留红标——见 `feat/ui-rollover-shutdown-whitespace`
- [x] **Sunsama shutdown 仪式**：当前任务视图「收尾复盘」按钮，未做完项一键顺延到明天/下周/稍后——同上分支
- [ ] **Linear 命令面板**：`/` 或 Cmd+K 跳转 + 快速记一条（纯客户端，不改数据模型）
- [x] **Superlist / Google Tasks 留白纪律**：focus 行次要徽章由描边 chip 改扁平文字，靠间距而非分隔线——同上分支
- [ ] **Worktile 印证 + 边界**（见 §3）：多视图 / 标准任务字段 / 顶层聚合已被覆盖（确认方向一致）；OKR / 审批 / 工时 / IM / 知识库 / 自动化 / 权限明确不搬

---

## 5. 全部来源网址

### 第一轮（web 版）

- Things 3 设计评测：https://www.macstories.net/reviews/things-3-beauty-and-delight-in-a-task-manager/
- Todoist 自然语言用法：https://www.usecarly.com/blog/how-to-use-natural-language-in-todoist/
- Todoist 日期与时间语法：https://www.todoist.com/help/articles/introduction-to-dates-and-time-q7VobO
- Things 3 官方支持（列表模型）：https://culturedcode.com/things/support/articles/4001304/
- Todoist 快速添加（中文）：https://www.todoist.com/zh-CN/help/todoist/features/use-task-quick-add-in-todoist-va4Lhpzz

### 第二轮（手机 / 小屏 Top 10）

- Top10 清单类 app 汇总：https://www.top10.com/list-making-apps
- 2026 最佳 to-do app（10 款实测）：https://notion-automation.com/blog/best-to-do-list-apps
- 待办清单 app 排行榜前十（中文·87G）：https://www.87g.com/zhuanji/4735.html
- 待办清单 app 排行榜（中文·2265 安卓网）：http://2265.com/k/dbqdappphb/
- 极简 to-do app（无订阅）：https://www.taskspot.app/blog/best-simple-to-do-list-apps
- 9 款最佳移动端任务管理 app：https://stackrundown.com/best-mobile-task-management-apps
- 9 款最佳 to-do app 实测对比（Any.do）：https://www.any.do/blog/the-9-best-to-do-list-apps-in-2026-tested-and-compared/
- 各工作风格任务管理 app 选型：https://goalsandprogress.com/best-task-management-apps/
- 2026 台湾生产力工具（待办深度比较）：https://ima.qq.com/wiki/?shareId=ba9a32c9d41534a409df044c52fe970f53dce8f2e612d705d2ad4e08130f8388
- 最佳 to-do app 总评（Mindful Suite）：https://www.mindfulsuite.com/reviews/best-to-do-list-apps
- 5 款极简任务 app（反企业化）：https://magdigit.com/stop-managing-your-life-like-a-corporate-project-5-minimalist-task-apps/amp/
- 7 款平静规划 app（无压力设计）：https://staycomposed.app/best/calm-planning-apps/

### 第三轮（企业级·Worktile）

- Worktile 官网（一体化协作平台总览）：https://worktile.com/
- 工作台用法（界面拆解 / 多视图 / 角色定制部件）：https://worktile.com/academy/p7lfm5lkocerqhy6mrglsj2n
- 项目管理方案（多视图 / 工作流 / 任务关联）：https://worktile.com/solution/project
- 电商项目管理（功能清单 / 使用体验）：https://worktile.com/kb/p/3981530
- 企业任务跟踪选型指南（适用场景 / 边界）：https://worktile.com/kb/p/3971750
- 产品解析（一体化 / 可定制 / 国产化适配）：https://www.ai-321.com/AI/10272.html
- 10 款进度跟踪工具测评（含 Worktile 段落）：https://docs.pingcode.com/baike/5246984
