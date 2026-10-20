# Native permission questionnaire samples

Captured on macOS arm64 from the installed Kimi Code 2.1.1 and Qwen Code 0.25.0
through `scripts/smoke-native-questionnaires.mjs`, using the production Core and
a local scripted OpenAI-compatible provider. Both native sessions used `yolo`.
The question and options are synthetic. Only `sessionId` and `toolCallId` have
been replaced; object key order/whitespace are insignificant.

The unique regression owner is `approval_selects_the_exact_native_option_id`.
It derives damaged and conflicting samples from these complete native frames.
These are protocol/dispatch evidence, not real-model qualification or evidence
about untested native versions.

Both requests received exactly `{"outcome":{"outcome":"cancelled"}}`. Kimi then
produced its own empty-answer/dismissed tool result; Core did not send an answers
object or claim that a user had answered. The Run retained the unsupported
questionnaire terminal even after the native agent produced final text.
