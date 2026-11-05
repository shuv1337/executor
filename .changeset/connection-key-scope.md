---
"@executor-js/sdk": patch
"@executor-js/hosted-server": patch
"@executor-js/app-data": patch
---

A scoped MCP connection stays scoped when its key calls the Executor app, including a nested `tools.call`. The API narrows that request to the calling connection and stamps the connection on the caller, so a further app invocation stays bound. Facet apps get the same connection on their outbound. Create, update, and mint stay inside the connection, including for an organization admin.
