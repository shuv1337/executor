import { expect, layer } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, FileSystem, Layer, Ref, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { createServer } from "node:http";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { publishedRelease } from "../support/app-package.ts";
import { appsManifest } from "../support/apps-release.ts";
import { createProfile, selectProfileAccounts } from "../support/profiles.ts";
import { scenarios } from "../test-plan.ts";

const App = Schema.Struct({
  id: Schema.String,
  requirements: Schema.Struct({
    accounts: Schema.Struct({ syncro: Schema.Struct({ provider: Schema.String }) }),
  }),
});
const Check = Schema.Struct({
  status: Schema.String,
  info: Schema.NullOr(Schema.Json),
  message: Schema.optionalKey(Schema.String),
});
const AccountHealth = Schema.Struct({
  info: Schema.NullOr(Schema.Json),
  apps: Schema.Array(
    Schema.Struct({
      app: Schema.String,
      checkable: Schema.Boolean,
      check: Schema.NullOr(Schema.Struct({ status: Schema.String })),
    }),
  ),
});
const secret = "synthetic-syncro-secret";
const userEmail = "synthetic-syncro-user@example.test";
const handle = /^Bearer exsec_[0-9a-f]+_$/;

/** Replace one exact authored string, failing if the source no longer contains it. */
const rewrite = (source: string, from: string, to: string) => {
  if (!source.includes(from)) throw new Error(`Syncro source no longer contains ${from}`);
  return source.replaceAll(from, to);
};

