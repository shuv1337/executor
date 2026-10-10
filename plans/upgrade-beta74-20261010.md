# Upgrade the VM to apps beta.74 (merge 00649377f)

Prepared October 10, 2026 (PDT). This is a plan for `ltc-executor.exe.xyz` and has not been run. It
follows the procedure in [executor-live-delivery-20261008.md](executor-live-delivery-20261008.md).
That report records production at `5a1a8736c`: apps `0.0.1-beta.28` and SDK storage `4.0.5`.

## What ships

- Source: branch `shuv/merge-upstream-v2-20261010`, merge commit
  `00649377f148fd3c6ee681417c3a9ffed4cd76be`. That merge brings in upstream v2 `cd712b7f7` and
  keeps the fork's changes. The commit after it changes only this file.
- Image built from that commit: `executor-v2-server:merge-00649377f`, image ID
  `sha256:081f4e14becf699eb3f884b46ecf884a24a5eead4d2991d1898ff85c4109a5de`, linux/amd64.
  `EXECUTOR_BUILD_VERSION` is the full merge SHA. This Compose build sets no OCI revision label,
  so check the build with `EXECUTOR_BUILD_VERSION` instead.
- The upgrade moves apps from `0.0.1-beta.28` to `0.0.1-beta.74` (host protocol 12) and SDK
  storage from `4.0.5` to `4.0.8`.

Before shipping, check that the VM is amd64 (`docker info --format '{{.Architecture}}'`). If it
is not, build on the VM from the source archive instead.

```bash
# On the build host
cd /home/shuv/.cache/agent-ws/executor-fork
git archive --format=tar.gz --prefix=src-00649377f/ 00649377f -o executor-src-00649377f.tar.gz
docker save executor-v2-server:merge-00649377f | gzip > executor-v2-server-merge-00649377f.tar.gz
sha256sum executor-src-00649377f.tar.gz executor-v2-server-merge-00649377f.tar.gz
# Copy both files to /home/exedev/executor on the VM, then check the sums there and:
cd /home/exedev/executor && tar -xzf executor-src-00649377f.tar.gz
gunzip -c executor-v2-server-merge-00649377f.tar.gz | docker load
docker image inspect executor-v2-server:merge-00649377f --format '{{.Id}}'   # must equal the ID above
```

Check free disk first. The last delivery left about 4.2 GiB, and the image and backups need
space too.

## 1. Back up first (required: this upgrade cannot be undone in place)

The new server migrates the product database to storage `4.0.8` when it starts. Older servers
refuse that version (`makeExecutorStorage` accepts only versions it knows). Swapping the image
back is therefore not a rollback; you have to restore this backup.

1. Record the current state: `docker inspect executor-v2-server-1 --format '{{.Image}}'` (or
   whatever the server container is called), the running `EXECUTOR_BUILD_VERSION`, and a copy of
   `compose.vm.yaml`. Save them to `ops-20261010/` (mode 700, files mode 600).
2. Stop only the server. Cloudflared keeps running.
   `docker compose -p executor-v2 -f src-5a1a8736c/apps/hosted/self-host/compose.yaml -f compose.vm.yaml stop server`
3. Take snapshots of the stopped volumes. Use the same image-provided tooling as on 2026-10-08:
   - product `executor-v2_v4-dd84782f9` → `ops-20261010/product-data-before.tar.gz`
   - telemetry `executor-v2_motel-data` → `ops-20261010/telemetry-before.tar.gz`
4. Run `gzip -t` and `sha256sum` on both archives and record the results. Do not print their
   contents.
5. Optional, recommended: restore the product archive into a throwaway volume and run the
   **new** image against it with networking disabled and `EXECUTOR_DATA_STEPS=report`. This runs
   the 4.0.5→4.0.8 schema migration on the copy. In report mode, the data steps only log what they
   would do and write nothing. Check that `/health` succeeds inside that container, then remove
   the throwaway volume.

Keep the window short: build and compress outside it. The last replacement took about 34 seconds.

## 2. Activate

1. In `compose.vm.yaml`, set `services.server.image` to `executor-v2-server:merge-00649377f`.
   Keep everything else: environment, trusted proxy `/32`, and volumes. Then save the new file
   to `ops-20261010/compose.vm.after.yaml`.
2. Start only the server:

```bash
cd /home/exedev/executor
docker compose -p executor-v2 \
  -f src-00649377f/apps/hosted/self-host/compose.yaml \
  -f compose.vm.yaml \
  up --no-build --no-deps --detach --wait server
```

3. Read `docker logs --tail 200` for the server. Expect the storage migration, then
   `Data step pass finished` for steps 1–5, including `5_redeploy_pre_beta10_executor_apps`,
   which is new since production. Also expect the warning
   `EXECUTOR_REGISTRY_URL is set but has no effect` if the override still sets that variable.

## 3. Acceptance

- `curl -fsS http://127.0.0.1:4400/health` and `https://executor-v2.shuv.dev/health` both
  return `{"status":"ok"}`, and Docker reports the container healthy.
- `https://executor-v2.shuv.dev/.well-known/oauth-authorization-server` returns 200 with the
  public issuer `/api/auth` and the registration, token and authorize endpoints, as on
  2026-10-08.
- The trusted-proxy rate limit still holds. From cloudflared's network namespace, send invalid
  registrations: client A gets 5×400, then 429 with `Retry-After: 60`, and client B still gets 400.
