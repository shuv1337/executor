# Executor pilot walkthrough

This is the practical guide for **actually using the current executor pilot on shuvbot**.

At a high level:

- **the web UI** is where you connect sources, manage secrets, and inspect tools
- **the CLI** is where you run TypeScript against the shared tool catalog
- **the MCP endpoint** is for other MCP-capable hosts/agents that want to drive executor remotely

This pilot is currently a **shared, trusted-LAN deployment**. It is useful now, but it is **not hardened for internet exposure**.

---

## 0. What is running right now?

Current pilot values:

```bash
export EXECUTOR_HOME="$HOME/.local/share/executor-pilot"
export EXEC="$HOME/repos/executor/apps/executor/bin/executor"
export EXECUTOR_BASE_URL="http://10.0.2.110:8788"
```

Notes:

- `EXECUTOR_BASE_URL` is the current shuvbot LAN URL
- if shuvbot's IP changes, update that value
- the pilot state lives under `~/.local/share/executor-pilot`

Useful paths:

```bash
$EXECUTOR_HOME/data/control-plane
$EXECUTOR_HOME/run/server.pid
$EXECUTOR_HOME/run/server.log
```

---

## 1. Mental model: how to use executor correctly

The most important thing to understand is that **executor is not the agent itself**.

Instead, it is a **tool runtime / control plane** that an agent or human-driven script can use.

Typical flow:

1. Start the executor daemon on `shuvbot`
2. Open the UI and connect a source
3. Use `executor call` to run TypeScript against the shared tool catalog
4. If auth or approval is needed, let executor pause, complete the interaction, then resume

The normal code pattern is:

```ts
const matches = await tools.discover({ query: "<intent>", limit: 10 });
const path = matches.bestPath;
const detail = await tools.describe.tool({ path, includeSchemas: true });
return { path, detail };
```

Then, once you know the path/schema, actually call the tool:

```ts
return await tools.some_namespace.some_tool({ ...input });
```

Important rule:

- use `tools.*`
- do **not** use raw `fetch`

---

## 2. Starting and stopping the pilot

### Start it on shuvbot

Run these **on shuvbot**:

```bash
export EXECUTOR_HOME="$HOME/.local/share/executor-pilot"
export EXEC="$HOME/repos/executor/apps/executor/bin/executor"
export EXECUTOR_BASE_URL="http://10.0.2.110:8788"

$EXEC up --base-url "$EXECUTOR_BASE_URL"
```

That will ensure the daemon is running in the background and bound to the LAN URL.

### Check health

```bash
$EXEC status --json --base-url "$EXECUTOR_BASE_URL"
$EXEC doctor --json --base-url "$EXECUTOR_BASE_URL"
```

### Stop it

```bash
$EXEC down --base-url "$EXECUTOR_BASE_URL"
```

### Foreground debugging mode

If you want to run the server in the foreground for debugging:

```bash
$EXEC server start --base-url "$EXECUTOR_BASE_URL" --host 10.0.2.110 --port 8788
```

---

## 3. Using it from shuvdev or another trusted LAN machine

### Browser access

From `shuvdev`, open:

```text
http://10.0.2.110:8788/
```

Useful routes:

- `/` — source list / main UI
- `/sources/add` — add a new source
- `/secrets` — manage secrets
- `/v1/local/installation` — quick sanity-check API endpoint
- `/mcp` — executor MCP endpoint for MCP clients

### CLI access from another machine

If you have an `executor` CLI available on another trusted machine, point it at the shared base URL:

```bash
executor status --json --base-url "http://10.0.2.110:8788"
```

Important caveat:

- **server lifecycle commands should be treated as shuvbot operations**
- remote clients should assume shuvbot already owns the daemon
- use remote `status`, `doctor`, `call`, and `resume` against the shared base URL

---

## 4. The UI: what it is actually for

Use the web UI for these jobs:

### Add a source

Go to:

```text
http://10.0.2.110:8788/sources/add
```

Then:

1. paste the MCP/OpenAPI/GraphQL endpoint
2. let executor probe it
3. review inferred kind/auth/transport
4. connect it
5. if prompted, complete credential or OAuth setup

### Manage secrets

Go to:

```text
http://10.0.2.110:8788/secrets
```

Use this for API keys and reusable secret material.

For authenticated sources, the UI is currently the easiest path, especially when the source needs:

