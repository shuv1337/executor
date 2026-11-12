/** Cold discovery must serve a newly activated generated catalog, including concurrent readers. */
import { expect, layer } from "@effect/vitest";
import { Clock, Console, Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { appsManifest } from "../support/apps-release.ts";
import { saveAndDeploy } from "../support/app-authoring.ts";
import { McpClient } from "../support/mcp-client.ts";

/** Graph-sized operation count; cyclic shared definitions make duplicate projections costly. */
const count = 8_549;
const source = (revision: string) => `import { defineApp } from "apps";
import { liveOpenapiRouter } from "apps/openapi";
const paths = {};
for (let i = 0; i < ${count}; i++) paths["/records/" + i] = { get: {
  operationId: "getRecord" + i, tags: ["records"], summary: "${revision} record " + i,
  parameters: [{ name: "id", in: "query", schema: { type: "string" } }],
  responses: { "200": { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Record0" } } } } }
} };
const schemas = Object.fromEntries(Array.from({length: 600}, (_, i) => ["Record" + i, {type: "object", properties: { parent: { $ref: "#/components/schemas/Root" }, value: { type: "string" } }}]));
schemas.Root = {type: "object", properties: Object.fromEntries(Array.from({length: 600}, (_, i) => ["record" + i, {$ref: "#/components/schemas/Record" + i}]))};
const document = { components: {schemas}, openapi: "3.0.3", info: { title: "Generated catalog", version: "1" }, servers: [{ url: "https://example.com" }], paths };
export default defineApp({}, async ({ cache, fetch }) => ({ tools: liveOpenapiRouter({ source: { document }, allowedOrigin: "https://example.com", securitySchemes: {}, methods: {}, oauth: [], cache, fetch }) }));`;
const Search = Schema.Struct({
  items: Schema.Array(Schema.Struct({ path: Schema.String, description: Schema.String })),
  unavailableApps: Schema.optional(Schema.Array(Schema.Unknown)),
});

layer(HostedLive, { excludeTestServices: true })("Cold OpenAPI discovery", (it) => {
  it.effect(scenarios.coldOpenapiDiscovery.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          mcp = yield* McpClient,
          evidence = yield* Evidence;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const files = (revision: string) => [
          { path: "index.ts", content: source(revision) },
          appsManifest,
        ];
        const key = yield* body(
          Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
          yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
            name: "Cold discovery",
          }),
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
            .pipe(Effect.orDie),
        );
        const client = yield* mcp.connect(key.key, "cold-discovery", {
          organization: actors.organization.id,
        });
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Cold catalog ${randomUUID().slice(0, 8)}`,
          files: files("Initial"),
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        const path = `${prefix}/${app.id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
        );
        const search = (label: string, revision: string) =>
          Effect.gen(function* () {
            const start = yield* Clock.currentTimeMillis;
            const result = yield* client.use(label, (client, signal) =>
              client.callTool(
                {
                  name: "search",
                  arguments: { namespace: app.slug, query: "records.getRecord8548", limit: 5 },
                },
                undefined,
                { signal },
              ),
            );
            const elapsed = (yield* Clock.currentTimeMillis) - start;
            yield* Console.log(
              JSON.stringify({ label, elapsed, result: result.structuredContent }),
            );
            yield* evidence.json(`${label}.json`, { elapsed, result: result.structuredContent });
            expect(result.isError).not.toBe(true);
            const found = yield* Schema.decodeUnknownEffect(Search)(result.structuredContent);
            expect(found.unavailableApps ?? []).toEqual([]);
            expect(found.items).toHaveLength(1);
            expect(found.items[0]!.path).toContain("getRecord8548");
            expect(found.items[0]!.description).toBe(`${revision} record 8548`);
          });
        yield* search("initial-cold", "Initial");
        const changed = yield* saveAndDeploy(actors.owner, path, { files: files("Updated") });
        expect(changed.status).toBe(200);
        yield* Effect.forEach([0, 1, 2, 3], (i) => search(`concurrent-cold-${i}`, "Updated"), {
          concurrency: "unbounded",
        });
        yield* search("warm", "Updated");
        // Walk public search pages, not the management index, so no prewarm can hide the cold path.
        const paged = yield* client.use("Walk the updated catalog", (client, signal) =>
          client.callTool(
            {
              name: "execute",
              arguments: {
                code: `const items = [];
for (let page = await tools.search({ namespace: ${JSON.stringify(app.slug)}, limit: 100 }); ; page = await tools.search(page.next)) {
  items.push(...page.items);
  if (page.next === null) break;
}
return { count: items.length, unique: new Set(items.map(item => item.path)).size, updated: items.every(item => item.description.startsWith("Updated record ")) };`,
              },
            },
            undefined,
            { signal },
          ),
        );
        yield* evidence.json("updated-pages.json", paged.structuredContent);
        expect(paged.structuredContent).toMatchObject({
          status: "completed",
          execution: { ok: true, value: { count, unique: count, updated: true } },
          unavailableApps: [],
        });
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
