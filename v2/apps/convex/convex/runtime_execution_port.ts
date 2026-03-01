import {
  RuntimeExecutionPortError,
  type ExecuteRuntimeRun,
} from "@executor-v2/engine";
import {
  ToolProviderRegistryService,
  makeRuntimeAdapterRegistry,
  makeToolProviderRegistry,
  type RuntimeExecuteError,
} from "@executor-v2/engine";
import { makeLocalInProcessRuntimeAdapter } from "@executor-v2/runtime-local-inproc";
import { type ExecuteRunInput } from "@executor-v2/sdk";
import * as Effect from "effect/Effect";

const convexRuntimeAdapter = makeLocalInProcessRuntimeAdapter();

const runtimeAdapters = makeRuntimeAdapterRegistry([convexRuntimeAdapter]);
const toolProviders = makeToolProviderRegistry([]);

export const executeRuntimeRunInConvex: ExecuteRuntimeRun = (input: ExecuteRunInput) =>
  Effect.gen(function* () {
    const runtimeAdapter = yield* runtimeAdapters.get(convexRuntimeAdapter.kind).pipe(
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
        message: `Runtime '${convexRuntimeAdapter.kind}' is not available in this convex process.`,
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
        Effect.provideService(ToolProviderRegistryService, toolProviders),
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
