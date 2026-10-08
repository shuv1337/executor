import { expect, layer } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, FileSystem, Layer, Ref, Schema } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { createServer } from "node:http";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { appsManifest } from "../support/apps-release.ts";
import { createProfile, selectProfileAccounts } from "../support/profiles.ts";
import { scenarios } from "../test-plan.ts";

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
                received.push({
                  url: request.url,
                  authorization: request.headers.authorization,
                  method: request.method,
                });
                const responseStatus = yield* Ref.get(status);
                if (responseStatus !== 200)
                  return yield* HttpServerResponse.json(
                    { message: "synthetic-syncro-secret" },
                    { status: responseStatus },
                  );
                const url = new URL(request.url, "http://fixture");
                const page = Number(url.searchParams.get("page") ?? 1);
                const entity = { id: page, body: "internal note", hidden: true };
                const meta = { page, total_pages: 2, per_page: 10 };
                const response = url.pathname.endsWith("/comments")
                  ? { comments: [entity], meta }
                  : url.pathname === "/api/v1/tickets"
                    ? { tickets: [entity], meta }
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
        // Read authored source as deployment data; only its external HTTPS origin is redirected to the owned provider.
        const source = (yield* fs.readFileString("playground/demo-apps/syncro/index.ts")).replace(
          "https://${subdomain}.syncromsp.com",
          `http://127.0.0.1:${server.address.port}`,
        );
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: "Syncro REST reads",
          files: [{ path: "index.ts", content: source }, appsManifest],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        const path = `${prefix}/apps/${app.id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
        );
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
                fields: { apiKey: "synthetic-syncro-secret", subdomain },
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
          });
        yield* connect("fixture");
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
        for (const tool of ["getTicket", "getCustomer"])
          expect((yield* call(tool, { id: 7 })).status).toBe(200);
        expect(
          received.every(
            (request) =>
              request.method === "GET" &&
              request.authorization === "Bearer synthetic-syncro-secret" &&
              !request.url.includes("synthetic-syncro-secret"),
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
        for (const failureStatus of [302, 401, 429, 503]) {
          yield* Ref.set(status, failureStatus);
          const failed = yield* call("getTicket", { id: 7 });
          expect(failed.status).not.toBe(200);
          expect(JSON.stringify(failed.body)).not.toContain("synthetic-syncro-secret");
          expect(JSON.stringify(failed.body)).toContain(
            failureStatus === 302
              ? "rejected"
              : failureStatus === 401
                ? "unauthorized"
                : failureStatus === 429
                  ? "rate_limited"
                  : "unavailable",
          );
        }
        yield* Ref.set(status, 200);
        const beforeInvalid = received.length;
        expect((yield* call("searchTickets", { page: 0 })).status).not.toBe(200);
        expect((yield* call("getTicket", { id: 1.5 })).status).not.toBe(200);
        yield* connect("fixture.evil.example");
        expect((yield* call("getTicket", { id: 7 })).status).not.toBe(200);
        expect(received.length).toBe(beforeInvalid);
      }),
    ),
  );
});
