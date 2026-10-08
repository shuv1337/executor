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
for the key; Executor substitutes it on HTTPS requests to one subdomain label of
`syncromsp.com`, in the Bearer header. Redirects are refused. The hosts are
recorded when an account is connected, so connect only after this declaration
is final.

The account check reads `GET /api/v1/me`. A 401 reports rejected credentials, a
403 forbidden, and 429 or 5xx an unavailable service. It reports no account
info, so no user name or email from `/me` is retained.

The five tools expose no writes. Existing approved write tools stay on the
current app. This provider has its own definition; existing MCP account
selections do not automatically bind to it.

Search and comment tools return exactly one page with the provider's `meta`
and `nextPage`. Follow `nextPage` until it is null; never treat the first page
as a complete digest. Ticket pages hold 25 tickets. `searchTickets` accepts
`number`, the ticket number users cite (such as 4207), as Syncro's `number`
filter; it returns every match rather than failing on duplicates. Ticket lists do
not provide complete comments: use `ticketComments`, which calls the dedicated
comments endpoint. Comments may include internal notes according to the API
account's permissions.

Before switching ticket-watch or digest routines, compare the same ticket IDs,
filters, complete page sets and comment visibility against the current app.
Measure cold discovery separately from repeated tool execution from the same
host. Syncro's published API limit is 180 requests per minute per IP; pace
routine fan-out and stop on rate-limit errors rather than retrying blindly.
No live provider benchmark or routine migration has been performed.

API contract: https://api-docs.syncromsp.com/ and
https://api-docs.syncromsp.com/swagger.json (reviewed October 8, 2026).
