/**
 * Apps see who called them: each MCP user as a verified agent acting for them, the dashboard as
 * the signed-in person, and workflows as the host's own work. Resumed approvals run as their
 * requester and name their approver; a tool that requires a person refuses the agent's own answer.
 */
import { Browser } from "../support/browser.ts";
import { expect, layer } from "@effect/vitest";
import { Effect, Exit, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body, type Session } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { McpClient } from "../support/mcp-client.ts";
import { HostedLive, TestLive, withCase, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { appsManifest } from "../support/apps-release.ts";
import { clientGrantId, consentTo, revokeClientGrants } from "../support/mcp-connections.ts";
import { pairLocalOperator } from "../support/mcp-consent.ts";
import { reveal } from "../support/failure-text.ts";
import { Target } from "../support/platform.ts";
import { targetHosts } from "../support/role-hosts.ts";

const source = `import { defineApp, mutation, query, workflow, object, string, json, router } from "apps";
import { always, human } from "apps/operations/approval";
const identity = (ctx) => ({ caller: ctx.caller ?? null, approvedBy: ctx.approvedBy ?? null });
const whoami = query({ input: object({}) }, async (ctx) => identity(ctx));
// Identity named in the input is just data: the host sets ctx.caller and ctx.approvedBy.
const claim = query({ input: object({ caller: json(), approvedBy: json() }) }, async (ctx) => identity(ctx));
const mine = query({ input: object({}) }, async (ctx) =>
  ctx.cache.forCaller().get({ key: "me", schema: string(), freshFor: "1 minute",
    load: async () => ctx.caller?.subject ?? "none" }));
const reviewed = query({ input: object({ note: string() }), approval: always() }, async (ctx) => identity(ctx));
const personal = query({ input: object({ note: string() }), approval: human() }, async (ctx) => identity(ctx));
const probe = workflow({ input: object({}) }, async (ctx) => ctx.step.runQuery("who", whoami, {}));
const launch = mutation({ input: object({ key: string() }) }, async (ctx, input) =>
  (await ctx.workflows.start({ workflow: "probe", input: {}, key: input.key })).id);
export default defineApp({}, { tools: router({ whoami, claim, mine, reviewed, personal, launch }), workflows: { probe } });`;

const Caller = Schema.Struct({
  kind: Schema.Literals(["human", "agent", "system"]),
  subject: Schema.NullOr(Schema.String),
  issuer: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
  organizationId: Schema.NullOr(Schema.String),
  channel: Schema.String,
  provenance: Schema.optionalKey(
    Schema.Struct({
      trusted: Schema.Literal(false),
      clientId: Schema.optionalKey(Schema.String),
      connectionId: Schema.optionalKey(Schema.String),
    }),
  ),
});
const Identity = Schema.Struct({
  caller: Caller,
  approvedBy: Schema.NullOr(Schema.Struct({ ...Caller.fields, method: Schema.String })),
});
const Token = Schema.Struct({ key: Schema.RedactedFromValue(Schema.String), id: Schema.String });
const Access = Schema.Struct({ revision: Schema.String });
const Pending = Schema.Struct({
  status: Schema.Literal("approval-required"),
  requestId: Schema.String,
  human: Schema.optionalKey(Schema.Literal(true)),
  approvalUrl: Schema.optionalKey(Schema.String),
});
const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
});
const Run = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  output: Schema.optionalKey(Schema.Unknown),
});

const deployCallerApp = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors;
  const prefix = `/api/organizations/${actors.organization.id}`;
  const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
    name: `Caller identity ${randomUUID().slice(0, 8)}`,
    files: [{ path: "index.ts", content: source }, appsManifest],
  });
  expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
  const app = yield* body(App, deployed),
    path = `${prefix}/apps/${app.id}`;
  yield* Effect.addFinalizer(() => api.request(actors.owner, "DELETE", path).pipe(Effect.ignore));
  const access = yield* body(Access, yield* api.request(actors.owner, "GET", `${path}/access`));
  expect(
    (yield* api.request(actors.owner, "PATCH", `${path}/access`, {
      revision: access.revision,
      audience: { kind: "everyone" },
    })).status,
  ).toBe(200);
  return { app, path };
});

const ApprovalView = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("pending"),
    request: Schema.Struct({
      status: Schema.Literal("approval-required"),
      invocation: Schema.Struct({ tool: Schema.String }),
    }),
  }),
  Schema.Struct({ status: Schema.Literal("answered") }),
  Schema.Struct({ status: Schema.Literal("unavailable") }),
]);
const ApprovalAck = Schema.Struct({ status: Schema.Literals(["answered", "unavailable"]) });

const approvalPath = (requestId: string, params: URLSearchParams) =>
  `/api/mcp/approvals/${encodeURIComponent(requestId)}?${params.toString()}`;

const withMode = (base: URLSearchParams, mode: string | null) => {
  const next = new URLSearchParams(base);
  if (mode === null) next.delete("mode");
  else next.set("mode", mode);
  return next;
};

