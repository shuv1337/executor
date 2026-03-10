# PLAN: executor pilot deployment for shuvbot skills

## Goal

Stand up a **test deployment of `executor` on `shuvbot`** and evaluate whether it can replace or complement parts of our current skills repo for:

- remote MCP-based skills
- REST/OpenAPI-backed skills
- multi-step tool workflows that currently rely on bespoke CLIs or Code Mode sidecars

This is a **pilot**, not a migration plan for the whole repo.

---

## What we learned from reviewing `executor`

## Product/runtime shape

`executor` is currently a **local-first daemon** with:

- CLI entrypoint: `apps/executor/src/cli/main.ts`
- server/runtime: `packages/server/src/index.ts`
- web UI: `apps/web/src/server.ts`
- execution environment assembly: `packages/control-plane/src/runtime/workspace-execution-environment.ts`

Key current behavior:

- default bind is `127.0.0.1:8788` (`packages/server/src/config.ts`)
- supported source types today are **MCP**, **OpenAPI**, and **GraphQL** (`README.md`, `apps/web/src/views/source-templates.ts`)
- MCP transport support is currently **HTTP/SSE only** (`packages/control-plane/src/schema/models/source.ts`, `packages/codemode-mcp/src/mcp-connection.ts`)
- execution prefers **Deno** when available and falls back to SES when Deno is missing (`packages/control-plane/src/runtime/workspace-execution-environment.ts`)

## Packaging / deploy readiness

From upstream validation, the healthiest packaging path today appears to be the **normal package/distribution flow**, not the portable bundle.

Evidence from local validation:

- `bun install` succeeded
- `bun run --cwd apps/executor typecheck` passed
- `bun run --cwd apps/executor test` passed **20/21** tests
- packaged install flow passes in `apps/executor/src/distribution/distribution.test.ts`
- portable bundle test is currently failing in `apps/executor/src/distribution/portable.test.ts`

That said, for **our** pilot we do **not** want to install executor from npm.

## Practical implication

For the pilot, we should:

- **clone the executor repo onto `shuvbot`**
- **build/run it locally from source** so we can patch it as needed
- treat the source checkout as the canonical pilot environment
- keep portable bundles out of scope for now
- design the pilot around **HTTP/SSE MCP** and **OpenAPI** sources first

The upstream package tests still matter because they give us confidence that the repo’s normal build/distribution path is healthy enough to use as a base, even though we are not consuming the published npm package directly.

---

## Revised deployment shape

## Host

Use **`shuvbot`** as the executor host.

Reasons:

- it already has access to many of the local/internal services our skills target
- it is the most realistic place to test internal API-backed skills
- it lets us evaluate executor close to actual shuvbot workflows

## Target operating model

For this pilot, we are explicitly treating executor as a **shared control plane for multiple trusted agents on the same local network**.

That means:

- one executor instance on `shuvbot`
- multiple agent/client entrypoints may use it
- initial access is limited to trusted LAN peers such as `shuvdev`
- this is **not** intended to be a hardened internet-facing or multi-tenant deployment yet

Pilot assumptions:

- [ ] shared state is acceptable for this phase
- [ ] trusted-LAN access is acceptable for this phase
- [ ] production-grade hardening, tenancy, and remote auth can be deferred until after the pilot proves useful

## LAN access requirement

We want to hit the pilot from **`shuvdev`** as well.

Important constraint:

- today, the current executor CLI defaults to `127.0.0.1`, and the CLI surface we reviewed does **not** expose a normal `--host` override for `executor up`
- `packages/server/src/index.ts` supports host selection internally, but `apps/executor/src/cli/main.ts` does not surface it in the normal pilot workflow yet

## Recommended approach

### Preferred pilot path: add a tiny LAN-bind patch to executor

Before using it broadly, make a small local patch to `executor` so we can run it on `shuvbot` as:

- host: `0.0.0.0` or shuvbot’s LAN IP
- port: `8788` (or alternate pilot port if we want to avoid collisions)

Likely code touchpoints:

- `apps/executor/src/cli/main.ts`
- `packages/server/src/config.ts`
- `packages/server/src/index.ts`

Minimum patch scope (five touchpoints in `main.ts`):

- [x] `serverStartCommand` (~line 1116): add `--host` option alongside existing `--port`
- [x] `getDefaultServerOptions()` (~line 415): accept and forward a `host` parameter instead of hardcoding `DEFAULT_SERVER_HOST`
- [x] `startServerInBackground()` (~line 429): accept `host` and include `--host` in the spawned `__local-server` args (currently only passes `--port`)
- [x] `ensureServer()` (~line 689): extract host from the `baseUrl` and forward it to `startServerInBackground()`
- [x] `upCommand` (~line 1131): either add an explicit `--host` option or extract host from `--base-url` and thread it through
- [x] verify `executor status --json` and `executor doctor --json` still work against a non-localhost `--base-url`

