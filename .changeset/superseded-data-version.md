---
"@executor-js/sdk": patch
"@executor-js/hosted-server": patch
"@executor-js/local-server": patch
---

A data query, mutation or live query that names a superseded version of an app with a database is
now refused with `AppDataVersionSuperseded` (409) instead of running that build's code against the
database, which follows the active version's migrations. A live query left on the old version ends
at the next change or 15-second check. Before, a client pinned to an old version swapped the app's
one data facet to the old build on every refresh, so the active build cold-started on its next call.
App pages reload on the new version as before. The hosted data routes now answer each data failure
with its own status instead of 500.
