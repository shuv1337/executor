/**
 * Cloud keeps database work beside the database. Cron Triggers run wherever Cloudflare starts
 * them, so each one only asks the API Worker's own placed fetch handler to run its job. Durable
 * Objects serve many calls, so an MCP session holds its connections across calls and operations,
 * replaces one the server drops, and closes them once the session has been idle.
 */
import { expect, layer } from "@effect/vitest";
import { Duration, Effect, Schedule, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { HttpClient } from "effect/unstable/http";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, type SpanQuery } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { McpClient } from "../support/mcp-client.ts";
import { Target } from "../support/platform.ts";
import { appsManifest } from "../support/apps-release.ts";

type Spans = (typeof SpanQuery.Type)["data"];

/** Every span of the trace below the first span that satisfies `from`, inclusive. */
const below = (spans: Spans, from: (span: Spans[number]["span"]) => boolean) => {
  const byId = new Map(spans.map(({ span }) => [span.spanId, span]));
  const roots = new Set(spans.filter(({ span }) => from(span)).map(({ span }) => span.spanId));
  return spans.filter(({ span }) => {
    const visited = new Set<string>();
    let current: string | null = span.spanId;
    while (current !== null && !visited.has(current)) {
      if (roots.has(current)) return true;
      visited.add(current);
      current = byId.get(current)?.parentSpanId ?? null;
    }
    return false;
  });
};

/** The chain of span names from a span up to its trace's root. */
const ancestry = (spans: Spans, spanId: string) => {
  const byId = new Map(spans.map(({ span }) => [span.spanId, span]));
  const chain: Array<Spans[number]["span"]> = [];
  let current = byId.get(spanId);
  while (current !== undefined && !chain.includes(current)) {
    chain.push(current);
    current = current.parentSpanId === null ? undefined : byId.get(current.parentSpanId);
  }
  return chain;
};

const echoAppSource = `import { defineApp, query, object, string, router } from "apps";
export default defineApp({ accounts: {} }, async () => ({ tools: router({
  echo: query({ input: object({ text: string() }), description: "Echo text" },
    async (_ctx, { text }) => ({ text })),
}) }));`;

const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
});

/** Count or terminate one MCP session object's connections in the local database. */
const objectConnections = (owner: string, terminate: boolean) =>
  Effect.gen(function* () {
    const target = yield* Target;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const output = yield* processes.string(
      ChildProcess.make(
        "node",
        [
          "apps/hosted/testing/database-connections-fixture.ts",
          "--configuration",
          `${target.directory}/sso-database.json`,
          "--owner",
          owner,
          ...(terminate ? ["--terminate"] : []),
        ],
        { env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" }, extendEnv: false },
      ),
    );
    return (yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Struct({ connections: Schema.Number })),
    )(output)).connections;
  });

layer(HostedLive, { excludeTestServices: true })("Cloud database placement", (it) => {
  it.effect(scenarios.cloudCronJobsPlaced.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          target = yield* Target,
          telemetry = yield* Telemetry,
          evidence = yield* Evidence,
          http = yield* HttpClient.HttpClient;

        yield* evidence.step(
          "The job route refuses callers without the Worker's own key",
          Effect.gen(function* () {
            const anonymous = yield* api.session();
            for (const headers of [{}, { authorization: "Bearer synthetic-wrong-key" }])
              expect(
                (yield* api.request(
                  anonymous,
                  "POST",
                  "/api/internal/jobs/provisioning",
                  undefined,
                  headers,
                )).status,
              ).toBe(404);
          }),
        );

        // The local Worker also fires its minute cron on its own; either tick proves the path.
        const dispatched = telemetry
          .search("job.dispatch", { "executor.job": "provisioning" })
          .pipe(Effect.map((found) => new Set(found.data.map((entry) => entry.traceId))));
        const before = yield* dispatched;
        yield* Effect.scoped(
          http
            .get(
              `${target.metadata.origin}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent("* * * * *")}`,
            )
            .pipe(Effect.flatMap((response) => response.text)),
        );
        const job = yield* dispatched.pipe(
          Effect.map((after) => [...after].filter((trace) => !before.has(trace))),
          Effect.flatMap((fresh) =>
            Effect.forEach(fresh, (trace) => telemetry.query(trace)).pipe(
              Effect.map((traces) =>
                traces
                  .flatMap((trace) => trace.data)
                  .filter(({ span }) => span.operationName === "job.provisioning.dispatch"),
              ),
            ),
          ),
          Effect.flatMap((found) =>
            found[0] === undefined
              ? Effect.fail(new Error("No dispatched provisioning job has reached Motel"))
              : Effect.succeed(found[0]),
          ),
          Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 60 }),
        );
        const trace = yield* telemetry.query(job.traceId);
        const chain = ancestry(trace.data, job.span.spanId);
        yield* evidence.json(
          "provisioning-job-ancestry.json",
          chain.map((span) => ({ name: span.operationName, tags: span.tags })),
        );
        const server = chain.findIndex(
          (span) =>
            span.operationName.startsWith("http.server") &&
            span.tags["url.path"] === "/api/internal/jobs/provisioning",
        );
        const trigger = chain.findIndex((span) => span.operationName === "job.dispatch");
        expect(server, "The job must run in the API Worker's fetch handler").toBeGreaterThan(0);
        expect(trigger, "The fetch handler must be started by the cron's dispatch").toBeGreaterThan(
          server,
        );
        // The cron invocation itself opens no database connection.
        const triggerSpan = chain[trigger];
        if (triggerSpan === undefined) return yield* Effect.die("Missing dispatch span");
        const outside = below(trace.data, (span) => span.spanId === triggerSpan.spanId).filter(
          ({ span }) =>
            span.operationName === "sql.connect" &&
            !ancestry(trace.data, span.spanId).some(
              (parent) => parent.tags["url.path"] === "/api/internal/jobs/provisioning",
            ),
        );
        expect(outside).toEqual([]);
      }),
    ),
  );

  it.effect(
    scenarios.cloudMcpObjectConnections.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors,
            mcp = yield* McpClient,
            evidence = yield* Evidence,
            telemetry = yield* Telemetry;
          const prefix = `/api/organizations/${actors.organization.id}`;
          const key = yield* body(
            Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
            yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
              name: "Object connections",
            }),
          );
          yield* Effect.addFinalizer(() =>
            api
              .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
              .pipe(Effect.orDie),
          );
          const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Object connections ${randomUUID().slice(0, 8)}`,
            files: [{ path: "index.ts", content: echoAppSource }, appsManifest],
          });
          expect(deployed.status).toBe(200);
          const app = yield* body(App, deployed);
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
          );
          // The session's first requests, from initialization on, are part of its first window.
          const opened = (yield* evidence.requests).length;
          const client = yield* mcp.connect(key.key, "object-connections", {
            organization: actors.organization.id,
          });
          // Six sequential tool calls: each is its own MCP operation inside the session object.
          const execute = (label: string) =>
            Effect.gen(function* () {
              const seen = (yield* evidence.requests).length;
              const result = yield* client.use(label, (client, signal) =>
                client.callTool(
                  {
                    name: "execute",
                    arguments: {
                      code: `const out = [];
