---
"@executor-js/app-data": patch
"@executor-js/sdk": patch
---

A self-hosted or local runtime keeps an app's database facet warm between calls. Each call that
found the facet idle used to restart it, because Cloudflare counts a facet's subrequests over its
whole life (cloudflare/workerd#7572); open-source workerd has no such limit, so on a workerd host
that restart only cost a cold start (about 0.4–1 s) on every database call, serialized concurrent
writes behind it, and churned memory. Cloudflare keeps restarting idle facets.
