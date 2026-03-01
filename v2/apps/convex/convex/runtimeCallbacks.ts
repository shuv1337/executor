import {
  createRuntimeToolCallHandler,
  createUnimplementedRuntimeToolInvoker,
} from "@executor-v2/engine";
import type { RuntimeToolCallResult } from "@executor-v2/sdk";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as ParseResult from "effect/ParseResult";
import * as Schema from "effect/Schema";

import { httpAction, type ActionCtx } from "./_generated/server";
import { createConvexResolveToolCredentials } from "./credential_resolver";

class RuntimeToolCallBadRequestError extends Data.TaggedError(
  "RuntimeToolCallBadRequestError",
)<{
  message: string;
  details: string;
}> {}

const RuntimeToolCallCredentialContextSchema = Schema.Struct({
  workspaceId: Schema.String,
  sourceKey: Schema.String,
  organizationId: Schema.optional(Schema.NullOr(Schema.String)),
  accountId: Schema.optional(Schema.NullOr(Schema.String)),
});

const RuntimeToolCallRequestSchema = Schema.Struct({
  runId: Schema.String,
  callId: Schema.String,
  toolPath: Schema.String,
  input: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: Schema.Unknown,
    }),
  ),
  credentialContext: Schema.optional(RuntimeToolCallCredentialContextSchema),
});

const decodeRuntimeToolCallRequest = Schema.decodeUnknown(RuntimeToolCallRequestSchema);

const badRequest = (message: string): Response =>
  Response.json(
    {
      ok: false,
      kind: "failed",
      error: message,
    } satisfies RuntimeToolCallResult,
    { status: 400 },
  );

const formatBadRequestMessage = (error: RuntimeToolCallBadRequestError): string =>
  error.details.length > 0 ? `${error.message}: ${error.details}` : error.message;

const formatUnknownDetails = (cause: unknown): string => String(cause);

const handleToolCallHttpEffect = (
  ctx: ActionCtx,
  request: Request,
): Effect.Effect<Response, never> => {
  const resolveCredentials = createConvexResolveToolCredentials(ctx);
  const invokeRuntimeTool = createUnimplementedRuntimeToolInvoker("convex");
  const handleToolCall = createRuntimeToolCallHandler({
    resolveCredentials,
    invokeRuntimeTool,
  });

  return Effect.gen(function* () {
    const body = yield* Effect.tryPromise({
      try: () => request.json(),
      catch: (cause) =>
        new RuntimeToolCallBadRequestError({
          message: "Invalid runtime callback request body",
          details: formatUnknownDetails(cause),
        }),
    });

    const input = yield* decodeRuntimeToolCallRequest(body).pipe(
      Effect.mapError(
        (cause) =>
          new RuntimeToolCallBadRequestError({
            message: "Runtime callback request body is invalid",
            details: ParseResult.TreeFormatter.formatErrorSync(cause),
          }),
      ),
    );

    const result = yield* handleToolCall(input);
    return Response.json(result, { status: 200 });
  }).pipe(
    Effect.catchTag("RuntimeToolCallBadRequestError", (error) =>
      Effect.succeed(badRequest(formatBadRequestMessage(error))),
    ),
  );
};

export const handleToolCallHttp = httpAction((ctx, request) =>
  Effect.runPromise(handleToolCallHttpEffect(ctx, request)),
);