const mcpRunner = (
  client: Effect.Success<ReturnType<McpClient["Service"]["connect"]>>,
  slug: string,
  mode?: "model" | "browser" | "automatic",
) => {
  const tool = (name: string, input: Schema.Json) =>
    `return await tools[${JSON.stringify(slug)}].${name}(${JSON.stringify(input)});`;
  const execute = (step: string, name: string, input: Schema.Json = {}) =>
    client.use(step, (client, signal) =>
      client.callTool({ name: "execute", arguments: { code: tool(name, input) } }, undefined, {
        signal,
      }),
    );
  const resume = (step: string, requestId: string) =>
    client.use(step, (client, signal) =>
      client.callTool(
        {
          name: "resume",
          arguments:
            mode === "browser" ? { requestId } : { requestId, response: { action: "accept" } },
        },
        undefined,
        { signal },
      ),
    );
  const completed = <A>(schema: Schema.Codec<A>, result: unknown) =>
    Schema.decodeUnknownEffect(Schema.Struct({ structuredContent: Completed }))(result).pipe(
      Effect.flatMap((done) =>
        Schema.decodeUnknownEffect(schema)(done.structuredContent.execution.value),
      ),
    );
  return { execute, resume, completed };
};

/** One user's MCP client over a personal access token, deleted when the scenario ends. */
const mcpUser = (
  actor: Session,
  label: string,
  slug: string,
  mode?: "model" | "browser" | "automatic",
) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors,
      mcp = yield* McpClient;
    const issued = yield* api.request(actor, "POST", "/api/auth/api-key/create", {
      name: `Caller identity ${label}`,
    });
    expect(issued.status).toBe(200);
    const key = yield* body(Token, issued);
    const revoke = api
      .request(actor, "POST", "/api/auth/api-key/delete", { keyId: key.id })
      .pipe(Effect.orDie);
    yield* Effect.addFinalizer(() => Effect.ignore(revoke));
    const client = yield* mcp.connect(key.key, `caller-identity-${label}`, {
      organization: actors.organization.id,
      ...(mode === undefined ? {} : { mode }),
    });
    return {
      actor,
      ...mcpRunner(client, slug, mode),
      revoke,
      keyId: key.id,
      secret: key.key,
    };
  });

