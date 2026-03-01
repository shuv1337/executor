import {
  createRuntimeToolCallHandler,
  createUnimplementedRuntimeToolInvoker,
} from "@executor-v2/engine";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { createPmResolveToolCredentials } from "./credential-resolver";

const emptyLocalStateStore = {
  getSnapshot: () => Effect.succeed(Option.none()),
  writeSnapshot: () => Effect.void,
  readEvents: () => Effect.succeed([]),
  appendEvents: () => Effect.void,
};

describe("PM runtime tool-call handling", () => {
  it.effect("returns failed callback result for unimplemented invoker", () =>
    Effect.gen(function* () {
      const resolveCredentials = createPmResolveToolCredentials(emptyLocalStateStore);
      const invokeRuntimeTool = createUnimplementedRuntimeToolInvoker("pm");
      const handleToolCall = createRuntimeToolCallHandler({
        resolveCredentials,
        invokeRuntimeTool,
      });

      const result = yield* handleToolCall({
        runId: "run_2",
        callId: "call_2",
        toolPath: "tools.example.weather",
        input: { city: "London" },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe("failed");
        expect(result.error).toContain("tools.example.weather");
      }
    }),
  );
});
