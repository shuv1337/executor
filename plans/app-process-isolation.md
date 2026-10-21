# Self-host: run app code in a second workerd process (stage a design)

Repo `executor-v2` @ `2c6068fd7`, workerd `v1.20260918.1-executor.caf569c512`. Fixes issue #14.
Line refs: `pr.ts` = `apps/hosted/self-host/scripts/package-runtime.ts`, `we.ts` =
`packages/sdk/src/implementation/workerd-entry.ts`, `main.go` = `apps/hosted/self-host/native/main.go`.

## 1. The current boundary

One config (`pr.ts:267-301`) holds three services in one process and one JS thread.

| Crossing                                                                      | Kind                                                                                                   | Evidence                                                                                  |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| product → apps: `APPS`                                                        | plain `Fetcher` (HTTP)                                                                                 | `pr.ts:276`; `apps/hosted/self-host/src/worker.ts:166-170`                                |
| `/rpc` over `APPS`                                                            | WebSocket upgrade + **capnweb** session (`AppApi.compile/invoke/cancel`)                               | `binding-workerd-apps.ts:26-75`; `we.ts:563-564`                                          |
| `invoke(encoded, callbacks)`                                                  | string in, string out; `callbacks` = capnweb stub `{load, elicit, control}` back to product            | `we.ts:337-362`; `contracts/workerd-host.ts:50-55,95`                                     |
| `/changes?app=`                                                               | long-lived WebSocket from `AppDataSupervisor` (revision notifications)                                 | `binding-workerd-apps.ts:76-108`; `we.ts:565-566,414-424`                                 |
| `/evaluated`, `/workflow` (start/status/terminate)                            | HTTP POST JSON                                                                                         | `binding-workerd-apps.ts:109-145`; `we.ts:568-614`                                        |
| apps → product: `SELF`                                                        | `service=(product, entrypoint SelfOrigin)`, HTTP                                                       | `pr.ts:281`; `worker.ts:300-306`; `we.ts:166-167`                                         |
| apps → product: `HOST`                                                        | `(product, WorkflowCallbacks)`, HTTP POST `/workflows` (prepare/context/invoke/load/control/finish)    | `pr.ts:281`; `worker.ts:289-293`; `we.ts:183-199`                                         |
| apps → workflows: `RUNS`                                                      | wrapped binding → `workflows.WorkflowBinding` (**JS RPC**)                                             | `pr.ts:281`                                                                               |
| workflows → apps: `USER_WORKFLOW`                                             | `(apps, AppWorkflows)` **JS RPC**, step stub passed in                                                 | `pr.ts:286`; `we.ts:434-555`                                                              |
| `LOADER`, `DATA`, facets, `STORAGE`/`ELICITATION`/`WORKFLOW_CONTROLS`/`CACHE` | all internal to apps: loader workers, the `AppDataSupervisor` DO, and stubs it passes to the app facet | `we.ts:203-240,367-432`; `app-data/src/cloudflare.ts:425-440`; `worker-bridge.ts:182-193` |

Storage per side (directory paths: `main.go:535`):

- product: `ExecutorProduct` DO (PGlite on `product-data`, `preventEviction`) plus `builds`/`legacy-data` (`pr.ts:277`).
- apps: `AppDataSupervisor` + app SQLite facets on `app-data` = `/app/data/workerd` (`pr.ts:282,296`).
- workflows: `Engine` DOs on `workflow-data` = `/app/data/workerd/workflows` (`pr.ts:225,287,297`).

**Finding:** product↔apps is already HTTP + capnweb over WebSocket. No JS RPC crosses it. The only
JS-RPC edges (`RUNS`, `USER_WORKFLOW`) run between apps and workflows. The Node dev host already
runs this exact apps Worker in a **separate** workerd and talks to it over `ws` (`workerd-apps.ts:282-300`).

## 2. Transport

