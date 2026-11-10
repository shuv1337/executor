# Entra SSO for the Executor web UI

Status: plan only, 2026-11-10 PST. Nothing here has been built, configured or deployed.

Decision being planned (2026-11-10): Executor's web login must use Entra SSO and must not be
exposed publicly. `/mcp` and the other endpoints meant to be public stay public. The reason is
the M365 Admin UI: an Executor session will be able to trigger password resets in client tenants.

Scope: production `https://executor-v2.shuv.dev` (fork `shuv1337/executor`, branch `v2`, commit
`4f97fd998`), Docker Compose project `executor-v2` on `ltc-executor.exe.xyz`, behind a Cloudflare
tunnel. App pages are served from the same server at `<app>.shuv.app`. The identity provider is
the Latitudes Microsoft 365 tenant.

## Summary

- **Recommendation:** put Cloudflare Access, with Entra as its only identity provider, in front
  of both hostnames. Deny by default and bypass an explicit list of machine endpoints. This needs
  no code, no container change and no restart, and rolls back in seconds.
- **Then** turn on Executor's existing OIDC sign-in (`SSO_*` settings) so each Executor account
  is bound to one Entra identity and sign-in is one click. This has one known gap with Entra
  (`email_verified`, below) that must be closed in staging first.
- **Removing passwords** for people needs fork code and is a separate decision. With Access in
  front, a password is only reachable after Entra sign-in.
- Tailnet-only is not recommended: it does not give Entra sign-in and breaks OAuth for MCP clients.
- MCP clients, the CLI, webhooks and the agents' `executor-v2` entries are unaffected by the
  recommended design. They never touch a gated path except when a person authorizes a new client
  or approves a call in a browser.

## What exists today

Read from the code at `4f97fd998` and from unauthenticated requests to production on
2026-11-10. Items marked _inferred_ were not checked directly.

- **One server, two kinds of host.** `selfHostRouteMap` (`apps/hosted/self-host/src/implementation/routes.ts`)
  sends requests whose `Host` is an app address to the app routes and everything else to the
  product routes. Production sets `BETTER_AUTH_URL=https://executor-v2.shuv.dev`,
  `EXECUTOR_APP_UI_BASE_URL=https://shuv.app`, `EXECUTOR_APP_UI_HOST_FORMAT=flat` and
  `EXECUTOR_APP_UI_DEFAULT_ORGANIZATION=latitudes`, so Latitudes apps are `<app>.shuv.app` and
  other organizations' are `<app>--<org>.shuv.app`.
- **People sign in with a password.** Self-host enables email and password with sign-up disabled
  (`auth-options.ts`). There are no passkeys and no second factor. Accounts are created only by
  first-run setup or by an invitation (`registration.ts`). `/login` and
  `POST /api/auth/sign-in/email` are reachable by anyone today.
- **Every dashboard page except `/login` requires a session.** The root route redirects a
  signed-out visitor to `/login?redirect=…` before any HTML (`__root.tsx`, `requireSession`).
  Production confirms it: `/mcp/approve/x`, `/app-auth` and `/org/latitudes` all answer 307 to
  `/login`.
- **Sessions last 7 days and slide.** Better Auth defaults; the fork sets no shorter lifetime.
- **OIDC sign-in already exists but is off.** `SSO_DISCOVERY_URL`, `SSO_CLIENT_ID`,
  `SSO_CLIENT_SECRET` and `SSO_ALLOWED_DOMAINS` add a "Continue with SSO" button through Better
  Auth's generic OAuth plugin. Production answers `{"setup":false,"sso":false}` at
  `/api/auth/self-host/config`. It never creates an account or a membership: a person is
  invited, registers with a password, then connects SSO on Account > Security. Linking requires
  the provider's email to equal the account's email and to be asserted verified. Upstream has
  nothing more for self-host; SAML and per-team SSO exist only in Cloud.
- **Machines authenticate with bearer credentials.** `/mcp` and `/org/:organization/mcp` accept
  an OAuth access token (1 hour, refresh token 30 days) or an `exp_` API key. The API
  (`/api/...`) and Git (`/git/...`) accept the same for the CLI. Each request rechecks the
  caller's current organization membership (`bearer-access.ts`). Browser-only endpoints refuse
  any `Authorization` header (`requireUserLive`).
