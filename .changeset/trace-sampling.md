---
"@executor-js/telemetry": patch
"@executor-js/hosted-self-host": patch
"@executor-js/local-server": patch
---

Self-host, local and desktop servers now sample traces instead of recording every one. A tenth of
ordinary traces is kept by default (`EXECUTOR_TRACE_SAMPLE_RATE`, chosen from the trace ID so every
request of a trace agrees), and a trace is always kept when its request sends a sampled
`traceparent`, when an operation in it fails or answers with a server error, or when it runs for
`EXECUTOR_TRACE_SLOW_MS` (default 1000) or longer. `EXECUTOR_TRACE_SAMPLE_RATE=1` records every
trace as before. Logs and metrics are never sampled. Cloud still records every trace.
