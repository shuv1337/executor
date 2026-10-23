---
"@executor-js/app-management": patch
---

`executor apps` commands signed in with `executor apps login` accept the signed-in organization by
its slug as well as its ID. Sign-in prints the slug, but `--organization <slug>` failed every
command, including `executor apps call`, with "Forbidden (HTTP 403)" before any request was sent.
Any other organization now goes to the host, which refuses one the session cannot use.