- **Bearer credentials come from a browser session.** An OAuth grant is approved on
  `/mcp/authorize` or `/device` by a signed-in person. API keys are created from the dashboard.
- **App pages never serve anonymous visitors.** A navigation without an app session is sent to
  the dashboard's `/app-auth`; any other anonymous request gets 403 (`app-ui.ts`). An app session
  is derived from the dashboard session and ends with it.
- **The tunnel is the only public path.** The server publishes `127.0.0.1:4400`. The tunnel runs
  from a token, so its hostnames are configured in Cloudflare, not on the VM (_inferred_).
  `https://ltc-executor.exe.xyz/` redirects to exe.dev's own login. A Cloudflare Zero Trust
  organization appears to exist: `/cdn-cgi/access/certs` answers with keys (_inferred_).

## 1. Route inventory

Classes: **(a)** stays public, **(b)** goes behind Entra SSO, **(c)** needs a decision.

### Dashboard host `executor-v2.shuv.dev`

| Path                                                                                                                                                                   | Who calls it                                            | Auth today                                                                              | Class                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------- |
| `/mcp`, `/org/:organization/mcp` (any method, `?elicitation_mode=`)                                                                                                    | MCP clients                                             | Bearer; 401 with a challenge otherwise                                                  | (a)                                      |
| `/.well-known/oauth-protected-resource`, `…/mcp`, `…/api`; `/.well-known/oauth-authorization-server`, `…/api/auth`                                                     | MCP clients, CLI                                        | None; metadata                                                                          | (a)                                      |
| `/api/auth/oauth2/register`, `token`, `revoke`, `introspect`, `device-authorization`                                                                                   | MCP clients, CLI                                        | Client authentication, PKCE, device code                                                | (a)                                      |
| `/api/auth/oauth2/authorize`, `consent`, `continue` and client management                                                                                              | The person's browser during client sign-in              | Session cookie; without one, `authorize` redirects to `/mcp/authorize`                  | (a), because the page it lands on is (b) |
| `/api` (challenge), `/api/context`, `/api/organizations/**`, `/api/viewer`, `/api/catalog`, `/api/dashboard/batch`, `/api/telemetry/*`                                 | Dashboard requests, CLI, agents                         | Session cookie or bearer, per endpoint                                                  | (a); see the note below                  |
| `/api/mcp/approvals/:requestId`                                                                                                                                        | The approval page                                       | Session cookie only; refuses `Authorization` and cross-site requests                    | (a) by path; needs a (b) session         |
| `/api/oauth/callback`, `/api/oauth/callback/resolve`                                                                                                                   | The person's browser returning from a connected account | Session cookie                                                                          | (a) by path; needs a (b) session         |
| `/api/webhooks/:appId/:subscriptionId`                                                                                                                                 | Third parties (Graph, Syncro, GitHub…)                  | The app's signature check                                                               | (a)                                      |
| `/git/:owner/:repo/**`                                                                                                                                                 | CLI (`apps commit`, `apps deploy`)                      | Bearer                                                                                  | (a)                                      |
| `/health`                                                                                                                                                              | Deploy checks, monitors                                 | None                                                                                    | (a)                                      |
| `/login`                                                                                                                                                               | People                                                  | None                                                                                    | (b)                                      |
| `/`, `/org/**`, `/account/**`                                                                                                                                          | People                                                  | Session                                                                                 | (b)                                      |
| `/mcp/authorize` (sign-in and consent for a new MCP or CLI client)                                                                                                     | People                                                  | Session                                                                                 | (b)                                      |
| `/mcp/approve/:requestId`                                                                                                                                              | People opening an approval link                         | Session, and the session's user must hold the grant                                     | (b)                                      |
| `/org/:slug/apps/:app/approve/:requestId`, `/org/:slug/approvals`, `…/:runId`                                                                                          | People                                                  | Session                                                                                 | (b)                                      |
| `/device` (CLI device sign-in), `/invite`, `/app-auth`, `/oauth/callback`                                                                                              | People                                                  | Session                                                                                 | (b)                                      |
| `/api/auth/**` other than `oauth2`: `sign-in/*`, `self-host/*`, `callback/*`, `get-session`, `sign-out`, `organization/*`, `admin/*`, `api-key/*`, `device/*`, `mcp/*` | The dashboard                                           | Session, except `sign-in/*` and `self-host/config`, `setup`, `register`, which are open | (b)                                      |
| `/assets/*`, `/favicon.png`                                                                                                                                            | The dashboard                                           | None                                                                                    | (b), by default                          |
| `/openapi.json`                                                                                                                                                        | Nothing external found in the CLI or SDK                | None                                                                                    | (c); recommend (b)                       |
| `/.well-known/agent-skills/*`                                                                                                                                          | Agents installing the authoring skill                   | None; the built-in authoring docs                                                       | (c); recommend (a)                       |
| `/oauth/client-metadata.json`                                                                                                                                          | Other authorization servers                             | 404 today (`EXECUTOR_OAUTH_CLIENT_METADATA_URL` unset)                                  | (a) if ever enabled                      |

