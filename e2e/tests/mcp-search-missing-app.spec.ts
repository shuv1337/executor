/**
 * A search that names an app the caller can no longer use, by its namespace or a tool path, such as
 * one removed since the agent last saw it, gets a notice that Executor keeps no record of removed
 * apps and how to find out, instead of a bare empty page.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { App } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { McpClient } from "../support/mcp-client.ts";
import { appsManifest } from "../support/apps-release.ts";

const source = `import { defineApp, query, object, string, router } from "apps";
export default defineApp({}, async () => ({ tools: router({
  echo: query({ input: object({ text: string() }), description: "Echo text from the missing-app fixture" },
    async (_ctx, { text }) => ({ text })),
}) }));`;

const Searched = Schema.Struct({
  items: Schema.Array(Schema.Struct({ path: Schema.String })),
  notice: Schema.optional(Schema.String),
  unavailableApps: Schema.Array(Schema.Unknown),
});
const Executed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({
    ok: Schema.Literal(true),
    value: Schema.Struct({
      items: Schema.Array(Schema.Unknown),
      notice: Schema.optional(Schema.String),
    }),
  }),
});

layer(HostedLive, { excludeTestServices: true })("MCP search missing app", (it) => {
  it.effect(scenarios.mcpSearchMissingApp.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          mcp = yield* McpClient,
          evidence = yield* Evidence;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const key = yield* body(
          Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
          yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
            name: "Search missing app",
          }),
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
            .pipe(Effect.orDie),
        );
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Missing app ${randomUUID().slice(0, 8)}`,
          files: [{ path: "index.ts", content: source }, appsManifest],
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        const client = yield* mcp.connect(key.key, "search-missing-app", {
          organization: actors.organization.id,
        });
        const search = (label: string, input: Record<string, unknown>) =>
          Effect.gen(function* () {
            const result = yield* client.use(label, (client, signal) =>
              client.callTool({ name: "search", arguments: input }, undefined, { signal }),
            );
            yield* evidence.json(
              `${label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}.json`,
              result.structuredContent,
            );
            return yield* Schema.decodeUnknownEffect(Searched)(result.structuredContent);
          });

        // An app the caller can use lists its tools with no notice.
        const present = yield* search("Search a present app", { namespace: app.slug });
        expect(present.items.length).toBeGreaterThan(0);
        expect(present.notice).toBeUndefined();

        const removed = yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`);
        expect(removed.status).toBe(200);

        // Its namespace, once the app is removed, says why the page is empty and what to do.
        const missing = yield* search("Search a removed app", { namespace: app.slug });
        expect(missing.items).toEqual([]);
        expect(missing.notice).toContain(`No app '${app.slug}' is available to you.`);
        expect(missing.notice).toContain("keeps no record of removed apps");
        const below = yield* search("Search inside a removed app", {
          namespace: `${app.slug}.echo`,
          query: "echo",
        });
        expect(below.notice).toContain(`No app '${app.slug}' is available to you.`);

        // A query that is one of its tool paths gets the same notice beside any ranked matches.
        const byPath = yield* search("Search a removed app's tool path", {
          query: `${app.slug}.echo`,
        });
        expect(byPath.notice).toContain(`No app '${app.slug}' is available to you.`);
        // A query that is no tool path gets no notice.
        const prose = yield* search("Search prose", { query: "echo text" });
        expect(prose.notice).toBeUndefined();

        // A program's tools.search returns the same notice.
        const executed = yield* client.use("Program search of a removed app", (client, signal) =>
          client.callTool(
            {
              name: "execute",
              arguments: {
                code: `return await tools.search({ namespace: ${JSON.stringify(app.slug)} });`,
              },
            },
            undefined,
            { signal },
          ),
        );
        const program = yield* Schema.decodeUnknownEffect(Executed)(executed.structuredContent);
        expect(program.execution.value.items).toEqual([]);
        expect(program.execution.value.notice).toContain(
          `No app '${app.slug}' is available to you.`,
        );
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
