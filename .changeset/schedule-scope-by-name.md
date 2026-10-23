---
"@executor-js/sdk": patch
"@executor-js/hosted-server": patch
"@executor-js/local-server": patch
---

Schedule configure and run now, by name, find app schedules without a scope. Run now takes an
optional `scope` (`app` or `user`), as configure does; it previously only looked for the caller's
own copy, so an app schedule was not found. Without `scope`, both routes act on the schedule saved
under the name, else on the app's declaration, else on the caller's copy as before. When both the
app schedule and the caller's copy are saved under the name, they fail with
`ScheduleScopeRequired` instead of guessing. Each scope keeps its authorization: only the app's
managers configure or run an app schedule. The SDK adds `schedules.scope`, which resolves it.
