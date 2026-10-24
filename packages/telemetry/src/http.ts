/** Host-authorized, bounded OTLP ingestion. Authentication/origin policy stays with the product. */
import { ByteSize, Clock, Effect, Option, Tracer } from "effect";
import {
  HttpEffect,
  HttpIncomingMessage,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { forwardTelemetry } from "./relay.ts";
import { recordResponseReady } from "./measurements.ts";
export { isRequestRejection, recordRequestRejections } from "./request-rejection.ts";

/**
 * Expose handler-to-response timing and correlation IDs to the caller.
 * The duration excludes runtime initialization, body streaming and cleanup.
 * Cloudflare advances this clock on I/O; native invocation CPU/wall measurements
 * remain necessary to account for CPU-only work.
 */
export const requestTiming = <E, R>(
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const span = yield* Effect.currentSpan.pipe(Effect.option);
    if (Option.isSome(span))
      yield* Effect.logInfo("executor.request.context").pipe(
        Effect.annotateLogs({
          "executor.trace_id": span.value.traceId,
          "executor.span_id": span.value.spanId,
          "executor.trace_sampled": span.value.sampled,
        }),
      );
    const ray = request.headers["cf-ray"]?.match(/^[a-f0-9]{16,32}(?:-[A-Z]{3})?$/i)?.[0];
    if (ray !== undefined)
      yield* Effect.annotateCurrentSpan("cloudflare.ray_id", ray.replace(/-[A-Z]{3}$/i, ""));
    const start = yield* Clock.currentTimeMillis;
    // The native hook also sees failure responses produced outside the handler.
    yield* HttpEffect.appendPreResponseHandler((_request, response) =>
      Effect.gen(function* () {
        const elapsed = (yield* Clock.currentTimeMillis) - start;
        const path = URL.parse(request.url, "http://executor.internal")?.pathname;
        yield* recordResponseReady(path, request.method, response.status, Math.max(0, elapsed));
        const timings = [`executor;dur=${Math.max(0, elapsed)}`];
        if (Option.isSome(span)) {
          timings.push(`executor-trace;desc="${span.value.traceId}"`);
          timings.push(`executor-span;desc="${span.value.spanId}"`);
          timings.push(`executor-sampled;desc="${span.value.sampled ? "1" : "0"}"`);
        }
        if (ray !== undefined) timings.push(`cf-ray;desc="${ray}"`);
        const existing = response.headers["server-timing"];
        return HttpServerResponse.setHeader(
          response,
          "server-timing",
          [...(existing === undefined ? [] : [existing]), ...timings].join(", "),
        );
      }),
    );
    return yield* handler;
  });

/**
 * Run a browser's request under an unsampled copy of its caller's trace context, so the server's
 * own sampling policy decides which of its spans to keep; only the request's server span keeps
 * the caller's flag. Browsers send `Sec-Fetch-Site` with every request; Node and Bun clients do not
 * (Node's fetch sends only `Sec-Fetch-Mode`), so an API client, test or operator that asks for a
 * trace still gets it. Pages marked every
 * request sampled, including app pages built with an earlier `apps` release, which made the
 * server record every request and live update of every open page.
 */
export const ignoreBrowserSampling = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const span = yield* Effect.option(Effect.currentSpan);
    if (
      request.headers["sec-fetch-site"] === undefined ||
      Option.isNone(span) ||
      !span.value.sampled
    )
      return yield* effect;
    return yield* effect.pipe(
      Effect.withParentSpan(
        Tracer.externalSpan({
          traceId: span.value.traceId,
          spanId: span.value.spanId,
          sampled: false,
        }),
      ),
    );
  });

/** Forward browser events to the host's private destination. Call only after authorizing the origin. */
export const receiveBrowserTelemetry = (signal: "traces" | "logs", build?: string) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (!request.headers["content-type"]?.startsWith("application/json"))
      return HttpServerResponse.empty({ status: 415 });
    const body = yield* request.text.pipe(
      Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(256)),
    );
    yield* forwardTelemetry(
      {
        traces: signal === "traces" ? [body] : [],
        logs: signal === "logs" ? [body] : [],
        dropped: 0,
      },
      undefined,
      { build },
      "executor-web",
    );
    return HttpServerResponse.empty({ status: 202, headers: { "cache-control": "no-store" } });
  }).pipe(
    Effect.catchTags({
      SchemaError: () => Effect.succeed(HttpServerResponse.empty({ status: 400 })),
      HttpClientError: () => Effect.succeed(HttpServerResponse.empty({ status: 502 })),
      TimeoutError: () => Effect.succeed(HttpServerResponse.empty({ status: 504 })),
    }),
  );