layer(HostedLive, { excludeTestServices: true })("Caller identity", (it) => {
  it.effect(scenarios.callerIdentity.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const organization = actors.organization.id;
        const { app, path } = yield* deployCallerApp;
        const alice = yield* mcpUser(actors.member, "alice", app.slug, "model"),
          bob = yield* mcpUser(actors.admin, "bob", app.slug, "model");

        // Concurrent calls from two users each reach the app as that user's own agent.
        const whoami = (user: typeof alice, step: string) =>
          user.execute(step, "whoami").pipe(Effect.flatMap((r) => user.completed(Identity, r)));
        const rounds = yield* Effect.all(
          Array.from({ length: 6 }, (_, index) =>
            Effect.all([whoami(alice, `alice ${index}`), whoami(bob, `bob ${index}`)], {
              concurrency: "unbounded",
            }),
          ),
          { concurrency: "unbounded" },
        );
        const [first] = rounds;
        const aliceCaller = first![0].caller,
          bobCaller = first![1].caller;
        for (const [a, b] of rounds) {
          expect(a.caller).toEqual(aliceCaller);
          expect(b.caller).toEqual(bobCaller);
        }
        expect(aliceCaller).toMatchObject({
          kind: "agent",
          channel: "mcp",
          email: "member@example.test",
          organizationId: organization,
          provenance: { trusted: false },
        });
        expect(bobCaller).toMatchObject({ kind: "agent", email: "admin@example.test" });
        expect(aliceCaller.subject).not.toBe(bobCaller.subject);

        // Naming another principal, organization or approver in the input changes nothing: the app
        // still sees the caller's own verified identity and no approver.
        const forged = yield* alice
          .execute("alice names bob, another organization and an approver", "claim", {
            caller: { ...bobCaller, organizationId: "org_forged", email: "owner@example.test" },
            approvedBy: { ...bobCaller, kind: "human", method: "browser" },
          })
          .pipe(Effect.flatMap((r) => alice.completed(Identity, r)));
        expect(forged.caller).toEqual(aliceCaller);
        expect(forged.approvedBy).toBe(null);
        // Provenance names the key by its record ID, never by the secret the client presents.
        expect(aliceCaller.provenance?.clientId).toBe(`pat:${alice.keyId}`);
        for (const secret of [alice.secret, bob.secret])
          expect(JSON.stringify([first, aliceCaller, bobCaller])).not.toContain(secret);
        expect(aliceCaller.issuer).not.toBe(null);
        expect(first![0].approvedBy).toBe(null);

        // forCaller keeps each user's cached value apart.
        const mine = (user: typeof alice, step: string) =>
          user.execute(step, "mine").pipe(Effect.flatMap((r) => user.completed(Schema.String, r)));
        expect(yield* mine(alice, "alice cached")).toBe(aliceCaller.subject);
        expect(yield* mine(bob, "bob cached")).toBe(bobCaller.subject);

        // The dashboard's tool run is the signed-in person.
        const dashboard = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
          tool: "whoami",
          kind: "query",
          input: {},
        });
        expect(dashboard.status, JSON.stringify(dashboard.body)).toBe(200);
        const owner = (yield* body(Identity, dashboard)).caller;
        expect(owner).toMatchObject({
          kind: "human",
          channel: "dashboard",
          email: "owner@example.test",
          organizationId: organization,
        });

        // A workflow's steps run as the host's own work, for the person who started it.
        const started = yield* api.request(actors.owner, "POST", `${path}/workflow-runs`, {
          workflow: "probe",
          input: {},
          key: randomUUID(),
        });
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        const run = yield* body(Run, started);
        let finished = run;
        for (let attempt = 0; finished.status !== "complete" && attempt < 400; attempt += 1) {
          expect(["errored", "terminated"]).not.toContain(finished.status);
          yield* Effect.sleep("100 millis");
          finished = yield* body(
            Run,
            yield* api.request(actors.owner, "GET", `${path}/workflow-runs/${run.id}`),
          );
        }
        expect(finished.status).toBe("complete");
        const system = yield* Schema.decodeUnknownEffect(Identity)(finished.output);
        expect(system.caller).toMatchObject({
          kind: "system",
          channel: "workflow",
          subject: owner.subject,
          organizationId: organization,
        });

        // A resumed approval runs as its requester and names who approved it.
        const paused = yield* Schema.decodeUnknownEffect(Pending)(
          (yield* alice.execute("alice asks for review", "reviewed", { note: "ok" }))
            .structuredContent,
        );
        expect(paused.human).toBeUndefined();
        const reviewed = yield* alice.completed(
          Identity,
          yield* alice.resume("alice approves", paused.requestId),
        );
        expect(reviewed.caller).toEqual(aliceCaller);
        expect(reviewed.approvedBy).toMatchObject({
          kind: "agent",
          method: "model",
          channel: "mcp",
          subject: aliceCaller.subject,
        });

        // Revoking a key stops its calls at once; the other user is unaffected.
        yield* bob.revoke;
        expect(Exit.isFailure(yield* Effect.exit(whoami(bob, "bob after revocation")))).toBe(true);
        expect((yield* whoami(alice, "alice after bob's revocation")).caller).toEqual(aliceCaller);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.personApproval.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const { app } = yield* deployCallerApp;
        const alice = yield* mcpUser(actors.member, "person", app.slug, "model");
        const asked = yield* Schema.decodeUnknownEffect(Pending)(
          (yield* alice.execute("agent asks", "personal", { note: "needs a person" }))
            .structuredContent,
        );
        expect(asked.human).toBe(true);
        expect(asked.approvalUrl).toBeDefined();
        // The agent's own acceptance does not run it; the same request comes back.
        const refused = yield* Schema.decodeUnknownEffect(Pending)(
          (yield* alice.resume("agent approves itself", asked.requestId)).structuredContent,
        );
        expect(refused.requestId).toBe(asked.requestId);
        expect(refused.approvalUrl).toBeDefined();
        // The signed-in person approves on the browser page; the agent then collects the result.
        // The page posts the answer to the approval API with the link's own query.
        const page = new URL(asked.approvalUrl!);
        // A link names its grant only by an opaque reference: no grant ID, API key ID or JSON.
        expect([...page.searchParams.keys()].sort()).toEqual(["grant", "mode", "sessionId"]);
        expect(page.searchParams.get("mode")).toBe("model");
        expect(page.searchParams.get("sessionId")).toBe("model");
        expect(asked.approvalUrl).not.toContain("grantId");
        expect(asked.approvalUrl).not.toContain("pat:");
        expect(asked.approvalUrl).not.toContain(alice.keyId);
        expect(decodeURIComponent(asked.approvalUrl!)).not.toContain("{");
        // The requester opens the link in a real browser, signed in, and approves it there.
        const browser = yield* Browser;
        yield* browser.login(actors.member);
        yield* browser.use("person opens the approval link", (tab) =>
          tab.goto(`${page.pathname}${page.search}`),
        );
        yield* browser.use("person approves on the page", (tab) =>
          tab.getByRole("button", { name: "Approve", exact: true }).click(),
        );
        yield* browser.use("the page confirms the answer", (tab) =>
          tab.getByText("You can return to your agent.").waitFor(),
        );
        const done = yield* alice.completed(
          Identity,
          yield* alice.resume("agent collects", asked.requestId),
        );
        expect(done.caller).toMatchObject({ kind: "agent", email: "member@example.test" });
        expect(done.approvedBy).toMatchObject({
          kind: "human",
          method: "browser",
          channel: "ui",
          email: "member@example.test",
          subject: done.caller.subject,
        });
        // No part of the caller, the approver or the approval link carries the key's secret.
        expect(JSON.stringify([asked, refused, done])).not.toContain(alice.secret);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.personApprovalPlainKey.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const { app } = yield* deployCallerApp;
        // No explicit mode on the URL: a plain key now defaults to automatic.
        const agent = yield* mcpUser(actors.member, "plain-key", app.slug);
        const allowed = yield* agent.completed(
          Identity,
          yield* agent.execute("The plain key automatically accepts client approval", "reviewed", {
            note: "automatic",
          }),
        );
        expect(allowed.approvedBy).toMatchObject({ kind: "agent", method: "client" });
        const asked = yield* Schema.decodeUnknownEffect(Pending)(
          (yield* agent.execute("The plain key asks a person to approve", "personal", {
            note: "person only",
          })).structuredContent,
        );
        expect(asked.human).toBe(true);
        if (asked.approvalUrl === undefined) return yield* Effect.die("No approval URL");
        const page = new URL(asked.approvalUrl);
        expect(page.searchParams.get("mode")).toBe("automatic");
        expect([...page.searchParams.keys()].sort()).toEqual(["grant", "mode", "sessionId"]);
        const refused = yield* Schema.decodeUnknownEffect(Pending)(
          (yield* agent.resume("The key's own answer does not approve", asked.requestId))
            .structuredContent,
        );
        expect(refused).toMatchObject({ requestId: asked.requestId, human: true });
        const path = approvalPath(asked.requestId, page.searchParams);
        expect(
          (yield* api.request(yield* api.session(), "POST", path, {
            response: { action: "accept" },
          })).status,
        ).toBe(401);
        const browser = yield* Browser;
        yield* browser.login(actors.member);
        yield* browser.use("Open the plain key's approval page as its owner", (tab) =>
          tab.goto(`${page.pathname}${page.search}`),
        );
        yield* browser.use("Approve as the signed-in person", (tab) =>
          tab.getByRole("button", { name: "Approve", exact: true }).click(),
        );
        yield* browser.use("Wait for the approval confirmation", (tab) =>
          tab.getByText("You can return to your agent.").waitFor(),
        );
        const done = yield* agent.completed(
          Identity,
          yield* agent.resume("The plain key collects the person's answer", asked.requestId),
        );
        expect(done.caller).toMatchObject({ kind: "agent", email: "member@example.test" });
        expect(done.approvedBy).toMatchObject({
          kind: "human",
          method: "browser",
          subject: done.caller.subject,
        });
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.personApprovalAutomatic.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          mcp = yield* McpClient,
          target = yield* Target;
        const { app } = yield* deployCallerApp;
        const clients: string[] = [];
        yield* revokeClientGrants(actors.owner, () => clients);
        const plain = `${targetHosts(target).mcp}/mcp`;
        const consent = yield* consentTo(actors.owner, plain, {
          "x-executor-organization": actors.organization.id,
          "x-executor-grant-settings": JSON.stringify({ mode: "automatic" }),
        });
        clients.push(consent.clientId);
        expect(consent.status).toBe(200);
        const token = yield* consent.tokens;
        const autoClient = yield* mcp.connect(token, "caller-identity-automatic");
        const auto = mcpRunner(autoClient, app.slug, "automatic");

        // 1. Automatic mode auto-accepts always() with client approval.
        const reviewed = yield* auto.completed(
          Identity,
          yield* auto.execute("automatic client runs always() tool", "reviewed", { note: "auto" }),
        );
        expect(reviewed.caller).toMatchObject({
          kind: "agent",
          channel: "mcp",
          email: "owner@example.test",
          organizationId: actors.organization.id,
        });
        expect(reviewed.approvedBy).toMatchObject({
          kind: "agent",
          method: "client",
          channel: "mcp",
          subject: reviewed.caller.subject,
        });

        // 2. human() still pauses and returns an approval link naming mode=automatic.
        const asked = yield* Schema.decodeUnknownEffect(Pending)(
          (yield* auto.execute("automatic client runs human() tool", "personal", {
            note: "needs owner",
          })).structuredContent,
        );
        expect(asked.human).toBe(true);
        expect(asked.approvalUrl).toBeDefined();
        const page = new URL(asked.approvalUrl!);
        expect([...page.searchParams.keys()].sort()).toEqual(["grant", "mode", "sessionId"]);
        expect(page.searchParams.get("mode")).toBe("automatic");
        expect(page.searchParams.get("sessionId")).toBe("automatic");
        expect(asked.approvalUrl).not.toContain("grantId");
        expect(asked.approvalUrl).not.toContain("pat:");
        expect(decodeURIComponent(asked.approvalUrl!)).not.toContain("{");

        // 3. The agent's own acceptance never answers a human() request.
        const refused = yield* Schema.decodeUnknownEffect(Pending)(
          (yield* auto.resume("automatic agent tries to self-approve", asked.requestId))
            .structuredContent,
        );
        expect(refused.requestId).toBe(asked.requestId);
        expect(refused.human).toBe(true);
        expect(refused.approvalUrl).toBeDefined();
        expect(new URL(refused.approvalUrl!).searchParams.get("mode")).toBe("automatic");

        // 4. Owner reads the approval page API for the automatic link.
        const ownLink = approvalPath(asked.requestId, page.searchParams);
        const ownerView = yield* api.request(actors.owner, "GET", ownLink);
        expect(ownerView.status, JSON.stringify(ownerView.body)).toBe(200);
        const pending = yield* body(ApprovalView, ownerView);
        expect(pending).toMatchObject({
          status: "pending",
          request: { status: "approval-required", invocation: { tool: "personal" } },
        });

        // 5. Other members of the same org are refused on GET and POST; request stays pending.
        for (const other of [actors.member, actors.admin]) {
          expect((yield* api.request(other, "GET", ownLink)).status).toBe(403);
          expect(
            (yield* api.request(other, "POST", ownLink, { response: { action: "accept" } })).status,
          ).toBe(403);
        }
        const stillPending = yield* api.request(actors.owner, "GET", ownLink);
        expect(stillPending.status).toBe(200);
        expect((yield* body(ApprovalView, stillPending)).status).toBe("pending");

        // 6. Owner hand-editing mode on the automatic link is refused (K4, K6).
        for (const edited of ["model", null] as const) {
          const path = approvalPath(asked.requestId, withMode(page.searchParams, edited));
          expect((yield* api.request(actors.owner, "GET", path)).status).toBe(403);
          expect(
            (yield* api.request(actors.owner, "POST", path, { response: { action: "accept" } }))
              .status,
          ).toBe(403);
        }
        for (const invalid of ["browser", "native", "bogus", "AUTOMATIC", "Model", ""]) {
          const path = approvalPath(asked.requestId, withMode(page.searchParams, invalid));
          expect((yield* api.request(actors.owner, "GET", path)).status).toBe(400);
          expect(
            (yield* api.request(actors.owner, "POST", path, { response: { action: "accept" } }))
              .status,
          ).toBe(400);
        }
        for (const extra of ["automatic", "model"]) {
          const repeated = new URLSearchParams(page.searchParams);
          repeated.append("mode", extra);
          const path = approvalPath(asked.requestId, repeated);
          expect((yield* api.request(actors.owner, "GET", path)).status).toBe(400);
          expect(
            (yield* api.request(actors.owner, "POST", path, { response: { action: "accept" } }))
              .status,
          ).toBe(400);
        }

        // 7. A second automatic-mode grant of the same owner cannot reach the first grant's run (K1).
        const secondConsent = yield* consentTo(actors.owner, plain, {
          "x-executor-organization": actors.organization.id,
          "x-executor-grant-settings": JSON.stringify({ mode: "automatic" }),
        });
        clients.push(secondConsent.clientId);
        expect(secondConsent.status).toBe(200);
        const secondToken = yield* secondConsent.tokens;
        const secondAuto = mcpRunner(
          yield* mcp.connect(secondToken, "caller-identity-automatic-second"),
          app.slug,
          "automatic",
        );
        const secondAsked = yield* Schema.decodeUnknownEffect(Pending)(
          (yield* secondAuto.execute("second automatic client runs human() tool", "personal", {
            note: "second grant",
          })).structuredContent,
        );
        const secondPage = new URL(secondAsked.approvalUrl!);
        expect(secondPage.searchParams.get("mode")).toBe("automatic");
        const secondAutoOnFirst = approvalPath(asked.requestId, secondPage.searchParams);
        const secondAutoGet = yield* api.request(actors.owner, "GET", secondAutoOnFirst);
        expect(secondAutoGet.status).toBe(200);
        expect(yield* body(ApprovalView, secondAutoGet)).toEqual({ status: "unavailable" });
        const secondAutoPost = yield* api.request(actors.owner, "POST", secondAutoOnFirst, {
          response: { action: "accept" },
        });
        expect(secondAutoPost.status).toBe(200);
        expect(yield* body(ApprovalAck, secondAutoPost)).toEqual({ status: "unavailable" });
        const firstStillPending = yield* api.request(actors.owner, "GET", ownLink);
        expect(firstStillPending.status).toBe(200);
        expect((yield* body(ApprovalView, firstStillPending)).status).toBe("pending");

        // 8. Model and browser foils owned by the same user cannot cross modes or grants.
        const modelFoil = yield* mcpUser(actors.owner, "model-foil", app.slug, "model");
        const browserFoil = yield* mcpUser(actors.owner, "browser-foil", app.slug, "browser");
        const modelAsked = yield* Schema.decodeUnknownEffect(Pending)(
          (yield* modelFoil.execute("model foil asks", "personal", { note: "model" }))
            .structuredContent,
        );
        expect(modelAsked.human).toBe(true);
        const modelPage = new URL(modelAsked.approvalUrl!);
        expect(modelPage.searchParams.get("mode")).toBe("model");

        const browserAsked = yield* Schema.decodeUnknownEffect(Pending)(
          (yield* browserFoil.execute("browser foil asks", "personal", { note: "browser" }))
            .structuredContent,
        );
        expect(browserAsked.human).toBe(true);
        const browserPage = new URL(browserAsked.approvalUrl!);
        expect(browserPage.searchParams.get("mode")).toBeNull();

        // Model and browser links re-pointed at the automatic run's id.
        for (const [params, mode, expectedStatus] of [
          [modelPage.searchParams, "automatic", 403],
          [browserPage.searchParams, "automatic", 403],
          [browserPage.searchParams, "model", 403],
        ] as const) {
          const path = approvalPath(asked.requestId, withMode(params, mode));
          expect((yield* api.request(actors.owner, "GET", path)).status).toBe(expectedStatus);
          expect(
            (yield* api.request(actors.owner, "POST", path, { response: { action: "accept" } }))
              .status,
          ).toBe(expectedStatus);
        }
        const crossGrantModel = yield* api.request(
          actors.owner,
          "GET",
          approvalPath(asked.requestId, withMode(modelPage.searchParams, "model")),
        );
        expect(crossGrantModel.status).toBe(200);
        expect(yield* body(ApprovalView, crossGrantModel)).toEqual({ status: "unavailable" });

        // Hand-edited modes on the model and browser foils' own request IDs (every direction).
        for (const [id, params, mode] of [
          [modelAsked.requestId, modelPage.searchParams, "automatic"],
          [modelAsked.requestId, modelPage.searchParams, null],
          [browserAsked.requestId, browserPage.searchParams, "automatic"],
          [browserAsked.requestId, browserPage.searchParams, "model"],
        ] as const) {
          const path = approvalPath(id, withMode(params, mode));
          expect((yield* api.request(actors.owner, "GET", path)).status).toBe(403);
          expect(
            (yield* api.request(actors.owner, "POST", path, { response: { action: "accept" } }))
              .status,
          ).toBe(403);
        }

        // 9. Automatic grant reference pointed at the browser foil's request and session.
        const autoOnBrowserNoMode = new URLSearchParams({
          grant: page.searchParams.get("grant")!,
          sessionId: browserPage.searchParams.get("sessionId")!,
        });
        const autoOnBrowserNoModePath = approvalPath(browserAsked.requestId, autoOnBrowserNoMode);
        expect((yield* api.request(actors.owner, "GET", autoOnBrowserNoModePath)).status).toBe(403);
        expect(
          (yield* api.request(actors.owner, "POST", autoOnBrowserNoModePath, {
            response: { action: "accept" },
          })).status,
        ).toBe(403);
        const autoOnBrowserWithAuto = new URLSearchParams(autoOnBrowserNoMode);
        autoOnBrowserWithAuto.set("mode", "automatic");
        const autoOnBrowserWithAutoPath = approvalPath(
          browserAsked.requestId,
          autoOnBrowserWithAuto,
        );
        const crossGrantAuto = yield* api.request(actors.owner, "GET", autoOnBrowserWithAutoPath);
        expect(crossGrantAuto.status).toBe(200);
        expect(yield* body(ApprovalView, crossGrantAuto)).toEqual({ status: "unavailable" });
        const crossGrantAutoPost = yield* api.request(
          actors.owner,
          "POST",
          autoOnBrowserWithAutoPath,
          { response: { action: "accept" } },
        );
        expect(crossGrantAutoPost.status).toBe(200);
        expect(yield* body(ApprovalAck, crossGrantAutoPost)).toEqual({ status: "unavailable" });

        // 10. Model and browser foils still approve and complete through their own links (K2, K3).
        const modelOwnPath = approvalPath(modelAsked.requestId, modelPage.searchParams);
        expect((yield* api.request(actors.owner, "GET", modelOwnPath)).status).toBe(200);
        const modelAnswer = yield* api.request(actors.owner, "POST", modelOwnPath, {
          response: { action: "accept" },
        });
        expect(modelAnswer.status).toBe(200);
        expect(yield* body(ApprovalAck, modelAnswer)).toEqual({ status: "answered" });
        const modelDone = yield* modelFoil.completed(
          Identity,
          yield* modelFoil.resume("model foil collects", modelAsked.requestId),
        );
        expect(modelDone.approvedBy).toMatchObject({
          kind: "human",
          method: "browser",
          channel: "ui",
          email: "owner@example.test",
          subject: modelDone.caller.subject,
        });

        const browserOwnPath = approvalPath(browserAsked.requestId, browserPage.searchParams);
        expect((yield* api.request(actors.owner, "GET", browserOwnPath)).status).toBe(200);
        const browserAnswer = yield* api.request(actors.owner, "POST", browserOwnPath, {
          response: { action: "accept" },
        });
        expect(browserAnswer.status).toBe(200);
        expect(yield* body(ApprovalAck, browserAnswer)).toEqual({ status: "answered" });
        const browserDone = yield* browserFoil.completed(
          Identity,
          yield* browserFoil.resume("browser foil collects", browserAsked.requestId),
        );
        expect(browserDone.approvedBy).toMatchObject({
          kind: "human",
          method: "browser",
          channel: "ui",
          email: "owner@example.test",
          subject: browserDone.caller.subject,
        });

        // 11. Owner opens the automatic approval link in a real browser and clicks Approve.
        const browser = yield* Browser;
        yield* browser.login(actors.owner);
        yield* browser.use("owner opens the automatic approval link", (tab) =>
          tab.goto(`${page.pathname}${page.search}`),
        );
        yield* browser.use("owner approves on the page", (tab) =>
          tab.getByRole("button", { name: "Approve", exact: true }).click(),
        );
        yield* browser.use("the page confirms the answer", (tab) =>
          tab.getByText("You can return to your agent.").waitFor(),
        );

        // 12. Automatic agent resumes and receives the human approval.
        const done = yield* auto.completed(
          Identity,
          yield* auto.resume("automatic agent collects", asked.requestId),
        );
        expect(done.caller).toMatchObject({
          kind: "agent",
          channel: "mcp",
          email: "owner@example.test",
          organizationId: actors.organization.id,
        });
        expect(done.approvedBy).toMatchObject({
          kind: "human",
          method: "browser",
          channel: "ui",
          email: "owner@example.test",
          subject: done.caller.subject,
        });
        expect(JSON.stringify([asked, refused, done])).not.toContain(Redacted.value(token));
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});

