---
"@executor-js/sdk": patch
"@executor-js/app-templates": patch
---

A workflow body that keeps stopping the app process between steps now ends its run. The engine
started such a body again from the top after every restart, forever. Each body now reports when it
reaches a step or a sleep, and after three starts in a row without one the run fails with
"The workflow body started 3 times without reaching a step or a sleep". Sleeps never count toward
the limit.
