---
"@executor-js/sdk": patch
---

Self-host runs app code in its own workerd process. An app that loops without awaiting stops only
that process, which the host restarts after about 30 seconds of silence
(`EXECUTOR_APP_WATCHDOG_INTERVAL`, `EXECUTOR_APP_WATCHDOG_FAILURES`), while the product, dashboard,
API and MCP keep answering. `EXECUTOR_APP_PROCESS=shared` keeps the single process.

A workflow step whose attempts keep stopping its process ends the run once it has used its retry
limit, instead of running again after every restart.
