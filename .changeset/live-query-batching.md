---
"@executor-js/sdk": patch
"@executor-js/app-templates": patch
---

Live app queries rerun at most once a second per subscription. The first result
and a write after an idle second still arrive at once; change notifications that
arrive in between fold into one rerun that reads the newest data, so a burst of
writes ends with the final write and no update is lost. This applies to
`appData.subscribe`, the app page subscriptions built on it, and
`subscribeAppQuery`.
