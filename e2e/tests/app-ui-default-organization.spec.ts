/** A self-host with a default organization publishes its apps as `<app>.<base>` and refuses every other shape. */
import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { request as httpRequest } from "node:http";
import { Api, body, SessionClients } from "../support/api.ts";
import { helloIndex } from "../support/app-authoring.ts";
import { appsManifest } from "../support/apps-release.ts";
import { TestLive, withCase } from "../support/case.ts";
import { App, Organization } from "../support/contracts.ts";
import { startFreshSelfHost } from "../support/managed-server.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

const Organizations = Schema.NonEmptyArray(Organization);
const Location = Schema.Struct({ status: Schema.Literal("ready"), url: Schema.String });
/**
 * The public origins a reverse proxy serves; requests reach the loopback listener carrying them.
 * A public app base must be HTTPS, so the derived address is HTTPS while the listener stays HTTP.
 */
const publicOrigin = "http://executor.example.test";
const appBase = "https://apps.example.test";

layer(TestLive, { excludeTestServices: true })("App UI with a default organization", (it) => {
  it.effect(scenarios.appUiDefaultOrganization.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target;
        const origin = yield* startFreshSelfHost(target, {
          BETTER_AUTH_URL: publicOrigin,
          EXECUTOR_APP_UI_BASE_URL: appBase,
          EXECUTOR_APP_UI_HOST_FORMAT: "flat",
          EXECUTOR_APP_UI_DEFAULT_ORGANIZATION: "executor",
        });
        const api = yield* Api.pipe(
          Effect.provide(Layer.fresh(Api.layer)),
          Effect.provide(Layer.fresh(SessionClients.layer)),
          Effect.provideService(Target, { ...target, metadata: { ...target.metadata, origin } }),
        );
        const owner = yield* api.session();
        const request = (method: "GET" | "POST", path: string, data?: unknown) =>
          api.request(owner, method, path, data, { origin: publicOrigin });
        expect(
          (yield* request("POST", "/api/auth/self-host/setup", {
            name: "Proxy Owner",
            email: "proxy-owner@example.test",
            password: "Synthetic-proxy-password-123!",
            organizationName: "Proxy lab",
          })).status,
        ).toBe(200);
        const [organization] = yield* body(
          Organizations,
          yield* request("GET", "/api/auth/organization/list"),
        );
        // Setup gives a self-host its first organization the fixed slug the server was configured with.
        expect(organization.slug).toBe("executor");
        const prefix = `/api/organizations/${organization.id}`;
        const deployed = yield* request("POST", `${prefix}/apps/deploy`, {
          name: "Notes",
          files: [
            { path: "index.ts", content: helloIndex },
            appsManifest,
            { path: "ui/index.html", content: "<!doctype html><title>Notes</title><h1>Notes</h1>" },
          ],
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        const location = yield* request("GET", `${prefix}/apps/${app.id}/ui`);
        expect(location.status).toBe(200);
        const bareHost = `${app.slug}.apps.example.test`;
        expect(yield* body(Location, location)).toEqual({
          status: "ready",
          url: `https://${bareHost}`,
        });
        // The listener routes by the Host header alone, as it would behind the operator's proxy.
        // Fetch drops a `host` header, so this probe speaks HTTP directly and follows no redirect.
        const page = (host: string) =>
          Effect.callback<{ status: number; body: string; location: string }>((resume) => {
            const sent = httpRequest(new URL("/", origin), { headers: { host } }, (response) => {
              let body = "";
              response.setEncoding("utf8");
              response.on("data", (chunk: string) => (body += chunk));
              response.on("end", () =>
                resume(
                  Effect.succeed({
                    status: response.statusCode ?? 0,
                    body,
                    location: response.headers.location ?? "",
                  }),
                ),
              );
            });
            sent.on("error", (error) => resume(Effect.die(error)));
            sent.end();
          });
        // Anonymous visitors reach the app page handler, which withholds the app until sign-in.
        expect(yield* page(bareHost)).toEqual({
          status: 403,
          body: "App unavailable.",
          location: "",
        });
        // The app has one address: its flat and nested spellings are refused under the same base.
        const refused = { status: 404, body: "", location: "" };
        expect(yield* page(`${app.slug}--${organization.slug}.apps.example.test`)).toEqual(refused);
        expect(yield* page(`${app.slug}.${organization.slug}.apps.example.test`)).toEqual(refused);
      }),
    ),
  );
});
