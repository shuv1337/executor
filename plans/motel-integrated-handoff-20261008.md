# Motel isolation candidate

The reviewed collector isolation changes and the independent export diagnostics are combined locally on `shuv/motel-integrated-20261008` in `/Users/shuv/repos/executor-v2/.rifts/motel-integrated-20261008`. Implementation and test head: `c24a48d7e`. No push, PR, production deployment, restart, or data mutation occurred during consolidation.

## Combined changes

- `f403815c2`: run the bundled Motel collector in a separate supervised workerd process, retaining its storage key and data directory.
- `8d2f91fa7`: stop the collector alongside the product under one shutdown deadline; cancel restart backoff on stop; require the packaged `motel.capnp` artifact.
- `daa24f7e1`: require HTTP 200 for the product health poll, propagate poll failures, and exercise collector restart, retained traces, and shutdown with a draining product request.
- `c24a48d7e`: cherry-pick `32f4c6f98` from the validation branch, preserving its Effect HTTP client and explicit export-status diagnostics. The import conflict was resolved by retaining both the lifecycle process APIs and export HTTP APIs. No behavior was dropped.

All original task branches were preserved. The canonical checkout remains clean at `27351e46b`, matching `origin/v2`.

## Verification of the combined branch

With `/opt/homebrew/bin/bun` 1.4.2 first on PATH:

- Fresh `bun install --frozen-lockfile`: passed, 2,024 packages in 8.68 seconds.
- `bun run format`, `bun run check`: passed, including the TypeScript and E2E boundary checks.
- `bun run e2e:prepare`, self-host `package:runtime`, and the Go native-host build: passed.
- Named native run: three tests passed, zero filtered out, in 20.61 seconds:
  - `Native self-host OAuth rate limits isolate trusted proxy clients and reject spoofed addresses`
  - `Native self-host telemetry ingest does not stall product requests`
  - `Native self-host restarts its telemetry collector and stops it with the product`

Command:

```sh
PATH=/opt/homebrew/bin:$PATH bunx --no-install vitest run \
  --config e2e/self-host-native.config.ts \
  --testNamePattern 'Native self-host (OAuth rate limits|telemetry ingest|restarts its telemetry)' \
  --reporter=default --reporter=json \
  --outputFile=.local/motel-integrated-native.json
```

Combined-run evidence: `.local/motel-integrated-native.json`; build/check logs: `/tmp/motel-integrated-{build,check,native}-20261008.log`. Native server logs remain under `.local/native-auth/`.

The fixes task separately built `executor-motel-review-fixes:8d2f91fa7207` from a clean Git archive and passed the three named released-image credential/restart scenarios (`explicit`, `local`, `railway`). Changes after that image's source commit are tests and documentation only. The isolation implementation and shutdown changes also have red-check evidence in the original task rifts. These prior results were not rerun unnecessarily during consolidation.

`workspace:check` and `workspace:check --task` still reject this fork because they compare with obsolete `origin/main` and expect the upstream shared-preview layout. The actual origin remote, clean state, and `origin/v2` baseline were verified; the guard was left unchanged.

## Limits and next decision

The historical redacted export failure remains unexplained. Passing reproductions do not establish a fix for it. The updated scenario will retain the real transport error or HTTP refusal if it recurs; assertions, retries, and deadlines were not relaxed.

The 12,000-span ingest and lifecycle scenarios demonstrate that collector ingestion no longer blocks the product's event loop and that collector restart/shutdown behaves correctly in those conditions. They do not prove the cause of the production 20:24 hang, behavior under CPU/disk contention at the 1 GiB store cap, or absence of export loss under load. The native scenarios are not currently part of ordinary CI. Force-killing the Go host on macOS can still orphan its collector.

Production replacement remains a separate authorized action. It must preserve the product and Motel volumes, keep the previous image available for rollback, and verify both workerd processes, product health, retained traces, new exports, and account inventory on the actual host. No routine switch or Syncro account change is part of this candidate.
