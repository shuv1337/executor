---
"@executor-js/hosted-server": patch
"@executor-js/hosted-web": patch
---

Browser approval links name their grant only by an opaque reference sealed with the instance's
secret (`grant=`), instead of the grant ID, which for an API key embedded the key's ID. Links
already issued with `grantId` still open. The approval page now also forwards a model-mode link's
`mode`, so a person can approve a `human()` request from the link itself.
