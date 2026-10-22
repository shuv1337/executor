/**
 * Head and tail trace sampling for one process's span exporter.
 *
 * Recording every trace made the bundled collector the busiest process of a self-hosted server.
 * Most traces are short and successful, and nobody reads them. This sampler keeps:
 *
 * - every trace a caller asked for with a sampled `traceparent`, so an operator or a test that
 *   sends one can always read its trace;
 * - a fixed fraction of the rest, chosen from the trace ID alone (the same rule as OpenTelemetry's
 *   `TraceIdRatioBased`). Every process and every request of a trace, including the product's
 *   requests to itself through the app runtime, reaches the same decision without coordination;
 * - every trace in which a span fails or a server span answers 5xx, and every trace that runs for
 *   the slow threshold or longer, whatever its head decision.
 *
 * The last rule is a tail decision. A span of a trace the head decision did not sample is created
 * and timed as usual, and reports `sampled: false` to propagation, but its end is held in memory
 * with the trace. The trace is decided as soon as a span fails, as soon as a span ends at least
 * the slow threshold after the trace's first local root started, or, when its last local root
 * ends, dropped. A kept trace's held spans are exported at once and its later spans directly. The
 * decision is local to this process: a slow product trace keeps the product's spans and the app
 * isolate spans the product forwards (`whenRecorded`), never another process's spans.
 *
 * A local root is a span whose parent is absent or arrived from another process. Held spans per
 * trace are bounded; a trace that keeps opening spans becomes slow and is exported long before the
 * bound. Spans that end after their trace was dropped are dropped too.
 */
import { Cause, Context, Exit, Option, type Tracer } from "effect";
import type { TraceSampling } from "./config.ts";

/** Held span ends per undecided trace; spans beyond it are dropped. */
const heldLimit = 4096;
/** Recently kept traces whose late spans are still exported. */
const keptMemory = 1024;

type Reason = "error" | "slow";

interface Trace {
  decision: "pending" | "keep" | "drop";
  /** When the trace's first local root in this process started. */
  readonly start: bigint;
  /** Local roots still open. The trace is decided when the last one ends. */
  open: number;
  /** Local roots, which record why a tail decision kept their trace. */
  readonly roots: Array<Tracer.Span>;
  held: Array<() => void>;
}

/** One process's sampling decisions; `telemetryLayer` builds one per exporter. */
export interface TraceSampler {
  /** Create a span on the exporting tracer under this sampler's decision. */
  readonly span: (
    tracer: Tracer.Tracer,
    options: Parameters<Tracer.Tracer["span"]>[0],
  ) => Tracer.Span;
  /**
   * Run `record` now when `span`'s trace is recorded, when a tail decision keeps it, or never.
   * Records this process forwards for another runtime, such as an app isolate's spans, use it.
   */
  readonly whenRecorded: (span: Tracer.AnySpan, record: () => void) => void;
}

/** The exporter's sampler, absent when every trace is recorded. */
export const CurrentTraceSampler = Context.Reference<TraceSampler | undefined>(
  "executor/TraceSampler",
  { defaultValue: () => undefined },
);

/** Whether the trace ID's low 52 bits, as a fraction, fall under `rate`. */
export const traceIdSampled = (traceId: string, rate: number): boolean =>
  rate >= 1 || (rate > 0 && Number.parseInt(traceId.slice(-13), 16) / 2 ** 52 < rate);

const failed = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause);

const serverError = (span: Tracer.Span) => {
  if (span.kind !== "server") return false;
  const status = span.attributes.get("http.response.status_code");
  return typeof status === "number" && status >= 500;
};

/** Build a sampler; a rate of 1 still applies the same rules but never holds a span. */
export const makeTraceSampler = (sampling: TraceSampling): TraceSampler => {
  const slow = BigInt(sampling.slowMs) * 1_000_000n;
  const traces = new Map<string, Trace>();
  const kept = new Set<string>();
  const remember = (traceId: string) => {
    kept.add(traceId);
    if (kept.size > keptMemory) kept.delete(kept.values().next().value!);
  };
  const keep = (traceId: string, trace: Trace, reason: Reason) => {
    trace.decision = "keep";
    remember(traceId);
    // Roots end last, so each is still held or open and can carry the reason.
    for (const root of trace.roots) root.attribute("executor.trace.sampled_by", reason);
    const held = trace.held;
    trace.held = [];
    for (const record of held) record();
  };
  const settle = (traceId: string, trace: Trace) => {
    if (trace.open > 0) return;
    if (traces.get(traceId) === trace) traces.delete(traceId);
    if (trace.decision !== "pending") return;
    trace.decision = "drop";
    trace.held = [];
  };

  const span: TraceSampler["span"] = (tracer, options) => {
    const parent = Option.getOrUndefined(options.parent);
    // The exporter records whatever reaches it ended; this sampler decides which ends reach it.
    const inner = tracer.span({ ...options, sampled: true });
    const traceId = inner.traceId;
    const root = parent === undefined || parent._tag === "ExternalSpan";
    // A remote caller's sampled flag is honoured; an unsampled one leaves the decision to the ID.
    const sampled = root
      ? parent?.sampled === true || traceIdSampled(traceId, sampling.rate)
      : parent.sampled;
    let trace: Trace | undefined;
    if (!sampled) {
      trace = traces.get(traceId);
      if (root) {
        if (trace === undefined) {
          trace = { decision: "pending", start: options.startTime, open: 0, roots: [], held: [] };
          traces.set(traceId, trace);
        }
        trace.open += 1;
        trace.roots.push(inner);
      }
    }
    let status: Tracer.SpanStatus = { _tag: "Started", startTime: options.startTime };
    return {
      _tag: "Span",
      get name() {
        return inner.name;
      },
      get spanId() {
        return inner.spanId;
      },
      get traceId() {
        return traceId;
      },
      get parent() {
        return inner.parent;
      },
      get annotations() {
        return inner.annotations;
      },
      get status() {
        return status;
      },
      get attributes() {
        return inner.attributes;
      },
      get links() {
        return inner.links;
      },
      get sampled() {
        return sampled;
      },
      get kind() {
        return inner.kind;
      },
      end: (endTime, exit) => {
        if (status._tag === "Ended") return;
        status = { _tag: "Ended", startTime: status.startTime, endTime, exit };
        if (sampled) return inner.end(endTime, exit);
        // Only the outcome is exported; a held success does not keep its value alive.
        const record = () => inner.end(endTime, Exit.isSuccess(exit) ? Exit.void : exit);
        if (trace === undefined) {
          if (kept.has(traceId)) record();
          return;
        }
        if (trace.decision === "keep") record();
        else if (trace.decision === "pending") {
          if (trace.held.length < heldLimit) trace.held.push(record);
          if (failed(exit) || serverError(inner)) keep(traceId, trace, "error");
          else if (trace.start > 0n && endTime - trace.start >= slow) keep(traceId, trace, "slow");
        }
        if (root) {
          trace.open -= 1;
          settle(traceId, trace);
        }
      },
      attribute: (key, value) => inner.attribute(key, value),
      event: (name, startTime, attributes) => inner.event(name, startTime, attributes),
      addLinks: (links) => inner.addLinks(links),
    };
  };

  return {
    span,
    whenRecorded: (current, record) => {
      if (current.sampled) return record();
      const trace = traces.get(current.traceId);
      if (trace === undefined) {
        if (kept.has(current.traceId)) record();
        return;
      }
      if (trace.decision === "keep") record();
      else if (trace.decision === "pending" && trace.held.length < heldLimit)
        trace.held.push(record);
    },
  };
};
