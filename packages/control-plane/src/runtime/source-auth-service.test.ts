import { describe, expect, it } from "vitest";

import type { Source } from "#schema";

import {
  createTerminalSourceAuthSessionPatch,
  shouldPromptForOpenApiCredentialSetup,
} from "./source-auth-service";

const makeExistingOpenApiSource = (auth: Source["auth"]): Source => ({
  id: "src_test" as Source["id"],
  workspaceId: "ws_test" as Source["workspaceId"],
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
  auth,
  sourceHash: null,
  lastError: null,
  createdAt: 1,
  updatedAt: 1,
});

describe("source-auth-service", () => {
  it("clears ephemeral OAuth session fields when failing a session", () => {
    const patch = createTerminalSourceAuthSessionPatch({
      status: "failed",
      now: 123,
      errorText: "OAuth authorization failed",
      resourceMetadataUrl: "https://example.com/resource",
      authorizationServerUrl: "https://example.com/as",
      resourceMetadataJson: '{"issuer":"https://example.com"}',
      authorizationServerMetadataJson: '{"token_endpoint":"https://example.com/token"}',
    });

    expect(patch).toMatchObject({
      status: "failed",
      errorText: "OAuth authorization failed",
      completedAt: 123,
      updatedAt: 123,
      codeVerifier: null,
      authorizationUrl: null,
      clientInformationJson: null,
      resourceMetadataUrl: "https://example.com/resource",
      authorizationServerUrl: "https://example.com/as",
      resourceMetadataJson: '{"issuer":"https://example.com"}',
      authorizationServerMetadataJson: '{"token_endpoint":"https://example.com/token"}',
    });
  });

  it("clears ephemeral OAuth session fields when completing a session", () => {
    const patch = createTerminalSourceAuthSessionPatch({
      status: "completed",
      now: 456,
      errorText: null,
      resourceMetadataUrl: "https://example.com/resource",
      authorizationServerUrl: "https://example.com/as",
      resourceMetadataJson: '{"issuer":"https://example.com"}',
      authorizationServerMetadataJson: '{"token_endpoint":"https://example.com/token"}',
    });

    expect(patch).toMatchObject({
      status: "completed",
      errorText: null,
      completedAt: 456,
      updatedAt: 456,
      codeVerifier: null,
      authorizationUrl: null,
      clientInformationJson: null,
      resourceMetadataUrl: "https://example.com/resource",
      authorizationServerUrl: "https://example.com/as",
      resourceMetadataJson: '{"issuer":"https://example.com"}',
      authorizationServerMetadataJson: '{"token_endpoint":"https://example.com/token"}',
    });
  });

  it("reuses existing non-none OpenAPI auth without prompting again", () => {
    expect(
      shouldPromptForOpenApiCredentialSetup({
        existing: makeExistingOpenApiSource({
          kind: "bearer",
          headerName: "Authorization",
          prefix: "Bearer ",
          token: {
            providerId: "postgres",
            handle: "sec_bearer",
          },
        }),
      }),
    ).toBe(false);

    expect(
      shouldPromptForOpenApiCredentialSetup({
        existing: makeExistingOpenApiSource({
          kind: "oauth2",
          headerName: "Authorization",
          prefix: "Bearer ",
          accessToken: {
            providerId: "postgres",
            handle: "sec_access",
          },
          refreshToken: {
            providerId: "postgres",
            handle: "sec_refresh",
          },
        }),
      }),
    ).toBe(false);

    expect(
      shouldPromptForOpenApiCredentialSetup({
        existing: makeExistingOpenApiSource({
          kind: "none",
        }),
      }),
    ).toBe(true);
  });
});
