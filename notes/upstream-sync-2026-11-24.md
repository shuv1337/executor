# Upstream v2 sync — November 24, 2026

Fork base `cac34c7595f786a8f9a09c5d3eaee2f22ecb50d9`; upstream target
`e754f9d63067b2a144fd5406809ba90232453f75`; merge base
`56d893c24d60e76bc532400c8cfaefc8f70fa41d`. Upstream was fetched by URL,
without adding a remote, and joined as the merge's second parent.

## Conflict ledger

| #   | Path                                                                            | Resolution                                                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `apps/hosted/self-host/compose.yaml`                                            | Retained fork feedback, trusted proxy, app origins, telemetry volume and organization-only registry. Added MCP client bounds and the update-check opt-out.                                                                                                                                                         |
| 2   | `apps/hosted/self-host/native/main.go`                                          | Kept config substitution, trusted forwarding, both watchdogs, signal handling and bounded shutdown. Attached upstream life signs to the existing proxy transport, armed the stall monitor after readiness, stripped public probe headers, and sent restart reports through shutdown of both Workers.               |
| 3   | `apps/hosted/self-host/src/implementation/executor-services.ts`                 | Retained organization publishers and the obsolete public-registry setting warning. Took the npm-registry reader, optional startup catalog rebuild and self-host lifecycle settings. The Bun and packaged adapters both supply `readRegistry` via their host objects.                                               |
| 4   | `apps/hosted/self-host/src/implementation/registration.ts`                      | Kept invitations bound to their actual organization and added the live inviter check and setup/register rate limits.                                                                                                                                                                                               |
| 5   | `apps/hosted/self-host/src/mcp.ts`                                              | Made the upstream LRU use the fork's per-caller stores, step limit and idle configuration. Parked or in-flight work owns its handler. Idle expiry and restart retain session records; capacity eviction discards only the evicted caller's protocol sessions. Browser approvals still use the sealed grant issuer. |
| 6   | `apps/hosted/self-host/src/worker.ts`                                           | Combined MCP metadata storage, response lifetime tracking, update records and internal-only host probe suppression.                                                                                                                                                                                                |
| 7   | `apps/hosted/self-host/web/src/implementation/routes/org.$organizationSlug.tsx` | Kept the upstream update notice and passed the server-derived root-owner creation capability into the shell.                                                                                                                                                                                                       |
| 8   | `apps/hosted/server/src/contracts/api-keys.ts`                                  | Retained both metadata flags and managed-key helpers. Public key creation accepts organization metadata only.                                                                                                                                                                                                      |
| 9   | `apps/hosted/server/src/implementation/accounts.ts`                             | Kept committed security audits on credential submission and OAuth flows; validated Executor keys on submission and mapped `ConnectionKeyRefused` to a token refusal.                                                                                                                                               |
| 10  | `apps/hosted/server/src/implementation/bearer-access.ts`                        | Kept connection and generation checks, email provenance and connection-key refusals. Plain PAT URLs now use upstream's `automatic`; API-key revocations still carry the key credential marker used for renewal.                                                                                                    |
| 11  | `apps/hosted/server/src/implementation/mcp-http.ts`                             | Added `bundleSkills` to the request backend. Both initial auth and live rechecks preserve the explicit approval mode and connection; rechecks pin the original organization by ID. Kept scoped account/search and sealed approval links.                                                                           |
| 12  | `apps/hosted/server/src/implementation/mcp.ts`                                  | Kept verified caller, scoped accounts, caller-visible apps, kept search and app-link checks. Added skill bundles and request client metadata for attribution only. Stateless callers have no issued session ID.                                                                                                    |
| 13  | `apps/hosted/server/src/implementation/organization-defaults.ts`                | Used the shared managed-key eligibility check for onboarding without losing regular members.                                                                                                                                                                                                                       |
| 14  | `packages/apps/package.json`                                                    | Set the fork version to `0.0.1-beta.143.shuv.1`. Regenerated live protocol 14; earlier protocols were unchanged.                                                                                                                                                                                                   |
| 15  | `packages/app-templates/src/implementation/executor-skill-digests.gen.ts`       | Regenerated from the merged skill sources.                                                                                                                                                                                                                                                                         |
| 16  | `packages/sdk/src/contracts/executor.ts`                                        | Kept both typed app/version errors, the `searchableKept` and `deployReplacing` exclusions, secret rejection, revocation budget and skill catalog options.                                                                                                                                                          |
| 17  | `packages/sdk/src/implementation/app-runner.ts`                                 | Kept caller and approver data, connection-bound outbound and upstream per-call outbound grouping and resend tracking.                                                                                                                                                                                              |
| 18  | `packages/sdk/src/implementation/oauth.ts`                                      | Combined generic app-link refusals with upstream locked-account, credential rejection and deadline-aware revocation.                                                                                                                                                                                               |
| 19  | `packages/sdk/src/implementation/tools.ts`                                      | Kept verified callers and scoped/shared runtimes, requester/approver separation and kept search. Both call and resume now distinguish declared reads in failure reporting; credential rejection still flows to renewal.                                                                                            |
| 20  | `packages/sdk/src/implementation/workerd-client.ts`                             | Kept guarded workflow start, per-app shared notification streams and caller binding. Added registry reads, compiler outage handling and unanswered results.                                                                                                                                                        |
| 21  | `packages/sdk/src/workerd.ts`                                                   | Combined network failure, registry, runner and outbound group exports.                                                                                                                                                                                                                                             |
| 22  | `patches/better-auth@1.7.20.patch`                                              | Combined the fork's purpose-key exports and upstream's invitation cancellation; retained the unified diff's no-newline marker.                                                                                                                                                                                     |
| 23  | `bun.lock`                                                                      | Kept fork Playwright and codemode pins/patches and root inspection; took upstream MCP client, workerd, Effect, Better Auth, Alchemy and static-check inputs. Bun refreshed the lock.                                                                                                                               |
| 24  | `scripts/e2e-npm-packages.ts`                                                   | Took upstream retry and `--only`; kept beta.35 and the upstream additions (88, 100, 140). The merged fixture lock already has all 17 roots.                                                                                                                                                                        |
| 25  | `e2e/README.md`                                                                 | Kept native self-host authentication and organization registry notes, and added upstream snapshot guidance.                                                                                                                                                                                                        |
| 26  | `e2e/support/cloud-environment.ts`                                              | Kept the scoped OAuth proxy file and upstream release notes and removal budget settings.                                                                                                                                                                                                                           |
| 27  | `e2e/support/docker-release-server.ts`                                          | Unified default options, restart policy and full tracing with upstream container, readiness, logs and root-exec helpers.                                                                                                                                                                                           |
| 28  | `e2e/tests/pat-mcp.spec.ts`                                                     | Retained the self-host cleanup guard and opaque `requestId` schema checks, explicitly selected model where required, and accepted the automatic behavior at the plain URL.                                                                                                                                         |

