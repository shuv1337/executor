/**
 * Self-host organization creation belongs to the owners of the root organization, the one setup
 * created. Owning another organization grants nothing, and neither does a bearer credential:
 * Better Auth's endpoint reads only a browser session.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors, password } from "../support/actors.ts";
import { Api, body, type Session } from "../support/api.ts";
import { HostedLive, withCase, withHostedCase } from "../support/case.ts";
import { Organization, Resource } from "../support/contracts.ts";
import { legacyStorage } from "../support/legacy-storage.ts";
import { serverControl } from "../support/server-control.ts";
import { scenarios } from "../test-plan.ts";

const Access = Schema.Struct({ organization: Schema.String, role: Schema.String });
const Key = Schema.Struct({ key: Schema.RedactedFromValue(Schema.String) });
const Members = Schema.Struct({
  members: Schema.Array(
    Schema.Struct({ role: Schema.String, user: Schema.Struct({ email: Schema.String }) }),
  ),
});
const Configuration = Schema.Struct({ setup: Schema.Boolean });

const create = (session: Session, name: string, headers?: Record<string, string>) =>
  Effect.flatMap(Api, (api) =>
    api.request(
      session,
      "POST",
      "/api/auth/organization/create",
      { name, slug: `team-${randomUUID().slice(0, 8)}`, keepCurrentActiveOrganization: true },
      headers,
    ),
  );

const listed = (session: Session) =>
  Effect.flatMap(Api, (api) =>
    api
      .request(session, "GET", "/api/auth/organization/list")
      .pipe(Effect.flatMap((response) => body(Schema.Array(Organization), response))),
  );

/** The database of an install from before the root record existed. */
const beforeRootRecord = [
  { sql: `drop table "selfHostRoot"` },
  { sql: "drop table private_self_host_migrations" },
] as const;

layer(HostedLive, { excludeTestServices: true })("Self-host organization creation", (it) => {
  it.effect(scenarios.selfHostOrganizationCreationAuthority.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const created = yield* create(actors.owner, "Second team");
        expect(created.status).toBe(200);
        const second = yield* body(Organization, created);
        expect(
          (yield* body(
            Access,
            yield* api.request(actors.owner, "GET", `/api/organizations/${second.id}/access`),
          )).role,
        ).toBe("owner");
        const members = yield* body(
          Members,
          yield* api.request(
            actors.owner,
            "GET",
            `/api/auth/organization/list-members?organizationId=${second.id}`,
          ),
        );
        expect(members.members).toEqual([
          expect.objectContaining({
            role: "owner",
            user: expect.objectContaining({ email: "owner@example.test" }),
          }),
        ]);

        expect((yield* create(actors.admin, "Admin's team")).status).toBe(403);
        expect((yield* create(actors.member, "Member's team")).status).toBe(403);
        const anonymous = yield* api.session();
        expect((yield* create(anonymous, "Anonymous team")).status).toBe(401);
        const key = yield* body(
          Key,
          yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
            name: "Owner key",
          }),
        );
        expect(
          (yield* create(anonymous, "Bearer team", {
            authorization: `Bearer ${Redacted.value(key.key)}`,
          })).status,
        ).toBe(401);

        // Someone outside the root, invited into the new organization, cannot create one.
        const invitation = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", "/api/auth/organization/invite-member", {
            organizationId: second.id,
            email: "outsider@example.test",
            role: "admin",
          }),
        );
        const outsider = yield* api.session();
        expect(
          (yield* api.request(outsider, "POST", "/api/auth/self-host/register", {
            invitation: invitation.id,
            email: "outsider@example.test",
            name: "Out Sider",
            password,
          })).status,
        ).toBe(200);
        expect((yield* listed(outsider)).map((organization) => organization.id)).toEqual([
          second.id,
        ]);
        expect((yield* create(outsider, "Outsider's team")).status).toBe(403);

        // Owning an organization other than the root grants nothing either.
        yield* legacyStorage([
          {
            sql: `update "member" set "role" = 'owner'
              where "organizationId" = $1 and "userId" = (select "id" from "user" where "email" = $2)`,
            params: [second.id, "outsider@example.test"],
          },
        ]);
        yield* serverControl("start");
        expect(
          (yield* body(
            Access,
            yield* api.request(outsider, "GET", `/api/organizations/${second.id}/access`),
          )).role,
        ).toBe("owner");
        expect((yield* create(outsider, "Second owner's team")).status).toBe(403);

        expect(
          (yield* listed(actors.owner)).map((organization) => organization.id).toSorted(),
        ).toEqual([actors.organization.id, second.id].toSorted());
      }),
    ),
  );

  it.effect(scenarios.selfHostOrganizationCreationBootstrap.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const owner = yield* api.session();
        const configuration = (session: Session) =>
          api
            .request(session, "GET", "/api/auth/self-host/config")
            .pipe(Effect.flatMap((response) => body(Configuration, response)));
        expect((yield* configuration(owner)).setup).toBe(true);
        const setup = (session: Session, email: string) =>
          api.request(session, "POST", "/api/auth/self-host/setup", {
            name: "Setup Owner",
            email,
            password,
            organizationName: "Root team",
          });
        expect((yield* setup(owner, "owner@example.test")).status).toBe(200);
        const [root] = yield* listed(owner);
        if (root === undefined) return yield* Effect.die("Setup created no organization");
        expect((yield* configuration(owner)).setup).toBe(false);
        const late = yield* api.session();
        expect((yield* setup(late, "late@example.test")).status).toBe(403);

        expect((yield* create(owner, "Second team")).status).toBe(200);
        expect((yield* create(owner, "Third team")).status).toBe(200);
        expect((yield* setup(late, "late@example.test")).status).toBe(403);

        const [records = []] = yield* legacyStorage([
          { sql: `select "id", "organizationId" from "selfHostRoot"` },
        ]);
        expect(records).toEqual([{ id: "root", organizationId: root.id }]);
        yield* serverControl("start");
        expect((yield* configuration(late)).setup).toBe(false);
        expect((yield* setup(late, "late@example.test")).status).toBe(403);
        expect((yield* create(owner, "Fourth team")).status).toBe(200);
        expect(yield* listed(owner)).toHaveLength(4);
      }),
    ),
  );

  it.effect(scenarios.selfHostOrganizationCreationWithoutRoot.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        // An upgraded install with one organization records it, so its owner creates.
        yield* legacyStorage(beforeRootRecord);
        yield* serverControl("start");
        expect((yield* create(actors.owner, "Second team")).status).toBe(200);

        // One that already holds several has no root, so no one creates, not even setup's owner.
        yield* legacyStorage(beforeRootRecord);
        yield* serverControl("start");
        expect((yield* create(actors.owner, "Third team")).status).toBe(403);
        yield* serverControl("restart");
        expect((yield* create(actors.owner, "Third team")).status).toBe(403);
        expect(yield* listed(actors.owner)).toHaveLength(2);
      }),
    ),
  );
});
