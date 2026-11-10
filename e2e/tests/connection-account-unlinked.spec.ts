/** A lost runs-as link is account setup, not missing organization permission. */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { McpClient } from "../support/mcp-client.ts";
import { appsManifest } from "../support/apps-release.ts";
import { connectionsPath, linkedAccountIds, unlinkAccount } from "../support/app-accounts.ts";
import { ConnectionView } from "../support/mcp-connections.ts";

const Token = Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) });

layer(HostedLive, { excludeTestServices: true })("Unlinked connection accounts", (it) => {
  for (const [cardinality, scenario] of [
    ["many", scenarios.connectionAccountUnlinkedMany],
    ["one", scenarios.connectionAccountUnlinkedPlain],
  ] as const) {
    it.effect(scenario.title, (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors,
            mcp = yield* McpClient,
            browser = yield* Browser,
            evidence = yield* Evidence;
          const prefix = `/api/organizations/${actors.organization.id}`;
          const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Pinned ${cardinality} ${randomUUID().slice(0, 8)}`,
            files: [
              appsManifest,
              {
                path: "index.ts",
                content: `import { defineApp, defineProvider, secrets, object, string, query, router } from "apps";
const service = defineProvider({ name: "Pinned account fixture", auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) } });
export default defineApp({ user: { accounts: { service: service${cardinality === "many" ? ".many()" : ""} } } }, async ctx => ({ tools: router({ who: query({ input: object({}), description: "Report linked account IDs" }, async () => ${cardinality === "many" ? "ctx.user.accounts.service.map(account => account.id)" : "[ctx.user.accounts.service.id]"}) }) }));`,
              },
            ],
          });
          expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
          const app = yield* body(App, deployed);
          const path = `${prefix}/apps/${app.id}`;
          const accounts: string[] = [];
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              yield* api.request(actors.owner, "DELETE", path);
              for (const account of accounts)
                yield* api.request(actors.member, "DELETE", `${prefix}/accounts/${account}`);
            }).pipe(Effect.orDie),
          );
          const share = (kind: "everyone" | "private") =>
            Effect.gen(function* () {
              const access = yield* body(
                Schema.Struct({ revision: Schema.String }),
                yield* api.request(actors.owner, "GET", `${path}/access`),
              );
              const result = yield* api.request(actors.owner, "PATCH", `${path}/access`, {
                revision: access.revision,
                audience: { kind },
              });
              expect(result.status, JSON.stringify(result.body)).toBe(200);
            });
          yield* share("everyone");
          const connect = (label: string) =>
            Effect.gen(function* () {
              const started = yield* api.request(
                actors.member,
                "POST",
                connectionsPath(path, "user", "service"),
                {
                  destination: { kind: "personal" },
                },
              );
              expect(started.status, JSON.stringify(started.body)).toBe(200);
              const connection = yield* body(Resource, started);
              const saved = yield* api.request(
                actors.member,
                "POST",
                `${prefix}/connections/${connection.id}/submit`,
                {
                  method: "key",
                  label,
                  fields: { token: "synthetic-only" },
                },
              );
              expect(saved.status, JSON.stringify(saved.body)).toBe(200);
              const account = (yield* body(Resource, saved)).id;
              accounts.push(account);
              return account;
            });
          const pinned = yield* connect("Private pinned label");
          const created = yield* api.request(actors.member, "POST", `${prefix}/mcp-connections`, {
            id: randomUUID(),
            name: "Pinned member connection",
            apps: [
              { app: app.id, runsAs: [{ kind: "account", id: pinned }], tools: { kind: "all" } },
            ],
          });
          expect(created.status, JSON.stringify(created.body)).toBe(200);
          const connection = yield* body(ConnectionView, created);
          yield* Effect.addFinalizer(() =>
            api
              .request(actors.member, "POST", `${prefix}/mcp-connections/${connection.id}/revoke`)
              .pipe(Effect.orDie),
          );
          const key = yield* body(
            Token,
            yield* api.request(actors.member, "POST", "/api/auth/api-key/create", {
              name: "Pinned fixture",
            }),
          );
          yield* Effect.addFinalizer(() =>
            api
              .request(actors.member, "POST", "/api/auth/api-key/delete", { keyId: key.id })
              .pipe(Effect.orDie),
          );
          const client = yield* mcp.connect(key.key, "pinned-member", {
            organization: actors.organization.id,
            connection: connection.id,
          });
          const run = (step: string, code: string) =>
            client.use(step, (client, signal) =>
              client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
            );
          const call = `return await tools[${JSON.stringify(app.slug)}].who({});`;
          expect((yield* run("Pinned account runs", call)).structuredContent).toMatchObject({
            execution: { ok: true, value: [pinned] },
          });
          const session = yield* api.session();
          const scoped = {
            authorization: `Bearer ${Redacted.value(key.key)}`,
            "x-executor-caller-connection": connection.id,
          };
          const message = `This connection runs as account ${pinned}, which is no longer linked to this app for you. Relink it, or edit the connection to run as another of your accounts.`;
          const checkMissing = (stage: string) =>
            Effect.gen(function* () {
              for (const suffix of ["", "/index", "/who"]) {
                const response = yield* api.request(
                  session,
                  "GET",
                  `${path}/tools${suffix}`,
                  undefined,
                  scoped,
                );
                yield* evidence.json(
                  `${stage}-discovery${suffix.replaceAll("/", "-")}.json`,
                  response,
                );
                expect(response.status, JSON.stringify(response.body)).toBe(409);
                expect(response.body).toMatchObject({
                  _tag: "ConnectionAccountUnlinked",
                  app: app.id,
                  accounts: [pinned],
                  message,
                  recovery: {
                    action: "Relink the account, or edit the connection to run as another account.",
                    instructions:
                      "Only the connection's owner can fix this; organization admins cannot edit another member's connection. Open the connection under Connect and save it to relink the account it runs as, or choose another of your accounts for this app. Relinking the account on the app's Accounts tab also works. For a single-account app, relinking replaces your current link. Linking a different account does not change which account the connection runs as. Do not change organization roles or bypass account access.",
                  },
                });
              }
              const called = yield* api.request(
                session,
                "POST",
                `${path}/tools/call`,
                { tool: "who", input: {} },
                scoped,
              );
              expect(called.status, JSON.stringify(called.body)).toBe(409);
              expect(called.body).toMatchObject({ _tag: "ConnectionAccountUnlinked", message });
              for (const [operation, code] of [
                ["call", call],
                [
                  "search",
                  `return await tools.search({ query: "Report linked account IDs", limit: 5 });`,
                ],
                [
                  "describe",
                  `return await tools.search.describe({ paths: [${JSON.stringify(`${app.slug}.who`)}] });`,
                ],
              ] as const) {
                const result = yield* run(`${stage}: ${operation}`, code);
                yield* evidence.json(`${stage}-${operation}.json`, result.structuredContent);
                const serialized = JSON.stringify(result.structuredContent);
                expect(serialized).toContain("ConnectionAccountUnlinked");
                expect(serialized).toContain(message);
                expect(serialized).not.toContain("OrganizationForbidden");
                expect(serialized).not.toContain("Private pinned label");
                expect(serialized).not.toContain("Other private label");
              }
            });
          yield* unlinkAccount(actors.member, path, "service", pinned);
          expect(yield* linkedAccountIds(actors.member, path)).toEqual([]);
          yield* checkMissing("zero-links");
          if (cardinality === "many") {
            const empty = yield* api.request(actors.member, "POST", `${path}/tools/call`, {
              tool: "who",
              input: {},
            });
            expect(empty.status, JSON.stringify(empty.body)).toBe(200);
            expect(empty.body).toEqual([]);
          }

          // The existing connection status shows the missing link and offers a working repair.
          yield* browser.login(actors.member);
          yield* browser.use("Open the connection needing an account", (page) =>
            page.goto(`/org/${actors.organization.slug}/connect/${connection.id}`),
          );
          yield* browser.use("Needs account with relink recovery", (page) =>
            page.getByText("Needs account — save to relink", { exact: true }).waitFor(),
          );
          yield* browser.checkpoint("Connection needs its pinned account");
          yield* browser.use("Relink by saving the connection", (page) =>
            page.getByRole("button", { name: "Save changes", exact: true }).click(),
          );
          yield* browser.use("Account setup status clears", (page) =>
            page
              .getByText("Needs account — save to relink", { exact: true })
              .waitFor({ state: "hidden" }),
          );
          expect(yield* linkedAccountIds(actors.member, path)).toEqual([pinned]);
          expect(
            (yield* run("Same connection recovers after relinking", call)).structuredContent,
          ).toMatchObject({ execution: { ok: true, value: [pinned] } });

          // Other links neither repair nor leak into this connection. An unrestricted call works.
          yield* unlinkAccount(actors.member, path, "service", pinned);
          const other = yield* connect("Other private label");
          yield* checkMissing("other-linked");
          const general = yield* api.request(actors.member, "POST", `${path}/tools/call`, {
            tool: "who",
            input: {},
          });
          expect(general.status, JSON.stringify(general.body)).toBe(200);
          expect(general.body).toEqual([other]);
          // Real app authorization still wins, even with the pinned link missing.
          yield* share("private");
          const forbidden = yield* api.request(session, "GET", `${path}/tools`, undefined, scoped);
          expect(forbidden.status, JSON.stringify(forbidden.body)).toBe(403);
          expect(forbidden.body).toMatchObject({ _tag: "OrganizationForbidden" });
        }).pipe(Effect.provide(McpClient.layer)),
      ),
    );
  }
});
