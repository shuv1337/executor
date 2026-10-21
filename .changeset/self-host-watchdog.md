---
"@executor-js/sdk": patch
"@executor-js/hosted-server": patch
---

The self-host host restarts itself when an app's code holds workerd's only JavaScript thread. Once
the product has answered, it probes `/health` on the product's private socket every
`EXECUTOR_WATCHDOG_INTERVAL` seconds (default 10). After `EXECUTOR_WATCHDOG_FAILURES` failures in a
row (default 9), it kills workerd and exits, and the container's restart policy starts a fresh
process. `EXECUTOR_WATCHDOG=off` turns it off.

`EXECUTOR_NPM_REGISTRY` may end with a slash; app builds no longer request `//<name>` from it.

An approval answered on the browser approval page records the approver's email in `ctx.approvedBy`.
