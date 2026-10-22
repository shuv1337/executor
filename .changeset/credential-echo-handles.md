---
"@executor-js/app-templates": patch
---

The app-authoring skill explains that an echo service such as httpbin shows app
code the credential handle, not the value it received, because Executor replaces
echoed values with their handles. Check what a service received from its own
answer, not from its echo.
