# Syncro reads

Deploy two files: `index.ts` as `index.ts`, and `deploy.package.json` as
`package.json`. The deploy manifest pins `apps` to `0.0.1-beta.35`, the newest
published release that speaks host protocol 8; later releases speak protocols
this host's build does not run, so their builds fail. The workspace
`package.json` uses `workspace:*` for repository typechecks and must not be sent
to a host.

Connect the `syncro` account slot using an API key with ticket/customer read
permissions and a lowercase subdomain such as `example` (not a complete URL).
The provider declares `*.syncromsp.com`, so app code only holds a sealed handle
for the key. Executor substitutes the real key for that handle only on requests
to a host matching the declaration: exactly one subdomain label of
`syncromsp.com`, on the scheme's default port. The matcher does not check the
scheme; requests use HTTPS because the app builds every URL as
`https://<subdomain>.syncromsp.com`. The app sends the key in the Bearer header,
does not follow redirects, and reports a 3xx as rejected. Any single-label host
under `syncromsp.com` matches, including non-tenant hosts such as `www`; the
app requires the subdomain to be one lowercase DNS label, but a mistyped
subdomain still receives the key. The hosts are recorded when an account is
connected, so connect only after this declaration is final.

The account check reads `GET /api/v1/me`. A 401 reports rejected credentials, a
403 forbidden, and 429 or 5xx an unavailable service. It reports no account
info, so no user name or email from `/me` is retained. `/me` needs no specific
permission, so a healthy check proves the key is accepted, not that it can read
tickets or customers; confirm that with a successful ticket and customer read.

Failed tool calls and checks report only a status; error bodies are not read.
Executor replaces echoed credentials with their handle in response headers, but
in bodies only for JSON or non-streaming text up to 1 MiB, so there is no such
guarantee for larger, streamed or binary responses.

The five tools expose no writes. Existing approved write tools stay on the
current app. This provider has its own definition; existing MCP account
selections do not automatically bind to it.

Search and comment tools return exactly one page with the provider's `meta`
and `nextPage`. Follow `nextPage` until it is null; never treat the first page
as a complete digest. Ticket pages hold 25 tickets. `searchTickets` accepts
`number`, the ticket number users cite (such as 4207), as Syncro's `number`
filter; it returns every match rather than failing on duplicates. Ticket lists are
not a complete comment source: use `ticketComments`, which calls the dedicated
comments endpoint. `getTicket` and `searchTickets` return Syncro's ticket objects
unchanged, which can include a `comments` array, so any ticket output may carry
internal notes according to the API account's permissions, not only
`ticketComments`.

Before switching ticket-watch or digest routines, compare the same ticket IDs,
filters, complete page sets and comment visibility against the current app.
Measure cold discovery separately from repeated tool execution from the same
host. Syncro's published API limit is 180 requests per minute per IP; pace
routine fan-out and stop on rate-limit errors rather than retrying blindly.
No live provider benchmark or routine migration has been performed.

API contract: https://api-docs.syncromsp.com/ and
https://api-docs.syncromsp.com/swagger.json (reviewed October 8, 2026).
