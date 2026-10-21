---
"@executor-js/app-management": patch
"@executor-js/app-templates": patch
"@executor-js/local-server": patch
---

`executor apps call --app <slug-or-id> --tool <path> --input-file <file.json>` calls one app tool
from a shell under the CLI's own credential (`EXECUTOR_ACCESS_TOKEN`, the local API key or the
`executor apps login` session) and prints its result as JSON. `--input-file -` reads stdin and
`--input` takes inline JSON; input that is not one JSON object is refused before any request. A
failing tool exits 1 with the app's message. A call that needs approval does not complete and exits 2;
the CLI never approves it.
