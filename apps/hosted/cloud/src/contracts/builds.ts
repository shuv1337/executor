/** Retained Worker bundles use the shared SDK wire format. */
import {
  RuntimeBuildFailed,
  RuntimeProtocolUnsupported,
  RuntimeAppsDependencyMissing,
  type SourceFiles,
} from "@executor-js/sdk/core";
import {
  RetainedWorkerBuild,
  WorkerBundle as CloudBundle,
  WorkerFramework,
} from "@executor-js/sdk/workerd";
import { Schema, type Effect } from "effect";
import type { RpcCallError } from "alchemy/Rpc";
export { CloudBundle };
export { RetainedWorkerBuild as RetainedCloudBuild } from "@executor-js/sdk/workerd";

/** Private compiler RPC result; no storage handles or caller credentials cross this boundary. */
export const CompiledCloudApp = Schema.Struct({
  bundle: Schema.toType(CloudBundle),
  framework: WorkerFramework,
  protocol: RetainedWorkerBuild.fields.protocol,
  ui: Schema.UndefinedOr(
    Schema.Array(
      Schema.Struct({
        path: Schema.String,
        contentType: Schema.String,
        body: Schema.Uint8Array,
      }),
    ),
  ),
});

/**
 * Decoded build records and frameworks one isolate keeps in memory, in UTF-16 code units of module
 * source plus WASM bytes. Each framework is held once, however many builds link it.
 */
export const isolateBuildCacheSize = 24 * 1024 * 1024;

/** Expected build failures cross the binding as data so the deploy can explain them. */
export const CloudCompileResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: CompiledCloudApp }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Union([
      RuntimeBuildFailed,
      RuntimeProtocolUnsupported,
      RuntimeAppsDependencyMissing,
    ]),
  }),
]);

/** Compiler binding calls fail only with Alchemy transport failures; build failures are results. */
export type CloudCompiler = {
  readonly compile: (
    files: SourceFiles,
    headers: Readonly<Record<string, string>>,
  ) => Effect.Effect<typeof CloudCompileResult.Encoded, RpcCallError>;
};
