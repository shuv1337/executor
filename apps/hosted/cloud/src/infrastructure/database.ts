/** Database infrastructure belongs to cloud; Docker and local keep their own drivers. */
import * as Output from "alchemy/Output";
import * as Command from "alchemy/Command";
import * as Planetscale from "alchemy/Planetscale";
import { Random } from "alchemy";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { adopt } from "alchemy/AdoptPolicy";
import { retain } from "alchemy/RemovalPolicy";
import { Config, Effect, Option, Redacted } from "effect";
import { developmentDatabase } from "./development.ts";
import { cloudOrigin, testStage, type TestStage } from "./stage.ts";
import { postgresUrl, previewDatabase } from "./preview-database.ts";

/** Both SQL adapters create schema objects as the stable owner, not the rotating login. */
const migrationUrl = (origin: Planetscale.PostgresOrigin) => {
  const url = new URL(Redacted.value(postgresUrl(origin)));
  url.searchParams.set("options", "-c role=postgres");
  return Redacted.make(url.toString());
};

/** Dedicated automated and performance stages may hand fixture authority to a local runner. */
const fixtureStage = /^test-(?:e2e|perf)-/;

/** Provision the preview schema and local fixtures before exposing its runtime URL. */
const preparedPreviewDatabase = (stage: TestStage) =>
  Effect.gen(function* () {
    const preview = yield* previewDatabase(stage);
    const migrations = globalThis.__ALCHEMY_RUNTIME__
      ? yield* Command.Exec.ref("Migrations")
      : yield* Command.Exec("Migrations", {
          command: "node src/migrate.ts",
          env: {
            DATABASE_URL: preview.migrationUrl,
            // The same logical id as `cloudSecrets`, so the job signs with the secret the Worker will verify.
            BETTER_AUTH_SECRET: (yield* Random("AuthSecret")).text,
            BETTER_AUTH_URL: stage.origin,
          },
          memo: false,
          timeout: "5 minutes",
        });
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      const fixtureOutput = yield* Config.String("TEST_STAGE_ACCOUNTS_OUTPUT").pipe(Config.option);
      const fixtureControl = yield* Config.Redacted("TEST_STAGE_FIXTURE_CONTROL").pipe(
        Config.option,
      );
      if (Option.isSome(fixtureControl)) {
        if (!fixtureStage.test(stage.name))
          return yield* Effect.die(
            new Error("Fixture control requires a dedicated test-e2e- or test-perf- stage"),
          );
        yield* Command.Exec("ScenarioFixtures", {
          command: "node scripts/configure-test-fixtures.ts",
          env: {
            ALCHEMY_STAGE: stage.name,
            BETTER_AUTH_URL: stage.origin,
            BETTER_AUTH_SECRET: (yield* Random("AuthSecret")).text,
            TEST_STAGE_FIXTURE_CONTROL: fixtureControl.value,
            TEST_STAGE_DATABASE_BRANCH: preview.branchName,
            TEST_STAGE_DATABASE_USERNAME: preview.username,
            TEST_STAGE_DATABASE_NAME: preview.databaseName,
            DATABASE_URL: Output.all(preview.migrationUrl, migrations.hash).pipe(
              Output.map(([url]) => url),
            ),
          },
          memo: false,
          timeout: "1 minute",
        });
      }
      if (Option.isSome(fixtureOutput)) {
        const fixtureOrganization = yield* Config.String("TEST_STAGE_APP_ORGANIZATION").pipe(
          Config.option,
        );
        if (!stage.name.startsWith("test-e2e-"))
          return yield* Effect.die(
            new Error("Account fixtures require a dedicated test-e2e- stage"),
          );
        yield* Command.Exec("TestAccounts", {
          command: "node scripts/test-accounts.ts",
          env: {
            ALCHEMY_STAGE: stage.name,
            BETTER_AUTH_URL: stage.origin,
            BETTER_AUTH_SECRET: (yield* Random("AuthSecret")).text,
            TEST_STAGE_ACCOUNTS_OUTPUT: fixtureOutput.value,
            TEST_STAGE_DATABASE_BRANCH: preview.branchName,
            TEST_STAGE_DATABASE_USERNAME: preview.username,
            TEST_STAGE_DATABASE_NAME: preview.databaseName,
            ...(Option.isSome(fixtureOrganization)
              ? { TEST_STAGE_APP_ORGANIZATION: fixtureOrganization.value }
              : {}),
            DATABASE_URL: Output.all(preview.migrationUrl, migrations.hash).pipe(
              Output.map(([url]) => url),
            ),
          },
          memo: false,
          timeout: "2 minutes",
        });
      }
    }
    // Depending on the migration hash keeps the Worker from serving an empty schema.
    return Output.all(preview.runtimeUrl, migrations.hash).pipe(Output.map(([url]) => url));
  });