- **(a) `external` HTTP over a unix socket (recommended).** Product binds `APPS` as
  `external=(address="unix:…/apps.sock",http=())`. workerd's `ExternalHttpService` forwards
  WebSocket upgrades (`server.c++:2391-2399`), so `/rpc` capnweb, its callback stubs and `/changes`
  work unchanged. `bindingWorkerdApps` needs no protocol change. The only edit: replace the hard-coded
  `authorization: "service-binding"` (`worker.ts:168`, `pr.ts:281 AUTH`) with a per-boot secret
  from the Go host, read with `fromEnvironment` in both processes. Reverse direction: the product config adds
  `sockets` bound to `(product, SelfOrigin)` and `(product, WorkflowCallbacks)`, and the apps config
  binds `SELF`/`HOST` as `external` unix services. HOST gets `injectRequestHeaders`
  (`workerd.capnp:1099`) with a secret header that `WorkflowCallbacks` checks. SELF keeps app
  `authorization` headers untouched. Risk is low because the code is proven in dev. The new cost is
  one unix-socket hop per call and callback.
- **(b) `capnpConnectHost` JS RPC** (`workerd.capnp:1116`, `server.c++:2289-2313`). It works across
  processes and could split `RUNS`/`USER_WORKFLOW`, but that is not needed. Its disconnect behavior with
  passed stubs is barely exercised. Reject for now.
- **(c) Go broker.** This adds a hop for no gain. Reject; Go only supervises.

## 3. Process split

- **Product process:** `product` and the PGlite DO, plus `native`, `motel`, `dashboard`, `builds` and
  `product-data`/`legacy-data`. It no longer receives `EXECUTOR_CREDENTIAL_HANDLE_SECRET`
  (`main.go:675`), because only apps seals handles.
- **App process:** `apps` (loader, `AppDataSupervisor`, facets, esbuild compile) and **`workflows`**.
  The JS-RPC edges force the engine to stay with apps, and the workflow body itself is app code
  (`we.ts:494-517`). It keeps its own `public`/`internet` network services. The `app-data` and
  `workflow-data` paths stay the same, so no data moves and rollback is a config flip.
- **Workflow state across a restart.** Engine DOs are SQLite on disk. The patched engine re-arms an alarm
  every 30 s while a step runs (`patches/@alchemy.run%2Fcloudflare-runtime@2.0.0-beta.80.patch:131`).
  `alarm()` re-runs `init` (patch :315-340). Before each attempt the engine writes `attemptStart`
  and saves `attemptedCount` (`…/workflows-shared/context.ts:656-664`). On replay it marks a dangling attempt
  `WorkflowInternalError` and retries (`context.ts:515-549`). Product reconciliation (`workflows.ts:694-735`)
  also polls status and wakes engines. While the app process is down, `/workflow` status fails with
  `WorkflowFailure{engine, retryable}`. Reconcile treats that as transient and does not finish the run
  (`workflows.ts:372-391`). Replayed `runMutation` steps are deduplicated by replay key and fingerprint
  (`workflows.ts:268-285`).
- **Events/webhooks.** The outbox and webhook leases live in product PGlite, so they survive. Deliveries that
  need the app fail with a `RuntimeProtocolFailed` cause and retry with backoff up to `maxAttempts`
  (`events.ts:657-668`). Webhook leases expire and are reclaimed (`webhooks.ts:337-357,419`).
  Inbound webhooks for an app return an error while the process restarts, so senders retry.
- **In-flight calls.** When the process dies, the WS closes, `onRpcBroken` aborts
  (`binding-workerd-apps.ts:58`), and the call currently fails as bare `RuntimeProtocolFailed()`
  (`:17`). Change: map a broken session to `RuntimeProtocolFailed{reason:"disconnected"}` and a
  product deadline to `{reason:"timeout"}`. Both reasons already exist (`contracts/runtime.ts:300-306`).
  The MCP `call` then returns that typed error instead of hanging.
