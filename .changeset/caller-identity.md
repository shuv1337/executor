---
"apps": patch
"@executor-js/sdk": patch
"@executor-js/mcp": patch
"@executor-js/hosted-server": patch
"@executor-js/hosted-web": patch
"@executor-js/local-server": patch
"@executor-js/ui": patch
---

Apps see who called them. `ctx.caller` holds the invocation's verified caller: `kind` (`human`,
`agent` or `system`), `subject` (the user it acts for), `issuer`, `email`, `organizationId` and
`channel` (`ui`, `mcp`, `api`, `dashboard`, `schedule`, `workflow` or `webhook`). MCP clients and
API keys are agents acting for their owner; their client and connection IDs ride along as
`provenance`, marked untrusted, for logs only. Schedules, workflow steps and webhook deliveries are
`system` work for the person they belong to, if any. Approval policies receive the same `caller`.
Builds declare this through the `callerIdentity` capability, so older bundles never receive it.

An approved call runs as its requester: `ctx.caller` stays the requester and `ctx.approvedBy`
names who approved it and how (`model`, `client`, `native`, `browser` or `dashboard`).

`human()` approvals (decision `human-approval`) accept only a person's answer: the browser approval
page, the dashboard, or the MCP client's own form. In model mode the agent's acceptance is refused
without consuming the request, and the request carries an `approvalUrl` the person approves on.

`ctx.cache.forCaller()` scopes cache entries to the user an invocation acts for. Data calls from an
app's page whose policy asks for approval fail with `approval_required` instead of
`operation_failed`. Resume tools advertise `requestId` as one plain pattern that strict
connector validators accept.
