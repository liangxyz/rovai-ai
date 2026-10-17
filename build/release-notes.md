# Rovai AI v0.4.14

<!-- lang:zh-CN -->

本次更新修复定时任务产出的会话无法永久删除的问题。该问题会让页面每次刷新都弹出“删除未完成，请重试”，点击重试也无效。

- 【修复】**定时任务产出的会话现在可以永久删除。** 之前删除这类会话时，数据库会被定时运行记录的外键挡住，反复报 `FOREIGN KEY constraint failed`。现在删除会话时会一并删除它对应的那一次定时运行记录及其通知记录；定时任务本身和其他次运行记录不受影响。
- 【说明】**已卡住的删除，升级后点一次“重试”即可完成。** 不需要手动修改数据库。

[完整变更](https://github.com/liangxyz/rovai-ai/compare/v0.4.13...v0.4.14)

---

<!-- lang:en -->

This release fixes a bug where a conversation produced by a scheduled task could not be permanently deleted. The page showed "Deletion incomplete, please retry" on every refresh, and retrying did not help.

- [Fix] **Conversations produced by scheduled tasks can now be permanently deleted.** Deleting such a conversation used to fail on a foreign key from the scheduled-run record, repeatedly reporting `FOREIGN KEY constraint failed`. Deletion now also removes the scheduled-run record of that one occurrence and its notification records. The scheduled task itself and its other runs are not affected.
- [Note] **A deletion that is already stuck completes after upgrading: click Retry once.** No manual database edit is needed.

[Full changelog](https://github.com/liangxyz/rovai-ai/compare/v0.4.13...v0.4.14)
