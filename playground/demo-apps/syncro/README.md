# Syncro reads

Deploy `index.ts` with a package manifest that depends on the public `apps` SDK.
Connect the `syncro` account slot using an API key with ticket/customer read
permissions and a lowercase subdomain such as `example` (not a complete URL).
The account stores the key as a secret and sends it only in the Bearer header
of HTTPS requests to that subdomain. Redirects are refused.

The five tools expose no writes. Existing approved write tools stay on the
current app. This provider has its own definition; existing MCP account
selections do not automatically bind to it.

Search and comment tools return exactly one page with the provider's `meta`
and `nextPage`. Follow `nextPage` until it is null; never treat the first page
as a complete digest. Ticket lists do not provide complete comments: use
`ticketComments`, which calls the dedicated comments endpoint. Comments may
include internal notes according to the API account's permissions.

Before switching ticket-watch or digest routines, compare the same ticket IDs,
filters, complete page sets and comment visibility against the current app.
Measure cold discovery separately from repeated tool execution from the same
host. Syncro's published API limit is 180 requests per minute per IP; pace
routine fan-out and stop on rate-limit errors rather than retrying blindly.
No live provider benchmark or routine migration has been performed.

API contract: https://api-docs.syncromsp.com/ and
https://api-docs.syncromsp.com/swagger.json (reviewed October 8, 2026).
