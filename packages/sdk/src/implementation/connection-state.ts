/** Persisted connection transitions shared by secrets and OAuth completion. */
import { Clock, type Crypto, Effect, Schema } from "effect";
import {
  AccountConnectionClosed,
  AccountConnectionNotFound,
  AccountConnectionState,
  type GetAccountConnection,
} from "../contracts/account-connection.ts";
import type { Account } from "../contracts/account.ts";
import { StorageError } from "../contracts/shared.ts";
import { StoredConnectionTarget } from "../contracts/storage.ts";
import { applyConnectionTarget } from "./connection-target.ts";
import { query, type Query } from "./database.ts";

/** Parse a stored request and apply its optional owner constraint. */
export const readConnection = (db: Query, input: typeof GetAccountConnection.Type) =>
  Effect.gen(function* () {
    const row = yield* query(() =>
      db.findFirst("accountConnections", { where: (b) => b("id", "=", input.connection) }),
    );
    if (row === null || (input.owner !== undefined && row.owner !== input.owner))
      return yield* new AccountConnectionNotFound(input);
    const state = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(AccountConnectionState))(
      row.state,
    ).pipe(Effect.mapError(() => new StorageError()));
    const target = yield* Schema.decodeUnknownEffect(Schema.NullOr(StoredConnectionTarget))(
      row.target,
    ).pipe(Effect.mapError(() => new StorageError()));
    const now = yield* Clock.currentTimeMillis;
    return {
      ...row,
      target,
      state:
        state.status === "pending" && row.expiresAt.getTime() <= now
          ? { status: "expired" as const }
          : state,
    };
  });
/** Claim by revision inside a transaction, including on databases without explicit row-lock APIs. */
export const lockConnection = (
  db: Query,
  input: typeof GetAccountConnection.Type,
  crypto: Crypto.Crypto,
) =>
  Effect.gen(function* () {
    const claim = yield* crypto.randomUUIDv4.pipe(Effect.mapError(() => new StorageError()));
    while (true) {
      const row = yield* readConnection(db, input);
      if (row.state.status !== "pending") return row;
      yield* query(() =>
        db.updateMany("accountConnections", {
          where: (b) => b.and(b("id", "=", row.id), b("revision", "=", row.revision)),
          set: { revision: claim },
        }),
      );
      const current = yield* readConnection(db, input);
      if (current.revision === claim || current.state.status !== "pending") return current;
    }
  });

/** A parsed connection row. */
export type ConnectionRow = Effect.Success<ReturnType<typeof readConnection>>;
/** Reject a completed, cancelled or expired request. */
export const requireOpen = (input: typeof GetAccountConnection.Type, row: ConnectionRow) =>
  row.state.status === "pending"
    ? Effect.succeed(row)
    : Effect.fail(new AccountConnectionClosed(input));
/** Read and check outside a transaction; transactions check the row returned by `lockConnection`. */
export const openConnection = (db: Query, input: typeof GetAccountConnection.Type) =>
  Effect.flatMap(readConnection(db, input), (row) => requireOpen(input, row));
/**
 * Commit with the account write, never as a later, independently failing update. `claimed` is the
 * row `lockConnection` returned in this transaction. Writers claim the row first, so it is current.
 */
export const finishConnection = (db: Query, claimed: ConnectionRow, account: Account) =>
  Effect.gen(function* () {
    if (claimed.target !== null)
      yield* applyConnectionTarget(db, claimed.target, claimed.provider, account);
    yield* query(() =>
      db.updateMany("accountConnections", {
        where: (b) => b("id", "=", claimed.id),
        set: {
          state: Schema.encodeSync(Schema.toCodecJson(AccountConnectionState))({
            status: "completed",
            account,
          }),
          oauthAttempt: null,
        },
      }),
    );
  });