- App list: signed in as an owner, the dashboard's Apps page (or `executor apps list`) shows all
  **24** apps with their active deployments, with no app in a failed state. Call one read-only
  tool of a few apps over MCP `execute`, including at least one app with stored data.
- Motel health returns 200, and a historical trace from before the upgrade can still be queried.
- `docker inspect` shows the server's `EXECUTOR_BUILD_VERSION` equal to `00649377f148fd3c6ee681417c3a9ffed4cd76be`.
- The cloudflared container ID has not changed.

## 4. Rollback

Rollback means restoring the step-1 backup into a **new** volume and starting the previous image
on it. Do not restore over the upgraded volume. Keep that volume for diagnosis.

```bash
cd /home/exedev/executor
docker volume create executor-v2_v4-rollback-20261010
# Restore ops-20261010/product-data-before.tar.gz into it with the same tooling that made it,
# then restore the original file ownership for the image's non-root user.
docker compose -p executor-v2 -f src-00649377f/apps/hosted/self-host/compose.yaml -f compose.vm.yaml stop server
cp ops-20261010/compose.vm.before.yaml compose.vm.yaml   # the override saved in step 1
EXECUTOR_V2_VOLUME=executor-v2_v4-rollback-20261010 \
docker compose -p executor-v2 \
  -f src-5a1a8736c/apps/hosted/self-host/compose.yaml \
  -f compose.vm.yaml \
  up --no-build --no-deps --detach --wait server
```

The 2026-10-08 rollback selected the product volume through `EXECUTOR_V2_VOLUME` together with
`ops-20261008/compose.rollback.private.json`. Before `up`, run the same files through
`docker compose ... config` and confirm that `/app/data` mounts the rollback volume. The snapshot
loses anything written after it was taken. The telemetry volume does not depend on
the product schema, so it stays mounted.

## Product database migrations in this upgrade (AGENTS.md "Migrations must keep the app online")

Self-host runs migrations in the single server at startup. No old server serves traffic while
they run, but the migrations still have to complete and must not lose data:

- SDK storage `4.0.6`: adds a nullable check message column.
- SDK storage `4.0.7`: adds three event tables and their indexes.
- SDK storage `4.0.8`: **destructive cleanup.** It deletes `executor_account_connections` rows
  with a null or JSON-null `target`, and their `executor_oauth_attempts`. Then `target` becomes
  required. These rows are pending or old connection requests, not saved accounts. A sign-in
  started before the upgrade but not finished may disappear and need to be started again.
- Hosted step `7_require_connection_targets`:
  `alter table hosted_connection_access alter column target set not null`. Access rows of the
  deleted connections were deleted with them (cascade).
- The data-step journal adds `5_redeploy_pre_beta10_executor_apps`. It redeploys only Executor
  apps built on apps older than beta.10, with only their apps pin changed.
- No better-auth version change (1.7.5 on both sides) and no change to the registry storage
  layout.
- Downgrade is not possible in place (see Rollback).

The native host now gives workerd an `EXECUTOR_CREDENTIAL_HANDLE_SECRET` derived from the
encryption key. Credential handles sealed under the earlier constant are refused once, and apps
get new handles on their next call. Expect a few retried calls right after the upgrade.

## Breaking changes from beta.28 to beta.74 for the 24 deployed apps

Existing deployments keep running unchanged. The host still runs bundles for protocols 1–11
(`apps:protocols`: "the live protocol 12 is recorded and keeps their bundles running"). These
changes apply when an app is **redeployed or upgraded** to beta.74:

1. **beta.38 replaces the document database with SQL.** `defineDatabase`, `table` and `ctx.db`
   are removed. Apps add `migrations/NNNN_*.sql` and use the synchronous `ctx.sql`. The old rows
   stay in `_executor_legacy_rows (table_name, id, body)`, and the first migration must copy
   them. Mutations no longer run as one transaction around `fetch`. Workflow
   `step.runMutation` writes go inside a single `ctx.sql.transaction`. Guide:
   `packages/app-templates/executor/skills/app-authoring/upgrades/0.0.1-beta.38.md`. Before
   redeploying, check each of the 24 apps for `defineDatabase` or `ctx.db`.
2. **`ctx.sql` binds at most 100 values per statement.** Use `json_each(?)` for long lists.
   Migrations may end with comments.
3. **Accounts are saved only through an app's connection request.** `POST /v1/accounts` and
   `PUT /v1/accounts/:account/credentials` are removed (SDK minor). Any script or automation on
   the VM that creates or replaces accounts through the API breaks.
4. **`githubSkills` / `wellKnownSkills` with `cache: ctx.cache`** no longer serve a stale catalog
   while refreshing. A source check that fails or takes over 5 seconds fails the read. Provider
   errors now surface as `AppProviderFailed`.
5. **App cache:** a lifetime over the 7-day retention is shortened instead of failing. Limit
   failures name the limit.
6. **Workers:** data Workers now count against `EXECUTOR_APP_WORKERS`, whose default rises from
   32 to 64. Idle Workers unload after `EXECUTOR_APP_WORKER_IDLE_SECONDS` (300). If
   `compose.vm.yaml` sets `EXECUTOR_APP_WORKERS` explicitly, add one per app with a database or
   remove the override.
7. Not affecting this fork: the `hostedExecutorOrigin` default moved to `https://api.executor.sh`.
   Self-host here uses its own organization registry and ignores `EXECUTOR_REGISTRY_URL`.