const deployLocalCallerApp = (operator: Session) =>
  Effect.gen(function* () {
    const target = yield* Target;
    const headers = { authorization: `Bearer ${reveal(target.apiKey)}` };
    const deployed = yield* operator.send(
      "POST",
      "/v1/apps/deploy",
      {
        owner: "local",
        name: `Caller identity ${randomUUID().slice(0, 8)}`,
        files: [{ path: "index.ts", content: source }, appsManifest],
      },
      headers,
    );
    expect(deployed.status).toBe(200);
    const { app } = yield* body(Schema.Struct({ app: App }), deployed);
    yield* Effect.addFinalizer(() =>
      operator.send("DELETE", `/v1/apps/${app.id}`, undefined, headers).pipe(Effect.orDie),
    );
    return app.slug;
  });

type Runner = ReturnType<typeof mcpRunner>;
const callerModes = ["model", "automatic"] as const;
const accept = { response: { action: "accept" } };
const localApprovalPath = (requestId: string, params: URLSearchParams) =>
  `/dashboard/api/mcp/approvals/${encodeURIComponent(requestId)}?${params}`;

const startLocalApproval = (runner: Runner, mode: (typeof callerModes)[number] | "browser") =>
  Effect.gen(function* () {
    const asked = yield* Schema.decodeUnknownEffect(Pending)(
      (yield* runner.execute(`${mode} client calls a person-only tool`, "personal", {
        note: `Review the ${mode} call`,
      })).structuredContent,
    );
    expect(asked.human).toBe(true);
    if (asked.approvalUrl === undefined) return yield* Effect.die("No approval URL");
    const page = new URL(asked.approvalUrl);
    if (mode === "browser") {
      expect(page.searchParams.get("mode")).toBeNull();
      expect(page.searchParams.get("sessionId")).toBeTruthy();
      expect(callerModes).not.toContain(page.searchParams.get("sessionId"));
    } else {
      expect(page.searchParams.get("mode"), `${mode} link carries its mode`).toBe(mode);
      expect(page.searchParams.get("sessionId")).toBe(mode);
      const refused = yield* Schema.decodeUnknownEffect(Pending)(
        (yield* runner.resume(`${mode} client tries to approve its own call`, asked.requestId))
          .structuredContent,
      );
      expect(refused).toMatchObject({
        requestId: asked.requestId,
        human: true,
        approvalUrl: asked.approvalUrl,
      });
    }
    return { requestId: asked.requestId, page };
  });

