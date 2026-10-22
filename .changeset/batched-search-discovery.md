---
"@executor-js/mcp": patch
"@executor-js/mcp-auth": patch
"@executor-js/sdk": patch
"@executor-js/hosted-server": patch
"@executor-js/local-server": patch
---

An organization-wide MCP search no longer costs product operations and SQL statements per app.
Discovery lists every searched app's linked accounts in one operation and reads the search rows the
product already keeps for all of them in one more, with the same checks per app read in bulk: the
caller's access and links in one statement, the apps and their active versions in one, the accounts
in one, the kept rows in one and the actor's recheck of every app in one. An app whose rows must be
written by listing its tools, or that any check refuses, is still discovered on its own exactly as
before, so a slow or stalled app holds only itself and reports the same errors.

On self-host with 30 apps, a search-heavy execute went from 73 product operations and 129 statements
to 11 and 16, its first search's discovery from about 550 ms to 140 ms on a throttled host, and other
sessions' MCP calls during it from 503 ms to 434 ms at the median and 724 ms to 498 ms at the
slowest. Local still reads each app's rows on its own.
