---
"@executor-js/hosted-server": patch
"@executor-js/hosted-web": patch
"@executor-js/hosted-cloud": patch
"@executor-js/app-templates": patch
---

Connection keys: API keys bound to one scoped MCP connection, for headless agents, CI and staff
bots. A connection's owner mints one with `POST .../mcp-connections/<id>/keys` and a required
expiry of 5 seconds to 90 days. The key works only at its connection's MCP URL; plain `/mcp`,
other connections and the Executor API refuse it with a 403 that says so. It stops when its
connection is revoked, which deletes it, and every mint is in the audit log.
