/**
 * The offline root-record gate (`scripts/inspect-self-host-root.ts`) run as an operator runs it:
 * a separate Node process over a PGlite data-directory archive and a recorded baseline. The
 * archives are real PGlite dumps with the product's table and column names. Every case checks
 * the exit code, the fixed report, and that neither stream carries rows, SQL errors, stack
 * traces or the session token planted in each archive.
 */
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const root = "org-root-1";
const owners = ["user-owner-a", "user-owner-b"];
const canary = "CANARY-SESSION-TOKEN-7d1f";

const schema = [
  `create table "organization" ("id" text primary key, "name" text not null, "slug" text not null)`,
  `create table "member" ("id" text primary key, "organizationId" text not null, "userId" text not null, "role" text not null)`,
  `create table "session" ("id" text primary key, "token" text not null)`,
  `insert into "session" values ('session-1', '${canary}')`,
];
const rootTable = `create table "selfHostRoot" ("id" text not null, "organizationId" text not null)`;
const journalTable = `create table private_self_host_migrations (migration_id integer primary key, created_at timestamptz not null default now(), name text not null)`;
const organizations = [
  `insert into "organization" values ('${root}', 'Root', 'executor'), ('org-second', 'Second', 'second')`,
  `insert into "member" values
    ('m1', '${root}', 'user-owner-a', 'owner'),
    ('m2', '${root}', 'user-owner-b', 'owner'),
    ('m3', '${root}', 'user-admin', 'admin'),
    ('m4', 'org-second', 'user-outsider', 'owner')`,
];
const recorded = [`insert into "selfHostRoot" values ('root', '${root}')`];
const journal = [
  `insert into private_self_host_migrations (migration_id, name) values (1, 'root_organization')`,
];
/** An upgraded install whose root has two legitimate owners. */
const valid = [...schema, rootTable, journalTable, ...organizations, ...recorded, ...journal];

/** Builds one archive: `node --eval builder <statements.json> <out.tar>`. */
const builder = `
import { readFileSync, writeFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
const [input, output] = process.argv.slice(1);
const db = new PGlite();
try {
  for (const statement of JSON.parse(readFileSync(input, "utf8"))) await db.exec(statement);
  writeFileSync(output, new Uint8Array(await (await db.dumpDataDir("none")).arrayBuffer()));
} finally {
  await db.close();
}
`;

const baseline = (ownerUserIds: readonly string[] = owners, organizationId = root) =>
  JSON.stringify({ version: 1, organizationId, ownerUserIds });

const Report = Schema.Struct({
  gate: Schema.Literals(["pass", "fail", "invalid", "error"]),
  reason: Schema.optionalKey(Schema.String),
  missingOwners: Schema.optionalKey(Schema.Array(Schema.String)),
  unexpectedOwners: Schema.optionalKey(Schema.Number),
  checks: Schema.optionalKey(Schema.Record(Schema.String, Schema.Boolean)),
});