const checkLocalApproval = (
  session: Session,
  requestId: string,
  params: URLSearchParams,
  label: string,
  status: 200 | 400 | 401 | 403,
  headers?: Record<string, string>,
) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const path = localApprovalPath(requestId, params);
    const read = yield* api.request(session, "GET", path, undefined, headers);
    expect(read.status, `Read: ${label}`).toBe(status);
    const answer = yield* api.request(session, "POST", path, accept, headers);
    expect(answer.status, `Answer: ${label}`).toBe(status);
    if (status === 200) {
      expect(yield* body(ApprovalView, read)).toEqual({ status: "unavailable" });
      expect(yield* body(ApprovalAck, answer)).toEqual({ status: "unavailable" });
    }
  });

const approveLocalInBrowser = (
  operator: Session,
  runner: Runner,
  approval: Effect.Success<ReturnType<typeof startLocalApproval>>,
) =>
  Effect.gen(function* () {
    const api = yield* Api,
      browser = yield* Browser;
    const pending = yield* api.request(
      operator,
      "GET",
      localApprovalPath(approval.requestId, approval.page.searchParams),
    );
    expect(pending.status).toBe(200);
    expect(yield* body(ApprovalView, pending)).toMatchObject({
      status: "pending",
      request: { status: "approval-required", invocation: { tool: "personal" } },
    });
    yield* browser.use("Open the original approval link as the paired operator", (tab) =>
      tab.goto(approval.page.toString()),
    );
    yield* browser.use("Approve the person-only call", (tab) =>
      tab.getByRole("button", { name: "Approve", exact: true }).click(),
    );
    yield* browser.use("The browser acknowledges the answer", (tab) =>
      tab.getByText("You can return to your agent.").waitFor(),
    );
    const done = yield* runner.completed(
      Identity,
      yield* runner.resume("The agent collects the person's answer", approval.requestId),
    );
    expect(done.approvedBy).toMatchObject({ kind: "human", method: "browser" });
  });

