---
"apps": patch
"@executor-js/hosted-server": patch
"@executor-js/hosted-web": patch
"@executor-js/hosted-self-host-web": patch
"@executor-js/hosted-cloud-web": patch
"@executor-js/local-server": patch
"@executor-js/app-templates": patch
---

An app's own page can ask for an approval-gated mutation. Hosted Executor saves it as the
signed-in person's own dashboard run, and `client.mutate` rejects with a `UiFailed` of reason
`approval_required` whose `approval` holds `{ requestId, url }`. The URL opens the review at
`/org/<org>/apps/<app>/approve/<requestId>` on the dashboard, where only that person approves
or declines it; the app's origin has no way to answer it. Approving runs the saved call once,
as the person, with `ctx.approvedBy` naming their dashboard approval.
`client.approvalStatus(requestId)` returns `{ status: "pending" }` while that person's own
request waits and `{ status: "settled" }` otherwise, without revealing other requests. Pages
built with earlier `apps` releases still receive plain `approval_required`, and local Executor
saves no request.