layer(HostedLive, { excludeTestServices: true })("Syncro REST", (it) => {
  it.effect(scenarios.syncroRest.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          fs = yield* FileSystem.FileSystem;
        const status = yield* Ref.make(200);
        const received: { url: string; authorization: string | undefined; method: string }[] = [];
        const services = yield* Layer.build(
          HttpRouter.serve(
            HttpRouter.add(
              "*",
              "/*",
              Effect.gen(function* () {
                const request = yield* HttpServerRequest.HttpServerRequest;
                const authorization = request.headers.authorization;
                received.push({ url: request.url, authorization, method: request.method });
                const responseStatus = yield* Ref.get(status);
                if (responseStatus !== 200)
                  return yield* HttpServerResponse.json(
                    { message: secret },
                    { status: responseStatus },
                  );
                const url = new URL(request.url, "http://fixture");
                if (url.pathname === "/api/v1/me")
                  return yield* HttpServerResponse.json({
                    user_id: 1,
                    user_email: userEmail,
                    user_name: "Synthetic Syncro User",
                    subdomain: "127",
                  });
                const page = Number(url.searchParams.get("page") ?? 1);
                // The service echoes the credential it received, as debug responses can.
                const entity = { id: page, body: "internal note", hidden: true, authorization };
                const meta = { page, total_pages: 2, per_page: 10 };
                const number = url.searchParams.get("number");
                const response = url.pathname.endsWith("/comments")
                  ? { comments: [entity], meta }
                  : url.pathname === "/api/v1/tickets"
                    ? {
                        tickets:
                          number === null
                            ? [entity]
                            : [
                                { id: 90, number: 4207 },
                                { id: 91, number: 4208 },
                              ].filter((ticket) => String(ticket.number) === number),
                        meta,
                      }
                    : url.pathname === "/api/v1/customers"
                      ? { customers: [entity], meta }
                      : url.pathname.startsWith("/api/v1/tickets/")
                        ? { ticket: entity }
                        : { customer: entity };
                return yield* HttpServerResponse.json(response);
              }),
            ),
            { disableLogger: true, disableListenLog: true },
          ).pipe(
            Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
          ),
        );
        const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
        if (!("port" in server.address)) return yield* Effect.die("Syncro fixture needs TCP");
        const port = server.address.port;
        // Deploy the authored source with only Syncro's domain moved to the owned provider. The
        // wildcard keeps its one-label form: account subdomain `127` addresses 127.0.0.1.
        const authored = yield* fs.readFileString("playground/demo-apps/syncro/index.ts");
        const source = rewrite(
          rewrite(authored, `"*.syncromsp.com"`, `"*.0.0.1:${port}"`),
          "https://${fields.subdomain}.syncromsp.com",
          `http://\${fields.subdomain}.0.0.1:${port}`,
        );
        const prefix = `/api/organizations/${actors.organization.id}`;
        // The same source runs on this checkout's framework and on the published release that
        // deploy.package.json pins, served from its npm archive.
        const beta35 = yield* publishedRelease("0.0.1-beta.35");
        const published = {
          path: "package.json",
          content: JSON.stringify({ dependencies: { apps: beta35.url } }),
        };
        for (const manifest of [appsManifest, published]) {
          received.length = 0;
          const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: manifest === published ? "Syncro REST reads on beta.35" : "Syncro REST reads",
            files: [{ path: "index.ts", content: source }, manifest],
          });
          expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
          const fetched = (yield* beta35.requests)[beta35.route] ?? 0;
          if (manifest === published) expect(fetched).toBeGreaterThan(0);
          else expect(fetched).toBe(0);
          const app = yield* body(App, deployed);
          const path = `${prefix}/apps/${app.id}`;
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
          );

          // The account form's check reads /me through the sealed network before saving.
          const check = (subdomain: string) =>
            Effect.gen(function* () {
              const response = yield* api.request(
                actors.owner,
                "POST",
                `${path}/credential-checks`,
                {
                  provider: app.requirements.accounts.syncro.provider,
                  method: "apiKey",
                  fields: { apiKey: secret, subdomain },
                },
              );
              expect(response.status, JSON.stringify(response.body)).toBe(200);
              expect(JSON.stringify(response.body)).not.toContain(secret);
              expect(JSON.stringify(response.body)).not.toContain(userEmail);
              return yield* body(Check, response);
            });
          expect(yield* check("127")).toEqual({ status: "healthy", info: null });
          for (const [failureStatus, outcome] of [
            [401, "credentials_rejected"],
            [403, "forbidden"],
            [503, "upstream_unavailable"],
          ] as const) {
            yield* Ref.set(status, failureStatus);
            expect((yield* check("127")).status).toBe(outcome);
          }
          yield* Ref.set(status, 200);
          expect(received.filter((request) => request.url === "/api/v1/me")).toHaveLength(4);

          const profile = yield* createProfile(actors.owner, path);
          const connect = (subdomain: string) =>
            Effect.gen(function* () {
              const connection = yield* body(
                Resource,
                yield* api.request(actors.owner, "POST", `${path}/connections`, {
                  requirement: "syncro",
                  profile: profile.id,
                }),
              );
              const saved = yield* api.request(
                actors.owner,
                "POST",
                `${prefix}/connections/${connection.id}/submit`,
                {
                  method: "apiKey",
                  label: "Synthetic Syncro",
                  fields: { apiKey: secret, subdomain },
                },
              );
              expect(saved.status, JSON.stringify(saved.body)).toBe(200);
              const account = yield* body(Resource, saved);
              yield* Effect.addFinalizer(() =>
                api
                  .request(actors.owner, "DELETE", `${prefix}/accounts/${account.id}`)
                  .pipe(Effect.orDie),
              );
              const selected = yield* selectProfileAccounts(actors.owner, path, profile.id, {
                syncro: account.id,
              });
              expect(selected.status).toBe(200);
              return account.id;
            });
          const account = yield* connect("127");
          // A saved account's check reads /me with the stored key.
          const accountCheck = Effect.gen(function* () {
            const response = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/accounts/${account}/health`,
            );
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            expect(JSON.stringify(response.body)).not.toContain(userEmail);
            return yield* body(AccountHealth, response);
          });
          expect(yield* accountCheck).toMatchObject({
            info: null,
            apps: [{ app: app.id, checkable: true, check: { status: "healthy" } }],
          });
          yield* Ref.set(status, 401);
          expect(yield* accountCheck).toMatchObject({
            apps: [{ app: app.id, check: { status: "credentials_rejected" } }],
          });
          yield* Ref.set(status, 200);
          const call = (tool: string, input: object) =>
            api.request(actors.owner, "POST", `${path}/tools/call`, {
              profile: profile.id,
              tool,
              kind: "query",
              input,
            });
          const Page = Schema.Struct({
            meta: Schema.Struct({ page: Schema.Number, total_pages: Schema.Number }),
            nextPage: Schema.NullOr(Schema.Number),
          });
          for (const tool of ["searchTickets", "searchCustomers", "ticketComments"]) {
            const input = tool === "ticketComments" ? { id: 7 } : { query: "A & B" };
            const first = yield* call(tool, input);
            expect(first.status, JSON.stringify(first.body)).toBe(200);
            expect(yield* body(Page, first)).toMatchObject({ meta: { page: 1 }, nextPage: 2 });
            if (tool === "ticketComments")
              expect(first.body).toMatchObject({
                comments: [{ id: 1, hidden: true, body: "internal note" }],
              });
            const last = yield* call(tool, { ...input, page: 2 });
            expect(last.status).toBe(200);
            expect(yield* body(Page, last)).toMatchObject({ meta: { page: 2 }, nextPage: null });
          }
          const ticket = yield* call("getTicket", { id: 7 });
          expect(ticket.status).toBe(200);
          // The service received the real key; its echo reaches the app and caller as the handle.
          const echoed = yield* body(
            Schema.Struct({ ticket: Schema.Struct({ authorization: Schema.String }) }),
            ticket,
          );
          expect(echoed.ticket.authorization).toMatch(handle);
          expect((yield* call("getCustomer", { id: 7 })).status).toBe(200);

          // The ticket number users cite is sent as Syncro's number filter.
          const cited = yield* call("searchTickets", { number: 4207 });
          expect(cited.status, JSON.stringify(cited.body)).toBe(200);
          expect(cited.body).toMatchObject({ tickets: [{ id: 90, number: 4207 }] });
          expect(received.some((request) => request.url.includes("number=4207"))).toBe(true);

          expect(
            received.every(
              (request) =>
                request.method === "GET" &&
                request.authorization === `Bearer ${secret}` &&
                !request.url.includes(secret),
            ),
          ).toBe(true);
          expect(
            received.some(
              (request) =>
                request.url.includes("/tickets/7/comments?") &&
                request.url.includes("comment_format=plaintext"),
            ),
          ).toBe(true);
          expect(received.some((request) => request.url.includes("query=A+%26+B"))).toBe(true);
          for (const failureStatus of [302, 401, 403, 429, 503]) {
            yield* Ref.set(status, failureStatus);
            const failed = yield* call("getTicket", { id: 7 });
            expect(failed.status).not.toBe(200);
            expect(JSON.stringify(failed.body)).not.toContain(secret);
            expect(JSON.stringify(failed.body)).toContain(
              failureStatus === 302
                ? "rejected"
                : failureStatus === 401
                  ? "unauthorized"
                  : failureStatus === 403
                    ? "forbidden"
                    : failureStatus === 429
                      ? "rate_limited"
                      : "unavailable",
            );
          }
          yield* Ref.set(status, 200);
          const beforeInvalid = received.length;
          expect((yield* call("searchTickets", { page: 0 })).status).not.toBe(200);
          expect((yield* call("searchTickets", { number: 0 })).status).not.toBe(200);
          expect((yield* call("getTicket", { id: 1.5 })).status).not.toBe(200);
          // The app refuses a subdomain that is not one lowercase label before sending anything.
          // Executor's own refusal of unlisted hosts is covered by credential-hosts.spec.ts.
          yield* connect("fixture.evil.example");
          expect(yield* check("fixture.evil.example")).toMatchObject({ status: "check_failed" });
          expect((yield* call("getTicket", { id: 7 })).status).not.toBe(200);
          expect(received.length).toBe(beforeInvalid);
        }
      }),
    ),
  );
});
