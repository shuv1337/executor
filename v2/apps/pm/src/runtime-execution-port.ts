import {
  RuntimeExecutionPortError,
  type ExecuteRuntimeRun,
} from "@executor-v2/engine";
import {
  ToolProviderRegistryService,
  type RuntimeAdapterRegistry,
  type RuntimeExecuteError,
  type ToolProviderRegistry,
} from "@executor-v2/engine";
import { type ExecuteRunInput } from "@executor-v2/sdk";
import * as Effect from "effect/Effect";

export type PmRuntimeExecutionPortOptions = {
  defaultRuntimeKind: string;
  runtimeAdapters: RuntimeAdapterRegistry;
  toolProviders: ToolProviderRegistry;
};

export const createPmExecuteRuntimeRun = (
  options: PmRuntimeExecutionPortOptions,
): ExecuteRuntimeRun => {
  return (input: ExecuteRunInput) =>
    Effect.gen(function* () {
      const runtimeAdapter = yield* options.runtimeAdapters
        .get(options.defaultRuntimeKind)
        .pipe(
          Effect.mapError(
            (error) =>
              new RuntimeExecutionPortError({
                operation: "resolve_runtime_adapter",
                message: error.message,
                details: null,
              }),
          ),
        );

      const isAvailable = yield* runtimeAdapter.isAvailable();
      if (!isAvailable) {
        return yield* new RuntimeExecutionPortError({
          operation: "runtime_available",
          message: `Runtime '${options.defaultRuntimeKind}' is not available in this pm process.`,
          details: null,
        });
      }

      return yield* runtimeAdapter
        .execute({
          code: input.code,
          timeoutMs: input.timeoutMs,
          tools: [],
        })
        .pipe(
          Effect.provideService(ToolProviderRegistryService, options.toolProviders),
          Effect.mapError(
            (error: RuntimeExecuteError) =>
              new RuntimeExecutionPortError({
                operation: "runtime_execute",
                message: error.message,
                details: error.details,
              }),
          ),
        );
    });
};