### Fallback path: keep executor on localhost and expose it through a LAN proxy

If we do **not** want to patch executor before the pilot, use a lightweight reverse proxy on `shuvbot` that binds to LAN and forwards to local executor.

This is the operational fallback, but the preferred plan is the tiny host-bind patch because it tests executor more directly.

## Deployment recommendation

- [x] clone `https://github.com/RhysSullivan/executor` to `shuvbot` (for example `~/repos/executor`)
- [x] run `bun install` in the repo checkout
- [x] use the local checkout as the pilot runtime so patches can be made in place
- [x] run validation/build steps locally from the checkout:
  - [x] `bun run --cwd apps/executor typecheck`
  - [x] `bun run --cwd apps/executor test` (still 20/21; portable bundle test remains the known failing case)
  - [x] optional packaging smoke check: `bun run --cwd apps/executor build:dist`
- [x] install Deno on `shuvbot`
- [x] use an isolated pilot home/data dir for executor state
- [x] expose the pilot to `shuvdev` over LAN
- [ ] keep access restricted to trusted LAN/test machines only

Recommended command wrapper from the source checkout:

```bash
EXEC="$HOME/repos/executor/apps/executor/bin/executor"
```

Use `$EXEC ...` for the rest of the pilot so we are always running the patched local checkout, not any globally installed binary.

Suggested pilot environment isolation:

```bash
export EXECUTOR_HOME="$HOME/.local/share/executor-pilot"
```

Setting `EXECUTOR_HOME` alone is sufficient. All derived paths (`data/`, `run/`, PID file, log file) nest under it automatically via `packages/server/src/config.ts`. Do **not** set `EXECUTOR_LOCAL_DATA_DIR` independently unless there is a specific reason to split the control-plane data dir from the rest of the pilot state — doing so risks PID/log files landing in the default location while data lives elsewhere.

---

## Phase 0 — shuvbot bootstrap and LAN exposure

### 0A. Clone + local validation on shuvbot

- [x] clone the executor repo to `shuvbot`
- [x] run `bun install`
- [x] install Deno on `shuvbot`
- [x] set isolated pilot env vars
- [x] define `EXEC="$HOME/repos/executor/apps/executor/bin/executor"`
- [x] run local validation from the checkout:
  - [x] `bun run --cwd apps/executor typecheck`
  - [x] `bun run --cwd apps/executor test` (still 20/21; portable bundle test remains the known failing case)
  - [x] optional: `bun run --cwd apps/executor build:dist`
- [x] run:
  - [x] `$EXEC doctor --json`
  - [x] `$EXEC up`
  - [x] `$EXEC status --json`
- [x] confirm:
  - [x] daemon starts
  - [x] local workspace is provisioned
  - [x] web UI loads locally
  - [x] a trivial `tools.discover(...)` execution completes

### 0B. LAN accessibility from shuvdev

Preferred path:

- [x] patch executor to support a host override
- [x] run executor on `shuvbot` bound to LAN
- [x] verify from `shuvdev` that these are reachable:
  - [x] `/`
  - [x] `/v1/local/installation`
  - [x] `/mcp`

Fallback path:

- [ ] put a LAN-bound reverse proxy in front of localhost executor
- [ ] verify the same routes from `shuvdev`

### Validation criteria

- [x] `shuvdev` can open the UI hosted on `shuvbot`
- [x] `shuvdev` can hit the pilot API/MCP endpoints on `shuvbot`
- [x] executor still behaves normally when addressed through the chosen LAN base URL

---

## Phase 1 — first-wave pilots

The first wave should follow this exact order:

1. **Cloudflare MCP**
2. **context7**
3. **Jotform**
4. **Discord**
5. **Gitea**

This order intentionally front-loads MCP and hosted API cases before ending on our self-hosted Gitea case.

## 1. Cloudflare MCP

Primary goal:

- validate executor’s MCP support
- validate auth + interaction/resume behavior
- validate remote HTTP/SSE MCP sources on a real admin API

Why it belongs first:

- already matches executor’s MCP model well
- exercises the most interesting executor behavior early: discovery, auth, interaction, resume
- we already have strong skill docs in `cloudflare-mcp/SKILL.md`

Pilot scope:

- [x] connect the **docs** server first (no-auth)
- [x] run read-only discovery and one documentation query
- [ ] connect one OAuth-backed Cloudflare MCP server
- [ ] verify OAuth/interaction flow works cleanly
- [ ] perform one safe read-only query on the authenticated server