const workspace = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path,
    processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-root-inspection-" });
  let files = 0;
  const file = (contents: string | Uint8Array) =>
    Effect.gen(function* () {
      const target = path.join(directory, `fixture-${files++}`);
      yield* typeof contents === "string"
        ? fs.writeFileString(target, contents)
        : fs.writeFile(target, contents);
      return target;
    });
  /**
   * A PGlite data-directory dump of a database built from `statements`, as export writes it. The
   * dump is made in its own Node process with the repository's pinned PGlite.
   */
  const dump = (statements: readonly string[]) =>
    Effect.gen(function* () {
      const input = yield* file(JSON.stringify(statements));
      const output = `${input}.tar`;
      yield* processes.string(
        ChildProcess.make("node", ["--input-type=module", "--eval", builder, input, output], {
          cwd: path.resolve("."),
        }),
      );
      return yield* fs.readFile(output);
    });
  const archive = (statements: readonly string[]) => Effect.flatMap(dump(statements), file);
  /** Run the gate as `node <script> ...args` from `cwd` and read both streams and the exit code. */
  const run = (args: readonly string[], options: { script?: string; cwd?: string } = {}) =>
    Effect.scoped(
      Effect.gen(function* () {
        const child = yield* processes.spawn(
          ChildProcess.make(
            "node",
            [options.script ?? path.resolve("scripts/inspect-self-host-root.ts"), ...args],
            {
              cwd: options.cwd ?? path.resolve("."),
              env: { PATH: process.env.PATH ?? "" },
              extendEnv: false,
            },
          ),
        );
        const [stdout, stderr, code] = yield* Effect.all(
          [
            child.stdout.pipe(Stream.decodeText(), Stream.mkString),
            child.stderr.pipe(Stream.decodeText(), Stream.mkString),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        for (const leak of [canary, "Error", "    at ", "relation", "select ", "SQLSTATE"])
          expect(stdout + stderr, `output must not contain ${JSON.stringify(leak)}`).not.toContain(
            leak,
          );
        expect(stderr, "nothing is written to stderr").toBe("");
        const report = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Report))(stdout);
        return { code: Number(code), report };
      }),
    );
  return { directory, file, dump, archive, run };
});

it.live(
  "the root gate passes for the recorded organization and every one of its owners",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* workspace;
        const archive = yield* gate.archive(valid);
        const passed = yield* gate.run([archive, yield* gate.file(baseline())]);
        expect(passed.code).toBe(0);
        expect(passed.report).toMatchObject({
          gate: "pass",
          missingOwners: [],
          unexpectedOwners: 0,
        });
        // Owner order in the baseline does not matter.
        const reordered = yield* gate.run([
          archive,
          yield* gate.file(baseline(owners.toReversed())),
        ]);
        expect(reordered.code).toBe(0);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  120_000,
);

