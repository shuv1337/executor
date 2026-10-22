---
"@executor-js/mcp": patch
"@executor-js/hosted-self-host": patch
---

Hosts can set how many apps MCP discovery lists at once with the optional
`discoveryConcurrency` MCP limit, which execute, search, describe and the skill
index use. Self-host reads it from `EXECUTOR_MCP_DISCOVERY_CONCURRENCY`
(default 8, unchanged). Discovery shares self-host's one product thread with
every other request: a lower value delays other sessions less during a
catalog-wide search, at the cost of a slower search and a longer wait when
several apps' upstream servers never answer.
