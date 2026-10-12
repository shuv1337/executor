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
