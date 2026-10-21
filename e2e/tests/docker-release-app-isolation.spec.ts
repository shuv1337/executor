/**
 * App code runs in its own workerd process. An app isolate in a synchronous loop holds that
 * process's only JavaScript thread, so the host restarts the app process alone: the product,
 * dashboard API and MCP discovery keep answering throughout, the container never restarts, and
 * other apps answer again once the app process is back.
 */
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Fiber, Schedule, Schema } from "effect";
import { appsManifest } from "../support/apps-release.ts";
import { releasedServerWith } from "../support/docker-release-server.ts";

const spinner = `import { defineApp, object, query, router } from "apps";
export default defineApp({}, { tools: router({
  spin: query({ input: object({}) }, async () => { for (;;) {} }),
}) });`;
const steady = `import { defineApp, object, query, router } from "apps";
export default defineApp({}, { tools: router({
  ping: query({ input: object({}) }, async () => "pong"),
}) });`;

it.live("released image restarts only the app process when an app isolate spins", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* releasedServerWith({
        environment: { EXECUTOR_APP_WATCHDOG_INTERVAL: "1", EXECUTOR_APP_WATCHDOG_FAILURES: "3" },
        restart: "unless-stopped",
      });
      const spinning = yield* server.deploy("Spinner", [
        { path: "index.ts", content: spinner },
        appsManifest,
      ]);
      const other = yield* server.deploy("Steady", [
        { path: "index.ts", content: steady },
        appsManifest,
      ]);
      const ping = server.json(
        Schema.Literal("pong"),
        `${server.prefix}/apps/${other.id}/tools/call`,
        {
          tool: "ping",
          kind: "query",
          input: {},
        },
      );
      const answers = (route: string) =>
        server.request(route).pipe(
          Effect.timeout("3 seconds"),
          Effect.map((response) => response.status === 200),
          Effect.orElseSucceed(() => false),
        );
      expect(yield* ping).toBe("pong");

      const call = yield* Effect.forkScoped(
        server
          .request(`${server.prefix}/apps/${spinning.id}/tools/call`, {
            tool: "spin",
            kind: "query",
            input: {},
          })
          .pipe(Effect.asVoid, Effect.timeout("90 seconds")),
      );
      // Until the app process restarts, the product and its API keep answering: every check passes.
      const started = Date.now();
      let checks = 0;
      while (Date.now() - started < 15_000) {
        expect(yield* answers("/health"), "the product answers while an app spins").toBe(true);
        expect(yield* answers("/api/auth/organization/list"), "the API answers").toBe(true);
        checks += 1;
        yield* Effect.sleep("500 millis");
      }
      expect(checks).toBeGreaterThan(10);
      // The spinning call ends with an error once its process is restarted, instead of hanging.
      const ended = yield* Fiber.await(call);
      expect(Exit.isSuccess(ended), "the spinning call returns").toBe(true);
      // The other app answers again, and the container itself never restarted.
      yield* ping.pipe(Effect.retry({ schedule: Schedule.spaced("1 second"), times: 45 }));
      expect(yield* server.restartCount).toBe(0);
      expect(yield* server.logs).toContain(
        "the app process did not answer 3 health checks in a row",
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

const spinningStep = `import { defineApp, workflow, object } from "apps";
export default defineApp({}, {
  workflows: {
    stuck: workflow({ input: object({}) }, async (ctx) => {
      await ctx.step.do("spin", { retries: { limit: 1, delay: "1 second" }, timeout: "10 minutes" }, async () => { for (;;) {} });
      return "unreachable";
    }),
  },
});`;
const Run = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  error: Schema.optionalKey(Schema.String),
});

// A step that stops its process on every attempt would otherwise run again after each restart
// forever: the engine retries it without checking the step's retry limit after a restart.
it.live(
  "a workflow step that keeps stopping the app process ends the run after its retry limit",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* releasedServerWith({
          environment: { EXECUTOR_APP_WATCHDOG_INTERVAL: "1", EXECUTOR_APP_WATCHDOG_FAILURES: "3" },
          restart: "unless-stopped",
        });
        const app = yield* server.deploy("Stuck step", [
          { path: "index.ts", content: spinningStep },
          appsManifest,
        ]);
        const runs = `${server.prefix}/apps/${app.id}/workflow-runs`;
        const started = yield* server.json(Run, runs, {
          workflow: "stuck",
          input: {},
          key: `stuck-${Date.now()}`,
        });
        const finished = yield* server.json(Run, `${runs}/${started.id}`).pipe(
          Effect.flatMap((run) =>
            ["complete", "errored", "terminated"].includes(run.status)
              ? Effect.succeed(run)
              : Effect.fail(run),
          ),
          Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 90 }),
        );
        expect(finished.status).toBe("errored");
        // Each attempt stopped the app process once: two attempts for a limit of 1, then it ends.
        const restarts = (yield* server.logs).split("the app process did not answer").length - 1;
        expect(restarts).toBeGreaterThanOrEqual(1);
        expect(restarts).toBeLessThanOrEqual(3);
        // The product stayed up throughout.
        expect(yield* server.restartCount).toBe(0);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
