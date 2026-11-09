/**
 * A self-host database can hold several organizations before this server lets anyone create one,
 * as after a rollback from a release that did. Their rows are written directly. The root record
 * names the organization setup created; an upgrade records an install's only organization and
 * never picks one among several.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Actors, password } from "../support/actors.ts";
import { Api, body, type Session } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Organization, Resource } from "../support/contracts.ts";
import { legacyStorage } from "../support/legacy-storage.ts";
import { serverControl } from "../support/server-control.ts";
import { scenarios } from "../test-plan.ts";

const Root = Schema.Array(Schema.Struct({ id: Schema.String, organizationId: Schema.String }));
const Journal = Schema.Array(Schema.Struct({ name: Schema.String }));
const Access = Schema.Struct({ organization: Schema.String, role: Schema.String });

const rootQueries = [
  { sql: `select "id", "organizationId", "createdAt" from "selfHostRoot"` },
  { sql: "select name from private_self_host_migrations order by migration_id" },
] as const;

const decodeRoot = ([root = [], journal = []]: ReadonlyArray<
  ReadonlyArray<Readonly<Record<string, unknown>>>
>) =>
  Effect.gen(function* () {
    return {
      root: yield* Schema.decodeUnknownEffect(Root)(root),
      createdAt: root.map((row) => row.createdAt),
      journal: (yield* Schema.decodeUnknownEffect(Journal)(journal)).map((row) => row.name),
    };
  });

/** The database of an install from before the root record existed. */
const beforeRootRecord = [
  { sql: `drop table "selfHostRoot"` },
  { sql: "drop table private_self_host_migrations" },
] as const;

const secondOrganization = (ownerEmail: string) =>
  [
    {
      sql: `insert into "organization" ("id", "name", "slug", "createdAt") values ('org-second', 'Second team', 'second-team', now())`,
    },
    {
      sql: `insert into "member" ("id", "organizationId", "userId", "role", "createdAt")
      select 'member-second-owner', 'org-second', "id", 'owner', now() from "user" where "email" = $1`,
      params: [ownerEmail],
    },
  ] as const;

const signIn = (email: string) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const session = yield* api.session();
    const response = yield* api.request(session, "POST", "/api/auth/sign-in/email", {
      email,
      password,
    });
    return { session, status: response.status };
  });

const access = (session: Session, organization: string) =>
  Effect.flatMap(Api, (api) =>
    api.request(session, "GET", `/api/organizations/${organization}/access`),
  );

layer(HostedLive, { excludeTestServices: true })("Self-host with several organizations", (it) => {
  it.effect(scenarios.selfHostRootRecord.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const root = { id: "root", organizationId: actors.organization.id };
        const setUp = yield* legacyStorage(rootQueries).pipe(Effect.flatMap(decodeRoot));
        expect(setUp.root).toEqual([root]);
        expect(setUp.journal).toEqual(["root_organization"]);

        yield* legacyStorage(beforeRootRecord);
        yield* serverControl("start");
        const upgraded = yield* legacyStorage(rootQueries).pipe(Effect.flatMap(decodeRoot));
        expect(upgraded.root).toEqual([root]);
        expect(upgraded.journal).toEqual(["root_organization"]);

        yield* serverControl("start");
        const repeated = yield* legacyStorage(rootQueries).pipe(Effect.flatMap(decodeRoot));
        expect(repeated).toEqual(upgraded);
        yield* serverControl("start");
        expect((yield* access(actors.owner, actors.organization.id)).status).toBe(200);
      }),
    ),
  );

  it.effect(scenarios.selfHostRootUnsetAmongSeveral.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        yield* legacyStorage([...beforeRootRecord, ...secondOrganization("owner@example.test")]);
        yield* serverControl("start");
        const upgraded = yield* legacyStorage(rootQueries).pipe(Effect.flatMap(decodeRoot));
        expect(upgraded.root).toEqual([]);
        expect(upgraded.journal).toEqual(["root_organization"]);
        yield* serverControl("start");
        expect((yield* access(actors.owner, actors.organization.id)).status).toBe(200);
        expect((yield* access(actors.owner, "org-second")).status).toBe(200);
      }),
    ),
  );

  it.effect(scenarios.selfHostSeveralOrganizations.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const root = actors.organization.id;
        yield* legacyStorage(secondOrganization("owner@example.test"));
        yield* serverControl("start");

        const owner = yield* signIn("owner@example.test");
        expect(owner.status).toBe(200);
        const listed = yield* body(
          Schema.Array(Organization),
          yield* api.request(owner.session, "GET", "/api/auth/organization/list"),
        );
        expect(listed.map((organization) => organization.id).toSorted()).toEqual(
          [root, "org-second"].toSorted(),
        );
        expect((yield* access(actors.member, root)).status).toBe(200);

        // A new person joins the organization whose invitation they redeem, and only that one.
        const invitation = yield* body(
          Resource,
          yield* api.request(owner.session, "POST", "/api/auth/organization/invite-member", {
            organizationId: "org-second",
            email: "newcomer@example.test",
            role: "member",
          }),
        );
        const newcomer = yield* api.session();
        const joined = yield* api.request(newcomer, "POST", "/api/auth/self-host/register", {
          invitation: invitation.id,
          email: "newcomer@example.test",
          name: "New Comer",
          password,
        });
        expect(joined.status).toBe(200);
        const newcomerOrganizations = yield* body(
          Schema.Array(Organization),
          yield* api.request(newcomer, "GET", "/api/auth/organization/list"),
        );
        expect(newcomerOrganizations.map((organization) => organization.id)).toEqual([
          "org-second",
        ]);
        expect(
          yield* body(Access, yield* access(newcomer, "org-second")).pipe(
            Effect.map((value) => value.role),
          ),
        ).toBe("member");
        expect((yield* access(newcomer, root)).status).toBe(403);

        // A member of the root accepts an invitation into the second organization with its role.
        const adminInvitation = yield* body(
          Resource,
          yield* api.request(owner.session, "POST", "/api/auth/organization/invite-member", {
            organizationId: "org-second",
            email: "admin@example.test",
            role: "admin",
          }),
        );
        const accepted = yield* api.request(
          actors.admin,
          "POST",
          "/api/auth/organization/accept-invitation",
          { invitationId: adminInvitation.id },
        );
        expect(accepted.status).toBe(200);
        expect((yield* body(Access, yield* access(actors.admin, "org-second"))).role).toBe("admin");
        expect((yield* body(Access, yield* access(actors.admin, root))).role).toBe("admin");

        // Someone who belongs to no organization cannot sign in.
        const removed = yield* api.request(
          owner.session,
          "POST",
          "/api/auth/organization/remove-member",
          { organizationId: root, memberIdOrEmail: "member@example.test" },
        );
        expect(removed.status).toBe(200);
        expect((yield* signIn("member@example.test")).status).toBe(403);

        // Setup stays closed however many organizations exist, across a restart.
        const config = yield* body(
          Schema.Struct({ setup: Schema.Boolean }),
          yield* api.request(newcomer, "GET", "/api/auth/self-host/config"),
        );
        expect(config.setup).toBe(false);
        const anonymous = yield* api.session();
        const setup = yield* api.request(anonymous, "POST", "/api/auth/self-host/setup", {
          name: "Intruder",
          email: "intruder@example.test",
          password,
          organizationName: "Takeover",
        });
        expect(setup.status).toBe(403);
        yield* serverControl("restart");
        expect((yield* signIn("owner@example.test")).status).toBe(200);
      }),
    ),
  );
});
