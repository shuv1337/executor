/**
 * Execute runs programs in an interpreter on the product's own thread. A program that only computes
 * used to run until its five-minute wall-time budget, keeping the product busy all that time: on
 * production one program spent 203 s in the interpreter and other requests slowed until clients
 * gave up. The step budget stops such a program with `TimeoutExceeded` long before its wall time,
 * whatever its own `catch` does, while other requests keep answering and an ordinary program that
 * calls tools and loops still completes. Native calls are charged for the data they read and
 * return, so a loop of large `split` calls, one step each, stops in seconds too.
 */
import { expect, layer } from "@effect/vitest";
import { Duration, Effect, Fiber, Schema } from "effect";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";
import { McpClient } from "../support/mcp-client.ts";

/** The products' default `maxSteps` (`defaultMcpLimits` in packages/mcp). */
const defaultMaxSteps = 5_000_000;
/** The products' default wall-time budget, which the runaway program must end well inside. */
const defaultTimeoutMs = 5 * 60_000;

const Executed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({
    ok: Schema.Boolean,
    value: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.Struct({ kind: Schema.String, message: Schema.String })),
    toolCalls: Schema.Array(Schema.Struct({ name: Schema.String, outcome: Schema.String })),
  }),
});

type Connected = Effect.Success<ReturnType<Effect.Success<typeof McpClient>["connect"]>>;

const execute = (client: Connected, name: string, code: string) =>
  Effect.gen(function* () {
    const [took, { execution }] = yield* client
      .use(`Run the ${name} program`, (client, signal) =>
        client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
      )
      .pipe(
        Effect.flatMap((result) => Schema.decodeUnknownEffect(Executed)(result.structuredContent)),
        Effect.timed,
      );
    const ms = Math.round(Duration.toMillis(took));
    yield* (yield* Evidence).json(`${name}.json`, { ms, execution });
    return { ms, execution };
  });

/** Connects to hosted MCP execute with a new API key for the owner, deleted when the case ends. */
const connectHosted = (label: string) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors,
      mcp = yield* McpClient;
    const key = yield* body(
      Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
      yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", { name: label }),
    );
    yield* Effect.addFinalizer(() =>
      api
        .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
        .pipe(Effect.orDie),
    );
    return yield* mcp.connect(key.key, label, { organization: actors.organization.id });
  });

/** Calls a tool every product serves without setup, then loops briefly, as ordinary programs do. */
const ordinary = `
const found = await tools.search({ query: 'executor', limit: 1 });
let sum = 0;
for (let i = 0; i < 1000; i++) sum += i;
return { items: Array.isArray(found.items), sum };`;
const ordinaryValue = { items: true, sum: 499_500 };

/**
 * Never returns on its own, and tries to outlast the budget: each iteration catches what it
 * throws and runs a finally block, and the program returns from its outer catch.
 */
const runaway = `
let n = 0;
try {
  while (true) {
    try { n++; if (n % 1000 === 0) throw new Error('again'); } catch (e) { n++; } finally { n++; }
  }
} catch (e) {
  return 'caught: ' + String(e);
}`;

/**
 * The review's proof that native calls escaped the budget: each `split` is one step, but builds a
 * million-element array. Uncharged, it ran 83 s and outlasted a 60 s wall-time budget.
 */
const nativeRunaway = `
const s = "x".repeat(1000000);
let n = 0;
for (let i = 0; i < 100000; i++) { n += s.split("").length }
return n;`;

/** Filters and maps 10,000 records, as programs do with a large tool result. */
const recordsTransform = `
const records = Array.from({ length: 10000 }, (_, i) => ({ id: 'r' + i, price: i % 100, tags: ['a', 'b'] }));
const cheap = records.filter((record) => record.price < 50).map((record) => ({ id: record.id, price: record.price * 2 }));
return { kept: cheap.length, json: JSON.stringify(cheap).length > 0 };`;

/**
 * Three tool calls with a 200,000-iteration loop between them: several times the interpreter work
 * of the programs agents send, which spend well under a second before their first call.
 */
const heavyButFine = `
const first = await tools.search({ query: 'executor', limit: 1 });
let total = 0;
for (let i = 0; i < 200000; i++) total = (total + i) % 1000003;
const second = await tools.search({ query: 'github', limit: 1 });
const third = await tools.search({ query: 'slack', limit: 1 });
return { total, calls: [first, second, third].length };`;

