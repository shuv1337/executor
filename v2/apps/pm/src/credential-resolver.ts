import {
  buildCredentialHeaders,
  CredentialResolverError,
  extractCredentialResolutionContext,
  makeCredentialResolver,
  selectCredentialBinding,
  selectOAuthAccessToken,
  sourceIdFromSourceKey,
  type ResolveToolCredentials,
} from "@executor-v2/engine";
import { type LocalStateStore } from "@executor-v2/persistence-local";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

const toCredentialResolverError = (
  operation: string,
  message: string,
  details: string | null,
): CredentialResolverError =>
  new CredentialResolverError({
    operation,
    message,
    details,
  });

export const createPmResolveToolCredentials = (
  localStateStore: LocalStateStore,
): ResolveToolCredentials =>
  makeCredentialResolver((input) =>
    Effect.gen(function* () {
      const context = extractCredentialResolutionContext(input);
      if (context === null) {
        return {
          headers: {},
        };
      }

      const snapshotOption = yield* localStateStore.getSnapshot().pipe(
        Effect.mapError((error) =>
          toCredentialResolverError(
            "read_local_state_snapshot",
            "Failed reading local snapshot while resolving credentials",
            error.details ?? error.message,
          ),
        ),
      );

      const snapshot = Option.getOrNull(snapshotOption);
      if (snapshot === null) {
        return {
          headers: {},
        };
      }

      const binding = selectCredentialBinding(
        snapshot.credentialBindings,
        context,
      );
      if (binding === null) {
        return {
          headers: {},
        };
      }

      const sourceId = sourceIdFromSourceKey(context.sourceKey);

      const oauthAccessToken =
        binding.provider === "oauth2" && sourceId
          ? selectOAuthAccessToken(snapshot.oauthTokens, context, sourceId)
          : null;

      return {
        headers: buildCredentialHeaders(binding, {
          oauthAccessToken,
        }),
      };
    }),
  );
