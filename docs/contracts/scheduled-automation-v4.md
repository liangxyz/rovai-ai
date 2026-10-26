---
document_type: contract
contract: scheduled-automation-v4
status: accepted
target_version: v1.72
last_updated: 2026-10-26
---

# Scheduled Automation v4

v4 继承 [v3](scheduled-automation-v3.md) 的定义、调度、occurrence、普通 Delivery、结果与通知合同，
增加 Host 编辑的对话命名配置。任务名称仍是 Automation 的名称；生成的 Thread 标题单独持久化。

## 命名配置

Desktop/Web `CreateAutomationCommand` 可省略 `threadNaming`，省略使用下表默认值；
`UpdateAutomationCommand` 省略该字段保留原配置，提供时整体替换。`AutomationView.threadNaming`
始终返回完整对象。对象是 closed schema，字段必须齐全，未知字段、枚举或类型拒绝。

| 字段 | 值 | 默认值 |
| --- | --- | --- |
| `includeDate` | boolean | `true` |
| `includeTime` | boolean | `true` |
| `dateFormat` | `iso` / `slash` / `short` / `chinese` | `iso` |
| `timeFormat` | `24` / `12` / `seconds` | `24` |
| `position` | `prefix` / `suffix` | `suffix` |

日期格式分别是 `YYYY-MM-DD`、`YYYY/MM/DD`、`MM-DD`、`M月D日`；前三种月份/日期补零，
中文格式不补零。时间分别是 `HH:mm`、`上午/下午 h:mm`、`HH:mm:ss`；12 小时制零点/正午分别是
`上午 12:mm` / `下午 12:mm`，小时不补零。它们是保存的数据格式，不随界面语言重写。

关闭日期或时间只停止拼接该部分，保留对应格式选项。日期和时间之间一个空格；整体时间戳与任务名
之间用 ` · `，按 `position` 放在名称前或后。全部关闭仅用任务名，无多余空格和分隔符。
任务名仍最多 80 个 Unicode scalar；生成标题允许超过 80，不截断名称或日期时间。

## 时间与不可变边界

- Core 在 occurrence admission 的同一事务内生成标题并交给普通 Camp 创建路径，`camp.title`
  与 `camp.created` 事件使用同一个结果；保持现有用户来源名称语义，后续自动派生不覆盖。
- 定时运行用 occurrence 的 `scheduled_for`，手动运行用 admission 的实际时间；均按 Core
  设备本地时区格式化。延迟 claim、排队、Runtime 启动或通知重试不刷新标题。
- 省略设置的旧命令保留原 canonical payload/digest；旧回执按原字节重放，Host 将旧回执缺失的配置按迁移默认值展示。
- 命令重放返回原 occurrence，不新建 Thread、不重新计时。修改命名、任务名称或计划只影响之后
  创建的 Thread；不改历史标题、用户重命名、历史消息或引用快照。
- 命名配置参与现有版本 CAS 和命令幂等；只改命名不改变 `nextRunAt`。
- Renderer 的即时预览是浏览器本地时间样例，不是下一次运行预测或 Core 的权威标题。

## 持久化与 Agent 边界

Migration 215 将 v1.72/schema 164 升级至 schema 165，在 Automation 定义增加
`thread_naming_json`。旧定义默认开启日期、时间和后置格式；不重写任何 occurrence 或 Thread。
DDL、migration receipt 和 schema marker 同事务提交，失败完整回滚，重开继续升级。

Agent Built-in automation 工具仍沿用原参数与输出合同，不暴露 `threadNaming`；Agent 创建使用默认值，
更新保留既有设置。Host 编辑回执和查询返回完整设置。没有模型模板、Bootstrap、Manifest 或工具
目录版本变化；模型读取 Thread 时沿现有字段看到实际标题。