layer(TestLive, { excludeTestServices: true })("Local person-only approvals", (it) => {
  it.effect(scenarios.localPersonApprovalOAuth.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          target = yield* Target,
          mcp = yield* McpClient,
          browser = yield* Browser;
        const operator = yield* pairLocalOperator;
        const anonymous = yield* api.session();
        const slug = yield* deployLocalCallerApp(operator);
        const clients: string[] = [];
        yield* revokeClientGrants(operator, () => clients);
        const connect = (mode: (typeof callerModes)[number] | "browser", label: string) =>
          Effect.gen(function* () {
            const consent = yield* consentTo(operator, `${target.metadata.origin}/mcp`, {
              "x-executor-grant-settings": JSON.stringify({ mode }),
            });
            clients.push(consent.clientId);
            expect(consent.status).toBe(200);
            const token = yield* consent.tokens;
            const runner = mcpRunner(yield* mcp.connect(token, label), slug, mode);
            const grantId = yield* clientGrantId(operator, consent.clientId);
            return { runner, token, grantId };
          });
        const browserFoil = yield* connect("browser", "local-browser-foil");
        yield* browser.login(operator);
        for (const mode of callerModes) {
          const { runner, token, grantId } = yield* connect(mode, `local-${mode}`);
          const approval = yield* startLocalApproval(runner, mode);
          const { requestId, page } = approval;
          const own = page.searchParams;
          expect(own.get("grantId")).toBe(grantId);
          if (mode === "model") {
            const ordinary = yield* Schema.decodeUnknownEffect(Pending)(
              (yield* runner.execute("model client asks for ordinary approval", "reviewed", {
                note: "Agent approval is enough",
              })).structuredContent,
            );
            expect(ordinary.human).toBeUndefined();
            yield* checkLocalApproval(operator, ordinary.requestId, own, "not person-only", 403);
            const done = yield* runner.completed(
              Identity,
              yield* runner.resume("The model approves the ordinary request", ordinary.requestId),
            );
            expect(done.approvedBy).toMatchObject({ kind: "agent", method: "model" });
          }
          const other = mode === "model" ? "automatic" : "model";
          const wrongMode = withMode(own, other);
          wrongMode.set("sessionId", other);
          const wrongMarker = new URLSearchParams(own);
          wrongMarker.set("sessionId", other);
          const wrongGrant = new URLSearchParams(own);
          wrongGrant.set("grantId", browserFoil.grantId);
          for (const [label, params] of [
            ["a different mode and its marker", wrongMode],
            ["an omitted mode", withMode(own, null)],
            ["a wrong session marker", wrongMarker],
            ["a browser-mode grant", wrongGrant],
          ] as const) {
            yield* checkLocalApproval(operator, requestId, params, label, 403);
          }
          yield* checkLocalApproval(anonymous, requestId, own, "no pairing cookie", 401);
          yield* checkLocalApproval(operator, requestId, own, "a bearer header", 403, {
            authorization: `Bearer ${reveal(token)}`,
          });
          expect(
            (yield* api.request(operator, "POST", localApprovalPath(requestId, own), accept, {
              origin: "https://wrong-origin.example.test",
            })).status,
            "Answer: a cross-origin request",
          ).toBe(403);
          yield* checkLocalApproval(
            operator,
            requestId,
            withMode(own, "browser"),
            "malformed mode",
            400,
          );
          const repeated = new URLSearchParams(own);
          repeated.append("mode", mode);
          yield* checkLocalApproval(operator, requestId, repeated, "repeated mode", 400);
          yield* browser.use("Open a link that repeats its mode", (tab) =>
            tab.goto(`${page.pathname}?${repeated}`),
          );
          yield* browser.use("The browser refuses the ambiguous link", (tab) =>
            tab.getByRole("heading", { name: "This approval link is invalid." }).waitFor(),
          );

          const second = yield* connect(mode, `local-${mode}-second`);
          const secondGrant = new URLSearchParams(own);
          expect(second.grantId).not.toBe(grantId);
          secondGrant.set("grantId", second.grantId);
          yield* checkLocalApproval(
            operator,
            requestId,
            secondGrant,
            "another same-mode grant",
            200,
          );
          expect(
            (yield* api.request(operator, "POST", "/api/auth/mcp/grants/revoke", {
              id: second.grantId,
            })).status,
          ).toBe(200);
          yield* checkLocalApproval(operator, requestId, secondGrant, "a revoked grant", 403);
          yield* approveLocalInBrowser(operator, runner, approval);
          yield* checkLocalApproval(operator, requestId, own, "a consumed request", 200);
        }
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.localPersonApprovalAdministrator.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target,
          mcp = yield* McpClient,
          browser = yield* Browser;
        const operator = yield* pairLocalOperator;
        const slug = yield* deployLocalCallerApp(operator);
        yield* browser.login(operator);
        for (const mode of [...callerModes, "browser"] as const) {
          const runner = mcpRunner(
            yield* mcp.connect(target.apiKey, `local-admin-${mode}`, { mode }),
            slug,
            mode,
          );
          const approval = yield* startLocalApproval(runner, mode);
          const { requestId, page } = approval;
          expect(page.searchParams.get("grantId")).toBe("local-administrator");
          if (mode !== "browser") {
            const other = mode === "model" ? "automatic" : "model";
            const wrongMode = withMode(page.searchParams, other);
            yield* checkLocalApproval(
              operator,
              requestId,
              wrongMode,
              "other mode, same marker",
              403,
            );
            wrongMode.set("sessionId", other);
            yield* checkLocalApproval(operator, requestId, wrongMode, "other mode and marker", 200);
          }
          yield* approveLocalInBrowser(operator, runner, approval);
        }
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
