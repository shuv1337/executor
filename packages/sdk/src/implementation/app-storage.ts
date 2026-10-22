/** Configured-app data dispatch. Platform storage never holds authored rows. */
import { Effect, Schema, Stream } from "effect";
import type { WorkflowHostControls } from "apps/contracts";
import { Json } from "../contracts/shared.ts";
import { HostOperationNotFound, HostToolApprovalRequired } from "apps/contracts";
import {
  AppDataApprovalRequired,
  AppDataFailed,
  AppDataNotFound,
  AppDataVersionSuperseded,
  type AppDataInput,
} from "../contracts/app-data.ts";
import type { Runtime } from "../contracts/runtime.ts";
import type { ExecutorDatabase } from "./storage.ts";
import { database } from "./database.ts";
import { callerContext, resolve, snapshot, type InvocationSnapshot } from "./tools.ts";
import type { makeOAuth } from "./oauth.ts";
import { ownsDatabase, sharesRuntime } from "../contracts/apps.ts";
import { refreshAtMostEvery } from "./live-refresh.ts";

/**
 * Refuse a call pinned to a superseded version of an app with a database. The database follows the
 * active version's migrations, and its data facet holds one build at a time: a page or client left
 * on an old version would run old code against the new schema and, on every refresh, replace the
 * active build's warm facet, so the app's next call would cold-start.
 */
const activeData = <S extends InvocationSnapshot>(input: AppDataInput, state: S) =>
  input.version !== undefined &&
  ownsDatabase(state.version.requirements) &&
  state.version.id !== state.app.activeVersion
    ? Effect.fail(new AppDataVersionSuperseded({ app: state.app.id, version: state.version.id }))
    : Effect.succeed(state);

/** Bind data calls to the current app version and the named accounts. */
export const makeAppData = (
  storage: ExecutorDatabase,
  resolveAccount: ReturnType<typeof makeOAuth>["resolveSelected"],
  runtime: Runtime,
  workflows?: (state: InvocationSnapshot) => WorkflowHostControls,
) => {
  const db = database(storage);
  const execute = (
    kind: "query" | "mutate",
    input: AppDataInput,
    observeRevision?: (revision: number) => void,
    read: ReturnType<typeof snapshot> = snapshot(db, input),
  ) =>
    Effect.gen(function* () {
      const state = yield* read.pipe(Effect.flatMap((state) => activeData(input, state)));
      const accounts = yield* resolve(state, resolveAccount);
      return yield* runtime[kind]({
        build: state.version.build,
        database: ownsDatabase(state.version.requirements),
        sharedRuntime: sharesRuntime(state.version.requirements),
        ...accounts,
        app: state.app.id,
        ...(workflows === undefined ? {} : { workflowControls: workflows(state) }),
        name: input.name,
        input: input.input,
        ...callerContext(state),
        ...(observeRevision === undefined ? {} : { observeRevision }),
      }).pipe(
        Effect.mapError((error) =>
          Schema.is(HostOperationNotFound)(error)
            ? new AppDataNotFound({ app: input.app, name: input.name })
            : Schema.is(HostToolApprovalRequired)(error)
              ? new AppDataApprovalRequired({ app: input.app, name: input.name })
              : new AppDataFailed({ app: input.app, name: input.name }),
        ),
      );
    });
  const changes = runtime.changes;
  return {
    subscribe: (input: AppDataInput) =>
      Effect.succeed(
        changes === undefined
          ? storage.reactivity.subscribe(execute("query", input))
          : Stream.unwrap(
              Effect.sync(() => {
                let observedRevision: number | undefined;
                return Stream.tick("15 seconds").pipe(
                  // A pinned version that is superseded ends the stream at the next tick.
                  Stream.mapEffect(() =>
                    snapshot(db, input).pipe(Effect.flatMap((state) => activeData(input, state))),
                  ),
                  Stream.changesWith((a, b) => a.version.id === b.version.id),
                  Stream.switchMap((state) => {
                    // The version's first query uses the selections just read for it.
                    // Later executions reread them, so they see account changes.
                    let fresh: InvocationSnapshot | undefined = state;
                    const current = Effect.suspend(() => {
                      const known = fresh;
                      fresh = undefined;
                      return known === undefined ? snapshot(db, input) : Effect.succeed(known);
                    });
                    return Stream.merge(
                      // First data does not wait for the notification connection.
                      // The initial notification is skipped only if its writes were
                      // already observed by a successful query. Setup races still reread.
                      Stream.succeed(undefined),
                      !ownsDatabase(state.version.requirements)
                        ? Stream.empty
                        : changes(input.app).pipe(
                            Stream.mapError(
                              () => new AppDataFailed({ app: input.app, name: input.name }),
                            ),
                          ),
                    ).pipe(
                      Stream.merge(Stream.tick("15 seconds").pipe(Stream.drop(1))),
                      // Under a burst of writes each subscriber reruns its query at most once
                      // a second, and the run after the burst reads its last write.
                      (notifications) =>
                        refreshAtMostEvery(notifications, {
                          // A notification without a revision always runs.
                          combine: (pending, next) =>
                            typeof pending === "number" && typeof next === "number"
                              ? Math.max(pending, next)
                              : undefined,
                          skip: (revision) =>
                            typeof revision === "number" &&
                            observedRevision !== undefined &&
                            revision <= observedRevision,
                          run: () =>
                            execute(
                              "query",
                              input,
                              (revision) => {
                                observedRevision = revision;
                              },
                              current,
                            ),
                        }),
                    );
                  }),
                  Stream.changesWith(Schema.toEquivalence(Json)),
                  Stream.zipWithIndex,
                  Stream.map(([value, revision]) => ({ value, revision })),
                );
              }),
            ),
      ).pipe(Effect.withSpan("sdk.data.subscribe")),
    query: (input: AppDataInput) => execute("query", input).pipe(Effect.withSpan("sdk.data.query")),
    mutate: (input: AppDataInput) =>
      execute("mutate", input).pipe(Effect.withSpan("sdk.data.mutate")),
  };
};
