/**
 * Local-only probe of one object's database connections, by the name the Cloud Worker gives
 * them. Counts them, or terminates them to stand in for a connection the server drops. Never
 * installed in the HTTP server.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Pool } from "pg";
import { Config, Console, Effect, FileSystem, Redacted, Schema } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { LocalDatabaseUrl } from "../cloud/src/contracts/database.ts";

const command = Command.make("database-connections-fixture", {
  configuration: Flag.String("configuration"),
  owner: Flag.String("owner"),
  terminate: Flag.Boolean("terminate").pipe(Flag.withDefault(false)),
}).pipe(
  Command.withHandler((args) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* Config.String("NODE_ENV").pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Literal("test"))),
        );
        // Only one object's connections, so parallel scenarios on the shared database are untouched.
        if (!/^mcp [0-9a-f]{40,64}$/.test(args.owner))
          return yield* Effect.die("Expected an MCP session object's owner name");
        const fs = yield* FileSystem.FileSystem;
        const configuration = yield* fs
          .readFileString(args.configuration)
          .pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.fromJsonString(Schema.Struct({ database: Schema.String })),
              ),
            ),
          );
        const database = yield* Schema.decodeUnknownEffect(LocalDatabaseUrl)(
          Redacted.make(configuration.database),
        );
        const pool = yield* Effect.acquireRelease(
          Effect.sync(() => new Pool({ connectionString: Redacted.value(database), max: 1 })),
          (pool) => Effect.promise(() => pool.end()),
        );
        const name = `executor ${args.owner}`.slice(0, 63);
        const result = yield* Effect.promise(() =>
          pool.query(
            args.terminate
              ? `SELECT count(*) FILTER (WHERE pg_terminate_backend(pid))::int AS connections
                 FROM pg_stat_activity WHERE application_name = $1`
              : `SELECT count(*)::int AS connections FROM pg_stat_activity WHERE application_name = $1`,
            [name],
          ),
        );
        const rows = yield* Schema.decodeUnknownEffect(
          Schema.Tuple([Schema.Struct({ connections: Schema.Number })]),
        )(result.rows);
        yield* Console.log(JSON.stringify(rows[0]));
      }),
    ),
  ),
);

NodeRuntime.runMain(
  Command.run(command, { version: "0.0.0" }).pipe(Effect.provide(NodeServices.layer)),
);
