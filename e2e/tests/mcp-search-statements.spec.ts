/**
 * An MCP search inside execute reaches every app of the organization. Each app's search target was
 * one product operation for its linked accounts and one for its search rows, each with its own
 * statements, so an organization-wide search cost a few statements per app on the thread every
 * other session's call shares. Once the rows are kept, the product reads them for every app at
 * once: adding apps adds no statement and no product operation to a search.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { connectionsPath, linkAccount, linkedAccountIds } from "../support/app-accounts.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { McpClient } from "../support/mcp-client.ts";
import { scenarios } from "../test-plan.ts";

const accountSource = (
  index: number,
) => `import { defineApp, defineProvider, secrets, object, string, query, router } from "apps";
const service = defineProvider({ name: "Search statement fixture", auth: {
  key: secrets({ label: "API key", fields: object({ token: string() }) })
} });
export default defineApp({ user: { accounts: { service } } }, async () => ({
  tools: router({
    probe${index}: query({ description: "Statement probe ${index} with an account", input: object({}) }, async () => ${index}),
  }),
}));`;
const accountlessSource = (
  index: number,
) => `import { defineApp, object, query, router } from "apps";
export default defineApp({}, {
  tools: router({
    probe${index}: query({ description: "Statement probe ${index} without accounts", input: object({}) }, async () => ${index}),
  }),
});`;

const Token = Schema.Struct({ key: Schema.RedactedFromValue(Schema.String), id: Schema.String });
const Searched = Schema.Struct({
  structuredContent: Schema.Struct({
    status: Schema.Literal("completed"),
    execution: Schema.Struct({ ok: Schema.Literal(true), value: Schema.Number }),
    unavailableApps: Schema.Array(Schema.Unknown),
  }),
});

layer(HostedLive, { excludeTestServices: true })("MCP search statements", (it) => {
  it.effect(scenarios.mcpSearchStatements.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence,
          telemetry = yield* Telemetry,
          mcp = yield* McpClient;
        const organization = actors.organization.id;
        const prefix = `/api/organizations/${organization}`;
        const run = randomUUID().slice(0, 8);
        const deploy = (name: string, source: string) =>
          Effect.gen(function* () {
            const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name: `${name} ${run}`,
              files: [{ path: "index.ts", content: source }, appsManifest],
            });
            expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
            const app = yield* body(App, deployed);
            const path = `${prefix}/apps/${app.id}`;
            yield* Effect.addFinalizer(() =>
              api.request(actors.owner, "DELETE", path).pipe(
                Effect.map((response) => expect(response.status).toBe(200)),
                Effect.orDie,
              ),
            );
            return path;
          });

        // One saved key account, linked to every app that needs one.
        const first = yield* deploy("Search statements 0", accountSource(0));
        const pending = yield* api.request(
          actors.owner,
          "POST",
          connectionsPath(first, "user", "service"),
          {},
        );
        expect(pending.status).toBe(200);
        const saved = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${(yield* body(Resource, pending)).id}/submit`,
          { method: "key", label: "Synthetic", fields: { token: "synthetic-search-statements" } },
        );
        expect(saved.status).toBe(200);
        const account = (yield* body(Resource, saved)).id;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`).pipe(Effect.orDie),
        );
        expect(yield* linkedAccountIds(actors.owner, first)).toEqual([account]);
        /** Deploy apps `from` to `to`: every other one needs the linked account. */
        const deployApps = (from: number, to: number) =>
          Effect.forEach(
            Array.from({ length: to - from }, (_, offset) => from + offset),
            (index) =>
              index % 2 === 0
                ? deploy(`Search statements ${index}`, accountSource(index)).pipe(
                    Effect.tap((path) => linkAccount(actors.owner, path, "service", account)),
                  )
                : deploy(`Search statements ${index}`, accountlessSource(index)),
            { concurrency: 4, discard: true },
          );

        const created = yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
          name: "MCP search statements",
        });
        expect(created.status).toBe(200);
        const token = yield* body(Token, created);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: token.id })
            .pipe(Effect.orDie),
        );
        const client = yield* mcp.connect(token.key, "pat", { organization });
        const code = `const page = await tools.search({ query: "statement probe", limit: 50 });
return page.items.length;`;

        /** Search every app, and count the statements and product operations the search made. */
        const search = (operation: string, apps: number) =>
          Effect.gen(function* () {
            const called = yield* client.use(operation, (client, signal) =>
              client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
            );
            const searched = yield* Schema.decodeUnknownEffect(Searched)(called);
            expect(searched.structuredContent.execution.value).toBe(apps);
            expect(searched.structuredContent.unavailableApps).toEqual([]);
            const request = (yield* evidence.requests)
              .filter((request) => request.path === "/mcp")
              .at(-1);
            if (request === undefined)
              return yield* Effect.die(new Error("MCP request evidence missing"));
            return yield* telemetry.query(request.traceId).pipe(
              Effect.flatMap((result) => {
                const root = result.data.find(
                  (entry) => entry.span.operationName === "mcp.execute",
                );
                const complete = result.data.some(
                  (entry) => entry.span.tags["http.response.status_code"] === "200",
                );
                if (root === undefined || !complete)
                  return Effect.fail(new Error("The completed server trace must reach Motel"));
                const byId = new Map(result.data.map(({ span }) => [span.spanId, span]));
                /** Whether a span lies under the execute and outside any app's own runtime. */
                const product = (spanId: string | null) => {
                  const visited = new Set<string>();
                  let parent = spanId;
                  while (parent !== null && !visited.has(parent)) {
                    if (parent === root.span.spanId) return true;
                    visited.add(parent);
                    const span = byId.get(parent);
                    if (span === undefined || span.operationName.startsWith("runtime."))
                      return false;
                    parent = span.parentSpanId;
                  }
                  return false;
                };
                const statements = result.data.flatMap(({ span }) =>
                  span.operationName === "sql.execute" && product(span.parentSpanId)
                    ? [
                        String(span.tags["db.query.text"] ?? "")
                          .replace(/\s+/g, " ")
                          .slice(0, 80),
                      ]
                    : [],
                );
                const operations = result.data.flatMap(({ span }) =>
                  span.operationName === "product.operation" && product(span.parentSpanId)
                    ? [String(span.tags["executor.product.operation"] ?? "")]
                    : [],
                );
                return statements.length === 0
                  ? Effect.fail(new Error("SQL descendants must reach Motel"))
                  : Effect.succeed({
                      traceId: request.traceId,
                      apps,
                      statements,
                      operations: operations.sort(),
                    });
              }),
              Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
              Effect.timeout("25 seconds"),
            );
          });

        yield* deployApps(1, 6);
        // The first search writes every app's search rows; the next reads the kept rows.
        yield* search("Search six apps for the first time", 6);
        const six = yield* search("Search six apps again", 6);
        yield* deployApps(6, 12);
        yield* search("Search twelve apps for the first time", 12);
        const twelve = yield* search("Search twelve apps again", 12);
        yield* evidence.json("mcp-search-statements.json", { six, twelve });

        expect(
          twelve.operations,
          "Listing the apps, their accounts, their kept rows and ranking: one operation each",
        ).toEqual(["listAccountsEach", "listApps", "searchTools", "searchableKept"]);
        expect(six.operations).toEqual(twelve.operations);
        expect(
          twelve.statements.length,
          "Twice the apps read their accounts, access, links and kept rows in the same statements",
        ).toBe(six.statements.length);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
