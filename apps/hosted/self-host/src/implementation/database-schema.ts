import { organizationPublishers } from "@executor-js/hosted-server/publishers";
/** Shared auth and product schema initialization over an acquired SQL client. */
import { selfHostAuthOptions, selfHostAuthSettings } from "./auth-options.ts";
import { migrateHostedSchemas, migrationFailed } from "@executor-js/hosted-server/migrations";
import { makeRegistryStorage } from "@executor-js/app-registry";
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
    const registry = yield* makeRegistryStorage(yield* organizationPublishers);
    yield* migrateHostedSchemas(
      {
        // Migrations read plugin schemas only. SSO adds none, so this reads no provider metadata.
        ...selfHostAuthOptions(settings, [], null),
        database,
        secret: Redacted.value(settings.secret),
      },
      registry.migrate.pipe(Effect.mapError(migrationFailed("product"))),
    );
    return database;
  }),
);
