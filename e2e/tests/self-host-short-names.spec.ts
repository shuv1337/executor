/**
 * A CLI released before publisher scopes states no wire revision and addresses an organization
 * listing by its short name, `@acme/notes` for `@acme.executor.community/notes`. Self-host serves
 * that listing only inside the caller's organization. This release's CLI states revision 1 and
 * sends the full name. A removal still needs the full name: a short name selects whichever
 * listing holds it when the request arrives, and a removal names no commit.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body, currentClient, releasedClient } from "../support/api.ts";
import { withApps } from "../support/apps-release.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";

const Publication = Schema.Struct({ name: Schema.String, commit: Schema.String });
const Snapshot = Schema.Struct({
  publication: Publication,
  files: Schema.Array(Schema.Struct({ path: Schema.String })),
});
const Copy = Schema.Struct({
  id: Schema.String,
  copiedFrom: Schema.Struct({ name: Schema.String, commit: Schema.String }),
});
const Refusal = Schema.Struct({
  _tag: Schema.String,
  name: Schema.String,
  fullName: Schema.String,
});

layer(HostedLive, { excludeTestServices: true })("Self-host short names", (it) => {
  it.effect(scenarios.selfHostShortNames.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const label = `short-${randomUUID().slice(0, 8)}`;
        const fullName = `@${actors.organization.slug}.executor.community/${label}`;
        const shortName = `@${actors.organization.slug}/${label}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Short name ${label}`,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp } from "apps";\nexport default defineApp({}, {});\n`,
            },
            {
              path: "package.json",
              content: JSON.stringify({
                name: fullName,
                description: label,
                dependencies: withApps(),
              }),
            },
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`)
            .pipe(Effect.asVoid, Effect.orDie),
        );
        const workspace = yield* api.request(
          actors.owner,
          "GET",
          `${prefix}/apps/${app.id}/workspace`,
        );
        expect(workspace.status, JSON.stringify(workspace.body)).toBe(200);
        const commit = (yield* body(
          Schema.Struct({ revision: Schema.Struct({ commit: Schema.String }) }),
          workspace,
        )).revision.commit;
        const published = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/apps/${app.id}/publication`,
          { commit },
        );
        expect(published.status, JSON.stringify(published.body)).toBe(200);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", `${prefix}/app-publications/unpublish`, {
              package: fullName,
            })
            .pipe(Effect.asVoid, Effect.orDie),
        );

        const catalog = (name: string | undefined, client: Record<string, string>) =>
          api.request(
            actors.owner,
            "GET",
            `${prefix}/app-publications${
              name === undefined ? "" : `?name=${encodeURIComponent(name)}`
            }`,
            undefined,
            client,
          );
        const source = (name: string, client: Record<string, string>) =>
          api.request(
            actors.owner,
            "GET",
            `${prefix}/app-publications/source?name=${encodeURIComponent(name)}&commit=${commit}`,
            undefined,
            client,
          );
        const listings = (response: { readonly status: number; readonly body: unknown }) =>
          Effect.gen(function* () {
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            return yield* body(Schema.Array(Publication), response);
          });

        // The older client is shown the short name and sends it back. The answer uses that name.
        const releasedCatalog = yield* listings(yield* catalog(undefined, releasedClient));
        expect(releasedCatalog).toContainEqual({ name: shortName, commit });
        expect(releasedCatalog).not.toContainEqual({ name: fullName, commit });
        expect(yield* listings(yield* catalog(shortName, releasedClient))).toEqual([
          { name: shortName, commit },
        ]);
        const releasedSource = yield* source(shortName, releasedClient);
        expect(releasedSource.status, JSON.stringify(releasedSource.body)).toBe(200);
        expect(yield* body(Snapshot, releasedSource)).toMatchObject({
          publication: { name: shortName, commit },
          files: expect.arrayContaining([{ path: "index.ts" }]),
        });

        // This release states revision 1 and reads the name the organization publishes under.
        const currentCatalog = yield* listings(yield* catalog(undefined, currentClient));
        expect(currentCatalog).toContainEqual({ name: fullName, commit });
        expect(currentCatalog).not.toContainEqual({ name: shortName, commit });
        expect(yield* listings(yield* catalog(fullName, currentClient))).toEqual([
          { name: fullName, commit },
        ]);
        const currentSource = yield* source(fullName, currentClient);
        expect(currentSource.status, JSON.stringify(currentSource.body)).toBe(200);
        expect(yield* body(Snapshot, currentSource)).toMatchObject({
          publication: { name: fullName, commit },
        });

        // Installing names the commit the client was shown, so the short name can be resolved.
        const copied = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/apps/copies`,
          { from: { package: shortName, commit }, name: `Copy ${label}` },
          releasedClient,
        );
        expect(copied.status, JSON.stringify(copied.body)).toBe(200);
        const copy = yield* body(Copy, copied);
        expect(copy.copiedFrom).toMatchObject({ name: fullName, commit });
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "DELETE", `${prefix}/apps/${copy.id}`)
            .pipe(Effect.asVoid, Effect.orDie),
        );

        // A removal names no commit. The short name is refused and the listing stays.
        const refused = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/app-publications/unpublish`,
          { package: shortName },
          releasedClient,
        );
        expect(refused.status, JSON.stringify(refused.body)).toBe(400);
        expect(yield* body(Refusal, refused)).toMatchObject({
          _tag: "FullListingNameRequired",
          name: shortName,
          fullName,
        });
        expect(yield* listings(yield* catalog(fullName, currentClient))).toEqual([
          { name: fullName, commit },
        ]);
      }),
    ),
  );
});
