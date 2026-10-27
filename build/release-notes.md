# Rovai AI v0.5.2

<!-- lang:zh-CN -->

本次更新支持为定时任务生成的会话标题添加日期和时间，并改进会话记录读取与执行状态展示。

- 【功能】**定时任务生成的会话可自动添加日期和时间。** 在“对话命名”中，可分别开关日期和时间，选择显示在任务名称前或后，并实时预览标题，方便区分多次运行。设置对之后生成的会话生效。
- 【功能】**支持增量读取会话记录。** 新增 `rovai thread read --after N`，可从指定消息序列之后按顺序读取后续记录，支持分页和回复链，方便队员补读长会话。
- 【交互】**明确区分手动停止与执行失败。** 手动停止后，消息回执和执行卡片统一显示“已停止”；失败单独标识为“执行失败”。发送给多位队员时，分别统计各自状态。
- 【界面】**调整消息回复图标。** 回复按钮改用更紧凑的三点气泡样式。

感谢 [@liangxyz](https://github.com/liangxyz) 提出的定时任务会话标题建议（[#875](https://github.com/murray17/rovai-ai/issues/875)），以及 [@liuqiong0319](https://github.com/liuqiong0319) 反馈的 Copilot 无法运行问题。

[完整变更](https://github.com/liangxyz/rovai-ai/compare/v0.5.1...v0.5.2)

---

<!-- lang:en -->

This release adds date and time options for conversations created by scheduled tasks, incremental conversation history reads, and clearer execution status.

- [Feature] **Add dates and times to conversations created by scheduled tasks.** In Conversation naming, toggle the date and time separately, place them before or after the task name, and preview the title. The settings apply to conversations created afterward.
- [Feature] **Read conversation history incrementally.** Use `rovai thread read --after N` to read subsequent records in order, with pagination and reply-chain support, so teammates can catch up on long conversations.
- [Interaction] **Distinguish stopped executions from failures.** Message receipts and execution cards now use Stopped for manual stops. Failures are identified separately as Execution failed, and messages sent to multiple teammates show counts for each status.
- [UI] **Update the message reply icon.** The reply button now uses a compact speech bubble with three dots.

Thanks to [@liangxyz](https://github.com/liangxyz) for suggesting dates in scheduled-task conversation titles ([#875](https://github.com/murray17/rovai-ai/issues/875)), and [@liuqiong0319](https://github.com/liuqiong0319) for reporting the Copilot startup issue.

[Full changelog](https://github.com/liangxyz/rovai-ai/compare/v0.5.1...v0.5.2)
