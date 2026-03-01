import {
  type ExecuteRunInput,
  type ExecuteRunResult,
  createExecutorRunClient,
} from "@executor-v2/sdk";
import { handleMcpHttpRequest } from "@executor-v2/mcp-gateway";
import * as Effect from "effect/Effect";

export const createPmMcpHandler = (
  executeRun: (input: ExecuteRunInput) => Effect.Effect<ExecuteRunResult>,
): ((request: Request) => Promise<Response>) => {
  const runClient = createExecutorRunClient((input) =>
    Effect.runPromise(executeRun(input)),
  );

  return (request: Request) =>
    handleMcpHttpRequest(request, {
      serverName: "executor-v2-pm",
      serverVersion: "0.0.0",
      runClient,
    });
};