Note on `/api/**`. The same endpoints serve the dashboard with a cookie and the CLI and agents
with a bearer, so they cannot be split by path. They stay public at the edge. That is safe
because a session cookie can only be obtained through class (b) paths, and browser-only
endpoints refuse bearers. The residual is in "Risks that remain".

### App hosts `<app>.shuv.app`, `<app>--<org>.shuv.app`

| Path                                                                                              | Auth today                                                          | Class              |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------ |
| Any page; `/_executor/assets/**`; `/_executor/version`; `/_executor/api/**`; the sign-in callback | App session cookie, minted only through the dashboard's `/app-auth` | (c); recommend (b) |
| `/api/*`, `/mcp/*`, `/.well-known/*`                                                              | 404                                                                 | —                  |

No app page is meant for people outside the organization: the framework cannot serve one. The
M365 Admin UI will be one of these hosts, which is why they should be gated too.

### Approval links: the confirmed flow

1. A tool call that needs a person returns
   `https://executor-v2.shuv.dev/mcp/approve/<requestId>?sessionId=…&grant=<sealed reference>`
   (`mcp-http.ts`).
2. The page is a dashboard route. Signed out, the server redirects to `/login?redirect=…` and
   returns after sign-in.
3. The page reads and answers `/api/mcp/approvals/<requestId>` with the session cookie. The
   server refuses an `Authorization` header, refuses cross-site requests, opens the sealed
   grant, and checks that the signed-in user holds it (`mcp-approvals.ts`). The approver recorded
   is the signed-in person.

So an approval link already needs a browser session of the grant's owner, and a bearer cannot
answer it. Gating `/mcp/approve/*` and `/login` makes that session an Entra-backed one. On a
phone the technician signs in to Entra in the phone's browser; links opened inside a chat app's
built-in browser will ask again, because that browser keeps its own cookies.

Not every approval is a link. The MCP URL chooses the mode: `model` (the default), `native` or
`browser`. A tool that requires a person refuses a `model` or `client` answer, but accepts a
`native` one, which the MCP client collects in its own UI with no Entra session
(`packages/mcp/src/implementation/executions.ts`). See "Risks that remain".

## 2. Options

### A. Executor's own OIDC sign-in, with Entra

Set the four `SSO_*` variables and restart the server. No code is needed to turn it on.

- **Mapping.** No automatic provisioning. A person is invited to an organization, registers with
  a password, then connects SSO once. Entra's `sub` is linked to that account; organization
  membership, role and groups stay managed in Executor.
- **Known gap.** Connecting SSO requires the provider to assert `email_verified`, in the ID
  token or at UserInfo. Entra workforce tenants do not send that claim, and Better Auth's own
  Entra provider works around it with Entra's `verified_primary_email` claims. Executor's generic
  path does not. Unfixed, "Connect SSO" is refused for every account, so nobody can sign in
  with it. This is from reading the code and Microsoft's claim list; confirm it in staging.
  Three ways to close it, to try in this order:
  1. An Entra claims customization that emits `email_verified`.
  2. Cloudflare Access as the OIDC provider for Executor (Access for SaaS), with Entra behind it,
     if its ID token carries `email_verified` or can map one.
  3. A small fork change in `auth-options.ts` that trusts the configured provider for linking
     or maps Entra's verification claims, with a scenario in `self-host-sso.spec.ts`.
