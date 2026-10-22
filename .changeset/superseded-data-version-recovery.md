---
"@executor-js/sdk": patch
---

`AppDataVersionSuperseded` now names the active version (`active`) and says how to recover: retry the
call without a version, or with the active one, or reload the app page. A live query left on the old
version has ended and is resubscribed the same way.
