/**
 * An app with a database runs one build against it, at the active version's schema. A data call
 * or live query that names a superseded version is refused instead of running that build's code
 * against the migrated database, and a live query left on the old version ends; calls of the
 * active version keep working.
 */
import { expect, layer } from "@effect/vitest";
import { Clock, Deferred, Effect, Redacted, Ref, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";
import { withApps } from "../support/apps-release.ts";

const source = (label: string) => [
  { path: "package.json", content: JSON.stringify({ dependencies: withApps({}) }) },
  {
    path: "index.ts",
    content: `import { defineApp, mutation, number, object, query, router, string } from "apps";
export const latest = query({ input: object({}), output: object({ count: number(), label: string() }) },
  async ({ sql }) => ({ ...sql.exec("SELECT COUNT(*) AS count FROM writes").one(), label: ${JSON.stringify(label)} }));
export const write = mutation({ input: object({ n: number() }), output: number() }, async ({ sql }, { n }) => {
  sql.exec("INSERT INTO writes (n) VALUES (?)", n); return n;
});
export default defineApp({}, { tools: router({ latest, write }) });`,
  },
  { path: "migrations/0001_writes.sql", content: "CREATE TABLE writes (n INTEGER NOT NULL);\n" },
];

const Active = Schema.Struct({ activeVersion: Schema.String });
const Latest = Schema.Struct({ count: Schema.Number, label: Schema.String });
const Refusal = Schema.Struct({
  _tag: Schema.Literal("AppDataVersionSuperseded"),
  version: Schema.String,
  active: Schema.NullOr(Schema.String),
});

layer(HostedLive, { excludeTestServices: true })("Superseded data version", (it) => {
  it.effect(scenarios.appSupersededDataVersion.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence,
          target = yield* Target;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Superseded data ${randomUUID().slice(0, 8)}`,
          files: source("first"),
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.orDie),
        );
        const active = api
          .request(actors.owner, "GET", `${prefix}/${app.id}`)
          .pipe(Effect.flatMap((response) => body(Active, response)));
        const data = (kind: "query" | "mutate", name: string, input: object, version?: string) =>
          api.request(actors.owner, "POST", `${prefix}/${app.id}/data/${kind}`, {
            name,
            input,
            ...(version === undefined ? {} : { version }),
          });
        const first = (yield* active).activeVersion;
        const pinnedFirst = yield* data("query", "latest", {}, first);
        expect(pinnedFirst.status, JSON.stringify(pinnedFirst.body)).toBe(200);
        expect(yield* body(Latest, pinnedFirst)).toEqual({ count: 0, label: "first" });

        // A client keeps a live query open on the first version, as a page or watcher would.
        const key = yield* body(
          Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
          yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
            name: "Superseded data",
          }),
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
            .pipe(Effect.ignore),
        );
        const http = yield* HttpClient.HttpClient;
        const received = yield* Ref.make("");
        const firstValue = yield* Deferred.make<void>();
        const closed = yield* Deferred.make<number>();
        const request = HttpClientRequest.post(
          new URL(`${prefix}/${app.id}/data/subscribe`, target.metadata.origin),
          { headers: { accept: "text/event-stream" } },
        ).pipe(
          HttpClientRequest.bearerToken(Redacted.value(key.key)),
          HttpClientRequest.bodyJsonUnsafe({ name: "latest", input: {}, version: first }),
        );
        yield* http.execute(request).pipe(
          Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
          Effect.flatMap((response) =>
            response.stream.pipe(
              Stream.decodeText,
              Stream.runForEach((text) =>
                Ref.updateAndGet(received, (all) => all + text).pipe(
                  Effect.flatMap((all) =>
                    all.includes('"label":"first"')
                      ? Deferred.succeed(firstValue, undefined)
                      : Effect.void,
                  ),
                ),
              ),
            ),
          ),
          Effect.ignore,
          Effect.andThen(Clock.currentTimeMillis),
          Effect.flatMap((at) => Deferred.succeed(closed, at)),
          Effect.scoped,
          Effect.provideService(HttpClient.TracerPropagationEnabled, false),
          Effect.forkScoped,
        );
        yield* Deferred.await(firstValue).pipe(Effect.timeout("15 seconds"));

        const redeployed = yield* api.request(actors.owner, "POST", `${prefix}/${app.id}/deploy`, {
          files: source("second"),
        });
        expect(redeployed.status, JSON.stringify(redeployed.body)).toBe(200);
        const second = (yield* active).activeVersion;
        expect(second).not.toBe(first);
        const supersededAt = yield* Clock.currentTimeMillis;

        // The active version serves, named or not, and its write wakes the old live query.
        const written = yield* data("mutate", "write", { n: 1 });
        expect(written.status, JSON.stringify(written.body)).toBe(200);
        const unpinned = yield* data("query", "latest", {});
        expect(yield* body(Latest, unpinned)).toEqual({ count: 1, label: "second" });
        const pinnedSecond = yield* data("query", "latest", {}, second);
        expect(yield* body(Latest, pinnedSecond)).toEqual({ count: 1, label: "second" });

        // The superseded version's code no longer runs against the database.
        for (const [kind, name, input] of [
          ["query", "latest", {}],
          ["mutate", "write", { n: 2 }],
        ] as const) {
          const refused = yield* data(kind, name, input, first);
          expect(refused.status, `${kind} pinned to the superseded version`).toBe(409);
          // The refusal names both versions and says how to recover.
          expect(yield* body(Refusal, refused)).toMatchObject({ version: first, active: second });
          expect(JSON.stringify(refused.body)).toContain("Retry the call without a version");
        }
        expect(yield* body(Latest, yield* data("query", "latest", {}))).toEqual({
          count: 1,
          label: "second",
        });

        // The live query left on the old version ends instead of running it again.
        const closedAt = yield* Deferred.await(closed).pipe(Effect.timeout("20 seconds"));
        const text = yield* Ref.get(received);
        yield* evidence.json("superseded-live-query.json", {
          closedAfterMs: closedAt - supersededAt,
          received: text.slice(-2_000),
        });
        expect(text).toContain("AppDataVersionSuperseded");
        expect(text).not.toContain('"label":"second"');
      }),
    ),
  );
});
