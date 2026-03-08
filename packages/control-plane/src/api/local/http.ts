import {
  HttpApiBuilder,
} from "@effect/platform";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { randomUUID } from "node:crypto";

import { SecretMaterialIdSchema } from "#schema";
import {
  getLocalInstallation,
} from "../../runtime/local-operations";
import {
  ENV_SECRET_PROVIDER_ID,
  KEYCHAIN_SECRET_PROVIDER_ID,
  POSTGRES_SECRET_PROVIDER_ID,
  parseSecretStoreProviderId,
} from "../../runtime/secret-material-providers";
import { ControlPlaneStore } from "../../runtime/store";
import type {
  CreateSecretResult,
  InstanceConfig,
  SecretProvider,
  UpdateSecretResult,
} from "./api";

import { ControlPlaneApi } from "../api";
import {
  ControlPlaneBadRequestError,
  ControlPlaneNotFoundError,
  ControlPlaneStorageError,
} from "../errors";

const SECRET_STORE_PROVIDER_ENV = "EXECUTOR_SECRET_STORE_PROVIDER";

const getInstanceConfig = (): Effect.Effect<InstanceConfig> => {
  const providers: SecretProvider[] = [
    {
      id: POSTGRES_SECRET_PROVIDER_ID,
      name: "Database",
      canStore: true,
    },
  ];

  if (process.platform === "darwin" || process.platform === "linux") {
    providers.push({
      id: KEYCHAIN_SECRET_PROVIDER_ID,
      name: process.platform === "darwin" ? "macOS Keychain" : "Desktop Keyring",
      canStore: true,
    });
  }

  providers.push({
    id: ENV_SECRET_PROVIDER_ID,
    name: "Environment variable",
    canStore: false,
  });

  const defaultStoreProvider =
    parseSecretStoreProviderId(process.env[SECRET_STORE_PROVIDER_ENV])
    ?? POSTGRES_SECRET_PROVIDER_ID;

  return Effect.succeed({
    platform: process.platform,
    secretProviders: providers,
    defaultSecretStoreProvider: defaultStoreProvider,
  });
};

const storageError = (message: string) =>
  new ControlPlaneStorageError({
    operation: "secrets",
    message,
    details: message,
  });

export const ControlPlaneLocalLive = HttpApiBuilder.group(
  ControlPlaneApi,
  "local",
  (handlers) =>
    handlers
      .handle("installation", () =>
        getLocalInstallation(),
      )
      .handle("config", () =>
        getInstanceConfig(),
      )
      .handle("listSecrets", () =>
        Effect.gen(function* () {
          const store = yield* ControlPlaneStore;
          const rows = yield* store.secretMaterials.listAll().pipe(
            Effect.mapError(() => storageError("Failed listing secrets.")),
          );
          const linkedSourcesMap = yield* store.secretMaterials.listLinkedSources().pipe(
            Effect.mapError(() => storageError("Failed loading linked sources.")),
          );
          return rows.map((row) => ({
            ...row,
            linkedSources: linkedSourcesMap.get(row.id) ?? [],
          }));
        }),
      )
      .handle("createSecret", ({ payload }) =>
        Effect.gen(function* () {
          const name = payload.name.trim();
          const value = payload.value;
          const purpose = payload.purpose ?? "auth_material";

          if (name.length === 0) {
            return yield* Effect.fail(
              new ControlPlaneBadRequestError({
                operation: "secrets.create",
                message: "Secret name is required.",
                details: "Secret name is required.",
              }),
            );
          }

          const store = yield* ControlPlaneStore;
          const now = Date.now();
          const id = SecretMaterialIdSchema.make(`sec_${randomUUID()}`);

          yield* store.secretMaterials.upsert({
            id,
            name,
            purpose,
            value,
            createdAt: now,
            updatedAt: now,
          }).pipe(
            Effect.mapError(() => storageError("Failed creating secret.")),
          );

          return {
            id,
            name,
            providerId: POSTGRES_SECRET_PROVIDER_ID,
            purpose,
            createdAt: now,
            updatedAt: now,
          } satisfies CreateSecretResult;
        }),
      )
      .handle("updateSecret", ({ path, payload }) =>
        Effect.gen(function* () {
          const secretId = SecretMaterialIdSchema.make(path.secretId);
          const store = yield* ControlPlaneStore;

          const existing = yield* store.secretMaterials.getById(secretId).pipe(
            Effect.mapError(() => storageError("Failed looking up secret.")),
          );

          if (Option.isNone(existing)) {
            return yield* Effect.fail(
              new ControlPlaneNotFoundError({
                operation: "secrets.update",
                message: `Secret not found: ${path.secretId}`,
                details: `Secret not found: ${path.secretId}`,
              }),
            );
          }

          const update: { name?: string | null; value?: string } = {};
          if (payload.name !== undefined) update.name = payload.name.trim() || null;
          if (payload.value !== undefined) update.value = payload.value;

          const updated = yield* store.secretMaterials.updateById(secretId, update).pipe(
            Effect.mapError(() => storageError("Failed updating secret.")),
          );

          if (Option.isNone(updated)) {
            return yield* Effect.fail(
              new ControlPlaneNotFoundError({
                operation: "secrets.update",
                message: `Secret not found after update: ${path.secretId}`,
                details: `Secret not found after update: ${path.secretId}`,
              }),
            );
          }

          return {
            id: updated.value.id,
            name: updated.value.name,
            purpose: updated.value.purpose,
            createdAt: updated.value.createdAt,
            updatedAt: updated.value.updatedAt,
          } satisfies UpdateSecretResult;
        }),
      )
      .handle("deleteSecret", ({ path }) =>
        Effect.gen(function* () {
          const secretId = SecretMaterialIdSchema.make(path.secretId);
          const store = yield* ControlPlaneStore;

          const removed = yield* store.secretMaterials.removeById(secretId).pipe(
            Effect.mapError(() => storageError("Failed removing secret.")),
          );

          if (!removed) {
            return yield* Effect.fail(
              new ControlPlaneNotFoundError({
                operation: "secrets.delete",
                message: `Secret not found: ${path.secretId}`,
                details: `Secret not found: ${path.secretId}`,
              }),
            );
          }

          return { removed: true };
        }),
      ),
);
