/**
 * An OAuth proxy state package encrypted the way better-auth 1.7.16 encrypts one:
 * HKDF purpose keys `oauth-proxy-state` and `oauth-proxy-package`, then `symmetricEncrypt`.
 * Resolved from the Cloud package so the scenario uses that install's patched export.
 */
import { createRequire } from "node:module";
import { Effect, Schema } from "effect";

const betterAuthCrypto = createRequire(
  new URL("../../apps/hosted/cloud/package.json", import.meta.url),
)("better-auth/crypto") as {
  readonly derivePurposeKey: (secret: string, purpose: string) => string;
  readonly symmetricEncrypt: (input: {
    readonly key: string;
    readonly data: string;
  }) => Promise<string>;
};

export class OauthProxyStateFailed extends Schema.TaggedError<OauthProxyStateFailed>()(
  "OauthProxyStateFailed",
  { message: Schema.String },
) {}

/** The `state` query production's callback receives for a proxied sign-in to `callbackURL`. */
export const oauthProxyState = (secret: string, callbackURL: string) =>
  Effect.tryPromise({
    try: () => {
      const stateKey = betterAuthCrypto.derivePurposeKey(secret, "oauth-proxy-state");
      const packageKey = betterAuthCrypto.derivePurposeKey(secret, "oauth-proxy-package");
      return betterAuthCrypto
        .symmetricEncrypt({
          key: stateKey,
          data: JSON.stringify({
            callbackURL,
            errorURL: callbackURL,
            newUserURL: callbackURL,
            codeVerifier: "verifier",
            oauthState: "a".repeat(32),
          }),
        })
        .then((stateCookie) =>
          betterAuthCrypto.symmetricEncrypt({
            key: packageKey,
            data: JSON.stringify({
              state: "a".repeat(32),
              stateCookie,
              isOAuthProxy: true,
            }),
          }),
        );
    },
    catch: () => new OauthProxyStateFailed({ message: "Could not encrypt an OAuth proxy state." }),
  });
