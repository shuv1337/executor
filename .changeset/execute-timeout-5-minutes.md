---
"@executor-js/mcp": patch
"@executor-js/local-server": patch
---

Raise the default `execute` timeout from 30 seconds to 5 minutes on Cloud,
self-host and local. Local can still override it with `EXECUTOR_MCP_TIMEOUT_MS`.
