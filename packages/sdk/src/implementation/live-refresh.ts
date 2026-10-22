/** Live queries re-run on change notifications, but never more often than once per second. */
import { Clock, Duration, Effect, Result, Stream } from "effect";

/** The shortest time between the starts of two runs of one live query. */
export const liveRefreshSpacing = Duration.seconds(1);

/**
 * Re-run a live query for change notifications at most once per `spacing`.
 *
 * The first notification runs at once, so the first result is never delayed. Notifications that
 * arrive while a run is in flight or spaced out are folded into one with `combine`; the next run
 * starts once `spacing` has passed since the previous one started and reads the newest state, so
 * a burst of writes always ends with a run that sees the last of them. `skip` decides, when the
 * run is due, whether the folded notification was already observed; a skipped notification does
 * not count as a run.
 */
export const refreshAtMostEvery = <N, A, E, R, E2, R2>(
  notifications: Stream.Stream<N, E, R>,
  options: {
    readonly combine: (pending: N, next: N) => N;
    readonly skip?: (notification: N) => boolean;
    readonly run: (notification: N) => Effect.Effect<A, E2, R2>;
    readonly spacing?: Duration.Input;
  },
): Stream.Stream<A, E | E2, R | R2> =>
  Stream.unwrap(
    Effect.sync(() => {
      const spacing = Duration.toMillis(options.spacing ?? liveRefreshSpacing);
      // The folded notification waiting to run. Each buffered wake-up only asks to look at it,
      // so a dropped wake-up never drops a notification.
      let pending: { readonly notification: N } | undefined;
      let lastStarted: number | undefined;
      return notifications.pipe(
        Stream.map((notification) => {
          pending = {
            notification:
              pending === undefined
                ? notification
                : options.combine(pending.notification, notification),
          };
        }),
        Stream.buffer({ capacity: 1, strategy: "sliding" }),
        Stream.filterMapEffect(() =>
          Effect.gen(function* () {
            if (lastStarted !== undefined) {
              const wait = lastStarted + spacing - (yield* Clock.currentTimeMillis);
              if (wait > 0) yield* Effect.sleep(Duration.millis(wait));
            }
            const due = pending;
            pending = undefined;
            if (due === undefined || options.skip?.(due.notification) === true)
              return Result.fail(undefined);
            lastStarted = yield* Clock.currentTimeMillis;
            return Result.succeed(yield* options.run(due.notification));
          }),
        ),
      );
    }),
  );
