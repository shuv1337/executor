import {
  buildCredentialHeaders,
  selectOAuthAccessToken,
} from "@executor-v2/engine";
import { type UpsertCredentialBindingPayload } from "@executor-v2/management-api";
import {
  OAuthTokenSchema,
  SourceCredentialBindingSchema,
  type OAuthToken,
  type SourceCredentialBinding,
} from "@executor-v2/schema";
import { v } from "convex/values";
import * as Schema from "effect/Schema";

import { internal } from "../_generated/api";
import { decryptSecretValue, encryptSecretValue } from "../credential_crypto";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";

const runtimeInternal = internal;

const decodeSourceCredentialBinding = Schema.decodeUnknownSync(
  SourceCredentialBindingSchema,
);
const decodeOAuthToken = Schema.decodeUnknownSync(OAuthTokenSchema);

const stripConvexSystemFields = (
  value: Record<string, unknown>,
): Record<string, unknown> => {
  const { _id: _ignoredId, _creationTime: _ignoredCreationTime, ...rest } = value;
  return rest;
};

const toSourceCredentialBinding = (
  document: Record<string, unknown>,
): SourceCredentialBinding =>
  decodeSourceCredentialBinding(stripConvexSystemFields(document));

const credentialProviderValidator = v.union(
  v.literal("api_key"),
  v.literal("bearer"),
  v.literal("oauth2"),
  v.literal("custom"),
);

const credentialSecretProviderValidator = v.literal("local");

const credentialScopeTypeValidator = v.union(
  v.literal("workspace"),
  v.literal("organization"),
  v.literal("account"),
);

const sourceCredentialBindingPayloadValidator = v.object({
  id: v.optional(v.string()),
  credentialId: v.string(),
  scopeType: credentialScopeTypeValidator,
  sourceKey: v.string(),
  provider: credentialProviderValidator,
  secretProvider: v.optional(credentialSecretProviderValidator),
  secretRef: v.string(),
  accountId: v.optional(v.union(v.string(), v.null())),
  additionalHeadersJson: v.optional(v.union(v.string(), v.null())),
  boundAuthFingerprint: v.optional(v.union(v.string(), v.null())),
});

const sortSourceCredentialBindings = (
  bindings: ReadonlyArray<SourceCredentialBinding>,
): Array<SourceCredentialBinding> =>
  [...bindings].sort((left, right) => {
    const leftKey = `${left.sourceKey}:${left.provider}`.toLowerCase();
    const rightKey = `${right.sourceKey}:${right.provider}`.toLowerCase();

    if (leftKey === rightKey) {
      return left.id.localeCompare(right.id);
    }

    return leftKey.localeCompare(rightKey);
  });

const resolveWorkspaceOrganizationId = async (
  ctx: QueryCtx | MutationCtx,
  workspaceId: string,
): Promise<string> => {
  const workspace = await ctx.db
    .query("workspaces")
    .withIndex("by_domainId", (q) => q.eq("id", workspaceId))
    .unique();

  if (!workspace) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }

  return workspace.organizationId;
};

const canAccessSourceCredentialBinding = (
  binding: SourceCredentialBinding,
  input: {
    workspaceId: string;
    organizationId: string;
  },
): boolean =>
  binding.workspaceId === input.workspaceId
  || (binding.workspaceId === null && binding.organizationId === input.organizationId);

const toOAuthToken = (document: Record<string, unknown>): OAuthToken =>
  decodeOAuthToken(stripConvexSystemFields(document));

const sourceKeyFromSourceId = (sourceId: string): string | null => {
  const trimmed = sourceId.trim();
  if (trimmed.length === 0) {
    return null;
  }

  return `source:${trimmed}`;
};

const bindingScopeScore = (
  binding: SourceCredentialBinding,
  input: {
    workspaceId: string;
    organizationId: string;
    accountId: string | null;
  },
): number => {
  if (binding.scopeType === "account") {
    if (!input.accountId || binding.accountId !== input.accountId) {
      return -1;
    }

    return binding.organizationId === input.organizationId ? 30 : -1;
  }

  if (binding.scopeType === "workspace") {
    return binding.workspaceId === input.workspaceId ? 20 : -1;
  }

  if (binding.scopeType === "organization") {
    return binding.organizationId === input.organizationId ? 10 : -1;
  }

  return -1;
};

