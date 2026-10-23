---
"@executor-js/mcp-auth": patch
"@executor-js/hosted-server": patch
---

A member can create a scoped MCP connection with the ID of one of their own revoked connections, so
the `/mcp?connection=<id>` URL agents were given keeps its address. This replaces the revoked record.
It does not restore it. Grants that name the ID are revoked again. Its OAuth resources are enabled,
and the new record's creation time becomes its generation. Connection keys minted before then, and
PAT grant IDs that carry an older generation, are refused at the URL and deleted. A grant stored
while its connection was revoked or replaced is revoked when it is created. Creating a live
connection again returns it unchanged only when the name and access match. A different body, or
another user's live or revoked ID, still fails with `ConnectionIdTaken`.
