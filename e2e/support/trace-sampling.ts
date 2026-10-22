/**
 * Product processes the suite starts record every trace, as scenarios read spans of requests they
 * did not mark sampled and of background work. Only the trace sampling scenario sets its own policy.
 */
export const fullTracing = { EXECUTOR_TRACE_SAMPLE_RATE: "1" } as const;
