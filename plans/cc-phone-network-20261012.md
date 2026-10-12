# CC physical-phone network proposal

Status: proposal only. Localhost proof stays online. Prepared October 12, 2026, 3:57 PM PDT.

## Decision

Approve a temporary, tailnet-only network path for the isolated CC proof, after identifying physical shuvphone. Keep signed installation and physical end-to-end acceptance separate.

The recommended topology uses two new HTTPS service names, provisionally `cc-gateway-proof.tail586a6d.ts.net` and `cc-notes-proof.tail586a6d.ts.net`, on port 443. Name availability must be checked before creation. A dedicated disposable Tailscale service-host process or VM owns only these services. It must not retag shuvbot, change its existing Serve endpoints, or touch production Executor.

Tailscale Services requires an administrator, a supported client and a tagged service host. Each service has its own DNS name; HTTPS Serve provisions its certificate. These are documented capabilities, not resources already provisioned: [Tailscale Services prerequisites and setup](https://tailscale.com/docs/features/tailscale-services).

## Exact boundaries

| Phone-facing origin                          | Local destination                                     | Allowed purpose                                                                                                                    |
| -------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `https://cc-gateway-proof.tail586a6d.ts.net` | Dedicated loopback ingress to CC gateway at port 8789 | Existing CC enrollment, authenticated native notes, canvas launch and socket routes; route inventory fixed with CC before exposure |
| `https://cc-notes-proof.tail586a6d.ts.net`   | Dedicated loopback ingress to Executor at port 4417   | Only the fixed private app document, assets, data/subscription routes and native ticket redemption                                 |

The ingress listeners accept only their exact Host values and approved route/method lists. Unknown Host, dashboard, OAuth, setup, management and unrelated app routes fail closed. Requests keep their original Host and Origin. Forwarding headers never select an app or principal. TLS ends at the dedicated service host; only loopback traffic continues to the local application.

A tailnet policy must allow only the verified phone and designated test workstation to these services on TCP 443. Existing broad rules must be evaluated too: adding a narrow allow rule does not override a broader allow. Verify an unrelated tailnet peer cannot connect before calling this restricted. No Funnel or public ingress.

## Minimal isolated host change

1. Add an optional configuration mapping the exact notes HTTPS origin to immutable organization `hTwb7tPn0Wu928TDCHQ9t8FxfYHSsqt9` and app `app_88a5c923-ec89-407f-a821-50094b400ce9`. Look up and verify those IDs on each target resolution; never infer identity from display labels or arbitrary host suffixes.
2. Keep the existing localhost app address and all existing localhost sessions working. Add an explicit launch/revoke destination selector restricted to configured aliases; omitted means the existing localhost destination. Discovery returns the configured HTTPS origin. No caller-supplied arbitrary redirect URL.
3. Bind each issued ticket and session to the selected exact origin as well as the current app, organization, actor, profile and scoped grant. Localhost tickets cannot redeem at the HTTPS alias and vice versa. Revocation uses the matching destination. Tests must prove both mismatches fail.
4. HTTPS alias cookies use `__Host-` naming, Secure, HttpOnly, Path=/ and no Domain. The private app has a distinct hostname from the gateway and all existing shuvbot tools. A different port alone does not isolate cookies.
5. Preserve PKCE, one-use 30-second tickets, five-minute sessions capped by parent grant, ongoing grant validation, fixed profile/tool scope and server-side device-session revocation. The only opaque-Origin exception remains the exact native redemption POST.

CC continues to call Executor over loopback with its limited per-member API OAuth tokens. Tokens remain audience-bound to the existing loopback API; they never go to the phone. The phone uses its CC device credential and receives only a short-lived PKCE ticket in a POST response. No credentials in URLs, notifications or request logs. No admin credential in runtime.

## Prerequisites and acceptance

- Match the physical device named shuvphone, UDID `00008150-001574C2026A401C`, to its Tailscale peer using direct device evidence. Currently no peer is named shuvphone; neither `iphone182` nor another reachable iOS peer is assumed to be it.
- Provision the dedicated service host and two services with narrowly scoped authorization. Supply any needed secret through a private secret-entry tool. Never change the primary host identity to satisfy the tagged-host prerequisite.
- Validate public TLS certificates on the phone without ATS exceptions, custom trust bypasses or Host/Origin rewriting.
- Check exact discovered origin and strict gateway/native allowlists. Confirm unrelated peer denial, dashboard denial and Host/Origin spoof denial.
- Repeat real phone native note creation, private WK note creation, authorship readback, cross-profile/tool denial, replay, expiry, logout/revocation and socket closure. A signed build, install link or health check does not satisfy these cases.
- Run named host E2E cases for alias routing and existing localhost browser/native behavior, then `bun run check`. Preserve the current source commit and data throughout.

## Lifetime and rollback

Use only the current synthetic organization and data. Current A/B OAuth grants expire around 4:36 PM PDT October 12; renewed proof grants must retain the same exact scope and have an explicit deadline. Do not extend them silently to keep a session alive.

At the agreed end of the physical proof, revoke test sessions/grants, stop the two dedicated ingress listeners, drain and remove only the two new service advertisements, remove their service/policy entries and deauthorize the disposable service host. Leave existing shuvbot Serve entries unchanged. The localhost server and synthetic data remain available until separate cleanup is agreed; no database copy or migration is required.

:::question
Proceed with this isolated phone-network implementation once the exact phone peer and dedicated service-host prerequisites are verified?

This adds two temporary private HTTPS endpoints and a narrowly configured app-origin alias. Localhost remains available and production is untouched. The alternative finishes the current Simulator/browser proof while leaving physical networking pending.

- [ ] Proceed with the restricted phone path
- [ ] Keep localhost only for now

Recommended: Proceed with the restricted phone path
:::
