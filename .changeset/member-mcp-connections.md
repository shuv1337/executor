---
"@executor-js/hosted-server": patch
"@executor-js/app-templates": patch
---

Organization members can list, create, update and revoke their own scoped MCP connections, and mint and revoke keys on those connections, from the dashboard or with their own API key. A connection still only includes apps the member can use and personal accounts they own. An Executor app self-call keeps the calling connection's policy: it cannot widen to all apps or mint a wider key, and a narrowed connection without manage is refused. Another member's connections stay unreachable.