- **Deadlines.** Today the only product-side bound is the workflow step's `Effect.timeout`
  (`workerd-client.ts:130`). Tool deadlines are cooperative and only reach the app (`app-runtime.ts:178`).
  Add an `Effect.timeout(deadline + 5 s grace, default 10 min)` around `rpc` invoke. After a
  timeout, the product calls `NATIVE /apps/stalled`. Go then probes apps health right away and
  restarts the process if the probe fails, which makes recovery faster than the watchdog.

## 4. Go host supervision

- Generalize `supervise` (`main.go:938-981`). It is Motel-only today and prints "Telemetry collector"
  hard-coded. Add a name and a `kill` hook. Start the apps process with backoff from 1 s to 30 s, the same as Motel (`main.go:719-729`).
  Order matters: start apps first, then product. Product calls fail as `disconnected` until apps listens,
  which is acceptable.
- **Sockets in `$temporary` (0700):** `apps.sock` (apps listens, product external),
  `product-self.sock`, `product-callbacks.sock` (product listens, apps external). Pass them with
  `--socket-addr` / `--external-addr` as the existing args do (`main.go:652`). Remove stale socket files
  before each start, as Motel does (`main.go:721`).
- **Config:** `package-runtime.ts` emits `product.capnp` and `apps.capnp`, and keeps `workerd.capnp`
  for the shared fallback. Go does the same `@@…@@` substitution (`main.go:567-640`).
  `APP_WORKERS`, `APP_WORKER_IDLE_SECONDS`, `APPS_PRIVATE_FETCH`, `NPM_REGISTRY` and the CA certificates go only to apps.
- **Watchdogs:** keep the product watchdog (`main.go:747-755`), which still exits the container. Add an apps
  watchdog that reuses `watchdog()` (`main.go:907`) with a probe of `GET /health` on `apps.sock`, sent with
  the secret. Every isolate in that process shares one thread, so any spinning app fails the probe.
  Defaults: interval 3 s and 10 failures (about 30 s). Its stall hook SIGKILLs only the apps process.
  `supervise` then restarts it, and the watchdog re-arms after the first success. The product
  `/health` (`web.ts:79`) must not call `APPS`. Verify this.
- **Export mode:** do not start apps. This replaces the temporary-path workaround at `main.go:536-541`.
- Env `EXECUTOR_APP_PROCESS=separate|shared` (default `separate`).

## 5. Memory (2 vCPU / 7.7 GB VM)

Live read-only check on ltc-executor at 2026-10-21 (container up 5 min): main workerd **RSS 595 MB**, Motel
**118 MB**, container 691 MiB, 6.7 GB available. Estimate after the split: product 250–350 MB (PGlite
wasm, product isolate) and apps 250–400 MB (esbuild wasm, up to `EXECUTOR_APP_WORKERS`=64 warm
loader isolates, `app-worker-residency.ts:26`). The extra process adds roughly 50–100 MB net, which is fine. Residency is per process. A restart drops every
warm worker, so cold loads then come back through `callbacks.load` to the product. Pass the `memory=(…)` block
(`pr.ts:247-257`) to both configs. `pressureThresholdMb` is container-wide (cgroup working set,
`main.go:39-49`), so both processes GC under pressure. ltc's container has **no cgroup limit**, so
the threshold is 0 and pressure GC is off there. Set `mem_limit` (e.g. 4g) in compose.

## 6. Stored-write-loss semantics

