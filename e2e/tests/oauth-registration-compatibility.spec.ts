import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { scenarios } from "../test-plan.ts";
const AppProvider = Schema.Struct({
  ...App.fields,
  requirements: Schema.Struct({
    accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
  }),
});
layer(HostedLive, { excludeTestServices: true })("OAuth registration compatibility", (it) => {
  it.effect(scenarios.oauthRegistrationCompatibility.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const issuer = yield* oauthSetupIssuer;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deploy = (name: string) =>
          Effect.gen(function* () {
            const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name: `${name} ${randomUUID().slice(0, 8)}`,
              files: [
                {
                  path: "index.ts",
                  content: `import { defineApp, defineProvider, oauth2 } from "apps";
const service=defineProvider({name:${JSON.stringify(name)},auth:{oauth:oauth2({discover:${JSON.stringify(issuer.origin + "/mcp")}})}});
export default defineApp({accounts:{service}},async()=>({queries:{}}));`,
                },
              ],
            });
            expect(response.status).toBe(200);
            const app = yield* body(AppProvider, response);
            yield* Effect.addFinalizer(() =>
              api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
            );
            return app;
          });

        for (const status of [201, 200]) {
          yield* issuer.configure({
            registrationStatus: status,
            malformedRegistration: false,
            authMethods: ["none"],
          });
          const app = yield* deploy(`HTTP ${status} registration`);
          const connection = yield* body(
            Resource,
            yield* api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/connections`, {
              requirement: "service",
            }),
          );
          const response = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${connection.id}/oauth/start`,
            { method: "oauth", label: "Synthetic account" },
          );
          expect(response.status).toBe(200);
          const redirect = yield* body(
            Schema.Struct({ status: Schema.Literal("redirect"), authorizationUrl: Schema.String }),
            response,
          );
          expect(new URL(redirect.authorizationUrl).searchParams.get("client_id")).toMatch(
            /^synthetic-client-/,
          );
          const setup = yield* body(
            Schema.Struct({ mode: Schema.String }),
            yield* api.request(
              actors.owner,
              "GET",
              `${prefix}/providers/${app.requirements.accounts.service.provider}/oauth/oauth/setup`,
            ),
          );
          expect(setup.mode).toBe("saved");
        }
        for (const [status, malformed] of [
          [200, true],
          [400, false],
        ] as const) {
          yield* issuer.configure({ registrationStatus: status, malformedRegistration: malformed });
          const app = yield* deploy(`Invalid registration ${status}`);
          const connection = yield* body(
            Resource,
            yield* api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/connections`, {
              requirement: "service",
            }),
          );
          const response = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${connection.id}/oauth/start`,
            { method: "oauth", label: "Synthetic account" },
          );
          expect(response.status).toBe(422);
          expect(
            yield* body(Schema.Struct({ _tag: Schema.String, reason: Schema.String }), response),
          ).toEqual({ _tag: "OAuthSetupFailed", reason: "registration" });
        }
        expect((yield* issuer.metrics).registrations).toBe(4);
      }),
    ),
  );
});