- **Does not meet the decision alone.** `/login` and the password endpoint stay public, and the
  password still works. Making it SSO-only needs fork code: a setting that refuses password
  sign-in, and invitation acceptance through SSO.

### B. Cloudflare Access in front of the tunnel, with Entra

Access checks every request at Cloudflare's edge before it reaches the tunnel. One application
covers the hostname and denies by default; more specific paths bypass it.

- Entra's MFA and Conditional Access apply before the login page can be seen.
- No code, no VM or container change, no restart. The tunnel container, which Compose cannot
  currently recreate, is not touched.
- Executor's own sign-in still runs behind it, so on its own this is two sign-ins.

### C. Tailnet-only UI

Serve the UI only over Tailscale and keep the machine endpoints on the tunnel.

- Executor has one origin for the UI, the OAuth issuer and the MCP resource. OAuth for a new MCP
  client opens `https://executor-v2.shuv.dev/api/auth/oauth2/authorize` in the person's browser,
  so the same hostname would have to resolve differently on and off the tailnet, with a
  certificate for it on the VM.
- Every technician device, phones included, would need to join the tailnet.
- It is network reachability, not Entra sign-in. The password would still be the only
  authentication.

### Comparison

|                                  | A. Native OIDC                                      | B. Cloudflare Access                                                   | C. Tailnet-only                             |
| -------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------- |
| Login not publicly exposed       | No                                                  | Yes                                                                    | Yes                                         |
| Entra MFA and Conditional Access | Only for people who choose SSO                      | Yes, for every browser session                                         | No                                          |
| Executor account bound to Entra  | Yes, once linked                                    | No; Access proves "an allowed person", the password says which account | No                                          |
| Effort                           | Config and a restart, plus the `email_verified` fix | Config only                                                            | DNS, certificates, a client on every device |
| MCP clients (Claude, Codex, pi…) | Unchanged                                           | Unchanged, if the bypass list is right                                 | New client sign-in breaks off the tailnet   |
| If Entra is down                 | Password still works                                | UI unreachable; machine endpoints keep working; needs break-glass      | Unaffected                                  |
| Passwords                        | Remain unless the fork is changed                   | Remain, reachable only after Entra                                     | Remain, the only authentication             |
| Fork divergence                  | None to enable; code to enforce                     | None                                                                   | None in code, large in operations           |
| Main risk                        | Does not hide the login                             | A wrong path rule locks out a client or exposes a page                 | Split-horizon DNS on the OAuth issuer       |

## 3. Recommendation and rollout

Do B, then A behind it. B meets the decision by itself. A adds the binding between an Entra
identity and an Executor account and removes the second prompt.

Rough effort, as estimates: Phases 0 and 1 are about a day of agent work and an hour of yours.
Phase 2 is about half a day plus one short production restart, more if the `email_verified`
gap needs the fork change.

### Access rule set

One gated application, so one cookie covers every gated path on the host. Dashboard pages call
`/api/auth/*` in the background; if those were a second application the calls would be
redirected to sign-in and fail.

| Application              | Destinations                                                                                                  | Policy                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Executor web (gated)     | `executor-v2.shuv.dev`; `executor-v2.shuv.dev/mcp/*`; `executor-v2.shuv.dev/api/auth`                         | Allow: the Entra group; Entra only       |
| Executor public (bypass) | `executor-v2.shuv.dev/mcp`; `…/org/*/mcp`; `…/.well-known`; `…/api`; `…/git`; `…/health`; `…/api/auth/oauth2` | Bypass: everyone                         |
| Executor apps (gated)    | `*.shuv.app`                                                                                                  | Allow: the Entra group; Entra only       |
| M365 Admin app (gated)   | That app's exact hostname, once it exists                                                                     | Allow: a narrower group, shorter session |