- API-key headers
- bearer tokens
- OAuth browser flows

### Inspect tools

After connecting a source, click into it and inspect:

- namespaces
- tool paths
- input schemas
- output schemas
- generated artifacts / inferred details

This is useful before you write any `executor call` code.

---

## 5. The CLI: day-to-day usage pattern

The main workflow command is:

```bash
$EXEC call --base-url "$EXECUTOR_BASE_URL" '<typescript>'
```

Think of it as: **run a small TypeScript program inside executor**.

### Pattern A: discover first

```bash
$EXEC call --base-url "$EXECUTOR_BASE_URL" '
const matches = await tools.discover({ query: "cloudflare docs search", limit: 5 });
return matches;
'
```

### Pattern B: inspect the best tool

```bash
$EXEC call --base-url "$EXECUTOR_BASE_URL" '
const matches = await tools.discover({ query: "cloudflare docs search", limit: 5 });
const path = matches.bestPath;
return await tools.describe.tool({ path, includeSchemas: true });
'
```

### Pattern C: call the tool directly

```bash
$EXEC call --base-url "$EXECUTOR_BASE_URL" '
return await tools.cloudflare_docs.search_cloudflare_documentation({
  query: "How to use Workers KV bindings"
});
'
```

---

## 6. First real example: Cloudflare Docs MCP

This is the cleanest first-run example because it is **no-auth** and already works in the pilot.

### Step 1: add the source

```bash
$EXEC call --base-url "$EXECUTOR_BASE_URL" '
return await tools.executor.sources.add({
  kind: "mcp",
  endpoint: "https://docs.mcp.cloudflare.com/sse",
  name: "Cloudflare Docs",
  namespace: "cloudflare_docs"
});
'
```

Expected result:

- source is added
- status becomes `connected`
- namespace becomes `cloudflare_docs`

### Step 2: discover what it exposed

```bash
$EXEC call --base-url "$EXECUTOR_BASE_URL" '
const matches = await tools.discover({ query: "cloudflare documentation search", limit: 5 });
const path = matches.bestPath;
const detail = await tools.describe.tool({ path, includeSchemas: true });
return { matches, detail };
'
```

### Step 3: run a real query

```bash
$EXEC call --base-url "$EXECUTOR_BASE_URL" '
return await tools.cloudflare_docs.search_cloudflare_documentation({
  query: "How to use Workers KV bindings"
});
'
```

This is the easiest way to get comfortable with executor's model:

- connect once
- discover tool paths
- inspect schema
- call typed tools repeatedly

---

## 7. What an OAuth-backed flow looks like

Executor's most important feature is that it can **pause for interaction** instead of forcing credentials into prompt text.

A real example is the Cloudflare Bindings MCP server.

### Start the source add

```bash
$EXEC call --no-open --base-url "$EXECUTOR_BASE_URL" '
return await tools.executor.sources.add({
  endpoint: "https://bindings.mcp.cloudflare.com/sse",
  name: "Cloudflare Bindings",
  namespace: "cf_bindings"
});
'
```

In the current pilot, this pauses with output like:

- execution status: `waiting_for_interaction`
- a browser URL to open
- a resume command

The important bits are:

```text
status: waiting_for_interaction
message: Open the provider sign-in page to connect Cloudflare Bindings
resumeCommand: executor resume --execution-id <exec_id> --base-url http://10.0.2.110:8788 --no-open
```

### Then do this

1. open the provided OAuth URL in a browser
2. complete the provider sign-in / consent flow
3. resume if needed:

```bash
$EXEC resume --execution-id <exec_id> --base-url "$EXECUTOR_BASE_URL" --no-open
```

This is the core human-in-the-loop model:

- executor pauses
- auth happens outside the prompt
- the execution resumes cleanly

---

## 8. Recommended ways to add sources right now

### Best path for simple, no-auth sources

Use CLI `tools.executor.sources.add(...)`.

Good examples:

- public MCP docs servers
- simple public OpenAPI specs
- low-friction GraphQL endpoints

### Best path for authenticated sources

Use the **web UI** first.

That is the best option when a source needs:

- OAuth
- secret capture
- API-key headers
- source inspection while you configure auth

### Good first pilots

In order:

