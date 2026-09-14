# dsh-workbench

个人工作台 —— DeepSeek Harness（dsh）Web 插件。做**工作计划的目标拆解、进度跟踪与版本留档**。

不是独立应用：它作为侧边栏的一个 tab 跑在你的 `dsh web` 里。

## 它解决什么

普通待办应用里，**进度要人来同步**——你干完一件事，得自己去勾掉。
在 dsh 里这件事可以反过来：插件把计划暴露成一组 agent 工具，
**AI 干完活自己把任务标完成，完成度自动重算**。

所以这个插件的设计原则是：任何能力都问一遍「agent 能不能也做」，
能就让工具和 UI 共用同一份数据。

## 核心概念

三层结构，`目标 → 关键结果 → 任务`：

```
目标 g1  完成低电压治理攻坚        40%
├─ KR k1  完成 12 个台区改造        25%   3/12 个
└─ KR k2  建立治理台账              33%
   ├─ [x] t1  收集基础数据
   ├─ [ ] t2  录入系统              截止 2026-11-01
   └─ [ ] t3  复核
```

关键结果有两种度量方式，自动识别：
- **量化 KR**：声明 `target`/`current`，按比例算（如 `3/12 个`）
- **清单 KR**：只挂任务，按任务完成比例算

目标完成度 = 各 KR 平均；全计划完成度 = 各目标平均。

## 数据在哪

落在**当前会话的工作区**里，跟着你的项目走、能进 git：

```
<workspace>/plan/plan.json      结构化真相
<workspace>/plan/PLAN.md        自动生成的只读视图（可读、可 diff）
<workspace>/plan/.versions/     每次变更前的快照
```

版本留档**独立于 git**：即使这个目录没被 commit，或你根本不用 git，
`plan/.versions/` 里依然有完整演进，可以回滚。

> `PLAN.md` 是生成物，别手工编辑——下次写入会覆盖。要改计划就让 agent 改，
> 或直接改 `plan.json`（结构变了 `PLAN.md` 会在下次写入时重新生成）。

## 安装

```sh
node scripts/build.mjs
dsh plugin --profile web add /Users/tinyseven/Documents/DSH/dsh-workbench
```

**装完必须重启 `dsh web`** —— host 插件是组合树里的一行，不是热加载。

卸载：

```sh
dsh plugin --profile web remove dsh-workbench
```

## 用法

### 让 agent 建计划

在任意会话里说：

> 帮我把这个季度的工作计划拆成目标和关键结果，写到这个工作区的计划里

agent 会调 `plan_goal_add` / `plan_kr_add` / `plan_task_add` 落成计划树。

### agent 回写进度

> 台区 B 的方案评审做完了

agent 调 `plan_task_set` 把 `t2` 标成 `done`，完成度自动重算——
你不需要动手同步。

### 侧边栏面板

侧边栏顶部「+」菜单里添加「🎯 工作计划」tab。面板里可以直接勾任务、
看进度条，tab 角标显示未完成任务数。勾选写的是同一份 `plan.json`。

### 手动留档 / 回滚

对 agent 说「给当前计划留个档」，或直接调 `plan_snapshot`；
`plan_history` 看历史版本，`plan_restore` 回滚。
每次通过工具修改计划前都会自动留档，所以回滚本身也可撤销。

## 工具一览

| 工具 | 作用 |
|---|---|
| `plan_show` | 查看计划树（含进度汇总） |
| `plan_goal_add` / `plan_goal_set` | 新增 / 修改目标 |
| `plan_kr_add` / `plan_kr_set` | 新增 / 修改关键结果（含量化进度） |
| `plan_task_add` / `plan_task_set` | 新增 / 更新任务状态 |
| `plan_snapshot` | 手动留档一个版本 |
| `plan_history` / `plan_restore` | 版本列表 / 回滚 |

定位子节点时 id 和标题都能用（`g1`、`完成 12 个台区改造`），
有歧义时会报错而不是猜。

## 开发

见 [AGENTS.md](./AGENTS.md) —— 里面记着架构、数据模型，以及几个
「不报错但完全不工作」的坑。设计取舍见 [docs/DESIGN.md](./docs/DESIGN.md)，
后续规划见 [docs/ROADMAP.md](./docs/ROADMAP.md)。

```sh
npm test        # 构建 + 54 个测试
```

## 许可证

MIT
