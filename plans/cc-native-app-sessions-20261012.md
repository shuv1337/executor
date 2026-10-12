# Isolated native app session contract

Approved scope: Executor CC proof only at localhost:4417. Production is unchanged.

A native client presents its API OAuth access token to POST the app's `/ui/launch` endpoint with its exact profile and an S256 challenge. The host checks live OAuth grant, organization, app-use and own-profile access. PATs and browser cookies cannot authorize this exchange. A 30-second, single-use ticket binds the exact app origin, user, profile, token hash and challenge. No persistent bearer is placed in a URL.

The WKWebView POSTs ticket and verifier to `/_executor/native/redeem` on the private app origin. Only this route permits an absent or null native Origin. It atomically consumes the ticket, validates the verifier, and sets a host-only HttpOnly SameSite=Lax cookie; response redirects to the fixed profile. Native app session lifetime is five minutes from launch, additionally bounded by its parent OAuth token and grant on every request. Revalidation uses the existing OAuth SQL validator from the stored token hash, never a copied dashboard cookie or stored raw bearer.

The session retains its launch-time tool policy and exact profile. Every request also checks current grant authority. Any policy edit ends existing app sessions; a fresh launch is required. UI operations must pass the saved tool policy and exact profile. Subscriptions repeat checks at delivery and heartbeat. The returned native entry URL retains `native=1`; entry and reload fail with HTTP 401 after expiry instead of starting dashboard login. Use a private WKWebsiteDataStore without dashboard cookies.

Launch returns an opaque session ID for POST `/ui/revoke`. The same live OAuth credential may revoke only its own launch/session ID. The revoke consumes the server session marker; all app HTTP and stream authority ends. Pending tickets also fail after revocation. CC records IDs against the device and calls this on device logout; clearing WK storage complements server revocation.

Proof: A/B notes authorship and scope, foreign profile/app/org, absent authorization/PAT rejection, incorrect PKCE, wrong-origin redemption, ticket replay/expiry, session revocation, parent grant revocation, and stream invalidation. No schema migration or production changes.

## Verification

The isolated host uses the fork baseline `712603a9ca0198b622e54612b97c6a95f00cccf1` and app framework `0.0.1-beta.82`. There are no schema migrations. Self-host wires the OAuth validator; Cloud retains its existing browser behavior and does not enable native redemption.

Named self-host E2E scenarios:

- `Native app sessions preserve scoped OAuth authority through PKCE, expiry and revocation`: real OAuth consent and narrowing, private app deployment, concurrent one-use redemption, wrong PKCE/origin/profile/tool, pending-ticket and active-session revocation, sibling-session independence, open subscription termination, real ticket expiry, grant narrowing and parent consent revocation.
- `private app bookmarks authenticate and execute through the hosted runtime`.
- `private app access revokes live sessions and supports complete DNS labels`.
- `API grants enforce exact tool selection and audience boundaries` guards unchanged API/MCP behavior in the reused OAuth validator.

Live CC binding checks use each user's own public connection and profile APIs. A personal account belongs to A; B cannot inspect it or select it in B's profile. B can change its own profile to an accessible shared account, as normal run authority permits, but CC's fixed allowlist rejects that shared account even with a forged parent label. Labels never confer identity. The original binding was restored and verified before notes writes.

The live HTTP proof also rejects the setup PAT on its own profile, an MCP-audience token, a foreign organization/app, and another user's session-revoke attempt. Credentials and transient cookies remain in protected local storage; evidence records only nonsecret identities, scopes, status codes and outcomes.

## Live acceptance handoff, October 12, 2026

Host implementation commit: `8b9a6b3b83ab599919b4efd9f29ffa60304d617b`, branch `shuv/cc-isolated-proof-20261012`, checkout `/Users/shuv/repos/executor-v2-cc-proof`. `bun run format`, `bun run check`, and the named scenarios above passed. No upstream PR, merge or production deployment was performed.

A separate live check kept an issued native session for its full five-minute lifetime: page 200 before expiry, 401 afterward with no redirect. Five concurrent redemptions produced exactly one 303 and four 401 responses. Nonsecret local evidence is in `.local/cc-proof/native-expiry-evidence.json`.

CC reported real UI acceptance against deployment `dpl_1b93925b-c7ac-4bd1-89f7-abf9d9c13c87`: the parent scoped browser created a note; the child native view read it and created its own; the parent browser read the exact child authorship. The nonpersistent child WK view marked the parent note read-only and created another note, whose exact body and Test child author were read back by the parent browser. These UI results are CC-owned evidence, not a claim that the host agent directly operated the device.

CC also reported 19 live lifecycle checks: authenticated A/B canvas sync and reconnect; child logout 204 followed by private host page 401 without redirect, native 401, canvas-cookie 401 and active socket closure; sibling A remained 200. Two real gateway restart checks retained canvas and native notes. Its scenario is `apps/phase0/scripts/prove-isolated-lifecycle.ts`, with protected nonsecret evidence under its `.local/isolated/` directory. CC retains ownership of the remaining parent WK spotcheck, outbox failure case and its own full checks/review.

Physical shuvphone installation and network acceptance are separate and incomplete. CC delivered a signed install link but reported the exact phone unavailable to CoreDevice. The phone network is only a proposal in `plans/cc-phone-network-20261012.md`; the existing localhost server remains available.

Current A/B runtime OAuth grants expire around 4:36 PM PDT October 12. The setup-only PAT expires October 13 around 3:31 PM PDT. Credentials are never included in this handoff. Explicit cleanup, after CC finishes using this proof: `node .local/cc-proof/revoke.mjs` revokes the known test grants and setup PAT; `python3 .local/cc-proof/stop.py` verifies the recorded isolated PID and working directory before stopping it. Neither cleanup command has been run. Synthetic storage is retained; deleting it is a separate explicit step.