for (let i = 0; i < 6; i++) out.push((await tools[${JSON.stringify(app.slug)}].echo({ text: String(i) })).text);
return out;`,
                    },
                  },
                  undefined,
                  { signal },
                ),
              );
              const completed = yield* Schema.decodeUnknownEffect(Completed)(
                result.structuredContent,
              );
              expect(completed.execution.value).toEqual(["0", "1", "2", "3", "4", "5"]);
              return (yield* evidence.requests).slice(seen).map((request) => request.traceId);
            });
          // The session object's own spans, once its calls have reached Motel.
          const sessionSpans = (traces: ReadonlyArray<string>, operations: number) =>
            Effect.forEach(traces, (trace) => telemetry.query(trace)).pipe(
              Effect.map((results) =>
                results.flatMap((result) =>
                  below(result.data, (span) => span.operationName === "mcp.session.request"),
                ),
              ),
              Effect.flatMap((spans) => {
                const count = (name: string) =>
                  spans.filter(({ span }) => span.operationName === name).length;
                return count("mcp.backend.dispatch") < operations
                  ? Effect.fail(new Error("The session's operations have not reached Motel"))
                  : Effect.succeed({
                      operations: count("mcp.backend.dispatch"),
                      databases: count("runtime.cloud.database.initialize"),
                      connects: count("sql.connect"),
                      windows: count("database.object.open"),
                      object: spans
                        .map(({ span }) => span.tags["executor.mcp.object_id"])
                        .find((id) => id !== undefined),
                    });
              }),
              Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
            );

          yield* execute("Six tool calls");
          yield* execute("Six more tool calls");
          const first = yield* sessionSpans(
            (yield* evidence.requests).slice(opened).map((request) => request.traceId),
            12,
          );
          yield* evidence.json("first-window.json", first);
          expect(first.databases, "Each operation resolves its database").toBeGreaterThanOrEqual(
            12,
          );
          expect(first.connects, "Operations reuse the object's connections").toBeLessThanOrEqual(
            3,
          );
          expect(first.windows, "The session's calls share one activity window").toBe(1);
          const object = first.object;
          if (object === undefined) return yield* Effect.die("Missing the session object's ID");
          const owner = `mcp ${object}`;

          // A connection the server drops is replaced on the next use, inside the same window.
          expect(yield* objectConnections(owner, true)).toBeGreaterThan(0);
          const dropped = yield* sessionSpans(
            yield* execute("Tool calls after a dropped connection"),
            6,
          );
          yield* evidence.json("after-drop.json", dropped);
          expect(dropped.windows).toBe(0);
          expect(dropped.connects).toBeGreaterThan(0);

          // Once the session has been idle, it holds no connection; the next call opens a window.
          yield* Effect.sleep(Duration.seconds(32));
          expect(yield* objectConnections(owner, false)).toBe(0);
          const reopened = yield* sessionSpans(yield* execute("Tool calls after idling"), 6);
          yield* evidence.json("after-idle.json", reopened);
          expect(reopened.windows).toBe(1);
          expect(reopened.connects).toBeGreaterThan(0);
        }).pipe(Effect.provide(McpClient.layer)),
      ),
    { timeout: 120_000 },
  );
});
