/**
 * Production-side hardening for Better Auth's `oAuthProxy` plugin.
 *
 * The plugin trusts anything encrypted with the shared proxy secret. Without this
 * guard, that secret alone lets its holder (1) point production's code exchange at
 * an arbitrary redirect target that then receives the provider tokens, and
 * (2) mint a production session for any email through the completion endpoints
 * that the plugin registers on every host. Production is never the receiving side,
 * so both paths are closed here. Place `oauthProxyProductionGuard` before
 * `oAuthProxy` so its before hooks run first.
 *
 * Recognition of a proxy package matches the plugin's own truthiness test. A
 * stricter test would let a package the plugin still accepts skip this guard.
 * better-auth 1.7.16 encrypts that package and its state cookie under
 * purpose-derived keys, not the raw secret. Decrypting with the raw secret fails,
 * and treating that failure as "not a proxy package" lets the plugin redirect to
 * whatever target the ciphertext names. A decrypt or parse failure of anything
 * other than a normal sign-in state is refused here: a redirect thrown later, in
 * the plugin's before hook, never reaches the after hooks.
 *
 * The plugin also rewrites the outgoing `Location` on `/callback/:id` from an
 * unvalidated `callbackURL` parameter. `oauthProxyLocationGuard` re-checks that
 * header and must be registered *after* `oAuthProxy`, because Better Auth runs
 * after hooks in plugin order.
 */
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { derivePurposeKey, symmetricDecrypt } from "better-auth/crypto";

/** Endpoints that only a test stage needs; production must not accept a profile. */
const completionPaths = new Set(["/callback/:id/oauth-proxy", "/oauth-proxy-callback"]);

/** Every field of a decrypted proxy state that Better Auth turns into a redirect. */
const redirectFields = ["callbackURL", "errorURL", "newUserURL"] as const;

const badState = (message: string) => new APIError("BAD_REQUEST", { message });

/** The same gate the plugin applies, so no package it accepts can skip this guard. */
export const isProxyStatePackage = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  "isOAuthProxy" in value &&
  Boolean(value.isOAuthProxy) &&
  "state" in value &&
  Boolean(value.state) &&
  "stateCookie" in value &&
  Boolean(value.stateCookie);

/**
 * A single-slash path stays on the receiving host and needs no origin. Anything
 * else must be an absolute http(s) URL whose origin can be checked.
 */
const redirectOrigin = (value: string, field: string): string | undefined => {
  if (value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")) return undefined;
  const target = URL.parse(value);
  if (target === null || (target.protocol !== "https:" && target.protocol !== "http:"))
    throw badState(`OAuth proxy ${field} is not a usable redirect.`);
  return target.origin;
};

/**
 * Every origin one decrypted proxy state can send the browser to. `errorURL` and
 * `newUserURL` are redirect targets on the failure and first-sign-in branches, and
 * the receiving host finally redirects to the `callbackURL` nested inside
 * `callbackURL`, so all of them are checked, not just the outer callback.
 */
export const proxyRedirectOrigins = (stateData: unknown): ReadonlyArray<string> => {
  if (typeof stateData !== "object" || stateData === null)
    throw badState("OAuth proxy state is missing its redirect.");
  const state = stateData as Record<string, unknown>;
  if (typeof state["callbackURL"] !== "string" || state["callbackURL"].length === 0)
    throw badState("OAuth proxy state is missing its redirect.");
  const origins = new Set<string>();
  for (const field of redirectFields) {
    const value = state[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" || value.length === 0)
      throw badState(`OAuth proxy ${field} is not a usable redirect.`);
    const origin = redirectOrigin(value, field);
    if (origin !== undefined) origins.add(origin);
  }
  const nested = URL.parse(state["callbackURL"])?.searchParams.get("callbackURL");
  if (nested !== null && nested !== undefined && nested.length > 0) {
    const origin = redirectOrigin(nested, "nested callbackURL");
    if (origin !== undefined) origins.add(origin);
  }
  return [...origins];
};

/**
 * Production's own sign-in state: `generateRandomString(32)`. It is not ciphertext.
 * A proxy package is hex from `symmetricEncrypt` and is far longer.
 */
const regularSignInState = /^[A-Za-z0-9_-]{32}$/u;

const decryptJson = async (key: string, data: string): Promise<unknown> =>
  JSON.parse(await symmetricDecrypt({ key, data }));

const proxiedRedirectOrigins = async (
  secret: string,
  state: unknown,
): Promise<ReadonlyArray<string> | undefined> => {
  if (typeof state !== "string" || state.length === 0) return undefined;
  let statePackage: unknown;
  try {
    statePackage = await decryptJson(derivePurposeKey(secret, "oauth-proxy-package"), state);
  } catch {
    // The plugin uses this same key. A normal sign-in token is not a package, so the
    // callback continues. Anything else that will not decrypt is refused: the plugin
    // must not be left to follow a target this guard could not read.
    if (regularSignInState.test(state)) return undefined;
    throw badState("OAuth proxy state cannot be read.");
  }
  if (!isProxyStatePackage(statePackage)) throw badState("OAuth proxy state cannot be read.");
  const stateCookie = (statePackage as { stateCookie: unknown }).stateCookie;
  if (typeof stateCookie !== "string") throw badState("OAuth proxy state cannot be read.");
  let stateData: unknown;
  try {
    stateData = await decryptJson(derivePurposeKey(secret, "oauth-proxy-state"), stateCookie);
  } catch {
    throw badState("OAuth proxy state cannot be read.");
  }
  return proxyRedirectOrigins(stateData);
};

/** Only allow proxied sign-ins to return to a trusted origin, and never complete one here. */
export const oauthProxyProductionGuard = (secret: string) =>
  ({
    id: "executor-oauth-proxy-production-guard",
    hooks: {
      before: [
        {
          matcher: (context) => context.path !== undefined && completionPaths.has(context.path),
          handler: createAuthMiddleware(async () => {
            throw new APIError("NOT_FOUND");
          }),
        },
        {
          matcher: (context) => context.path === "/callback/:id",
          handler: createAuthMiddleware(async (context) => {
            const origins = await proxiedRedirectOrigins(
              secret,
              context.query?.state ?? context.body?.state,
            );
            if (origins === undefined) return;
            for (const origin of origins)
              if (!context.context.isTrustedOrigin(origin))
                throw new APIError("FORBIDDEN", {
                  message: "OAuth proxy redirect target is not a trusted origin.",
                });
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin;

/**
 * The proxy plugin's own `after` hook rewrites `Location` to the `callbackURL`
 * parameter of the outgoing redirect without checking it, and that rewrite needs
 * no proxy secret. The check is against this host's trusted origins, so register
 * this after `oAuthProxy` on every host that registers the plugin, not only on
 * the origin that acts as production.
 */
export const oauthProxyLocationGuard = () =>
  ({
    id: "executor-oauth-proxy-location-guard",
    hooks: {
      after: [
        {
          matcher: (context) => context.path === "/callback/:id",
          handler: createAuthMiddleware(async (context) => {
            const location = context.context.responseHeaders?.get("location");
            if (location === null || location === undefined) return;
            // A relative destination stays on this host and needs no origin check.
            const target = URL.parse(location);
            if (target === null || context.context.isTrustedOrigin(target.origin)) return;
            context.setHeader("location", "/");
            throw new APIError("FORBIDDEN", {
              message: "OAuth redirect target is not a trusted origin.",
            });
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin;
