/** Self-host publications share a pinned snapshot only within the authenticated organization. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { App } from "../support/contracts.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { holdQuery } from "../support/query-transition.ts";
import { scenarios } from "../test-plan.ts";
import { withApps } from "../support/apps-release.ts";

const Publication = Schema.Struct({ name: Schema.String, commit: Schema.String });
const Files = Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String }));
const Workspace = Schema.Struct({
  revision: Schema.Struct({ commit: Schema.String }),
  files: Files,
});

layer(HostedLive, { excludeTestServices: true })("Team registry", (it) => {
  it.effect(scenarios.teamRegistry.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const name = `@${actors.organization.slug}/team-${randomUUID().slice(0, 8)}`;
        const files = [
          { path: "README.md", content: "The reviewed team snapshot" },
          {
            path: "index.ts",
            content: 'import {defineApp} from "apps"; export default defineApp({accounts:{}},{});',
          },
          {
            path: "package.json",
            content: JSON.stringify({
              name,
              description: "Team registry example",
              dependencies: withApps(),
            }),
          },
        ];
        const created = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: "Team example",
          files,
        });
        expect(created.status).toBe(200);
        const app = yield* body(App, created);
        const source = yield* body(
          Workspace,
          yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/workspace`),
        );
        const commit = source.revision.commit;
        const query = `name=${encodeURIComponent(name)}&commit=${commit}`;
        // Self-host admits only its configured organization; another organization must fail closed.
        const foreign = `/api/organizations/other-${randomUUID()}`;
        yield* browser.login(actors.owner);
        yield* browser.use("Open the unpublished team app", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}`),
        );
        yield* browser.use("Preview team publication", (page) =>
          page.getByRole("button", { name: "Publish", exact: true }).click(),
        );
        yield* browser.use("Explain the actual audience", (page) =>
          page
            .getByRole("dialog")
            .getByText("Only signed-in members of your organization can access these files.", {
              exact: true,
            })
            .waitFor(),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const held = yield* holdQuery(
              [actors.organization.id, actors.organization.slug].map(
                (id) => `/api/organizations/${id}/apps/${app.id}/publication`,
              ),
              "continue",
              { method: "POST" },
            );
            yield* browser.use("Publish the reviewed snapshot", (page) =>
              page.getByRole("button", { name: "Publish app", exact: true }).click(),
            );
            yield* held.requested;
            expect(
              yield* browser.use("Prevent closing during publication", (page) =>
                page
                  .getByRole("dialog")
                  .getByRole("button", { name: "Cancel", exact: true })
                  .isDisabled(),
              ),
            ).toBe(true);
            yield* held.release;
            yield* browser.use("Publication completes in the same dialog", (page) =>
              page
                .getByRole("dialog")
                .getByText("Your app is published", { exact: true })
                .waitFor(),
            );
          }),
        );
        yield* browser.checkpoint("Organization-only publication completed");
        const listings = yield* api.request(actors.member, "GET", `${prefix}/app-publications`);
        expect(listings.status).toBe(200);
        expect(yield* body(Schema.Array(Publication), listings)).toEqual([{ name, commit }]);
        const snapshot = yield* api.request(
          actors.member,
          "GET",
          `${prefix}/app-publications/source?${query}`,
        );
        expect(snapshot.status).toBe(200);
        expect((yield* body(Schema.Struct({ files: Files }), snapshot)).files).toEqual(files);
        expect(
          (yield* api.request(actors.member, "POST", `${prefix}/apps/${app.id}/publication`, {
            commit,
          })).status,
        ).toBe(403);
        expect(
          (yield* api.request(actors.member, "POST", `${prefix}/app-publications/unpublish`, {
            package: name,
          })).status,
        ).toBe(403);
        expect(
          (yield* api.request(actors.member, "POST", `${prefix}/apps/copies`, {
            name: "Member copy",
            from: { package: name, commit },
          })).status,
        ).toBe(200);
        const anonymous = yield* api.session();
        expect((yield* api.request(anonymous, "GET", `${prefix}/app-publications`)).status).toBe(
          401,
        );
        expect(
          (yield* api.request(anonymous, "GET", `${prefix}/app-publications/source?${query}`))
            .status,
        ).toBe(401);
        for (const path of ["/api/registry/apps", `/api/registry/source?${query}`]) {
          const status = yield* api.request(anonymous, "GET", path).pipe(
            Effect.map((response) => response.status),
            Effect.catchTag("RequestFailed", (error) =>
              error.status === undefined ? Effect.fail(error) : Effect.succeed(error.status),
            ),
          );
          expect(status).toBe(404);
        }
        expect(
          (yield* api.request(actors.owner, "GET", `${foreign}/app-publications`)).status,
        ).toBe(403);
        const foreignSource = yield* api.request(
          actors.owner,
          "GET",
          `${foreign}/app-publications/source?${query}`,
        );
        expect(foreignSource.status).toBe(403);
        expect(
          (yield* api.request(actors.owner, "POST", `${foreign}/apps/copies`, {
            name: "Cross-organization copy",
            from: { package: name, commit },
          })).status,
        ).toBe(403);
        expect(
          (yield* api.request(actors.member, "GET", `${foreign}/app-publications`)).status,
        ).toBe(403);
        // Working changes remain private until explicitly republished.
        const edited = files.map((file) =>
          file.path === "README.md" ? { ...file, content: "Unpublished changes" } : file,
        );
        expect(
          (yield* api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/commits`, {
            expected: commit,
            files: edited,
            message: "Private edit",
          })).status,
        ).toBe(200);
        expect(
          (yield* body(
            Schema.Struct({ files: Files }),
            yield* api.request(actors.member, "GET", `${prefix}/app-publications/source?${query}`),
          )).files,
        ).toEqual(files);
        yield* browser.use("Close publication dialog", (page) =>
          page.getByRole("button", { name: "Done", exact: true }).click(),
        );
        yield* browser.use("Find the team app in Add app", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/add`),
        );
        yield* browser.use("Search the team registry", (page) =>
          page.getByPlaceholder("Search apps").fill(name),
        );
        yield* browser.use("Select the published team app", (page) =>
          page.getByRole("button").filter({ hasText: name }).click(),
        );
        yield* browser.use("Name an independent copy", (page) =>
          page.getByLabel("App name", { exact: true }).fill("Team installed copy"),
        );
        yield* browser.use("Install the selected publication", (page) =>
          page.getByRole("button", { name: "Make a copy", exact: true }).click(),
        );
        yield* browser.use("Copy opens its own app", (page) =>
          page.waitForURL(/\/apps\/app_[^/?]+/),
        );
        const apps = yield* body(
          Schema.Array(App),
          yield* api.request(actors.owner, "GET", `${prefix}/apps`),
        );
        const copied = apps.find((candidate) => candidate.name === "Team installed copy");
        expect(copied).toBeDefined();
        if (!copied) return yield* Effect.die(new Error("The installed copy must exist"));
        expect(copied.id).not.toBe(app.id);
        expect(
          (yield* body(
            Workspace,
            yield* api.request(actors.owner, "GET", `${prefix}/apps/${copied.id}/workspace`),
          )).files,
        ).toEqual(files);
        expect(
          (yield* api.request(actors.admin, "POST", `${prefix}/app-publications/unpublish`, {
            package: name,
          })).status,
        ).toBe(200);
        expect(
          yield* body(
            Schema.Array(Publication),
            yield* api.request(actors.member, "GET", `${prefix}/app-publications`),
          ),
        ).toEqual([]);
        expect(
          (yield* api.request(actors.member, "GET", `${prefix}/app-publications/source?${query}`))
            .status,
        ).toBe(400);
        expect(
          (yield* body(
            Workspace,
            yield* api.request(actors.owner, "GET", `${prefix}/apps/${copied.id}/workspace`),
          )).files,
        ).toEqual(files);
        // Revocation is evaluated on each request, even while the old session remains valid.
        expect(
          (yield* api.request(actors.owner, "POST", "/api/auth/organization/remove-member", {
            organizationId: actors.organization.id,
            memberIdOrEmail: "member@example.test",
          })).status,
        ).toBe(200);
        expect(
          (yield* api.request(actors.member, "GET", `${prefix}/app-publications`)).status,
        ).toBe(403);
      }),
    ),
  );
});