it.live(
  "the root gate fails when the owners, the root record or the journal differ from the recording",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* workspace;
        const archive = yield* gate.archive(valid);
        const fails = (
          label: string,
          statements: readonly string[] | string,
          known: string,
          failed: readonly string[],
        ) =>
          Effect.gen(function* () {
            const target =
              typeof statements === "string" ? statements : yield* gate.archive(statements);
            const result = yield* gate.run([target, yield* gate.file(known)]);
            expect(result.code, label).toBe(1);
            expect(result.report.gate, label).toBe("fail");
            const checks = result.report.checks ?? {};
            expect(
              Object.keys(checks)
                .filter((name) => checks[name] === false)
                .toSorted(),
              label,
            ).toEqual([...failed].toSorted());
            return result.report;
          });
        const omitted = yield* fails(
          "a recorded owner omitted",
          archive,
          baseline(["user-owner-a"]),
          ["ownersMatchRecordedSet"],
        );
        expect(omitted).toMatchObject({ missingOwners: [], unexpectedOwners: 1 });
        const added = yield* fails(
          "an owner added to the recording",
          archive,
          baseline([...owners, "user-ghost"]),
          ["ownersMatchRecordedSet"],
        );
        expect(added).toMatchObject({ missingOwners: ["user-ghost"], unexpectedOwners: 0 });
        yield* fails(
          "an admin recorded as an owner",
          archive,
          baseline([...owners, "user-admin"]),
          ["ownersMatchRecordedSet"],
        );
        yield* fails(
          "an unrecorded member holding owner among several roles",
          [...valid, `update "member" set "role" = 'admin,owner' where "id" = 'm3'`],
          baseline(),
          ["ownersMatchRecordedSet"],
        );
        yield* fails(
          "one owner listed twice",
          [...valid, `insert into "member" values ('m5', '${root}', 'user-owner-a', 'owner')`],
          baseline(),
          ["ownerMembershipsUnique"],
        );
        yield* fails(
          "no root record",
          [...schema, rootTable, journalTable, ...organizations, ...journal],
          baseline(),
          ["exactlyOneRootRow", "rootIdIsRoot", "rootIsRecordedOrganization"],
        );
        yield* fails(
          "no root table",
          [...schema, journalTable, ...organizations, ...journal],
          baseline(),
          ["rootTableExists", "exactlyOneRootRow", "rootIdIsRoot", "rootIsRecordedOrganization"],
        );
        yield* fails(
          "two root records",
          [...valid, `insert into "selfHostRoot" values ('root', '${root}')`],
          baseline(),
          ["exactlyOneRootRow", "rootIdIsRoot", "rootIsRecordedOrganization"],
        );
        yield* fails(
          "a root record under another ID",
          [
            ...schema,
            rootTable,
            journalTable,
            ...organizations,
            ...journal,
            `insert into "selfHostRoot" values ('primary', '${root}')`,
          ],
          baseline(),
          ["rootIdIsRoot"],
        );
        // A structurally valid record naming another organization, whose owners would gain
        // creation, against the recorded identity.
        yield* fails(
          "a root record naming another organization",
          [
            ...schema,
            rootTable,
            journalTable,
            ...organizations,
            ...journal,
            `insert into "selfHostRoot" values ('root', 'org-second')`,
          ],
          baseline(),
          ["rootIsRecordedOrganization"],
        );
        yield* fails(
          "a recording of an organization the archive does not have",
          archive,
          baseline(owners, "org-elsewhere"),
          ["rootIsRecordedOrganization", "recordedOrganizationExists", "ownersMatchRecordedSet"],
        );
        yield* fails(
          "no journal",
          [...schema, rootTable, ...organizations, ...recorded],
          baseline(),
          ["journalRecordsRootOrganization"],
        );
        yield* fails(
          "a journal without the root step",
          [...schema, rootTable, journalTable, ...organizations, ...recorded],
          baseline(),
          ["journalRecordsRootOrganization"],
        );
        yield* fails(
          "a journal naming another first step",
          [
            ...schema,
            rootTable,
            journalTable,
            ...organizations,
            ...recorded,
            `insert into private_self_host_migrations (migration_id, name) values (1, 'other')`,
          ],
          baseline(),
          ["journalRecordsRootOrganization"],
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  180_000,
);

it.live("the root gate refuses an invalid invocation or baseline before reading the archive", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const gate = yield* workspace;
      const archive = yield* gate.archive(valid);
      const refused = (label: string, args: readonly string[], reason: string) =>
        Effect.gen(function* () {
          const result = yield* gate.run(args);
          expect(result.code, label).toBe(2);
          expect(result.report, label).toEqual({ gate: "invalid", reason });
        });
      const known = (text: string) => gate.file(text);
      yield* refused(
        "no arguments",
        [],
        "usage: node scripts/inspect-self-host-root.ts <export.tar> <baseline.json>",
      );
      yield* refused(
        "three arguments",
        [archive, archive, archive],
        "usage: node scripts/inspect-self-host-root.ts <export.tar> <baseline.json>",
      );
      yield* refused(
        "a missing baseline",
        [archive, `${gate.directory}/absent.json`],
        "baseline file cannot be read",
      );
      yield* refused("not JSON", [archive, yield* known("{owners")], "baseline is not JSON");
      yield* refused("an array", [archive, yield* known("[]")], "baseline must be an object");
      yield* refused(
        "an extra field",
        [
          archive,
          yield* known(
            JSON.stringify({
              version: 1,
              organizationId: root,
              ownerUserIds: owners,
              trusted: true,
            }),
          ),
        ],
        "baseline must have exactly version, organizationId and ownerUserIds",
      );
      yield* refused(
        "no owners field",
        [archive, yield* known(JSON.stringify({ version: 1, organizationId: root }))],
        "baseline must have exactly version, organizationId and ownerUserIds",
      );
      yield* refused(
        "another version",
        [
          archive,
          yield* known(JSON.stringify({ version: 2, organizationId: root, ownerUserIds: owners })),
        ],
        "baseline version must be 1",
      );
      yield* refused(
        "an empty owner set",
        [archive, yield* known(baseline([]))],
        "baseline ownerUserIds must be a non-empty array",
      );
      yield* refused(
        "a repeated owner",
        [archive, yield* known(baseline(["user-owner-a", "user-owner-a"]))],
        "baseline ownerUserIds must not repeat",
      );
      yield* refused(
        "an owner that is not an ID",
        [archive, yield* known(baseline(["user-owner-a", "x' or '1'='1"]))],
        "baseline ownerUserIds must be IDs",
      );
      yield* refused(
        "a numeric owner",
        [
          archive,
          yield* known(JSON.stringify({ version: 1, organizationId: root, ownerUserIds: [7] })),
        ],
        "baseline ownerUserIds must be IDs",
      );
      yield* refused(
        "an empty organization",
        [archive, yield* known(baseline(owners, ""))],
        "baseline organizationId must be an ID",
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "the root gate reports an unreadable archive, another Postgres or another PGlite as an error",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem,
          path = yield* Path.Path;
        const gate = yield* workspace;
        const known = yield* gate.file(baseline());
        const unusable = (
          label: string,
          args: readonly string[],
          reason: string,
          options?: { script?: string; cwd?: string },
        ) =>
          Effect.gen(function* () {
            const result = yield* gate.run(args, options);
            expect(result.code, label).toBe(3);
            expect(result.report, label).toEqual({ gate: "error", reason });
          });
        yield* unusable(
          "a missing archive",
          [`${gate.directory}/absent.tar`, known],
          "archive file cannot be read",
        );
        yield* unusable(
          "bytes that are not an archive",
          [yield* gate.file(`not a tar ${canary}`), known],
          "archive cannot be loaded as a PGlite data directory",
        );
        // Each PG_VERSION file in the dump says which Postgres wrote that directory; Postgres
        // refuses another. Tar headers are 512-byte aligned and a file's bytes follow its header.
        const versioned = Buffer.from(yield* gate.dump(valid));
        let patched = 0;
        for (
          let at = versioned.indexOf("PG_VERSION\u0000");
          at >= 0;
          at = versioned.indexOf("PG_VERSION\u0000", at + 1)
        ) {
          const contents = Math.floor(at / 512) * 512 + 512;
          if (versioned.subarray(contents, contents + 3).toString() !== "18\n") continue;
          versioned.write("17\n", contents);
          patched++;
        }
        expect(patched, "the dump's PG_VERSION files").toBeGreaterThan(0);
        yield* unusable(
          "a data directory from Postgres 17",
          [yield* gate.file(versioned), known],
          "archive cannot be loaded as a PGlite data directory",
        );

        // The script copied out of the repository cannot resolve PGlite at all.
        const outside = yield* fs.makeTempDirectoryScoped({ prefix: "executor-root-gate-copy-" });
        const copy = path.join(outside, "inspect-self-host-root.ts");
        yield* fs.copyFile(path.resolve("scripts/inspect-self-host-root.ts"), copy);
        const archive = yield* gate.archive(valid);
        yield* unusable("PGlite missing", [archive, known], "PGlite cannot be loaded", {
          script: copy,
          cwd: outside,
        });
        // A PGlite other than the product's pinned one is refused before it opens the archive.
        const stub = path.join(outside, "node_modules/@electric-sql/pglite");
        yield* fs.makeDirectory(stub, { recursive: true });
        yield* fs.writeFileString(
          path.join(stub, "package.json"),
          JSON.stringify({
            name: "@electric-sql/pglite",
            version: "0.4.0",
            type: "module",
            main: "index.js",
          }),
        );
        yield* fs.writeFileString(
          path.join(stub, "index.js"),
          "export class PGlite { constructor() { throw new Error('the stub must not open the archive'); } }\n",
        );
        yield* unusable("PGlite 0.4.0", [archive, known], "PGlite 0.4.0 is not 0.5.8", {
          script: copy,
          cwd: outside,
        });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  120_000,
);
