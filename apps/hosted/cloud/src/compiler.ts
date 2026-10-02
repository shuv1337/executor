/** Private compiler entry point. The esbuild WASM module belongs only to this Worker. */
import { WorkerEnvironment } from "alchemy/Cloudflare";
import { RuntimeBuildFailed, SourceFiles } from "@executor-js/sdk/core";
import { CloudCompileResult } from "./contracts/builds.ts";
import { withRemoteSpan } from "@executor-js/telemetry";
import { Config, Effect, Option, Predicate, Schema } from "effect";
import { compileCloudApp } from "./implementation/app-build.ts";
import {
  cloudObservability,
  cloudTelemetry,
  telemetryBindings,
} from "./infrastructure/telemetry.ts";
import { AppCompiler } from "./infrastructure/compiler.ts";

const FrameworkAssets = Schema.declare(
  (value): value is { readonly fetch: (request: Request) => Promise<Response> } =>
    Predicate.isObject(value) && "fetch" in value && typeof value.fetch === "function",
);
const FrameworkFiles = Schema.Record(Schema.String, Schema.String);

export default AppCompiler.make(
  Effect.gen(function* () {
    if (globalThis.__ALCHEMY_RUNTIME__) return { main: import.meta.url };
    // Only a test stage deploy supplies its checkout's `apps` package, as this Worker's own assets.
    const framework = yield* Config.String("EXECUTOR_APPS_FRAMEWORK").pipe(Config.option);
    return {
      main: import.meta.url,
      ...(yield* cloudObservability),
      workersDev: false,
      compatibility: { date: "2026-09-08", flags: ["nodejs_compat"] },
      env: yield* telemetryBindings,
      ...(Option.isSome(framework) ? { assets: { directory: framework.value } } : {}),
    };
  }),
  Effect.gen(function* () {
    // Resolved during initialization so Alchemy binds them into the Worker environment. Only local
    // Cloud development and tests set a registry; deployed stages use the public registry. Only a
    // test stage deploy sets an `apps` version, whose package files this Worker serves itself.
    const registry = Option.getOrUndefined(
      yield* Config.String("EXECUTOR_NPM_REGISTRY").pipe(Config.option),
    );
    const version = yield* Config.String("EXECUTOR_APPS_VERSION").pipe(Config.option);
    const env = yield* WorkerEnvironment;
    const files = yield* Effect.cached(
      Effect.gen(function* () {
        const assets = yield* Schema.decodeUnknownEffect(FrameworkAssets)(env.ASSETS);
        const response = yield* Effect.tryPromise(() =>
          assets.fetch(new Request("https://framework.invalid/framework.json")),
        );
        return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(FrameworkFiles))(
          yield* Effect.tryPromise(() => response.text()),
        );
      }).pipe(
        Effect.mapError(
          () => new RuntimeBuildFailed({ stage: "dependencies", dependency: "apps" }),
        ),
      ),
    );
    const host = {
      ...(registry === undefined ? {} : { registry }),
      ...(Option.isSome(version) ? { apps: { version: version.value, files } } : {}),
    };
    return AppCompiler.of({
      compile: (files, headers) =>
        Schema.decodeUnknownEffect(SourceFiles)(files).pipe(
          Effect.mapError(() => new RuntimeBuildFailed({ stage: "source" })),
          Effect.flatMap((files) => compileCloudApp(files, host)),
          Effect.map((value) => ({ ok: true as const, value })),
          Effect.catchTags({
            RuntimeBuildFailed: (error) => Effect.succeed({ ok: false as const, error }),
            RuntimeProtocolUnsupported: (error) => Effect.succeed({ ok: false as const, error }),
            RuntimeAppsDependencyMissing: (error) => Effect.succeed({ ok: false as const, error }),
          }),
          Effect.flatMap(Schema.encodeEffect(CloudCompileResult)),
          Effect.orDie,
          withRemoteSpan(new Request("https://compiler.internal", { headers }), "compiler.compile"),
        ),
    });
  }).pipe(Effect.provide(cloudTelemetry)),
);
