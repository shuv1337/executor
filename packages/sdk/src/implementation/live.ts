/** Live app queries re-resolve the configured app and its selected accounts on every evaluation. */
import { Schema, Effect, Stream } from "effect";
import type { ExecutorOptions } from "../contracts/executor.ts";
import { AppDataInput } from "../contracts/app-data.ts";
import { Json, RequestInvalid } from "../contracts/shared.ts";
import { toEffectRuntime } from "./runtime.ts";
import { createExecutor } from "./create.ts";
import { refreshAtMostEvery } from "./live-refresh.ts";

/** Native host subscription. Hosts must perform their product authorization inside authorize on every run.
 * Calling without authorize is appropriate only for the already-trusted in-process SDK caller.
 */
export const subscribeAppQuery = <E, R>(
  options: ExecutorOptions,
  input: AppDataInput,
  authorize: Effect.Effect<void, E, R> = Effect.void,
) => {
  const read = Effect.gen(function* () {
    const parsed = yield* Schema.decodeUnknownEffect(AppDataInput)(input).pipe(
      Effect.mapError(() => new RequestInvalid()),
    );
    yield* authorize;
    const executor = yield* createExecutor(options);
    return yield* executor.appData.query(parsed);
  });
  const runtime = toEffectRuntime(options.runtime, options.blobs);
  if (runtime.changes === undefined) return options.database.reactivity.subscribe(read);
  // A burst of writes reruns the query at most once a second; the last run reads the last write.
  return refreshAtMostEvery(Stream.merge(runtime.changes(input.app), Stream.tick("15 seconds")), {
    combine: (_pending, next) => next,
    run: () => read,
  }).pipe(
    Stream.changesWith(Schema.toEquivalence(Json)),
    Stream.zipWithIndex,
    Stream.map(([value, revision]) => ({ value, revision })),
  );
};
