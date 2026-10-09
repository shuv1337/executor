/** Shared auth and product schema initialization over an acquired SQL client. */
import { selfHostAuthOptions, selfHostAuthSettings } from "./auth-options.ts";
import { migrateHostedSchemas } from "@executor-js/hosted-server/migrations";
import { makeRegistryStorage } from "@executor-js/app-registry";
import { SqlClient } from "effect/sql";
import { Effect, Layer, Redacted } from "effect";
import { AuthDatabase } from "../contracts/database.ts";
import { makeAuthDatabase } from "./auth-database.ts";
/** Acquire one engine and initialize both schemas before exposing services. */
export const selfHostDatabaseSchema = Layer.effect(
  AuthDatabase,
  Effect.gen(function* () {
    const db = yield* makeAuthDatabase;
    const database = AuthDatabase.of({ db, type: "postgres", transaction: true });
    const settings = yield* selfHostAuthSettings;
    yield* migrateHostedSchemas({
      ...selfHostAuthOptions(settings, []),
      database,
      secret: Redacted.value(settings.secret),
    });
    const registry = yield* makeRegistryStorage;
    const sql = yield* SqlClient.SqlClient;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`set local lock_timeout = '5s'`;
        yield* sql`set local statement_timeout = '60s'`;
        yield* registry.migrate;
      }),
    );
    return database;
  }),
);