Access applies the most specific matching path, with no inheritance from a less specific one.
So `/mcp` is bypassed while `/mcp/approve/…` and `/mcp/authorize` are gated, and `/api/auth/…` is
gated while `/api/auth/oauth2/…` and the rest of `/api/…` are bypassed. Split the bypass list
over two applications if the per-application destination limit requires it. Turn on instant
authentication so people go straight to Entra, and leave the cookie path attribute off.

MFA strength belongs in an Entra Conditional Access policy that targets the Access app
registration. Phishing-resistant methods are the right bar for something that resets client
passwords.

### Phase 0: prerequisites and staging. No production change.

1. Entra: register a single-tenant app for Cloudflare Access with redirect URI
   `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`. Add the delegated Graph
   permissions Cloudflare documents (`openid`, `email`, `profile`, `offline_access`, `User.Read`,
   `Directory.Read.All`, `GroupMember.Read.All`) and grant admin consent. Choose or create the
   security group. Add the Conditional Access policy.
2. Cloudflare Zero Trust: add Entra as an identity provider with group support and test it.
3. Staging: run a throwaway self-host from `4f97fd998` on `shuvdev`, not on the production VM,
   with its own data and its own tunnel hostname, for example `executor-sso-test.shuv.dev`.
   Apply the same rule set to that hostname.
4. Run the verification matrix (appendix) against staging, with real clients: a fresh OAuth
   sign-in from Claude Code, Codex and pi; an API-key bearer; CLI device sign-in; an approval
   link; an invitation.
5. Settle the points this plan could not verify: path precedence for `/mcp` against `/mcp/*`;
   that dashboard background calls to `/api/auth/*` pass with the one cookie; what an open page
   does when the Access session expires.

### Phase 1: production cutover to Access

1. Record the current answers of the matrix against production as a baseline.
2. Create the bypass application. It changes nothing while nothing is gated.
3. At a quiet time, create the gated application for `executor-v2.shuv.dev`.
4. Run the matrix at once. Then check the agents' path as the deploy notes do: MCP
   `executor.context.get`, Mesh `broker_health`, and `executor-v2 apps list` from `shuvdev`.
5. Sign in through Entra, then with the Executor password. Open an approval link.
6. End browser sessions created before the cutover, so every live session was made after an
   Entra sign-in. Each person can do this on Account > Security.
7. Gate one app hostname, check an app page end to end, then gate `*.shuv.app`. Before the
   wildcard, list the DNS records in `shuv.app` so nothing unrelated is caught.

### Phase 2: bind accounts to Entra

1. Register a second single-tenant Entra app for Executor with redirect URI
   `https://executor-v2.shuv.dev/api/auth/callback/sso`. Use the tenant-ID discovery URL,
   `https://login.microsoftonline.com/<tenant-id>/v2.0/.well-known/openid-configuration`, not
   `common`: Executor reads discovery once at startup, refuses redirects, and verifies the issuer.
2. Close the `email_verified` gap in staging and prove a link and a sign-in there.
3. Put the four `SSO_*` values in the VM's Compose override and recreate only the server with
   the established command. This is a production restart and needs its own authorization. If
   discovery fails at startup, SSO stays off until the next restart and passwords still work.
4. Each person signs in with their password once and connects SSO on Account > Security. Their
   Executor email must equal their Entra email.

### Phase 3, optional: no passwords for people

Fork code: a setting that refuses password sign-in, invitation acceptance through SSO, and
scenarios for both. It is a few days of work and permanent divergence from upstream. It is only
needed if "an allowed Entra user who knows another account's password" is a risk worth closing.
Not planned until asked for.

### What only the user can do

- Entra: grant admin consent for the Access app registration; create or name the group; add the
  Conditional Access policy; later, register the Executor app and its claims.
- Cloudflare: add the identity provider in the Zero Trust dashboard, or issue an API token with
  the Access scopes so an agent can script the applications and policies. None was found in this
  shell's environment, 1Password was not searched, and Wrangler's sign-in does not cover Access.
- Answer the open questions below.
- Authorize the Phase 2 restart.
- Sign in during tests; each technician connects SSO once in Phase 2.
- Keep the break-glass items in 1Password.