layer(HostedLive, { excludeTestServices: true })("Hosted MCP execute step budget", (it) => {
  it.effect(
    scenarios.mcpExecuteStepBudget.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const evidence = yield* Evidence;
          const runner = yield* connectHosted("execute-step-budget-runaway");
          const other = yield* connectHosted("execute-step-budget-other");

          // How long the ordinary program takes on this server when nothing else runs.
          const quiet: Array<number> = [];
          for (let round = 0; round < 3; round++) {
            const { ms, execution } = yield* execute(other, `ordinary-quiet-${round}`, ordinary);
            expect(execution).toMatchObject({ ok: true, value: ordinaryValue });
            quiet.push(ms);
          }

          // The runaway program runs while the other caller keeps sending ordinary programs.
          const running = yield* Effect.forkChild(execute(runner, "runaway", runaway));
          const finished = Effect.sync(() => running.pollUnsafe() !== undefined);
          const busy: Array<number> = [];
          while (!(yield* finished)) {
            const { ms, execution } = yield* execute(
              other,
              `ordinary-busy-${busy.length}`,
              ordinary,
            );
            expect(execution).toMatchObject({ ok: true, value: ordinaryValue });
            // Only rounds that ended while the runaway program still ran count as beside it.
            if (!(yield* finished)) busy.push(ms);
          }
          const stopped = yield* Fiber.join(running);

          // It fails as a timeout that names the budget, although its own catch tried to return.
          expect(stopped.execution).toMatchObject({
            ok: false,
            error: {
              kind: "TimeoutExceeded",
              message: expect.stringContaining(
                `Execution exceeded its compute budget of ${defaultMaxSteps} interpreter steps`,
              ),
            },
            toolCalls: [],
          });
          expect(stopped.execution.error?.message).toContain("move heavy computation");
          // Far inside the five-minute wall-time budget it would otherwise have run to.
          expect(stopped.ms).toBeLessThan(defaultTimeoutMs / 5);

          // Other callers kept being answered while it ran, and promptly.
          expect(busy.length).toBeGreaterThanOrEqual(3);
          const slowestQuiet = Math.max(...quiet);
          expect(Math.max(...busy)).toBeLessThan(Math.max(5_000, slowestQuiet * 20));

          // An ordinary program that calls tools between longer loops still completes.
          const fine = yield* execute(runner, "heavy-but-fine", heavyButFine);
          expect(fine.execution).toMatchObject({
            ok: true,
            value: { total: expect.any(Number), calls: 3 },
          });
          expect(fine.execution.toolCalls.map((call) => call.outcome)).toEqual([
            "success",
            "success",
            "success",
          ]);

          // A loop of large native calls stops at the same budget, in seconds.
          const native = yield* execute(runner, "native-runaway", nativeRunaway);
          expect(native.execution).toMatchObject({
            ok: false,
            error: {
              kind: "TimeoutExceeded",
              message: expect.stringContaining(
                `Execution exceeded its compute budget of ${defaultMaxSteps} interpreter steps`,
              ),
            },
          });
          expect(native.ms).toBeLessThan(20_000);

          // Transforming 10,000 records with native calls stays well inside it.
          const records = yield* execute(runner, "records-transform", recordsTransform);
          expect(records.execution).toMatchObject({ ok: true, value: { kept: 5000, json: true } });

          yield* evidence.measure("runaway-ms", stopped.ms);
          yield* evidence.measure("ordinary-quiet-max-ms", slowestQuiet);
          yield* evidence.measure("ordinary-busy-max-ms", Math.max(...busy));
          yield* evidence.json("summary.json", {
            stepsPerSecond: Math.round(defaultMaxSteps / (stopped.ms / 1000)),
            busyRounds: busy.length,
            quiet,
            busy,
          });
          yield* evidence.measure("heavy-but-fine-ms", fine.ms);
          yield* evidence.measure("native-runaway-ms", native.ms);
          yield* evidence.measure("records-transform-ms", records.ms);
        }).pipe(Effect.provide(McpClient.layer)),
      ),
    { timeout: 180_000 },
  );
});