const selectBestSourceBinding = (
  bindings: ReadonlyArray<SourceCredentialBinding>,
  input: {
    workspaceId: string;
    organizationId: string;
    accountId: string | null;
  },
): SourceCredentialBinding | null => {
  const ranked = bindings
    .map((binding) => ({
      binding,
      scopeScore: bindingScopeScore(binding, input),
    }))
    .filter((candidate) => candidate.scopeScore >= 0)
    .sort((left, right) => {
      if (left.scopeScore !== right.scopeScore) {
        return right.scopeScore - left.scopeScore;
      }

      if (left.binding.updatedAt !== right.binding.updatedAt) {
        return right.binding.updatedAt - left.binding.updatedAt;
      }

      return right.binding.createdAt - left.binding.createdAt;
    });

  return ranked[0]?.binding ?? null;
};

const requireLocalSecretProvider = (
  secretProvider: SourceCredentialBinding["secretProvider"],
): "local" => {
  if (secretProvider !== "local") {
    throw new Error("Convex credentials require secretProvider 'local'");
  }

  return "local";
};

const defaultSecretProvider = (): "local" => "local";

const resolveSecretRefForHeaders = async (
  binding: SourceCredentialBinding,
): Promise<string> => {
  requireLocalSecretProvider(binding.secretProvider);
  return await decryptSecretValue(binding.secretRef);
};

const resolveSourceSelection = async (
  ctx: QueryCtx,
  args: {
    workspaceId: string;
    sourceId: string;
    accountId: string | null;
  },
): Promise<{
  binding: SourceCredentialBinding | null;
  oauthAccessToken: string | null;
}> => {
  const organizationId = await resolveWorkspaceOrganizationId(ctx, args.workspaceId);
  const sourceKey = sourceKeyFromSourceId(args.sourceId);
  if (!sourceKey) {
    return {
      binding: null,
      oauthAccessToken: null,
    };
  }

  const rows = await ctx.db
    .query("sourceCredentialBindings")
    .withIndex("by_sourceKey", (q) => q.eq("sourceKey", sourceKey))
    .collect();

  const binding = selectBestSourceBinding(
    rows.map((row) => toSourceCredentialBinding(row)),
    {
      workspaceId: args.workspaceId,
      organizationId,
      accountId: args.accountId,
    },
  );

  if (!binding) {
    return {
      binding: null,
      oauthAccessToken: null,
    };
  }

  const oauthTokens = binding.provider === "oauth2"
    ? (await ctx.db
      .query("oauthTokens")
      .withIndex("by_sourceId", (q) => q.eq("sourceId", args.sourceId))
      .collect()).map((row) => toOAuthToken(row))
    : [];

  const oauthAccessToken = binding.provider === "oauth2"
    ? selectOAuthAccessToken(oauthTokens, {
      workspaceId: args.workspaceId,
      organizationId,
      accountId: args.accountId,
      sourceKey,
    }, args.sourceId)
    : null;

  return {
    binding,
    oauthAccessToken,
  };
};

const withDecryptedSecret = async (
  binding: SourceCredentialBinding,
): Promise<SourceCredentialBinding> => {
  const secretRef = await resolveSecretRefForHeaders(binding);
  return {
    ...binding,
    secretProvider: "local",
    secretRef,
  };
};

