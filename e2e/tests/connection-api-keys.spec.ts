/**
 * Agents are provisioned without a browser: an organization admin's API key creates a scoped
 * connection, the same key runs at the connection's URL with only that connection's narrower
 * policy, and revoking it stops those calls. Members' keys cannot manage connections.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Exit, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body, type Session } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { McpClient } from "../support/mcp-client.ts";
import { ConnectionView, Execution, readWriteAppFiles } from "../support/mcp-connections.ts";

const Token = Schema.Struct({ key: Schema.RedactedFromValue(Schema.String), id: Schema.String });
const Access = Schema.Struct({ revision: Schema.String });
const Search = Schema.Struct({ items: Schema.Array(Schema.Struct({ path: Schema.String })) });

layer(HostedLive, { excludeTestServices: true })("Connection API keys", (it) => {
  it.effect(scenarios.connectionApiKeys.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          mcp = yield* McpClient;
        const organization = actors.organization.id;
        const prefix = `/api/organizations/${organization}`;
        const deploy = (name: string) =>
          Effect.gen(function* () {
            const receipt = randomUUID();
            const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name: `${name} ${receipt.slice(0, 8)}`,
              files: readWriteAppFiles(receipt),
            });
            expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
            const app = yield* body(App, deployed);
            const path = `${prefix}/apps/${app.id}`;
            yield* Effect.addFinalizer(() =>
              api.request(actors.owner, "DELETE", path).pipe(Effect.ignore),
            );
            const access = yield* body(
              Access,
              yield* api.request(actors.owner, "GET", `${path}/access`),
            );
            expect(
              (yield* api.request(actors.owner, "PATCH", `${path}/access`, {
                revision: access.revision,
                audience: { kind: "everyone" },
              })).status,
            ).toBe(200);
            return { app, receipt };
          });
        const scopedApp = yield* deploy("Scoped by key");
        const otherApp = yield* deploy("Outside the connection");
        const apiKey = (actor: Session, label: string) =>
          Effect.gen(function* () {
            const issued = yield* api.request(actor, "POST", "/api/auth/api-key/create", {
              name: `Connection key ${label}`,
            });
            expect(issued.status).toBe(200);
            const key = yield* body(Token, issued);
            yield* Effect.addFinalizer(() =>
              api
                .request(actor, "POST", "/api/auth/api-key/delete", { keyId: key.id })
                .pipe(Effect.ignore),
            );
            return key;
          });
        const admin = yield* apiKey(actors.admin, "admin");
        const member = yield* apiKey(actors.member, "member");
        const bearer = (key: typeof admin) => ({
          authorization: `Bearer ${Redacted.value(key.key)}`,
        });
        const asKey = (key: typeof admin, method: "GET" | "POST", path: string, data?: unknown) =>
          Effect.gen(function* () {
            // A fresh session with no cookies: the request carries only the key.
            return yield* api.request(yield* api.session(), method, path, data, bearer(key));
          });
        const policy = [
          { app: scopedApp.app.id, runsAs: [{ kind: "app" }], tools: { kind: "readOnly" } },
        ];

        // A member's key cannot manage connections, even its own.
        const refused = yield* asKey(member, "POST", `${prefix}/mcp-connections`, {
          id: randomUUID(),
          name: "Member connection",
          apps: policy,
        });
        expect(refused.status).toBe(403);

        // An admin's key creates one and lists it, with no browser session.
        const created = yield* asKey(admin, "POST", `${prefix}/mcp-connections`, {
          id: randomUUID(),
          name: `Agent ${randomUUID().slice(0, 6)}`,
          apps: policy,
        });
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        const connection = yield* body(ConnectionView, created);
        expect(connection.policy.apps).toEqual(policy);
        const listed = yield* asKey(admin, "GET", `${prefix}/mcp-connections`);
        expect(listed.status).toBe(200);
        expect(JSON.stringify(listed.body)).toContain(connection.id);

        // The same key at the connection's URL runs with only the connection's policy.
        const scoped = yield* mcp.connect(admin.key, "key-at-connection", {
          organization,
          connection: connection.id,
        });
        const run = (step: string, code: string) =>
          scoped
            .use(step, (client, signal) =>
              client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
            )
            .pipe(
              Effect.flatMap((result) =>
                Schema.decodeUnknownEffect(Execution)(result.structuredContent),
              ),
            );
        const appPath = `tools[${JSON.stringify(scopedApp.app.slug)}]`;
        const otherPath = `tools[${JSON.stringify(otherApp.app.slug)}]`;
        const found = yield* run(
          "Search at the connection",
          `return await tools.search({query: ${JSON.stringify(scopedApp.app.name)}, limit: 20})`,
        );
        const paths = (yield* Schema.decodeUnknownEffect(Search)(found.execution.value)).items.map(
          (item) => item.path,
        );
        expect(paths).toContain(`${appPath}.read`);
        expect(paths).not.toContain(`${appPath}.write`);
        expect((yield* run("Read", `return await ${appPath}.read({})`)).execution).toEqual({
          ok: true,
          value: { read: scopedApp.receipt },
        });
        expect(
          (yield* run("Write", `return await ${appPath}.write({message: "denied"})`)).execution.ok,
        ).toBe(false);
        expect((yield* run("Another app", `return await ${otherPath}.read({})`)).execution.ok).toBe(
          false,
        );

        // Without the connection, the key keeps its full access.
        const full = yield* mcp.connect(admin.key, "key-full", { organization });
        const other = yield* full
          .use("Read another app with the full key", (client, signal) =>
            client.callTool(
              { name: "execute", arguments: { code: `return await ${otherPath}.read({})` } },
              undefined,
              { signal },
            ),
          )
          .pipe(
            Effect.flatMap((result) =>
              Schema.decodeUnknownEffect(Execution)(result.structuredContent),
            ),
          );
        expect(other.execution).toEqual({ ok: true, value: { read: otherApp.receipt } });

        // Revoking it with the key stops the key's calls at that URL.
        expect(
          (yield* asKey(admin, "POST", `${prefix}/mcp-connections/${connection.id}/revoke`)).status,
        ).toBeLessThan(300);
        const revoked = yield* Effect.exit(
          Effect.gen(function* () {
            const after = yield* mcp.connect(admin.key, "key-after-revoke", {
              organization,
              connection: connection.id,
            });
            return yield* after.use("Read after revocation", (client, signal) =>
              client.callTool(
                { name: "execute", arguments: { code: `return await ${appPath}.read({})` } },
                undefined,
                { signal },
              ),
            );
          }),
        );
        expect(Exit.isFailure(revoked)).toBe(true);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
