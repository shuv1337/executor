import type { ExecuteRunInput, ExecuteRunResult } from "@executor-v2/sdk";
import * as Effect from "effect/Effect";
import * as Either from "effect/Either";

import type { ExecuteRuntimeRun } from "./runtime-execution-port";

export type ExecuteRunOptions = {
  makeRunId?: () => string;
};

export const executeRun = (
  executeRuntimeRun: ExecuteRuntimeRun,
  input: ExecuteRunInput,
  options: ExecuteRunOptions = {},
): Effect.Effect<ExecuteRunResult> =>
  Effect.gen(function* () {
    const runId = options.makeRunId?.() ?? `run_${crypto.randomUUID()}`;

    const runtimeResult = yield* executeRuntimeRun(input).pipe(Effect.either);
    if (Either.isLeft(runtimeResult)) {
      const error = runtimeResult.left;
      return {
        runId,
        status: "failed",
        error: error.details ? `${error.message}: ${error.details}` : error.message,
      } satisfies ExecuteRunResult;
    }

    return {
      runId,
      status: "completed",
      result: runtimeResult.right,
    } satisfies ExecuteRunResult;
  });

export const createRunExecutor = (
  executeRuntimeRun: ExecuteRuntimeRun,
  options: ExecuteRunOptions = {},
): {
  executeRun: (input: ExecuteRunInput) => Effect.Effect<ExecuteRunResult>;
} => ({
  executeRun: (input) => executeRun(executeRuntimeRun, input, options),
});
