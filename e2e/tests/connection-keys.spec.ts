/**
 * A connection key is an API key bound to one scoped MCP connection, for headless agents, CI and
 * staff bots. Only the connection's owner mints one, it always expires, it works only at its
 * connection's MCP URL, the API never accepts it, revoking the connection deletes it, and every
 * mint is in the audit log.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Exit, Redacted, Schedule, Schema } from "effect";
import { randomBytes, randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body, type Session } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Telemetry } from "../support/evidence.ts";
import { McpClient } from "../support/mcp-client.ts";
import { ConnectionView, Execution, readWriteAppFiles } from "../support/mcp-connections.ts";

const Access = Schema.Struct({ revision: Schema.String });
const ConnectionKey = Schema.Struct({
  id: Schema.String,
  key: Schema.RedactedFromValue(Schema.String),
  connection: Schema.String,
  url: Schema.String,
  expiresAt: Schema.String,
});
const Keys = Schema.Struct({ apiKeys: Schema.Array(Schema.Struct({ id: Schema.String })) });
const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "connection-key-check", version: "1" },
  },
};

layer(HostedLive, { excludeTestServices: true })("Connection keys", (it) => {
  it.effect(scenarios.connectionKeys.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          mcp = yield* McpClient,
          telemetry = yield* Telemetry;
        const organization = actors.organization.id;
        const prefix = `/api/organizations/${organization}`;
        const receipt = randomUUID();
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Connection key app ${receipt.slice(0, 8)}`,
          files: readWriteAppFiles(receipt),
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        const appPath = `${prefix}/apps/${app.id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", appPath).pipe(Effect.ignore),
        );
        const access = yield* body(
          Access,
          yield* api.request(actors.owner, "GET", `${appPath}/access`),
        );
        expect(
          (yield* api.request(actors.owner, "PATCH", `${appPath}/access`, {
            revision: access.revision,
            audience: { kind: "everyone" },
          })).status,
        ).toBe(200);
        const policy = [{ app: app.id, runsAs: [{ kind: "app" }], tools: { kind: "readOnly" } }];
        // The member owns two connections, made in the dashboard with their browser session.
        const connect = (name: string) =>
          Effect.gen(function* () {
            const created = yield* api.request(actors.member, "POST", `${prefix}/mcp-connections`, {
              id: randomUUID(),
              name,
              apps: policy,
            });
            expect(created.status, JSON.stringify(created.body)).toBe(200);
            return yield* body(ConnectionView, created);
          });
        const bound = yield* connect(`Bound ${receipt.slice(0, 6)}`);
        const other = yield* connect(`Other ${receipt.slice(0, 6)}`);
        const keysPath = (connection: string) => `${prefix}/mcp-connections/${connection}/keys`;
        const mint = (actor: Session, connection: string, data: unknown, headers = {}) =>
          api.request(actor, "POST", keysPath(connection), data, headers);

        // Only its owner mints a key: an admin or the organization's owner sees no such connection.
        for (const actor of [actors.admin, actors.owner])
          expect((yield* mint(actor, bound.id, { expiresInSeconds: 3600 })).status).toBe(404);
        // Every key expires, within 90 days.
        for (const invalid of [{}, { expiresInSeconds: 1 }, { expiresInSeconds: 91 * 86400 }])
          expect((yield* mint(actors.member, bound.id, invalid)).status).toBe(400);

        // The owner mints one; the mint is in the audit log, with the key and the connection.
        const trace = randomBytes(16).toString("hex");
        const minted = yield* mint(
          actors.member,
          bound.id,
          { name: "Headless probe", expiresInSeconds: 3600 },
          { traceparent: `00-${trace}-${randomBytes(8).toString("hex")}-01` },
        );
        expect(minted.status, JSON.stringify(minted.body)).toBe(200);
        const key = yield* body(ConnectionKey, minted);
        expect(key.connection).toBe(bound.id);
        expect(key.url).toBe(bound.url);
        const lifetime = Date.parse(key.expiresAt) - Date.now();
        expect(lifetime).toBeGreaterThan(3500_000);
        expect(lifetime).toBeLessThanOrEqual(3600_000);
        const audit = yield* telemetry.logs(trace, "MCP connection key minted").pipe(
          Effect.map((found) => found.join("\n")),
          Effect.filterOrFail((text) => text.includes(key.id)),
          Effect.retry({ schedule: Schedule.spaced("1 second"), times: 20 }),
        );
        expect(audit).toContain(bound.id);
        expect(audit).toContain("mcp-connection-key");
        expect(audit).not.toContain(Redacted.value(key.key));

        // At its connection's URL the key runs with the connection's policy.
        const scoped = yield* mcp.connect(key.key, "connection-key", {
          organization,
          connection: bound.id,
        });
        const read = yield* scoped
          .use("Read with the connection key", (client, signal) =>
            client.callTool(
              {
                name: "execute",
                arguments: { code: `return await tools[${JSON.stringify(app.slug)}].read({})` },
              },
              undefined,
              { signal },
            ),
          )
          .pipe(
            Effect.flatMap((result) =>
              Schema.decodeUnknownEffect(Execution)(result.structuredContent),
            ),
          );
        expect(read.execution).toEqual({ ok: true, value: { read: receipt } });

        // Anywhere else it is refused with a 403 that names the connection key.
        const asKey = (
          secret: Redacted.Redacted<string>,
          method: "GET" | "POST",
          path: string,
          data?: unknown,
        ) =>
          Effect.gen(function* () {
            return yield* api.request(yield* api.session(), method, path, data, {
              authorization: `Bearer ${Redacted.value(secret)}`,
              "x-executor-organization": organization,
              accept: "application/json, text/event-stream",
            });
          });
        for (const [label, path] of [
          ["plain MCP URL", "/mcp"],
          ["organization MCP URL", `/org/${organization}/mcp`],
          ["another connection", `/mcp?connection=${other.id}`],
        ] as const) {
          const refused = yield* asKey(key.key, "POST", path, initialize);
          expect(refused.status, `${label}: ${JSON.stringify(refused.body)}`).toBe(403);
          expect(JSON.stringify(refused.body), label).toContain(
            "works only at that connection's MCP URL",
          );
        }
        for (const [label, method, path, data] of [
          ["the API", "GET", `${prefix}/apps`, undefined],
          ["minting another key", "POST", keysPath(bound.id), { expiresInSeconds: 3600 }],
        ] as const) {
          const refused = yield* asKey(key.key, method, path, data);
          expect(refused.status, `${label}: ${JSON.stringify(refused.body)}`).toBe(403);
          expect(JSON.stringify(refused.body), label).toContain("ConnectionKeyRefused");
        }

        // It expires: a key minted for 5 seconds works at its own URL, then is refused there.
        const atConnection = (secret: Redacted.Redacted<string>, label: string) =>
          Effect.exit(
            Effect.gen(function* () {
              const client = yield* mcp.connect(secret, label, {
                organization,
                connection: bound.id,
              });
              return yield* client.use(`${label}: list tools`, (session, signal) =>
                session.listTools(undefined, { signal }),
              );
            }),
          );
        const brief = yield* body(
          ConnectionKey,
          yield* mint(actors.member, bound.id, { expiresInSeconds: 5 }),
        );
        expect(Exit.isSuccess(yield* atConnection(brief.key, "brief key"))).toBe(true);
        yield* Effect.sleep("6 seconds");
        expect(Exit.isFailure(yield* atConnection(brief.key, "expired key"))).toBe(true);

        // Revoking the connection stops the key at its URL and deletes it.
        expect(
          (yield* api.request(
            actors.member,
            "POST",
            `${prefix}/mcp-connections/${bound.id}/revoke`,
          )).status,
        ).toBeLessThan(300);
        expect(Exit.isFailure(yield* atConnection(key.key, "key after revocation"))).toBe(true);
        const remaining = yield* body(
          Keys,
          yield* api.request(actors.member, "GET", "/api/auth/api-key/list"),
        );
        expect(remaining.apiKeys.map((item) => item.id)).not.toContain(key.id);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
