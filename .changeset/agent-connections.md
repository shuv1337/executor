---
"@executor-js/hosted-server": patch
"@executor-js/app-management": patch
---

Organization admins can list, create, update and revoke their own scoped MCP connections with an API
key or a full-access API grant, as well as from the dashboard, so agents are provisioned without a
browser. Members' keys are refused, and every change made with an API credential is logged. An API
key used at a connection's MCP URL runs with only that connection's apps, tools and `runsAs`
accounts, and stops when the connection is revoked.

`executor apps credential` hands Git `EXECUTOR_ACCESS_TOKEN` when it is set, as every other command
uses it, instead of the signed-in session.
