---
document_type: contract
contract: runtime-file-change-observation
version: v9
status: accepted
source_version: v1.72
last_updated: 2026-10-19
---

# Runtime File Change Observation v9

继承 [v8](runtime-file-change-observation-v8.md) 的 Runtime 准入、归约、授权和展示规则。
本版增加成功 Send 输入文件的 Run 卡片排除，Evidence 文件操作和公开卡片 wire schema 保持。

## 成功发送输入文件排除

来源由 [Built-in Tool Transport v43](builtin-tool-transport-v43.md) 的内部 `sendInputFilePath` 提供。
归约只接受同一 `agentRunId + executionEpoch` 的 Core-owned `builtin_tool_invocation`，操作为
`thread.message.send`、状态为 `completed` 且 `coreEnvelope.ok=true`。相对路径、缺来源、失败／未完成、
其他操作或 Runtime 自报来源均不形成排除事实。

Core 终态 projector 复用已经读取的完整 Evidence，在原有遍历中收集来源路径，按 Run 冻结 execution root
转为相同的 display identity，并对归约后的最终文件列表做精确匹配。作用于权威 Run snapshot 与 operation
fallback，也覆盖 root 外绝对路径；不做 basename、前缀、内容或 symlink 别名推断，不查询当前磁盘／Git。
重复来源去重，多次 Send 各自的路径都有效。文件已删除仍可排除。

过滤后统一生成卡片摘要、detail 与计数；全部排除时发布内部 `no_changes`，不显示空卡片。
Command Diff 与 Runtime Evidence 不重写，Renderer 只读取过滤后的投影，不在展示时查询来源。

## 失效与恢复

成功来源作为 file fact 参与既有 `file_facts_change_sequence`；合法迟到终态使投影 stale，正常维护／读取
重算复用同一归约。来源 replay 不改变文件事实水位，其他 Run/epoch 不参与。持久来源随原 Evidence 保存，
重启重算后不能复活被排除文件；缺失或不可读来源不从 shell 文本补造。旧证据没有路径时沿用旧行为，
不扫描或回填历史卡片。不增加表、列、索引或第二份路径集合存储。