export const resolveSourceCredentialSelection = internalQuery({
  args: {
    workspaceId: v.string(),
    sourceId: v.string(),
    accountId: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => resolveSourceSelection(ctx, {
    workspaceId: args.workspaceId,
    sourceId: args.sourceId,
    accountId: args.accountId ?? null,
  }),
});

export const resolveSourceCredentialHeaders = internalAction({
  args: {
    workspaceId: v.string(),
    sourceId: v.string(),
    accountId: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args): Promise<{
    headers: Record<string, string>;
  }> => {
    const selected = await ctx.runQuery(
      runtimeInternal.control_plane.credentials.resolveSourceCredentialSelection,
      {
        workspaceId: args.workspaceId,
        sourceId: args.sourceId,
        accountId: args.accountId ?? null,
      },
    );

    if (!selected.binding) {
      return {
        headers: {},
      };
    }

    const decrypted = await withDecryptedSecret(selected.binding);

    const headers = buildCredentialHeaders(decrypted, {
      oauthAccessToken: selected.oauthAccessToken,
    });

    return { headers };
  },
});

export const listCredentialBindings = internalQuery({
  args: {
    workspaceId: v.string(),
  },
  handler: async (ctx, args): Promise<Array<SourceCredentialBinding>> => {
    const organizationId = await resolveWorkspaceOrganizationId(ctx, args.workspaceId);

    const workspaceRows = await ctx.db
      .query("sourceCredentialBindings")
      .withIndex("by_workspaceId", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();

    const organizationRows = await ctx.db
      .query("sourceCredentialBindings")
      .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
      .collect();

    const bindings = [...workspaceRows, ...organizationRows]
      .map((row) =>
        toSourceCredentialBinding(row),
      )
      .filter((binding) =>
        canAccessSourceCredentialBinding(binding, {
          workspaceId: args.workspaceId,
          organizationId,
        })
      );

    const uniqueBindings = Array.from(
      new Map(bindings.map((binding) => [binding.id, binding])).values(),
    );

    const decryptedBindings = await Promise.all(
      uniqueBindings.map((binding) => withDecryptedSecret(binding)),
    );

    return sortSourceCredentialBindings(decryptedBindings);
  },
});

export const upsertCredentialBindingRecord = internalMutation({
  args: {
    workspaceId: v.string(),
    payload: sourceCredentialBindingPayloadValidator,
  },
  handler: async (ctx, args): Promise<SourceCredentialBinding> => {
    const payload = args.payload;

    if (payload.scopeType === "account" && payload.accountId === null) {
      throw new Error("Account scope credentials require accountId");
    }

    const organizationId = await resolveWorkspaceOrganizationId(ctx, args.workspaceId);
    const now = Date.now();
    const bindingId = payload.id ?? `credential_binding_${crypto.randomUUID()}`;

    const existing = await ctx.db
      .query("sourceCredentialBindings")
      .withIndex("by_domainId", (q) => q.eq("id", bindingId))
      .unique();

    const existingBinding = existing
      ? toSourceCredentialBinding(existing)
      : null;

    if (
      existingBinding !== null
      && !canAccessSourceCredentialBinding(existingBinding, {
        workspaceId: args.workspaceId,
        organizationId,
      })
    ) {
      throw new Error(`Credential binding not found: ${bindingId}`);
    }

    const secretProvider = requireLocalSecretProvider(
      payload.secretProvider
      ?? existingBinding?.secretProvider
      ?? defaultSecretProvider(),
    );

    const nextBinding = decodeSourceCredentialBinding({
      id: bindingId,
      credentialId: payload.credentialId,
      organizationId,
      workspaceId: payload.scopeType === "workspace" ? args.workspaceId : null,
      accountId: payload.scopeType === "account" ? (payload.accountId ?? null) : null,
      scopeType: payload.scopeType,
      sourceKey: payload.sourceKey,
      provider: payload.provider,
      secretProvider,
      secretRef: payload.secretRef,
      additionalHeadersJson: payload.additionalHeadersJson ?? null,
      boundAuthFingerprint: payload.boundAuthFingerprint ?? null,
      createdAt: existingBinding?.createdAt ?? now,
      updatedAt: now,
    });

    if (existing) {
      await ctx.db.patch(existing._id, nextBinding);
    } else {
      await ctx.db.insert("sourceCredentialBindings", nextBinding);
    }

    return nextBinding;
  },
});

export const upsertCredentialBinding = internalAction({
  args: {
    workspaceId: v.string(),
    payload: sourceCredentialBindingPayloadValidator,
  },
  handler: async (ctx, args): Promise<SourceCredentialBinding> => {
    const payload = args.payload;
    const requestedSecretRef = payload.secretRef.trim();
    if (requestedSecretRef.length === 0) {
      throw new Error("Credential secret is required");
    }

    const encryptedSecretRef = await encryptSecretValue(requestedSecretRef);

    const written = await ctx.runMutation(
      runtimeInternal.control_plane.credentials.upsertCredentialBindingRecord,
      {
        workspaceId: args.workspaceId,
        payload: {
          ...payload,
          secretProvider: "local",
          secretRef: encryptedSecretRef,
        },
      },
    );

    return {
      ...written,
      secretProvider: "local",
      secretRef: requestedSecretRef,
    };
  },
});

export const removeCredentialBinding = internalMutation({
  args: {
    workspaceId: v.string(),
    credentialBindingId: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    removed: boolean;
  }> => {
    const organizationId = await resolveWorkspaceOrganizationId(ctx, args.workspaceId);

    const existing = await ctx.db
      .query("sourceCredentialBindings")
      .withIndex("by_domainId", (q) => q.eq("id", args.credentialBindingId))
      .unique();

    if (!existing) {
      return { removed: false };
    }

    const existingBinding = toSourceCredentialBinding(
      existing,
    );

    if (
      !canAccessSourceCredentialBinding(existingBinding, {
        workspaceId: args.workspaceId,
        organizationId,
      })
    ) {
      return { removed: false };
    }

    await ctx.db.delete(existing._id);

    return { removed: true };
  },
});
