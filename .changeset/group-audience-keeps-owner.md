---
"@executor-js/hosted-server": patch
"@executor-js/sdk": patch
"@executor-js/app-templates": patch
---

An app shared with groups stays usable by its creator and the organization's owner, who could
restore their own use by changing the audience anyway; narrowing an app to a group no longer
locks them out. A tool call whose input is over 32 MiB is refused with `InputInvalid`, naming
the input's size and the limit, before any app code runs, instead of failing inside the runtime
with an unreadable result. The connection-management routes are documented as deliberately not
tools: every MCP caller is an agent.
