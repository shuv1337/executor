# Combined fork PR validation

The October 8 issue batch, reviewed Motel isolation fixes, export diagnostics, and hardened Syncro REST app are combined on `shuv/issues-complete-20261008`, based on `origin/v2` at `27351e46b`. The combined implementation merge is `57c568c10`. The task worktrees remain intact; the canonical checkout remains clean. The PR targets `shuv1337/executor:v2`.

## Final combined-tree checks

Using Bun 1.4.2 with a fresh frozen install:

- `bun run format`, `bun run check`: passed.
- `bun run e2e:prepare`, self-host `package:runtime`, and native Go build: passed.
- Existing native `go test` suite and `go vet`: passed.
- Named self-host run: two tests passed; the other two cases in the older-protocol file were filtered out:
  - `Syncro REST reads preserve pagination, host-scoped bearer secrets, account checks and provider failures`. This runs against both the checkout framework and the integrity-verified published beta.35 archive.
  - `Protocol-1 builds keep working on the router host`.
- Named native run: OAuth rate-limit isolation and collector restart/shutdown passed. `Native self-host telemetry ingest does not stall product requests` failed during a `POST /v1/traces` with `HttpClientError`, caused by `TypeError: fetch failed`, caused by `write ECONNRESET`.

The native ingest failure recurred after earlier three-of-three passing runs on the integrated Motel branch. The cause remains unresolved. No passing rerun, retry, longer deadline, skipped assertion, or timing relaxation was used to conceal the final failure. The improved diagnostics preserve the transport cause, but are not a fix for it. The final run does not establish the ingest latency bound.

Evidence retained locally:

- Self-host: `.local/e2e/2026-10-08T23-31-07.220Z-self-host-3ba485`.
- Native: `.local/issues-complete-native.json` and `.local/native-auth/*/server.log`.
- Build/check/native console logs: `/tmp/executor-issues-pr-{build,check,native}-20261008.log`.

The prior fixes branch separately passed three named Docker release scenarios covering credential persistence, spans before/after replacement, and independent Motel reset. Those image results apply to the collector implementation, which is unchanged in this merge; they are not presented as a Docker run of this complete PR tree.

## Remaining acceptance and infrastructure limits

The historical production hang, store-cap CPU/disk contention, and export loss under load remain unproven. Syncro has not been connected to a live API-key account, benchmarked, or substituted for existing routines or approved writes. Schedule/workflow work is inventory and migration guidance only. Hermes repair lives in its separate repository.

This fork has no `.github` directory or GitHub Actions workflows at the verified baseline, so no automated GitHub CI result is claimed. The PR still selects `all` in the required E2E block because auth, lockfile, runtime packaging, and E2E support are cross-cutting.

The workspace guard still expects obsolete `origin/main` and the upstream shared-preview layout. Its failure is recorded separately from the passing static checks; origin, `origin/v2`, and clean canonical state were verified directly.

Opening the PR does not merge it or deploy the newer Motel/Syncro changes. Prior OAuth and persistent-volume delivery is recorded in `plans/executor-live-delivery-20261008.md`.