## Silent overlaps and security follow-up

- `managed-key-eligibility.ts`: all three membership roles are eligible; an absent membership is
  not. The renewal scenario checks an admin downgraded to member and then removed.
- Native host: renamed the fork probe to `watchdogHealthProbe` and set the private probe header.
  Go vet also found duplicate `stallGrace`; shutdown now uses the upstream constant.
- Organization shell: the update notice doesn't replace `organizationCreationAtom`; creation
  remains a root-owner capability.
- PAT spec audit: parked batches and caller-identity review explicitly select `model`. Step-budget
  calls and connection-key discovery don't expect a pause; OAuth grants retain their own modes.
  Managed-key and Executor account cases cover member eligibility.
- Shared-code audit: kept app-link checks and committed audits alongside `secretsRejected`; browser
  approval addressing alongside `McpServer.skillCatalog`; outbound grouping alongside verified
  connection binding; and feedback alongside update routing and browser sampling suppression.
- Dynamic skill evaluation forwards the verified connection to the runner even though it does not
  expose it to app code. Declaration cache keys distinguish scoped skill catalogs. The scoped MCP
  scenario reads from a synthetic publisher, checking the bound outbound and that scoped listings
  do not reuse the unscoped catalog.
- Fork CI selects skills scenarios by **Skills extension**, which actually occurs in upstream
  titles, and adds both new isolation cases, the client bound cases and the plain-PAT person check.
  Removed the stale **App dependency registry** alternative (a suite name, not a scenario title);
  the registry case is still selected by its private-fetch title.
- The upstream selection helper now requires a CI path for every scheduled scenario. Added the
  fork's existing OAuth-proxy refusal scenario to the selection table's managed Cloud edge job;
  no Cloud workflow was added to the fork.

## Invariants and handoff

No database schema migration or required secret, port, firewall or Access change. The update
check skips commit builds and otherwise uses the configured npm registry. Organization publishing,
scoped connection anti-widening, person-only approvals, MCP parking, feedback, trusted forwarding,
and search kept-order remain fork requirements.

For release, the private registry must have `apps@0.0.1-beta.143.shuv.1`. An API key at the plain
MCP URL accepts client-approvable tools automatically. Use `?elicitation_mode=model` for a
model-mediated pause; automatic mode still pauses for a person when the tool requires one.
This sync does not publish, merge the PR or deploy.

Rat-stack references: `ratstack://skills/security-audit` (source-first trust boundary),
`ratstack://lore/concurrent-work-needs-an-owner` (bounded client scopes), and
`ratstack://skills/investigate-a-failure` (rebuild and verify failures at their source).