/**
 * Production's PlanetScale database, its roles and the migration job. Workers use the runtime
 * role through PlanetScale's PgBouncer (port 6432), which pools in transaction mode like
 * Hyperdrive did. Only the migration job receives the schema-owner role.
 */
const productionDatabase = Effect.gen(function* () {
  // Inside the Worker only the binding's identity is needed, not provisioning config.
  if (globalThis.__ALCHEMY_RUNTIME__)
    return (yield* Planetscale.PostgresRole.ref("RuntimeRole")).pooledOrigin.pipe(
      Output.map(postgresUrl),
    );
  const settings = yield* Config.all({
    name: Config.String("PLANETSCALE_DATABASE_NAME"),
    clusterSize: Config.String("PLANETSCALE_CLUSTER_SIZE"),
    region: Config.String("PLANETSCALE_REGION"),
    adopt: Config.Boolean("PLANETSCALE_ADOPT_DATABASE").pipe(Config.withDefault(false)),
  });
  const database = yield* Planetscale.PostgresDatabase("Database", {
    name: settings.name,
    clusterSize: settings.clusterSize,
    region: { slug: settings.region },
  }).pipe(adopt(settings.adopt), retain());
  const role = yield* Planetscale.PostgresRole("RuntimeRole", {
    database,
    inheritedRoles: ["pg_read_all_data", "pg_write_all_data"],
  });
  const migrationRole = yield* Planetscale.PostgresRole("MigrationRole", {
    database,
    inheritedRoles: ["postgres"],
  }).pipe(retain());
  const migrations = yield* Command.Exec("Migrations", {
    command: "node src/migrate.ts",
    env: {
      DATABASE_URL: migrationRole.origin.pipe(Output.map(migrationUrl)),
      BETTER_AUTH_URL: yield* cloudOrigin,
      BETTER_AUTH_SECRET: yield* Config.Redacted("BETTER_AUTH_SECRET"),
    },
    memo: false,
    timeout: "5 minutes",
  });
  // Every database consumer waits for the migration, including an existing Worker update.
  return Output.all(role.pooledOrigin, migrations.hash).pipe(
    Output.map(([origin]) => postgresUrl(origin)),
  );
});

/**
 * The runtime database URL: local Postgres in development, the preview's own database on test
 * stages, and PlanetScale in production. Workers connect to it directly over verified TLS.
 * Props are resolved during infrastructure evaluation, never inside a Worker request.
 */
export const databaseInfrastructure = Effect.gen(function* () {
  const context = yield* Effect.serviceOption(AlchemyContext);
  if (Option.isSome(context) && context.value.dev) return yield* developmentDatabase;
  const stage = yield* testStage;
  if (Option.isSome(stage)) return yield* preparedPreviewDatabase(stage.value);
  return yield* productionDatabase;
}).pipe(Effect.orDie);

/** Bind the runtime URL as a Worker secret; callers own their request-scoped SQL pools. */
export const cloudDatabaseConnection = Effect.gen(function* () {
  return { connectionString: yield* Output.named(yield* databaseInfrastructure, "DatabaseUrl") };
});