An agent can do the rest: staging, the matrix script, scripted Access configuration given a
token, verification, the runbook, and the Phase 2 change once authorized.

### Break-glass

Machine endpoints do not depend on Entra: agents, existing MCP grants, the CLI and webhooks keep
working through an Entra outage. Only browser work stops: the UI, new client sign-ins, approvals.

- Keep no standing second identity provider. A one-time-PIN login would be a permanent way
  around Entra.
- Runbook: in the Cloudflare dashboard, add a temporary Bypass policy limited to one source IP,
  sign in with the owner's Executor password, and remove the policy afterward.
- This requires the Cloudflare account not to depend on Entra and to have its own strong MFA,
  and the owner's Executor password to stay in 1Password.
- Put the tenant's emergency-access accounts in the allowed group.
- SSH to the VM through exe.dev is separate from all of this and stays the path for server work.

### Rollback

- Phase 1: disable the gated applications. The effect is immediate and nothing on the VM
  changed. Leave the bypass application; it is inert.
- Phase 2: remove the `SSO_*` values and recreate the server. Linked identities stay in the
  database and do nothing; passwords were never removed.
- Neither phase touches data, so no snapshot restore is involved.

### Impact on the agents

- The harness entries (`~/.pi/agent/mcp.json`, `~/.claude.json`, `~/.codex/config.toml`,
  `~/.cursor/mcp.json`, shuvcode) all use `https://executor-v2.shuv.dev/mcp`, with OAuth or a
  bearer header. That path, token refresh at `/api/auth/oauth2/token`, and discovery under
  `/.well-known` are bypassed. No change is needed.
- `executor-v2` CLI: `/api/**` and `/git/**` are bypassed. API-key mode on `shuvdev` is
  unaffected. `apps login` opens a browser, which now passes Entra first.
- A new client sign-in, a re-consent after a revoked grant, and every approval link need a
  person with an Entra session. Agents cannot do these alone; they could not before either.
- App code calling the dashboard origin is dispatched inside the server and never reaches
  Cloudflare.
- Anything that shows an app page in an embedded browser or kiosk would need an Entra sign-in
  there (open question 6).

### Risks that remain

- **Bearer credentials outlive Entra.** A refresh token or API key keeps working after a person
  is disabled in Entra, until their Executor membership is removed. Removal takes effect on the
  next request. Offboarding must include it.
- **`/api/**` accepts a session cookie without an Access session.** A 7-day sliding Executor
  session keeps working for API calls after the Access session ends. Shortening it is a code
  change.
- **Default-deny blocks new public routes.** If an upstream sync adds a machine endpoint outside
  the bypass list, it fails until added. Add "diff `routes.ts`, rerun the matrix" to the upgrade
  runbook.
- **Password resets through tools.** A bearer with the right grant can call tools, and Access
  does not see those calls. Entra only stands behind a reset if the M365 Admin tool requires a
  person and the answer comes from the approval page or the dashboard. A `native` answer counts
  as a person and passes no Entra check. That is for the M365 Admin design to settle
  (open question 12).

## 4. Open questions

1. **Is Entra in front of the existing sign-in enough, or must the Executor account itself come
   from Entra?** Recommend Phases 1 and 2 now; Phase 3 only if you want passwords gone.
2. **Gate the app hosts?** Recommend yes, all of `*.shuv.app`, with a stricter policy on the
   M365 Admin hostname.
3. **Which Entra group may reach the UI?** Recommend a new security group for Executor users.
   Keep `ltc-tools-admin` as the Executor group that shares the M365 Admin app and accounts.
   They are not synchronized; mirror membership by hand, and add both to offboarding.
4. **Are there people on this instance outside the Latitudes tenant, in `latitudes` or another
   organization?** Access covers the whole instance. Recommend Entra B2B guests rather than a
   second identity provider.
5. **Do the Executor account emails equal the Entra emails?** Phase 2 linking requires it. If
   your own account uses a personal address, change it first.
6. **Does anything display an app page without a person at a browser,** such as the DC-1 tablet,
   a SHark in-app page or a kiosk? Recommend a per-hostname exception only where one is found.
7. **Is there a Cloudflare API token with Access scopes, in 1Password or elsewhere?** Recommend
   creating one, so the configuration is scripted, reviewable and exported.