Current status note:
- [x] confirmed executor pauses with a resumable OAuth interaction for the Cloudflare Bindings MCP server
- [ ] complete the browser OAuth flow and resume the paused execution

Constraints / notes:

- keep this pilot **read-only** at first
- do not use production-impacting write actions in the initial pass

## 2. context7

Primary goal:

- validate a simple, low-risk, read-oriented MCP workflow after Cloudflare MCP
- compare executor’s MCP ergonomics against our current `mcporter`-driven usage

Why it belongs second:

- low blast radius
- good for measuring discovery/search/schema ergonomics without admin risk
- useful control case after the heavier Cloudflare auth flow

Pilot scope:

- [x] add Context7 MCP source
- [x] discover tools from a natural-language query
- [x] inspect schemas for at least one tool
- [x] run at least two real doc queries successfully

## 3. Jotform

Primary goal:

- test an API-backed skill that already has a Code Mode escape hatch
- evaluate whether executor can reduce custom wrapper complexity for a medium-sensitivity admin API

Why it belongs in first wave:

- strong practical value
- existing `jotform/scripts/codemode-config.rest.json` gives us a good starting model
- manageable auth story

Pilot scope:

- [ ] connect Jotform as an OpenAPI or curated REST source
- [ ] perform safe read-only calls first (`/user`, forms list, submissions list)
- [ ] test one low-risk write in a non-sensitive form/workspace only if read path is solid

Safety notes:

- keep initial testing away from destructive submission/form mutations
- do not touch live workflows until read path and auth path are stable

## 4. Discord

Primary goal:

- test a rich REST API with a broad surface area and existing Code Mode precedent
- compare executor against our current Discord Code Mode flow

Why it belongs in first wave:

- strong fit for discovery + schema inspection
- existing skill already proves the API surface is useful and broad
- good stress test for long-tail REST workflows

Pilot scope:

- [ ] connect Discord source
- [ ] start with read-only operations:
  - [ ] get bot info
  - [ ] list guild channels
  - [ ] read recent messages from a test channel
- [ ] only after that, try one safe write such as posting to a dedicated test channel

Safety notes:

- avoid moderation/destructive actions in the pilot
- use a dedicated test channel for any write validation
- file-upload gaps should be tracked explicitly since the current skill already notes escape-hatch cases

## 5. Gitea

Primary goal:

- validate executor against a self-hosted internal API with swagger/OpenAPI
- compare executor against a skill that already maps very cleanly to REST

Why it is still in first wave even though it is last in order:

- it is one of the strongest long-term executor fits
- but we want to reach it after validating the hosted MCP/REST cases first

Pilot scope:

- [ ] connect Gitea using `${GITEA_URL}/swagger.json`
- [ ] verify auth works
- [ ] perform read operations:
  - [ ] repo list/get
  - [ ] issue list/get
  - [ ] PR list/get
- [ ] if all looks good, perform one low-risk write in a non-critical repo:
  - [ ] create a test issue

---

## Exa skill — add to consideration set

We should explicitly evaluate **`exa-search`** as an MCP candidate.

Reference:

- `exa-search/SKILL.md`

Why it is interesting:

- it is a remote MCP-backed skill, so it fits executor conceptually
- it has real utility for search, code context, crawling, company research, and deep research
- it gives us another high-value “tool discovery” style workload alongside Context7

Why it is not locked into the first-wave order yet:

- the current skill config passes Exa auth via **query params** in the MCP URL
- executor supports MCP `queryParams`, but its first-class secret/auth model is clearly more mature for **bearer** and **oauth2** than for arbitrary secret-bearing query parameters

However, the source schema (`packages/control-plane/src/schema/models/source.ts:149-150`) supports both `headers` and `queryParams` as `StringMap` fields. If Exa's MCP server accepts auth via an `Authorization` header (most MCP servers do), the query-param concern is likely a non-issue — we can use the `headers` field with bearer auth instead.

Recommendation:

- [ ] confirm whether Exa MCP accepts auth via `Authorization` header (likely yes)
- [ ] if yes, treat Exa as a **parallel MCP pilot** near Context7 using the `headers` field
- [ ] if no, keep it as a follow-up candidate after the first wave

Suggested Exa decision point:

- after Cloudflare MCP + Context7 are working, decide whether Exa becomes:
  - [ ] **Wave 1.5** optional MCP pilot
  - [ ] or a deferred candidate until auth ergonomics are clearer

---

## Phase 2 — second-wave pilots

Second-wave order:

1. **Ombi**
2. **Sonarr**
3. **Radarr**
4. **Prowlarr**

These are good second-wave targets because they are:

- practical for us
- mostly low-risk internal APIs
- easier to validate from `shuvbot`
- good examples of thin direct-HTTP skills that might benefit from central executor discovery/tooling

