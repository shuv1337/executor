---
"apps": patch
"@executor-js/app-templates": patch
---

Add `withApprovals(router, policy)` to choose an approval for each tool of a
protocol router, and `toolAnnotations(operation)` to read upstream hints.
Quick-add MCP apps now ask before running tools marked `destructiveHint: true`.
