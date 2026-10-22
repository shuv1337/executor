/**
 * The product samples traces before they reach its collector: a caller's sampled `traceparent`, a
 * failed operation and a slow trace are always recorded; an ordinary fast trace is recorded only
 * when the trace ID falls under `EXECUTOR_TRACE_SAMPLE_RATE`.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Option, Schedule } from "effect";
import { randomBytes, randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";
import { targetHosts } from "../support/role-hosts.ts";
import { withApps } from "../support/apps-release.ts";

/** Above the scenario's `EXECUTOR_TRACE_SLOW_MS` of 1500; see `test-plan.ts`. */
const slowToolMs = 2000;

const source = `import { defineApp, query, object, router } from "apps";
export default defineApp({}, async () => ({ tools: router({
  fast: query({ input: object({}) }, async () => ({ ok: true })),
  slow: query({ input: object({}) }, async () => {
    await new Promise((resolve) => setTimeout(resolve, ${slowToolMs}));
    return { ok: true };
  }),
  fails: query({ input: object({}) }, async () => { throw new Error("sampling fixture failure"); }),
}) }));`;

/** Deploy the fixture app and return a caller that names each call's trace and sampled flag. */
const sampledTools = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors,
    target = yield* Target;
  const prefix = `/api/organizations/${actors.organization.id}/apps`;
  const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
    name: `Sampling ${randomUUID().slice(0, 8)}`,
    files: [
      { path: "package.json", content: JSON.stringify({ dependencies: withApps() }) },
      { path: "index.ts", content: source },
    ],
  });
  expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
  const app = yield* body(App, deployed);
  yield* Effect.addFinalizer(() =>
    api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.orDie),
  );
  /** Call `tool` in a new trace whose `traceparent` carries `sampled`; return the trace ID. */
  return (tool: "fast" | "slow" | "fails", sampled: boolean) =>
    Effect.gen(function* () {
      const trace = randomBytes(16).toString("hex");
      const response = yield* actors.owner.send(
        "POST",
        `${prefix}/${app.id}/tools/call`,
        { tool, kind: "query", input: {} },
        {
          origin: targetHosts(target).browser,
          traceparent: `00-${trace}-${randomBytes(8).toString("hex")}-${sampled ? "01" : "00"}`,
        },
      );
      // The app's thrown error is the call's failure, answered as a bad gateway.
      expect(response.status, `${tool}: ${JSON.stringify(response.body)}`).toBe(
        tool === "fails" ? 502 : 200,
      );
      if (tool === "fails") expect(response.body).toMatchObject({ _tag: "ToolCallFailed" });
      return trace;
    });
});

/** The trace's delivered spans once its tool call span arrived. */
const delivered = (trace: string) =>
  Effect.gen(function* () {
    const telemetry = yield* Telemetry;
    return yield* telemetry.query(trace).pipe(
      Effect.filterOrFail(
        (found) => found.data.some(({ span }) => span.operationName === "sdk.tools.call"),
        () => `Trace ${trace} has not reached the collector`,
      ),
      Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
    );
  });

/** The local root span the product recorded for the call's request. */
const productRoot = (found: Effect.Success<ReturnType<typeof delivered>>) =>
  found.data.find(
    ({ span }) =>
      span.serviceName.startsWith("executor-") &&
      span.serviceName !== "executor-app" &&
      span.tags["executor.trace.parent_sampled"] !== undefined,
  )?.span;

layer(HostedLive, { excludeTestServices: true })("Trace sampling", (it) => {
  it.effect(scenarios.traceSampling.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const telemetry = yield* Telemetry,
          evidence = yield* Evidence;
        const call = yield* sampledTools;

        // (a) An ordinary fast call that did not ask for sampling. The rate is 0, so no trace ID
        // falls under it.
        const unsampled = yield* call("fast", false);

        // (b) The same call with a sampled traceparent is recorded, with every forwarded app span.
        const requested = yield* call("fast", true);
        const requestedTrace = yield* delivered(requested);
        expect(
          requestedTrace.data.some(({ span }) => span.serviceName === "executor-app"),
          "the app isolate's spans are forwarded",
        ).toBe(true);
        expect(productRoot(requestedTrace)?.tags["executor.trace.sampled_by"]).toBeUndefined();

        // (c) A failed call is recorded whatever its flag, and its root names why.
        const failed = yield* call("fails", false);
        const failedTrace = yield* delivered(failed);
        expect(
          failedTrace.data.find(({ span }) => span.operationName === "sdk.tools.call")?.span.status,
        ).toBe("error");
        expect(
          failedTrace.data.some(({ span }) => span.serviceName === "executor-app"),
          "a kept trace includes the app spans the product held",
        ).toBe(true);
        expect(productRoot(failedTrace)?.tags["executor.trace.sampled_by"]).toBe("error");

        // (d) A slow call is recorded whatever its flag.
        const slow = yield* call("slow", false);
        const slowTrace = yield* delivered(slow);
        const slowRoot = productRoot(slowTrace);
        expect(slowRoot?.tags["executor.trace.sampled_by"]).toBe("slow");
        expect(slowRoot?.durationMs ?? 0).toBeGreaterThanOrEqual(1500);

        // The unsampled fast call ended before every recorded one above, and the exporter sends
        // spans in the order they end. One more sampled call after those proves a later export
        // cycle reached the collector too; the unsampled trace still has nothing in it.
        yield* delivered(yield* call("fast", true));
        const dropped = yield* telemetry.query(unsampled).pipe(Effect.option);
        yield* evidence.json("traces.json", {
          unsampled: Option.getOrUndefined(dropped),
          requested: requestedTrace,
          failed: failedTrace,
          slow: slowTrace,
        });
        expect(
          Option.match(dropped, { onNone: () => 0, onSome: (found) => found.data.length }),
          "the unsampled fast call recorded no spans",
        ).toBe(0);
      }),
    ),
  );

  it.effect(scenarios.traceSamplingAll.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const call = yield* sampledTools;
        // (e) With a rate of 1, a fast call that did not ask for sampling is recorded as before.
        const trace = yield* delivered(yield* call("fast", false));
        expect(trace.data.some(({ span }) => span.serviceName === "executor-app")).toBe(true);
        expect(productRoot(trace)?.tags["executor.trace.sampled_by"]).toBeUndefined();
      }),
    ),
  );
});