8. **Access session length.** Recommend 12 hours for the dashboard and apps, shorter for the
   M365 Admin hostname.
9. **`/openapi.json` and `/.well-known/agent-skills/*`.** Recommend gating the first and leaving
   the second public; both hold only upstream's public documentation and API shape.
10. **Revoke existing API keys and MCP grants at cutover?** Recommend no blanket revocation, which
    would break every agent. Review the lists and revoke what is not recognized.
11. **Is the Cloudflare account's own login independent of Entra, with strong MFA?** Break-glass
    depends on it.
12. **Must a password reset always be approved in an Entra-backed browser?** Recommend yes: mark
    the reset tools as requiring a person, and connect agents that can reach them with
    `?elicitation_mode=browser`. Whether a tool can refuse `native` answers needs checking in
    the M365 Admin work; it is outside this plan.

## Appendix: verification matrix

Run without credentials unless noted. "Access" means a redirect to
`<team>.cloudflareaccess.com`; anything else is Executor's own answer and proves the bypass.

| Request                                                                                   | Expected after cutover                        | Today                            |
| ----------------------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------- |
| `GET /health`                                                                             | 200                                           | 200                              |
| `GET /mcp`, `POST /mcp`, `GET /mcp?elicitation_mode=browser`                              | 401 with a bearer challenge                   | 401                              |
| `GET /org/latitudes/mcp`                                                                  | 401                                           | 401                              |
| `GET /.well-known/oauth-protected-resource`, `…/mcp`, `…/api`                             | 200                                           | 200                              |
| `GET /.well-known/oauth-authorization-server`                                             | 200                                           | 200                              |
| `GET /api/auth/oauth2/authorize`                                                          | 302 from Executor                             | 302                              |
| `POST /api/auth/oauth2/register`, `POST /api/auth/oauth2/token`                           | Executor's OAuth answer                       | same                             |
| `GET /api`, `GET /api/viewer`, `GET /api/catalog`                                         | 401                                           | 401                              |
| `GET /git/x/y/info/refs`                                                                  | 401                                           | 401                              |
| `POST /api/webhooks/x/y`                                                                  | Executor's answer                             | same                             |
| `GET /login`, `GET /`, `GET /org/latitudes`                                               | Access                                        | 200 or 307 to `/login`           |
| `GET /mcp/approve/x`, `GET /mcp/authorize`, `GET /device`, `GET /invite`, `GET /app-auth` | Access                                        | 307                              |
| `GET /api/auth/self-host/config`, `GET /api/auth/get-session`                             | Access                                        | 200                              |
| `POST /api/auth/sign-in/email`                                                            | Access                                        | Executor's answer                |
| `GET /openapi.json`                                                                       | Access (if question 9 agrees)                 | 200                              |
| `GET https://<any>.shuv.app/`                                                             | Access                                        | 403 or a redirect to `/app-auth` |
| With a bearer: MCP `executor.context.get`; `executor-v2 apps list`                        | Succeeds                                      | Succeeds                         |
| Signed in through Entra: load the dashboard, wait, navigate                               | No sign-in prompt, no failed background calls | —                                |

## Sources

- Code at `4f97fd998`: `apps/hosted/self-host/src/implementation/{routes,auth-options,registration}.ts`,
  `apps/hosted/self-host/src/auth.ts`, `apps/hosted/self-host/web/src/implementation/routes/`,
  `apps/hosted/server/src/implementation/{auth,bearer-access,mcp-oauth,mcp-approvals,mcp-http,app-ui,app-sessions,api-keys}.ts`,
  `packages/mcp-auth/src/implementation/oauth.ts`, `e2e/tests/self-host-sso.spec.ts`.
- Better Auth 1.7.16: `oauth2/link-account.mjs`, `plugins/generic-oauth`, and the Entra provider
  in `@better-auth/core`.
- Production, unauthenticated requests on 2026-11-10; the non-secret settings in the saved
  Compose override; the deploy notes of 2026-11-10.
- Cloudflare One documentation for application paths, policies, the authorization cookie,
  session management and the Entra integration, read 2026-11-10.
