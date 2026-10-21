/**
 * Apps see who called them: each MCP user as a verified agent acting for them, the dashboard as
 * the signed-in person, and workflows as the host's own work. Resumed approvals run as their
 * requester and name their approver; a tool that requires a person refuses the agent's own answer.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body, type Session } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { McpClient } from "../support/mcp-client.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { appsManifest } from "../support/apps-release.ts";

const source = `import { defineApp, mutation, query, workflow, object, string, router } from "apps";
import { always, human } from "apps/operations/approval";
const identity = (ctx) => ({ caller: ctx.caller ?? null, approvedBy: ctx.approvedBy ?? null });
const whoami = query({ input: object({}) }, async (ctx) => identity(ctx));
const mine = query({ input: object({}) }, async (ctx) =>
  ctx.cache.forCaller().get({ key: "me", schema: string(), freshFor: "1 minute",
    load: async () => ctx.caller?.subject ?? "none" }));
const reviewed = query({ input: object({ note: string() }), approval: always() }, async (ctx) => identity(ctx));
const personal = query({ input: object({ note: string() }), approval: human() }, async (ctx) => identity(ctx));
const probe = workflow({ input: object({}) }, async (ctx) => ctx.step.runQuery("who", whoami, {}));
const launch = mutation({ input: object({ key: string() }) }, async (ctx, input) =>
  (await ctx.workflows.start({ workflow: "probe", input: {}, key: input.key })).id);
export default defineApp({}, { tools: router({ whoami, mine, reviewed, personal, launch }), workflows: { probe } });`;

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

/** One user's MCP client over a personal access token, deleted when the scenario ends. */
const mcpUser = (actor: Session, label: string, slug: string) =>
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
    });
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
          { name: "resume", arguments: { requestId, response: { action: "accept" } } },
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
    return { actor, execute, resume, completed, revoke };
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
        const alice = yield* mcpUser(actors.member, "alice", app.slug),
          bob = yield* mcpUser(actors.admin, "bob", app.slug);

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
        expect(aliceCaller.provenance?.clientId?.startsWith("pat:")).toBe(true);
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
        const api = yield* Api,
          actors = yield* Actors;
        const { app } = yield* deployCallerApp;
        const alice = yield* mcpUser(actors.member, "person", app.slug);
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
        const answer = yield* api.request(
          actors.member,
          "POST",
          `/api/mcp/approvals/${asked.requestId}${page.search}`,
          { response: { action: "accept", content: {} } },
        );
        expect(answer.status, JSON.stringify(answer.body)).toBe(200);
        expect(answer.body).toEqual({ status: "answered" });
        const done = yield* alice.completed(
          Identity,
          yield* alice.resume("agent collects", asked.requestId),
        );
        expect(done.caller).toMatchObject({ kind: "agent", email: "member@example.test" });
        expect(done.approvedBy).toMatchObject({
          kind: "human",
          method: "browser",
          channel: "ui",
          subject: done.caller.subject,
        });
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
