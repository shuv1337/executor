---
"apps": patch
"@executor-js/sdk": patch
"@executor-js/app-templates": patch
---

Apps can declare `sharedRuntime: true` beside their requirements
(`defineApp({ sharedRuntime: true, user: { accounts } }, ...)`). The host then
names the app's Worker and data facet by build alone, so every caller's calls
share one warm runtime instead of one per account selection: a multi-user
database app no longer restarts its facet each time a different person calls
it, and their calls run side by side. Accounts, `ctx.caller`, `ctx.approvedBy`
and `ctx.cache.forCaller()` stay per call. Module scope is shared between
callers, so an app must not keep per-user clients, credentials or data there;
the app-authoring skill lists what to check before opting in. Builds that do
not declare it keep one runtime per account selection.
