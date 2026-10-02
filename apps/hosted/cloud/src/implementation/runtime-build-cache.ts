/** Private cache of immutable executable builds. Invocation context never enters this store. */
import { type BuildId, type RuntimeBuildUnavailable } from "@executor-js/sdk/core";
import {
  type FrameworkIdentity,
  linkWorkerBuild,
  RetainedFramework,
  type RetainedWorkerBuild,
  StoredWorkerBuild,
} from "@executor-js/sdk/workerd";
import { Effect, FiberSet, Schema, type Scope } from "effect";
import { isolateBuildCacheSize } from "../contracts/builds.ts";

class BuildCacheFailed extends Schema.TaggedError<BuildCacheFailed>()("BuildCacheFailed", {}) {}
const cached = <A>(read: () => Promise<A>) =>
  Effect.tryPromise({ try: read, catch: () => new BuildCacheFailed() });
type Cache = Awaited<ReturnType<typeof caches.open>>;

/**
 * Build records and frameworks decoded in this isolate, least recently used first, in one size
 * budget. Both are immutable code and build metadata only, so any invocation may reuse them. A
 * framework is held once however many records link it, and every load of one of those records
 * refreshes it, so a framework in use outlives the records of builds no longer called.
 */
const memory = new Map<
  string,
  | { readonly record: StoredWorkerBuild; readonly size: number }
  | { readonly framework: RetainedFramework; readonly size: number }
>();
// oxlint-disable-next-line executor/no-module-level-mutable-state -- isolate-wide cache of immutable, credential-free build code, shared by design
let retained = 0;

const recordKey = (build: BuildId) => `build:${build}`;
const frameworkKey = (identity: FrameworkIdentity) => `framework:${identity.sha256}`;
const sizeOf = (modules: StoredWorkerBuild["modules"]) =>
  Object.values(modules).reduce(
    (total, module) =>
      total +
      (typeof module === "string"
        ? module.length
        : "js" in module
          ? module.js.length
          : module.wasm.byteLength),
    0,
  );

const recall = (key: string) => {
  const entry = memory.get(key);
  if (entry === undefined) return undefined;
  memory.delete(key);
  memory.set(key, entry);
  return entry;
};

/** Retain one decoded value, then evict to the size bound. */
const remember = (key: string, entry: NonNullable<ReturnType<typeof recall>>) => {
  // One oversized value would evict every other entry and still not fit.
  if (entry.size > isolateBuildCacheSize || memory.has(key)) return;
  memory.set(key, entry);
  retained += entry.size;
  for (const [oldest, evicted] of memory) {
    if (retained <= isolateBuildCacheSize) break;
    memory.delete(oldest);
    retained -= evicted.size;
  }
};

// Separate from browser assets. No route serves these synthetic URLs. The reader and the
// deploy-time warming address each part through these keys only.
const recordUrl = (origin: string, build: BuildId) =>
  new URL(`/_executor/runtime-build-cache/${encodeURIComponent(build)}`, origin).href;
const frameworkUrl = (origin: string, identity: FrameworkIdentity) =>
  new URL(
    `/_executor/runtime-framework-cache/${encodeURIComponent(`${identity.version}-${identity.sha256}`)}`,
    origin,
  ).href;
const openCache = cached(() => caches.open("executor-private-runtime-builds-v1")).pipe(
  Effect.catchTag("BuildCacheFailed", () => Effect.succeed(undefined)),
);

const encodedRecord = Schema.fromJsonString(StoredWorkerBuild);
const encodedFramework = Schema.fromJsonString(RetainedFramework);

/**
 * Copy one immutable value into the colo's Cache API in `writes`, the caller's event-scoped
 * background set. A failed write is logged and recorded on its span, never returned.
 */
const writeCache = <A>(
  writes: FiberSet.FiberSet,
  cache: Cache,
  url: string,
  part: "record" | "framework",
  schema: Schema.Codec<A, string>,
  value: A,
) =>
  FiberSet.run(
    writes,
    Effect.gen(function* () {
      // Recorded as failed until the put returns, so an interrupted write is not reported stored.
      yield* Effect.annotateCurrentSpan("executor.build.cache_write", "failed");
      // Encode only the retained code/metadata schema. Credentials, query results,
      // bindings, account identity and authorization are supplied per invocation.
      const body = yield* Schema.encodeEffect(schema)(value);
      yield* cached(() =>
        cache.put(
          url,
          new Response(body, {
            headers: {
              "content-type": "application/json",
              "cache-control": "public, max-age=31536000",
            },
          }),
        ),
      );
      yield* Effect.annotateCurrentSpan("executor.build.cache_write", "stored");
    }).pipe(
      Effect.catchTags({
        BuildCacheFailed: () => Effect.logWarning("Runtime build cache write failed"),
        SchemaError: () => Effect.logWarning("Runtime build cache encoding failed"),
      }),
      Effect.withSpan("runtime.cloud.build.cache_write", {
        attributes: { "executor.build.cache_part": part },
      }),
    ),
  );

