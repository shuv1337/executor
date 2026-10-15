# Upstream v2 synchronization — 2026-10-14 PDT

Merge upstream `92dc55f3e07fb2db1316fce28c686c3caf3ee46f` into fork
`1b25c33d339e29ad51216a093db968107daa3877`. A fresh fetch at 20:46 PDT
confirmed this was the latest public upstream v2 export. This brings apps beta.91
and host protocol 13 into the fork. It does not deploy the running host.

## Integration decisions

Retain organization-only publishing, member managed-key provisioning, flat app
hosts, and default-organization routing. Combine those changes with upstream's
resource lifecycle hooks and updated catalog mutation behavior. Adapt fork tests
and the Syncro demo to per-user account links. Keep a beta.35 Syncro compatibility
case by translating only its account declaration/access to the older API.

The registry upgrade fixture now uses upstream's schema rollback helpers before
labeling its disposable database as 4.0.10. Without these helpers it left newer
columns behind and failed on restart. It still checks two rejected upgrades,
unchanged old-version records, repaired retry, exact retained source, and repeat
startup. The current SDK schema version is 4.0.15.

## Verification

- `bun run format`, `bun run check`: passed (existing Effect warnings remain).
- `bun run e2e:prepare`: passed with Node 24.21.0 ahead of system Node/npm.
  System npm 12 changes pack JSON to an object and breaks the upstream pack helper;
  tracked separately as papercut pc_cad047aed471.
- `go test ./...` in `apps/hosted/self-host/native`: passed.
- Nine named self-host scenarios passed: team registry isolation/copy/unpublish;
  registry failed-upgrade repair/repeat; managed-key caller isolation; resumed
  workflow ownership; flat app hosts; default organization hosts; Syncro pagination,
  credential scoping and failures (current and beta.35); retained app-account links
  during upgrade; legacy profile account/schedule copies during upgrade.
- Local evidence under `.local/e2e/`: `2026-10-15T03-45-24.419Z-self-host-e68f6a`
  (six passes and original fixture failure), `2026-10-15T03-46-21.291Z-self-host-b4c4f4`
  (fixed registry scenario), `2026-10-15T03-46-42.191Z-self-host-30c439`
  (two account upgrade scenarios). Directory timestamps are machine UTC identifiers.
- This public export has no `.github/workflows`; no hosted CI or full-suite result
  is claimed. Cloud deployment and live database upgrade remain untested here.

## Desk identity follow-up

Rechecked `packages/sdk/src/implementation/tools.ts` and `app-runner.ts`:
`CurrentActor` reaches the tool snapshot, but `AppInvocation` and
`AppCapabilities` still do not expose a trusted caller identity or per-call
host-owned delegated fetch. This sync establishes the current baseline for the
isolated proof described in the Desk investigation; it does not implement it.