With `localDisk` + `enableSql`, DO storage is `ActorSqlite` in WAL mode (`server.c++:1287-1310`).
`neverFlush` (`server.c++:3349-3351`) applies only to the in-memory fallback with no `actorStorage`
(`server.c++:1311-1315`), so it does not apply here. SIGKILL keeps every committed transaction: the WAL is in the
OS page cache, and `synchronous` matters only for host crash or power loss. An implicit transaction that is open in
the spinning turn never commits and is lost. The output gate holds replies until commit, so no
caller saw success. Explicit transactions are all-or-nothing. `AppDataSupervisor` persists
`pending` + an alarm before writes, and `recover` bumps the revision and notifies subscribers after restart
(`cloudflare.ts:465-528`). **Authors should assume** at-least-once execution of steps and tool calls that
were interrupted, no partial transactions, and no rollback of external side effects (HTTP sent before the kill).
Use idempotency keys.

## 7. Crash-loop handling

The engine's crash recovery appears to retry **without checking `retries.limit`**
(`context.ts:515-549`, then 575-664). A step that spins would re-spin after every restart, forever.

- **Step guard (no migration):** in `we.ts` `driver.do` (`:463`), read the `ctx.attempt` that the
  engine passes to the step closure (`context.ts:563-567`). If `attempt > (retries.limit ?? 0) + 1` or
  `attempt > 3`, throw `NonRetryableError("step did not finish in 3 attempts")` before calling `work`. The
  count is persisted before each attempt, so it survives the kill. The run finishes `errored` through `finish`.
- **Body guard:** a spin in workflow code outside a step replays on every restart. Count `prepare` calls
  per run in the product (`we.ts:443`, `workflows.ts` prepare). That needs an additive `starts` column on
  `workflowRuns`, which is an online-safe migration: add the column first and read it later. Terminate after 5 starts with no new completed step.
- **Tool-call quarantine:** the product keeps the set of in-flight `(app, build)` calls. On each app-process
  restart, which the product sees as a session break or as Go reporting through `NATIVE`, attribute it to that set. A build present in at least 3
  restarts within 15 min is quarantined in memory for 30 min. Calls to it then fail fast with
  `RuntimeProtocolFailed{reason:"hung"}`, and the dashboard shows it. Stage 2 can persist this.

## 8. Plan (≤5 days)

1. **Day 1–1.5:** `package-runtime.ts` emits `product.capnp` and `apps.capnp`; secret auth for APPS, HOST and SELF
   sockets; Go: named `supervise`, apps process, sockets, env flag, export skip.
2. **Day 2.5:** apps watchdog (Go), `/apps/stalled` native route, product deadline, and reason mapping in
   `binding-workerd-apps.ts`. Make sure `/changes` consumers resubscribe after `RuntimeProtocolFailed`.
3. **Day 3.5:** step attempt guard in `we.ts` and in-memory quarantine. The body `starts` column follows in a later release.
4. **Day 4–4.5:** tests.
   - New `docker-release-app-isolation.spec.ts`, modeled on `docker-release-watchdog.spec.ts`. While Spinner
     spins: `/health`, dashboard and MCP `search` answer, and Steady fails `disconnected` and then answers
     within 45 s. The container never restarts (check `RestartCount`). The spinning call gets a typed error.
   - A workflow whose step spins ends `errored` after 3 attempts. A mutation committed before the kill is not run twice.
   - Run the existing `docker-release-workflow-restart` and `docker-release-app-memory` specs.
   - Go tests: named `supervise` restart and backoff, apps watchdog kills only the apps process, product watchdog unchanged.
5. **Day 5:** release, then deploy to ltc. Watch RSS and logs for 24 h.

**Rollback:** set `EXECUTOR_APP_PROCESS=shared` (same image, same data dirs) or redeploy the previous image.
There is no schema change in stages 1–4.

**Risks:**

- A legitimate long synchronous CPU burst, such as esbuild compiling a large app in `AppApi.compile`, can trip the apps watchdog. Mitigation: 30 s threshold, and compile in the same process is accepted.
- Every restart drops all apps' in-flight calls, not only the spinner's.
- Restart herd: up to 64 cold loads.
- The `ctx.attempt` semantics in the patched engine need a test.
- `/changes` reconnect behavior.
- Extra memory with no cgroup limit on ltc.