/**
 * Read one immutable value through the colo's Cache API before authoritative storage, and copy a
 * miss into the cache in the background. The cache is an optimisation: its failures are misses.
 */
const throughCache = <A, E, R>(
  cache: Cache | undefined,
  url: string,
  part: "record" | "framework",
  schema: Schema.Codec<A, string>,
  load: Effect.Effect<A, E, R>,
  writes: FiberSet.FiberSet,
) =>
  Effect.gen(function* () {
    const hit =
      cache === undefined
        ? undefined
        : yield* cached(() => cache.match(url)).pipe(
            Effect.flatMap((response) =>
              response === undefined
                ? Effect.succeed(undefined)
                : cached(() => response.text()).pipe(
                    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
                  ),
            ),
            Effect.catchTags({
              BuildCacheFailed: () => Effect.succeed(undefined),
              SchemaError: () => Effect.succeed(undefined),
            }),
          );
    if (hit !== undefined) return { value: hit, source: "hit" as const };
    const value = yield* load;
    if (cache !== undefined) yield* writeCache(writes, cache, url, part, schema, value);
    return { value, source: "miss" as const };
  });

/**
 * Warm this isolate and the colo's Cache API with a build just retained, under the same keys the
 * reader uses: its record, and its framework unless this isolate already holds it (then it was
 * read or written through the colo cache already). Call only after authoritative storage holds
 * both. The Cache API is per data centre, so other colos still read storage once.
 */
export const cacheRuntimeBuild = (
  writes: FiberSet.FiberSet,
  origin: string,
  build: BuildId,
  stored: { readonly record: RetainedWorkerBuild; readonly framework: RetainedFramework },
) =>
  Effect.gen(function* () {
    const cache = yield* openCache;
    const frameworkHeld = recall(frameworkKey(stored.framework)) !== undefined;
    if (cache !== undefined) {
      yield* writeCache(
        writes,
        cache,
        recordUrl(origin, build),
        "record",
        encodedRecord,
        stored.record,
      );
      if (!frameworkHeld)
        yield* writeCache(
          writes,
          cache,
          frameworkUrl(origin, stored.framework),
          "framework",
          encodedFramework,
          stored.framework,
        );
    }
    if (!frameworkHeld)
      remember(frameworkKey(stored.framework), {
        framework: stored.framework,
        size: sizeOf(stored.framework.modules),
      });
    remember(recordKey(build), { record: stored.record, size: sizeOf(stored.record.modules) });
  });

/**
 * Own writes in the event scope; return a loader that falls back to authoritative storage. A
 * build's record and its framework are cached separately, so a cold build whose framework is
 * already cached reads only its own few kilobytes.
 */
export const cachedRuntimeBuilds = <R>(
  origin: string,
  load: {
    readonly record: (
      build: BuildId,
    ) => Effect.Effect<StoredWorkerBuild, RuntimeBuildUnavailable, R>;
    readonly framework: (
      identity: FrameworkIdentity,
    ) => Effect.Effect<RetainedFramework, RuntimeBuildUnavailable, R>;
  },
): Effect.Effect<
  (build: BuildId) => ReturnType<typeof linkWorkerBuild<RuntimeBuildUnavailable, R>>,
  never,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const writes = yield* FiberSet.make();
    yield* Effect.addFinalizer(() =>
      FiberSet.awaitEmpty(writes).pipe(Effect.timeoutOption("2 seconds"), Effect.asVoid),
    );
    const framework = (identity: FrameworkIdentity) =>
      Effect.gen(function* () {
        const key = frameworkKey(identity);
        yield* Effect.annotateCurrentSpan(
          "executor.build.framework",
          `${identity.version}-${identity.sha256}`,
        );
        const memorized = recall(key);
        if (memorized !== undefined && "framework" in memorized) {
          yield* Effect.annotateCurrentSpan("executor.build.framework_cache", "memory");
          return memorized.framework;
        }
        const { value, source } = yield* throughCache(
          yield* openCache,
          frameworkUrl(origin, identity),
          "framework",
          encodedFramework,
          load.framework(identity),
          writes,
        );
        yield* Effect.annotateCurrentSpan("executor.build.framework_cache", source);
        remember(key, { framework: value, size: sizeOf(value.modules) });
        return value;
      });
    return (build: BuildId) =>
      Effect.gen(function* () {
        const key = recordKey(build);
        const memorized = recall(key);
        if (memorized !== undefined && "record" in memorized) {
          yield* Effect.annotateCurrentSpan("executor.build.cache", "memory");
          return yield* linkWorkerBuild(memorized.record, framework);
        }
        const { value, source } = yield* throughCache(
          yield* openCache,
          recordUrl(origin, build),
          "record",
          encodedRecord,
          load.record(build),
          writes,
        );
        yield* Effect.annotateCurrentSpan("executor.build.cache", source);
        remember(key, { record: value, size: sizeOf(value.modules) });
        return yield* linkWorkerBuild(value, framework);
      }).pipe(
        Effect.tap(() => Effect.annotateCurrentSpan("executor.build.isolate_size", retained)),
        Effect.withSpan("runtime.cloud.build.cached"),
      );
  });
