/** Public registration through the packaged Go/workerd host, never a partial auth server. */
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { nativeClientProxy, nativeSelfHost } from "../support/native-self-host.ts";
import { scenarios } from "../test-plan.ts";

it.live(scenarios.selfHostNativeAuth.title, () =>
  Effect.scoped(
    Effect.gen(function* () {
      const host = yield* nativeSelfHost({
        EXECUTOR_TRUSTED_PROXY_HEADER: "cf-connecting-ip",
        EXECUTOR_TRUSTED_PROXIES: "127.0.0.1/32",
      });
      const proxy = yield* nativeClientProxy(host.origin);
      const client = { "cf-connecting-ip": "198.51.100.99" };
      for (let index = 0; index < 5; index++)
        expect((yield* host.register(client, proxy.first)).status).toBe(201);
      const limited = yield* host.register(client, proxy.first);
      expect(limited.status).toBe(429);
      expect(Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(limited.text)).toEqual(
        {
          error: "temporarily_unavailable",
          error_description: "Too many requests. Please try again later.",
        },
      );
      expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
      expect(limited.headers["retry-after"]).toBe(limited.headers["x-retry-after"]);
      expect((yield* host.register(client, proxy.second)).status).toBe(201);
      expect(
        (yield* host.register({ ...client, "x-executor-client-ip": "198.51.100.3" }, proxy.first))
          .status,
      ).toBe(429);
      // Missing, malformed, and multi-value single-IP assertions all share the socket bucket.
      for (const value of ["invalid", "198.51.100.3, 198.51.100.4", "", "127.0.0.1:80", "::1%lo0"])
        expect((yield* host.register({ "cf-connecting-ip": value })).status).toBe(201);
      expect((yield* host.register({})).status).toBe(429);
      // Other MCP OAuth protocol paths use the same early generic limiter, at
      // their own thresholds. Preserve ordinary OAuth errors before exhaustion.
      for (const endpoint of ["token", "authorize"] as const) {
        const limit = endpoint === "token" ? 20 : 30;
        for (let index = 0; index < limit; index++) {
          const response = yield* host.oauth(endpoint, { "cf-connecting-ip": "198.51.100.50" });
          expect(response.status).not.toBe(429);
          expect(
            Schema.decodeUnknownSync(
              Schema.fromJsonString(Schema.Struct({ error: Schema.optional(Schema.String) })),
            )(response.text).error,
          ).not.toBe("temporarily_unavailable");
        }
        const response = yield* host.oauth(endpoint, { "cf-connecting-ip": "198.51.100.50" });
        expect(response.status).toBe(429);
        expect(
          Schema.decodeUnknownSync(
            Schema.fromJsonString(Schema.Struct({ error: Schema.optional(Schema.String) })),
          )(response.text).error,
        ).toBe("temporarily_unavailable");
        expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
        expect(response.headers["retry-after"]).toBe(response.headers["x-retry-after"]);
      }

      const untrusted = yield* nativeSelfHost({
        EXECUTOR_TRUSTED_PROXY_HEADER: "cf-connecting-ip",
        EXECUTOR_TRUSTED_PROXIES: "192.0.2.0/24",
      });
      for (let index = 0; index < 5; index++)
        expect(
          (yield* untrusted.register({ "cf-connecting-ip": `198.51.100.${index + 10}` })).status,
        ).toBe(201);
      expect(
        (yield* untrusted.register({
          "cf-connecting-ip": "198.51.100.99",
          "x-executor-client-ip": "198.51.100.98",
          "x-forwarded-for": "198.51.100.97",
        })).status,
      ).toBe(429);

      const chain = yield* nativeSelfHost({
        EXECUTOR_TRUSTED_PROXY_HEADER: "x-forwarded-for",
        EXECUTOR_TRUSTED_PROXIES: "127.0.0.1, ::1/128",
      });
      for (let index = 0; index < 5; index++)
        expect(
          (yield* chain.register({
            "x-forwarded-for": `198.51.100.${index + 30}, 198.51.100.20, 127.0.0.1`,
          })).status,
        ).toBe(201);
      // The client-controlled left edge cannot rotate the nearest untrusted hop's bucket.
      expect(
        (yield* chain.register({
          "x-forwarded-for": "198.51.100.99, 198.51.100.20, 127.0.0.1",
        })).status,
      ).toBe(429);
      expect(
        (yield* chain.register({
          "x-forwarded-for": "198.51.100.99, 198.51.100.21, 127.0.0.1",
        })).status,
      ).toBe(201);
    }),
  ).pipe(Effect.provide(NodeServices.layer), Effect.provide(FetchHttpClient.layer)),
);
