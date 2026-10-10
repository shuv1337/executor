# Executor issue #7 and #3 live delivery

Verified October 8, 2026, on `ltc-executor.exe.xyz`. The user authorized production delivery of the reviewed OAuth and trace changes and parallel Hermes repair. This report covers Executor only.

## Active artifact and retained state

- Source checkout: `/Users/shuv/repos/executor-v2/.rifts/issues-batch-20261008`, branch `shuv/issues-batch-20261008`.
- Deployed source: `5a1a8736c20478a0157ca2b18949f65a592d02ac`, archived without local edits. Archive SHA-256: `f6c89f2651e28166ed54cd9386ee155a44b116914c7031c3d6b67b6e19529f38`.
- Live image: `executor-v2-server:issues-5a1a8736c`, pinned in the VM override as `sha256:94a97c646566b6dd58e43c619b9d1e835cdee5082fd0a5b86985f27f654dd257`. Its OCI revision label and running `EXECUTOR_BUILD_VERSION` match the complete source SHA.
- Former image retained for rollback: `executor-v2-server:upstream-dd84782f9`, image `sha256:f46419a99c201a76e942437727199ed402eb7e5338f594848871838f126c5c31`.
- The prior remote source snapshot matched all 2,158 tracked blobs at `dd84782f9`. It is an ancestor of the batch; its difference from the batch baseline affects only Docker-release E2E, so this deployment does not revert later runtime changes.
- Existing product volume retained unchanged: `executor-v2_v4-dd84782f9` at `/app/data`.
- New separate telemetry volume: `executor-v2_motel-data` at `/app/motel-data`. Complete stopped-container telemetry was copied into it, with original file ownership restored for the image's non-root user.
- Cloudflared's container, tunnel settings and routes were unchanged. Its actual peer is `172.18.0.3`; the server accepts only `cf-connecting-ip` asserted by `172.18.0.3/32`.
- The complete prior environment was preserved in the installed private VM Compose override. No custom Syncro app was activated, no routines switched, and no GitHub push, merge or comments were made.

The exact proxy IP must be reverified and the trusted `/32` updated if cloudflared is replaced or its address changes. Do not widen trust to the whole bridge/private address range.

## Backups and recovery verification

Private operational material is on the VM under `/home/exedev/executor/ops-20261008`. The directory is mode 700 and its files are mode 600. It contains the original override/environment, rollback Compose configuration, stopped product and telemetry backups, acceptance results, and the sentinel. Do not publish these files: they contain product data, traces and configuration.

- Product backup: `product-data-before.tar.gz`, approximately 252 MiB, SHA-256 `b775b252156dcb6ea2bba07aa1e87a97fb58053917cc279759db10a681c751e9`.
- Telemetry backup: `telemetry-before.tar.gz`, approximately 166 MiB, SHA-256 `744726e89aa58fead9e09f16ee81175fda9310f420d028171041332183ade126`.
- Both gzip archives passed integrity validation. Both stopped telemetry SQLite databases passed `PRAGMA quick_check`. The trace snapshot contained 223,164 spans and 50,534 trace summaries.
- The product archive was restored into a disposable volume. The former image successfully ran its supported database export against that restored volume, with networking disabled. The export opened successfully in PGlite: 4 users, 1 organization, 24 apps, 23 provider accounts, 58 deployments, 10 OAuth clients, and 15 sessions. Only counts were read; no credentials or account payloads were printed. The disposable restore volume was removed.
- Existing data/key files stayed on the original product volume throughout. These are snapshot recovery and volume-preservation checks; no authenticated production inventory or provider sign-in was performed.

The initial stopped snapshot and server replacement occupied about 34 seconds. Builds and archive compression happened outside that window. The VM retained approximately 4.2 GiB of free disk at final verification.

## Live acceptance

- Public `https://executor-v2.shuv.dev/health` and local `/health` returned HTTP 200 after activation and after a second controlled server replacement. Docker reports healthy.
- OAuth discovery returned HTTP 200 with the expected public issuer `/api/auth` and registration/token/authorize endpoints.
- Synthetic requests originated from the actual cloudflared network namespace, using two documentation-range client IPs. Client A's intentionally invalid registrations returned five HTTP 400 responses followed by HTTP 429; client B still returned HTTP 400. Rotating a spoofed internal client-IP header did not bypass A's limit.
- The limited response used OAuth `temporarily_unavailable` and preserved `Retry-After: 60`. No successful client registration or account creation occurred. This proves live trusted-peer bucket isolation and parseable cooldowns, not a complete authenticated MCP browser grant.
- The collector's health endpoint returned HTTP 200. A synthetic OTLP span was ingested and queried successfully. A force-recreate changed the server container ID while retaining both volumes; the same sentinel remained queryable afterward. A historical trace from before deployment also remained queryable afterward.
- The cloudflared container ID remained identical across both replacements.

## Operating and rollback

The installed production override is `/home/exedev/executor/compose.vm.yaml`, protected mode 600. Future server-only activation uses:

```bash
cd /home/exedev/executor
docker compose -p executor-v2 \
  -f src-5a1a8736c/apps/hosted/self-host/compose.yaml \
  -f compose.vm.yaml \
  up --no-build --no-deps --detach --wait server
```

To roll back the server without replacing the product data, use the original source and saved overrides:

```bash
cd /home/exedev/executor
EXECUTOR_V2_VOLUME=executor-v2_v4-dd84782f9 \
docker compose -p executor-v2 \
  -f src-dd84782f9/apps/hosted/self-host/compose.yaml \
  -f ops-20261008/compose.vm.before.yaml \
  -f ops-20261008/compose.rollback.private.json \
  up --no-build --no-deps --detach --wait server
```

The older Compose file does not mount the retained telemetry volume. It remains intact for recovery. Restore the saved root override as well if rollback is retained operationally; preserve the new override first. Never restore a product snapshot over live data without a separate recovery decision.

## Remaining limits

Before deployment, public/local product and Motel HTTP requests timed out and Docker became unhealthy. The unmounted telemetry SQLite file was near the bundled 1 GiB cap. Replacement recovered service while preserving that store. The underlying Motel cap/maintenance hazard is unchanged; short live checks do not establish long-term resolution of that separate issue. No telemetry was discarded and no fresh-store fallback was needed.

The task workspace guard still fails because it compares this fork's v2 branch against obsolete `origin/main` (492 ahead, 2,928 behind). The known missing engineering notes/baseline mismatch was preserved, not repaired by integrating unrelated main. Prior focused source/E2E validation was not repeated because no application source changed during this operational delivery; the live acceptance and isolated restore checks above exercised the built production artifact.
