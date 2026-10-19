---
document_type: protocol-contract
contract: builtin-tool-transport-v43
authority: builtin-tool-transport
status: accepted
version: 43
source_version: v1.72
last_updated: 2026-10-19
---

# Built-in Tool Transport v43

继承 [v42](builtin-tool-transport-v42.md)。Transport/CLI **43**，capability
`builtin_cli.transport.v43`；IPC **3**、Envelope **2**、Agent Output **14** 保持。
本版只增加本机 IPC 的可选来源元数据，不改变 Agent 参数、Send 业务输入 Schema、help 或模型上下文。

## Send 输入文件来源

`Invoke` 可携带独立于 `input` 的 `sendInputFilePath?: string`，只允许 `thread.message.send`。
CLI 成功解析 `--input-file` 后，按当时 CLI cwd 转为绝对路径并做共享词法规范化；正文文件和完整请求
文件都记录这一个路径。`--body`、JSON stdin、其他命令的输入文件和 `--file` 附件不产生该元数据。
路径不得为空、含 NUL 或为相对路径；Core 验证并规范化，不读取或删除源文件、不解析 symlink、不猜文件名。

元数据绑定到已认证的 Run/epoch，随这次 Send 的现有 Built-in Tool Evidence 保存；复用现有 JSON／Blob，
不增加数据库表、SQL 列或 Run 级路径数组。Core 的成功终态与成功 Envelope 才允许此路径参与
[文件卡片排除](runtime-file-change-observation-v9.md)。失败、未完成和旧记录不推测路径。
来源不进入消息正文、附件、Agent Output 或模型上下文；记录来源不增加文件读取权限。

同一 IPC request identity 的内存 replay digest 包含已规范化来源；改变来源不能重放旧响应。
没有来源时沿用原 digest，持久业务命令／消息 receipt 的幂等身份不变。IPC 3 的旧请求仍可省略字段；
配套 CLI/Core 使用当前 Transport capability，旧证据和已生成卡片不回填。

## 用途边界

成功 Send 的输入文件从本轮 Files Changed 排除，包含项目内外路径。规则依据输入用途，不判断文件
是否临时；已有项目文档若被作为输入文件发送，其本轮变化同样排除。正式附件不因 `--file` 被排除。
原始 Runtime 文件操作及 Command Diff 保留；受管 `ROVAI_RUN_TMP` 的既有 ingress 排除继续独立生效。
