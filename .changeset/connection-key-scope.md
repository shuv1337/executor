---
"@executor-js/sdk": patch
---

A scoped MCP connection stays scoped when its key calls the Executor app. The calling connection is bound onto the app invocation even when that build does not receive `caller`, and a warm app worker loaded for another connection cannot serve the call. Create, update, and mint through that self-call stay inside the connection, including for an organization admin.