## 1. Ombi

Why it leads second wave:

- very thin current skill
- direct user value
- swagger docs are explicitly available in `ombi/SKILL.md`

Pilot scope:

- [ ] search movie
- [ ] search TV show
- [ ] list pending requests
- [ ] optionally create one test request if we want a write check

## 2. Sonarr

Pilot scope:

- [ ] list series
- [ ] lookup series
- [ ] inspect series details

## 3. Radarr

Pilot scope:

- [ ] list movies
- [ ] lookup movie
- [ ] inspect movie details

## 4. Prowlarr

Pilot scope:

- [ ] list/search indexers
- [ ] run cross-indexer query
- [ ] compare tool-discovery experience vs current wrapper/CLI usage

---

## Explicitly deferred / poor initial fits

## `make-api`

Still defer.

Reason:

- current implementation is a **stdio MCP server** (`make-api/make_api_server.py`, `make-api/scripts/codemode-config.mcp.json`)
- executor currently supports MCP over `auto` / `streamable-http` / `sse`, not stdio
- this would turn the pilot into a transport-gap project immediately

## Browser / process / shell-heavy skills

Not first-wave executor candidates:

- `browser`
- `browser-tools`
- `tmux`
- `zellij`
- `openclaw-manager`
- `overseer`
- `dev-browser-bridge`
- `walmart-grocery`

Reason:

- these are not naturally modeled as executor OpenAPI/GraphQL/MCP source problems
- they depend on browser control, shells, SSH, local processes, or interactive environments

---

## Comparison rubric for each pilot skill

For every pilot skill, compare executor vs the existing skill on:

- [ ] setup time
- [ ] auth friction
- [ ] credential management ergonomics (secret storage, rotation, reuse across sources)
- [ ] schema/discovery ergonomics
- [ ] ease of doing multi-step workflows
- [ ] safety for writes
- [ ] latency
- [ ] reliability
- [ ] context savings / reduced prompt bloat
- [ ] maintenance burden compared with the current custom skill

---

## Success criteria

The revised pilot is successful if:

- [x] executor runs on `shuvbot`
- [x] `shuvdev` can reach the pilot over LAN
- [ ] Cloudflare MCP works end-to-end including interaction/resume
- [x] Context7 works end-to-end as a low-risk MCP reference
- [ ] Jotform and Discord both demonstrate whether executor can replace current Code Mode-style escape hatches
- [ ] Gitea demonstrates whether a clean REST/OpenAPI skill becomes simpler in executor
- [ ] Ombi / Sonarr / Radarr / Prowlarr show whether thin local API skills are worth executor-izing in wave two
- [ ] we have a clear yes/no answer on whether Exa is a good executor fit

---

## Key risks / caveats

- [ ] **LAN bind is not first-class in the reviewed CLI flow yet** — likely requires a small patch or proxy
- [ ] **portable distribution is not pilot-safe yet** — current portable test failure
- [ ] **stdio MCP skills remain out of scope** for the first pilot
- [ ] **Discord and Jotform writes need careful guardrails**
- [ ] **Exa auth may be awkward** if it depends on secret-bearing query parameters rather than a cleaner auth path

---

## Internal references

### executor

- `~/repos/executor/README.md`
- `~/repos/executor/ARCHITECTURE.md`
- `~/repos/executor/apps/executor/src/cli/main.ts`
- `~/repos/executor/packages/server/src/config.ts`
- `~/repos/executor/packages/server/src/index.ts`
- `~/repos/executor/packages/control-plane/src/runtime/workspace-execution-environment.ts`
- `~/repos/executor/packages/control-plane/src/schema/models/source.ts`
- `~/repos/executor/packages/codemode-mcp/src/mcp-connection.ts`
- `~/repos/executor/apps/executor/src/distribution/distribution.test.ts`
- `~/repos/executor/apps/executor/src/distribution/portable.test.ts`
- `~/repos/executor/.github/workflows/publish-executor-package.yml`

### skills repo

- `cloudflare-mcp/SKILL.md`
- `context7/SKILL.md`
- `exa-search/SKILL.md`
- `jotform/SKILL.md`
- `jotform/scripts/codemode-config.rest.json`
- `discord/SKILL.md`
- `discord/scripts/codemode-config.rest.json`
- `gitea/SKILL.md`
- `gitea/scripts/codemode-config.rest.json`
- `ombi/SKILL.md`
- `sonarr/SKILL.md`
- `radarr/SKILL.md`
- `prowlarr/SKILL.md`
- `make-api/SKILL.md`
- `make-api/make_api_server.py`
- `make-api/scripts/codemode-config.mcp.json`