1. Cloudflare Docs MCP
2. Context7
3. Cloudflare Bindings MCP (OAuth)
4. Gitea / Jotform / Discord after auth setup strategy is clear

---

## 9. A practical workflow for everyday use

When you want to do real work, use this loop:

### Step 1: make sure the server is up

```bash
$EXEC status --json --base-url "$EXECUTOR_BASE_URL"
```

### Step 2: connect the source in the UI if needed

Open the UI and make sure the source is present and connected.

### Step 3: discover the right tool

```bash
$EXEC call --base-url "$EXECUTOR_BASE_URL" '
return await tools.discover({ query: "search recent Discord messages", limit: 10 });
'
```

### Step 4: inspect schema before calling

```bash
$EXEC call --base-url "$EXECUTOR_BASE_URL" '
const matches = await tools.discover({ query: "search recent Discord messages", limit: 10 });
return await tools.describe.tool({ path: matches.bestPath, includeSchemas: true });
'
```

### Step 5: call the tool with typed input

```bash
$EXEC call --base-url "$EXECUTOR_BASE_URL" '
return await tools.some_namespace.some_tool({ ... });
'
```

### Step 6: if it pauses, finish the interaction and resume

```bash
$EXEC resume --execution-id <exec_id> --base-url "$EXECUTOR_BASE_URL"
```

---

## 10. What not to do

Avoid these mistakes:

- do **not** treat executor like a shell wrapper
- do **not** use raw `fetch` in `executor call`
- do **not** paste secrets directly into prompts if the UI/secret flow can hold them
- do **not** expose this pilot on the public internet
- do **not** assume each client gets isolated state — this pilot is intentionally shared

---

## 11. Troubleshooting

### Is the server up?

```bash
$EXEC status --json --base-url "$EXECUTOR_BASE_URL"
$EXEC doctor --json --base-url "$EXECUTOR_BASE_URL"
```

### Check the log

```bash
tail -n 100 "$EXECUTOR_HOME/run/server.log"
```

### Verify the UI is reachable

```bash
curl -i "$EXECUTOR_BASE_URL/"
```

### Verify the local installation API

```bash
curl -i "$EXECUTOR_BASE_URL/v1/local/installation"
```

### Verify the MCP route exists

A raw GET to `/mcp` is mostly a reachability check, not a normal user workflow.

```bash
curl -i -H 'Accept: application/json, text/event-stream' "$EXECUTOR_BASE_URL/mcp"
```

If the route is reachable, you may still get an MCP protocol error like `400` / `Server not initialized` from a plain curl request. That is normal; real MCP clients should speak the MCP protocol instead of just opening the URL.

### If the LAN IP changed

On shuvbot, check the current address and update `EXECUTOR_BASE_URL`:

```bash
ipconfig getifaddr en0
# or
ipconfig getifaddr en1
```

---

## 12. Current pilot status

Already verified in this pilot:

- daemon runs on `shuvbot`
- UI is reachable over LAN from `shuvdev`
- `/v1/local/installation` is reachable from `shuvdev`
- `/mcp` is reachable from `shuvdev`
- Cloudflare Docs MCP can be added and queried
- OAuth-backed source add pauses correctly and produces a resume command

Still intentionally in-progress:

- full authenticated Cloudflare MCP completion/resume validation
- Context7 walkthrough through the UI
- Jotform / Discord / Gitea source setup writeups

---

## 13. The shortest happy-path recipe

If you only want the minimum viable workflow, do this:

```bash
export EXECUTOR_HOME="$HOME/.local/share/executor-pilot"
export EXEC="$HOME/repos/executor/apps/executor/bin/executor"
export EXECUTOR_BASE_URL="http://10.0.2.110:8788"

$EXEC up --base-url "$EXECUTOR_BASE_URL"

$EXEC call --base-url "$EXECUTOR_BASE_URL" '
return await tools.executor.sources.add({
  kind: "mcp",
  endpoint: "https://docs.mcp.cloudflare.com/sse",
  name: "Cloudflare Docs",
  namespace: "cloudflare_docs"
});
'

$EXEC call --base-url "$EXECUTOR_BASE_URL" '
return await tools.cloudflare_docs.search_cloudflare_documentation({
  query: "How to use Workers KV bindings"
});
'
```

If that feels good, the next step is:

- add more sources in the UI
- use `discover -> describe -> call`
- let executor handle auth/interaction when a source needs it
