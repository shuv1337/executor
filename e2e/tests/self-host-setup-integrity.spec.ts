/**
 * First setup creates the instance's only owner, organization and root record together. Callers
 * racing to set up a fresh instance leave exactly one of each, and a setup that fails partway
 * leaves nothing behind, so a retry starts from an empty instance.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { password } from "../support/actors.ts";
import { Api, body, type Session } from "../support/api.ts";
import { HostedLive, withCase } from "../support/case.ts";
import { Organization } from "../support/contracts.ts";
import { legacyStorage } from "../support/legacy-storage.ts";
import { serverControl } from "../support/server-control.ts";
import { scenarios } from "../test-plan.ts";

const Configuration = Schema.Struct({ setup: Schema.Boolean });

const countQueries = [
  {
    sql: `select
      (select count(*)::int from "user") as users,
      (select count(*)::int from "account") as accounts,
      (select count(*)::int from "organization") as organizations,
      (select count(*)::int from "member") as members,
      (select count(*)::int from "session") as sessions`,
  },
  { sql: `select "id", "organizationId" from "selfHostRoot"` },
] as const;

const setup = (session: Session, index: number) =>
  Effect.flatMap(Api, (api) =>
    api.request(session, "POST", "/api/auth/self-host/setup", {
      name: `Racer ${index}`,
      email: `racer-${index}@example.test`,
      password,
      organizationName: `Race team ${index}`,
    }),
  );

const configuration = (session: Session) =>
  Effect.flatMap(Api, (api) =>
    api
      .request(session, "GET", "/api/auth/self-host/config")
      .pipe(Effect.flatMap((response) => body(Configuration, response))),
  );

layer(HostedLive, { excludeTestServices: true })("Self-host setup integrity", (it) => {
  it.effect(scenarios.selfHostSetupRace.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const sessions = yield* Effect.forEach([0, 1, 2, 3, 4], () => api.session());
        expect((yield* configuration(sessions[0]!)).setup).toBe(true);
        const statuses = yield* Effect.forEach(
          sessions,
          (session, index) => setup(session, index).pipe(Effect.map((response) => response.status)),
          { concurrency: "unbounded" },
        );
        expect(statuses.toSorted()).toEqual([200, 403, 403, 403, 403]);
        const winner = statuses.indexOf(200);
        const organizations = yield* body(
          Schema.Array(Organization),
          yield* api.request(sessions[winner]!, "GET", "/api/auth/organization/list"),
        );
        expect(organizations).toHaveLength(1);
        expect((yield* configuration(sessions[0]!)).setup).toBe(false);

        const [[counts] = [], root = []] = yield* legacyStorage(countQueries);
        expect(counts).toEqual({
          users: 1,
          accounts: 1,
          organizations: 1,
          members: 1,
          sessions: 1,
        });
        expect(root).toEqual([{ id: "root", organizationId: organizations[0]!.id }]);
      }),
    ),
  );

  it.effect(scenarios.selfHostSetupRollback.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        // The membership is the last row setup writes, after the user, account, organization
        // and root record.
        yield* legacyStorage([
          {
            sql: `create function e2e_refuse_member() returns trigger language plpgsql as $$
              begin raise exception 'synthetic setup failure'; end $$`,
          },
          {
            sql: `create trigger e2e_refuse_member before insert on "member"
              for each row execute function e2e_refuse_member()`,
          },
        ]);
        yield* serverControl("start");
        const failed = yield* api.session();
        const first = yield* setup(failed, 1);
        expect(first.status).toBeGreaterThanOrEqual(500);
        expect((yield* configuration(failed)).setup).toBe(true);
        const [[afterFailure] = [], rootAfterFailure = []] = yield* legacyStorage(countQueries);
        expect(afterFailure).toEqual({
          users: 0,
          accounts: 0,
          organizations: 0,
          members: 0,
          sessions: 0,
        });
        expect(rootAfterFailure).toEqual([]);

        yield* legacyStorage([
          { sql: `drop trigger e2e_refuse_member on "member"` },
          { sql: "drop function e2e_refuse_member()" },
        ]);
        yield* serverControl("start");
        const retried = yield* api.session();
        expect((yield* setup(retried, 2)).status).toBe(200);
        const organizations = yield* body(
          Schema.Array(Organization),
          yield* api.request(retried, "GET", "/api/auth/organization/list"),
        );
        expect(organizations).toHaveLength(1);
        const [[afterRetry] = [], rootAfterRetry = []] = yield* legacyStorage(countQueries);
        expect(afterRetry).toEqual({
          users: 1,
          accounts: 1,
          organizations: 1,
          members: 1,
          sessions: 1,
        });
        expect(rootAfterRetry).toEqual([{ id: "root", organizationId: organizations[0]!.id }]);
      }),
    ),
  );
});
