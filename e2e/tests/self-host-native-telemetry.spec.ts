/** Telemetry ingest through the packaged Go/workerd host never stalls product requests. */
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { randomBytes } from "node:crypto";
import { Effect, Fiber, Schedule, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { nativeSelfHost } from "../support/native-self-host.ts";
import { driver } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const attribute = (key: string, value: string) => ({ key, value: { stringValue: value } });

/** One export near the collector's 16 MiB limit: traces of 40 spans with statement-sized tags. */
const traceExport = (spans: number) => {
  const now = BigInt(Date.now()) * 1_000_000n;
  let traceId = hex(16);
  let rootId = hex(8);
  return JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [attribute("service.name", "synthetic-load")] },
        scopeSpans: [
          {
            scope: { name: "synthetic" },
            spans: Array.from({ length: spans }, (_, index) => {
              if (index % 40 === 0) {
                traceId = hex(16);
                rootId = hex(8);
              }
              return {
                traceId,
                spanId: index % 40 === 0 ? rootId : hex(8),
                ...(index % 40 === 0 ? {} : { parentSpanId: rootId }),
                name: ["sql.execute", "storage.query", "http.server POST"][index % 3],
                kind: 1,
                startTimeUnixNano: String(now - 5_000_000n),
                endTimeUnixNano: String(now),
                attributes: [
                  attribute(
                    "db.query.text",
                    `select "id" from "records" where "id" = $1 -- ${hex(32)}`,
                  ),
                  attribute("synthetic.record.id", hex(20)),
                  attribute("synthetic.payload", hex(200)),
                ],
                status: { code: 1 },
              };
            }),
          },
        ],
      },
    ],
  });
};

const Ingested = Schema.Struct({ insertedSpans: Schema.Number });
const DeliveredSpans = Schema.Struct({
  data: Schema.Array(Schema.Struct({ span: Schema.Struct({ serviceName: Schema.String }) })),
});

it.live(scenarios.selfHostNativeTelemetry.title, () =>
  Effect.scoped(
    Effect.gen(function* () {
      const host = yield* nativeSelfHost({});
      const exports = 3;
      const spans = 12_000;
      const body = traceExport(spans);
      expect(Buffer.byteLength(body)).toBeLessThan(16 * 1024 * 1024);
      yield* driver("collector health", () =>
        fetch(`${host.collector}/api/health`).then((response) =>
          response.arrayBuffer().then(() => response.ok),
        ),
      ).pipe(
        Effect.flatMap((ok) => (ok ? Effect.void : Effect.fail("The collector is starting"))),
        Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }),
      );
      const health: number[] = [];
      const poll = yield* driver("product health", () => {
        const started = performance.now();
        return fetch(`${host.origin}/health`)
          .then((response) => response.arrayBuffer())
          .then(() => health.push(performance.now() - started));
      }).pipe(Effect.andThen(Effect.sleep("25 millis")), Effect.forever, Effect.forkScoped);
      const inserted = yield* Effect.forEach(
        Array.from({ length: exports }),
        () =>
          driver("trace export", () =>
            fetch(`${host.collector}/v1/traces`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body,
            }).then((response) => response.json()),
          ).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Ingested)),
            Effect.map((result) => result.insertedSpans),
          ),
        { concurrency: 1 },
      );
      // A health request that waited behind the last export completes just after it.
      yield* Effect.sleep("250 millis");
      yield* Fiber.interrupt(poll);
      expect(inserted).toEqual(Array.from({ length: exports }, () => spans));
      expect(health.length).toBeGreaterThan(0);
      // Storing each export holds the collector's thread for about a second or more. Product
      // requests must not wait behind it.
      expect(Math.max(...health)).toBeLessThan(750);

      // The product still delivers its own spans to the collector in the other process.
      const traceId = hex(16);
      const metadata = yield* driver("traced product request", () =>
        fetch(`${host.origin}/.well-known/oauth-authorization-server`, {
          headers: { traceparent: `00-${traceId}-${hex(8)}-01` },
        }),
      );
      expect(metadata.status).toBe(200);
      const delivered = yield* driver("delivered product spans", () =>
        fetch(`${host.collector}/api/traces/${traceId}/spans`).then((response) => response.json()),
      ).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(DeliveredSpans)),
        Effect.flatMap((trace) =>
          trace.data.some(({ span }) => span.serviceName === "executor-selfhost")
            ? Effect.succeed(trace)
            : Effect.fail("The product span has not reached the collector"),
        ),
        Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
      );
      expect(delivered.data.length).toBeGreaterThan(0);
    }),
  ).pipe(Effect.provide(NodeServices.layer), Effect.provide(FetchHttpClient.layer)),
);
