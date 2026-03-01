import { createRunExecutor } from "@executor-v2/engine";
import type { ExecuteRunInput, ExecuteRunResult } from "@executor-v2/sdk";
import * as Effect from "effect/Effect";

import { executeRuntimeRunInConvex } from "./runtime_execution_port";

const runExecutor = createRunExecutor(executeRuntimeRunInConvex);

export const executeRunImpl = (
  input: ExecuteRunInput,
): Effect.Effect<ExecuteRunResult> => runExecutor.executeRun(input);
