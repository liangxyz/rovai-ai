# Rovai AI v0.4.16

<!-- lang:zh-CN -->

本次更新合并上游 v0.4.13 之后的 11 项修复与改进，包括记忆页面重做、超长输入失败提示、Antigravity 长回合以及发送文件的差异统计。

- 【新增】**记忆页面改为紧凑的中性色工作区，并提供更准确的变更提示。**
- 【修复】**超长输入被拒绝后，会话里会明确显示失败原因。** 之前消息被领取后才发现输入过长，界面没有任何反馈。
- 【修复】**Antigravity 的长回合可以完整结束，工具调用的反馈也会正确收尾。**
- 【修复】**通过输入文件发送的内容不再计入本次运行的文件差异。**
- 【修复】**定时任务窗口可以重新拖动。**
- 【修复】**输入框里的链接高亮在打字时保持稳定。**
- 【修复】**会话上下文环改为中性色显示。**
- 【优化】**运行时检查复用最终的身份验证结果，并保留完整的 MiniMax 模型目录，检查更快。**

[完整变更](https://github.com/liangxyz/rovai-ai/compare/v0.4.15...v0.4.16)

---

<!-- lang:en -->

This release merges 11 fixes and improvements made upstream after v0.4.13, including a redesigned Memory page, clearer failures for oversized input, long Antigravity turns, and run diffs for sent files.

- [Feature] **The Memory page is now a compact neutral-color workspace with more accurate change notices.**
- [Fix] **A message rejected for oversized input now shows the failure in the conversation.** Previously the input was found too large only after the message was claimed, and the interface gave no feedback.
- [Fix] **Long Antigravity turns can now finish, and tool-call feedback settles correctly.**
- [Fix] **Content sent through input files is no longer counted in a run's file diff.**
- [Fix] **The scheduled task window can be dragged again.**
- [Fix] **Link highlights in the composer stay stable while typing.**
- [Fix] **The session context ring is now shown in a neutral color.**
- [Improvement] **Runtime checks reuse the final identity verification and keep complete MiniMax model catalogs, so they run faster.**

[Full changelog](https://github.com/liangxyz/rovai-ai/compare/v0.4.15...v0.4.16)
