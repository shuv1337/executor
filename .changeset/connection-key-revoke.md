---
"@executor-js/hosted-server": patch
"@executor-js/hosted-web": patch
"@executor-js/hosted-cloud": patch
"@executor-js/ui": patch
"@executor-js/app-templates": patch
---

A scoped connection's owner can list its connection keys and revoke one at a time, so a seat's key
can be rotated without revoking the connection. `GET .../mcp-connections/<id>/keys` lists each
key's name, first characters, creation, expiry and last use, never the secret, and
`POST .../mcp-connections/<id>/keys/<key>/revoke` deletes one key: it is refused at once while the
connection and its other keys keep working. Both follow the minting rules, and every revocation is
in the audit log. The connection's dashboard page lists its keys with a Revoke button for each.
