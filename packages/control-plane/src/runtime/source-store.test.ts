import { describe, expect, it } from "@effect/vitest";

import {
  AccountIdSchema,
  OrganizationIdSchema,
  SecretMaterialIdSchema,
  SourceAuthSessionIdSchema,
  SourceIdSchema,
  WorkspaceIdSchema,
  type Source,
} from "#schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { createSqlControlPlanePersistence } from "../persistence";
import { persistSource, removeSourceById } from "./source-store";

const makePersistence = Effect.acquireRelease(
  createSqlControlPlanePersistence({
    localDataDir: ":memory:",
  }),
  (persistence) =>
    Effect.tryPromise({
      try: () => persistence.close(),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }).pipe(Effect.orDie),
);

const makeOpenApiSource = (input: {
  workspaceId: Source["workspaceId"];
  sourceId: Source["id"];
  now: number;
  updatedAt?: number;
  auth: Source["auth"];
}): Source => ({
  id: input.sourceId,
  workspaceId: input.workspaceId,
  name: "GitHub",
  kind: "openapi",
  endpoint: "https://api.github.com",
  status: "connected",
  enabled: true,
  namespace: "github",
  transport: null,
  queryParams: null,
  headers: null,
  specUrl: "https://example.com/openapi.json",
  defaultHeaders: null,
  auth: input.auth,
  sourceHash: null,
  lastError: null,
  createdAt: input.now,
  updatedAt: input.updatedAt ?? input.now,
});

describe("source-store", () => {
  it.scoped("replaces superseded secrets and removes source auth state cleanly", () =>
    Effect.gen(function* () {
      const persistence = yield* makePersistence;
      const now = Date.now();
      const accountId = AccountIdSchema.make("acc_source_store");
      const organizationId = OrganizationIdSchema.make("org_source_store");
      const workspaceId = WorkspaceIdSchema.make("ws_source_store");
      const sourceId = SourceIdSchema.make("src_source_store");
      const firstTokenId = SecretMaterialIdSchema.make("sec_source_store_first");
      const secondTokenId = SecretMaterialIdSchema.make("sec_source_store_second");

      yield* persistence.rows.organizations.insert({
        id: organizationId,
        slug: "source-store",
        name: "Source Store",
        status: "active",
        createdByAccountId: accountId,
        createdAt: now,
        updatedAt: now,
      });
      yield* persistence.rows.workspaces.insert({
        id: workspaceId,
        organizationId,
        name: "Primary",
        createdByAccountId: accountId,
        createdAt: now,
        updatedAt: now,
      });

      yield* persistence.rows.secretMaterials.upsert({
        id: firstTokenId,
        purpose: "auth_material",
        value: "ghp_first",
        createdAt: now,
        updatedAt: now,
      });
      yield* persistence.rows.secretMaterials.upsert({
        id: secondTokenId,
        purpose: "auth_material",
        value: "ghp_second",
        createdAt: now,
        updatedAt: now,
      });

      yield* persistSource(
        persistence.rows,
        makeOpenApiSource({
          workspaceId,
          sourceId,
          now,
          auth: {
            kind: "bearer",
            headerName: "Authorization",
            prefix: "Bearer ",
            token: {
              providerId: "postgres",
              handle: firstTokenId,
            },
          },
        }),
      );

      yield* persistence.rows.sourceAuthSessions.upsert({
        id: SourceAuthSessionIdSchema.make("src_auth_source_store"),
        workspaceId,
        sourceId,
        executionId: null,
        interactionId: null,
        strategy: "oauth2_authorization_code",
        status: "pending",
        endpoint: "https://api.github.com",
        state: "state_source_store",
        redirectUri: "http://127.0.0.1/callback",
        scope: null,
        resourceMetadataUrl: null,
        authorizationServerUrl: null,
        resourceMetadataJson: null,
        authorizationServerMetadataJson: null,
        clientInformationJson: null,
        codeVerifier: "verifier",
        authorizationUrl: "https://example.com/auth",
        errorText: null,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
      });

      yield* persistSource(
        persistence.rows,
        makeOpenApiSource({
          workspaceId,
          sourceId,
          now,
          updatedAt: now + 1,
          auth: {
            kind: "bearer",
            headerName: "Authorization",
            prefix: "Bearer ",
            token: {
              providerId: "postgres",
              handle: secondTokenId,
            },
          },
        }),
      );

      expect(Option.isNone(yield* persistence.rows.secretMaterials.getById(firstTokenId))).toBe(true);
      expect(yield* persistence.rows.credentials.listByWorkspaceId(workspaceId)).toHaveLength(1);
      expect((yield* persistence.rows.credentials.listByWorkspaceId(workspaceId))[0]?.tokenHandle).toBe(
        secondTokenId,
      );

      const removed = yield* removeSourceById(persistence.rows, {
        workspaceId,
        sourceId,
      });
      expect(removed).toBe(true);

      expect(Option.isNone(yield* persistence.rows.secretMaterials.getById(secondTokenId))).toBe(true);
      expect(yield* persistence.rows.sources.listByWorkspaceId(workspaceId)).toHaveLength(0);
      expect(yield* persistence.rows.credentials.listByWorkspaceId(workspaceId)).toHaveLength(0);
      expect(yield* persistence.rows.sourceCredentialBindings.listByWorkspaceId(workspaceId)).toHaveLength(0);
      expect(yield* persistence.rows.sourceAuthSessions.listByWorkspaceId(workspaceId)).toHaveLength(0);
    }),
  );
});
