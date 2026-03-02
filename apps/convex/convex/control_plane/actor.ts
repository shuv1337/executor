import {
  ControlPlaneActorResolverLive,
  deriveWorkspaceMembershipsForPrincipal,
} from "@executor-v2/management-api";
import { ActorUnauthenticatedError, makeActor } from "@executor-v2/domain";
import {
  OrganizationMembershipSchema,
  PrincipalSchema,
  type Principal,
  WorkspaceSchema,
  type OrganizationMembership,
  type Workspace,
} from "@executor-v2/schema";
import { type UserIdentity } from "convex/server";
import { v } from "convex/values";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { internal } from "../_generated/api";
import {
  internalMutation,
  internalQuery,
  type ActionCtx,
} from "../_generated/server";

const decodeWorkspace = Schema.decodeUnknownSync(WorkspaceSchema);
const decodeOrganizationMembership = Schema.decodeUnknownSync(
  OrganizationMembershipSchema,
);
const decodePrincipal = Schema.decodeUnknownSync(PrincipalSchema);

const stripConvexSystemFields = (
  value: Record<string, unknown>,
): Record<string, unknown> => {
  const { _id: _ignoredId, _creationTime: _ignoredCreationTime, ...rest } = value;
  return rest;
};

const toOrganizationSlug = (accountId: string): string => {
  const slug = accountId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");

  return slug.length > 0 ? `acct-${slug}` : `acct-${crypto.randomUUID().slice(0, 8)}`;
};

export const getWorkspaceForActor = internalQuery({
  args: {
    workspaceId: v.string(),
  },
  handler: async (ctx, args): Promise<Workspace | null> => {
    const row = await ctx.db
      .query("workspaces")
      .withIndex("by_domainId", (q) => q.eq("id", args.workspaceId))
      .first();

    if (row === null) {
      return null;
    }

    return decodeWorkspace(
      stripConvexSystemFields(row as unknown as Record<string, unknown>),
    );
  },
});

export const listOrganizationMembershipsForActor = internalQuery({
  args: {
    accountId: v.string(),
  },
  handler: async (ctx, args): Promise<ReadonlyArray<OrganizationMembership>> => {
    const rows = await ctx.db
      .query("organizationMemberships")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .collect();

    return rows.map((row) =>
      decodeOrganizationMembership(
        stripConvexSystemFields(row as unknown as Record<string, unknown>),
      ),
    );
  },
});

export const listWorkspacesForActor = internalQuery({
  args: {
    accountId: v.string(),
    organizationIds: v.array(v.string()),
  },
  handler: async (ctx, args): Promise<ReadonlyArray<Workspace>> => {
    const ownRows = await ctx.db
      .query("workspaces")
      .withIndex("by_createdByAccountId", (q) => q.eq("createdByAccountId", args.accountId))
      .collect();

    const organizationRows = await Promise.all(
      args.organizationIds.map((organizationId) =>
        ctx.db
          .query("workspaces")
          .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
          .collect(),
      ),
    );

    const workspaces = [...ownRows, ...organizationRows.flat()].map((row) =>
      decodeWorkspace(stripConvexSystemFields(row as unknown as Record<string, unknown>)),
    );

    return Array.from(new Map(workspaces.map((workspace) => [workspace.id, workspace])).values());
  },
});

export const ensureWorkspaceForActor = internalMutation({
  args: {
    workspaceId: v.string(),
    accountId: v.string(),
  },
  handler: async (ctx, args): Promise<Workspace> => {
    const now = Date.now();

    const ensureOrganizationMembership = async (organizationId: string) => {
      const existingOrganization = await ctx.db
        .query("organizations")
        .withIndex("by_domainId", (q) => q.eq("id", organizationId))
        .first();

      if (existingOrganization === null) {
        await ctx.db.insert("organizations", {
          id: organizationId,
          slug: toOrganizationSlug(args.accountId),
          name: `${args.accountId} Organization`,
          status: "active",
          createdByAccountId: args.accountId,
          createdAt: now,
          updatedAt: now,
        });
      }

      const existingMembership = await ctx.db
        .query("organizationMemberships")
        .withIndex("by_organizationId_accountId", (q) =>
          q.eq("organizationId", organizationId).eq("accountId", args.accountId)
        )
        .first();

      if (existingMembership !== null) {
        return;
      }

      await ctx.db.insert("organizationMemberships", {
        id: `org_member_${crypto.randomUUID()}`,
        organizationId,
        accountId: args.accountId,
        role: "owner",
        status: "active",
        billable: false,
        invitedByAccountId: null,
        joinedAt: now,
        createdAt: now,
        updatedAt: now,
      });
    };

    const existing = await ctx.db
      .query("workspaces")
      .withIndex("by_domainId", (q) => q.eq("id", args.workspaceId))
      .first();

    if (existing !== null) {
      const existingWorkspace = decodeWorkspace(
        stripConvexSystemFields(existing as unknown as Record<string, unknown>),
      );

      await ensureOrganizationMembership(existingWorkspace.organizationId);

      if (existingWorkspace.createdByAccountId !== null) {
        return existingWorkspace;
      }

      await ctx.db.patch(existing._id, {
        createdByAccountId: args.accountId,
        updatedAt: now,
      });

      return decodeWorkspace({
        ...existingWorkspace,
        createdByAccountId: args.accountId,
        updatedAt: now,
      });
    }

    const organizationId = `org_${args.accountId}`;
    await ensureOrganizationMembership(organizationId);

    await ctx.db.insert("workspaces", {
      id: args.workspaceId,
      organizationId,
      name: args.workspaceId,
      createdByAccountId: args.accountId,
      createdAt: now,
      updatedAt: now,
    });

    return decodeWorkspace({
      id: args.workspaceId,
      organizationId,
      name: args.workspaceId,
      createdByAccountId: args.accountId,
      createdAt: now,
      updatedAt: now,
    });
  },
});

const runQueryEffect = <A>(
  operation: string,
  run: () => Promise<A>,
): Effect.Effect<A, ActorUnauthenticatedError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new ActorUnauthenticatedError({
        message: `Failed resolving actor (${operation}): ${String(cause)}`,
      }),
  });

const inferPrincipalProvider = (
  identity: UserIdentity,
): Principal["provider"] =>
  identity.issuer.trim().toLowerCase().includes("workos")
    ? "workos"
    : "local";

const toPrincipalFromIdentity = (
  identity: UserIdentity,
): Principal => {
  const accountId = identity.subject.trim();

  if (accountId.length === 0) {
    throw new ActorUnauthenticatedError({
      message: "Authenticated identity subject is required",
    });
  }

  const provider = inferPrincipalProvider(identity);
  const tokenIdentifier = identity.tokenIdentifier.trim();

  try {
    return decodePrincipal({
      accountId,
      provider,
      subject: tokenIdentifier.length > 0 ? tokenIdentifier : `${provider}:${accountId}`,
      email: identity.email?.trim() ?? null,
      displayName: identity.name?.trim() ?? null,
    });
  } catch (cause) {
    throw new ActorUnauthenticatedError({
      message: `Failed decoding authenticated principal: ${String(cause)}`,
    });
  }
};

const resolveAuthenticatedPrincipal = (
  ctx: ActionCtx,
): Effect.Effect<Principal, ActorUnauthenticatedError> =>
  Effect.tryPromise({
    try: async () => {
      const identity = await ctx.auth.getUserIdentity();

      if (identity === null) {
        throw new ActorUnauthenticatedError({
          message: "Authenticated principal is required",
        });
      }

      return toPrincipalFromIdentity(identity);
    },
    catch: (cause) =>
      cause instanceof ActorUnauthenticatedError
        ? cause
        : new ActorUnauthenticatedError({
            message: `Failed resolving authenticated principal: ${String(cause)}`,
          }),
  });

export const ConvexControlPlaneActorLive = (ctx: ActionCtx) =>
  ControlPlaneActorResolverLive({
    resolveActor: (input) =>
      Effect.gen(function* () {
        void input;

        const principal = yield* resolveAuthenticatedPrincipal(ctx);

        let organizationMemberships = yield* runQueryEffect(
          "organizationMembership.list",
          () =>
            ctx.runQuery(internal.control_plane.actor.listOrganizationMembershipsForActor, {
              accountId: principal.accountId,
            }),
        );

        let organizationIds = organizationMemberships.map(
          (membership) => membership.organizationId,
        );

        let workspaces = yield* runQueryEffect("workspace.list", () =>
          ctx.runQuery(internal.control_plane.actor.listWorkspacesForActor, {
            accountId: principal.accountId,
            organizationIds,
          }),
        );

        if (organizationMemberships.length === 0) {
          const workspaceId = workspaces[0]?.id ?? `ws_${principal.accountId}`;

          yield* runQueryEffect("workspace.ensureDefault", () =>
            ctx.runMutation(internal.control_plane.actor.ensureWorkspaceForActor, {
              workspaceId,
              accountId: principal.accountId,
            }),
          );

          organizationMemberships = yield* runQueryEffect(
            "organizationMembership.list",
            () =>
              ctx.runQuery(internal.control_plane.actor.listOrganizationMembershipsForActor, {
                accountId: principal.accountId,
              }),
          );

          organizationIds = organizationMemberships.map(
            (membership) => membership.organizationId,
          );

          workspaces = yield* runQueryEffect("workspace.list", () =>
            ctx.runQuery(internal.control_plane.actor.listWorkspacesForActor, {
              accountId: principal.accountId,
              organizationIds,
            }),
          );
        }

        const workspaceMemberships = workspaces.flatMap((workspace) =>
          deriveWorkspaceMembershipsForPrincipal({
            principalAccountId: principal.accountId,
            workspaceId: workspace.id,
            workspace,
            organizationMemberships,
          }),
        );

        return yield* makeActor({
          principal,
          workspaceMemberships,
          organizationMemberships,
        });
      }),
    resolveWorkspaceActor: (input) =>
      Effect.gen(function* () {
        void input.headers;

        const principal = yield* resolveAuthenticatedPrincipal(ctx);

        let workspace = yield* runQueryEffect("workspace.read", () =>
          ctx.runQuery(internal.control_plane.actor.getWorkspaceForActor, {
            workspaceId: input.workspaceId,
          }),
        );

        if (workspace === null || workspace.createdByAccountId === null) {
          workspace = yield* runQueryEffect("workspace.ensure", () =>
            ctx.runMutation(internal.control_plane.actor.ensureWorkspaceForActor, {
              workspaceId: input.workspaceId,
              accountId: principal.accountId,
            }),
          );
        }

        const organizationMemberships = yield* runQueryEffect(
          "organizationMembership.list",
          () =>
            ctx.runQuery(internal.control_plane.actor.listOrganizationMembershipsForActor, {
              accountId: principal.accountId,
            }),
        );

        const workspaceMemberships = deriveWorkspaceMembershipsForPrincipal({
          principalAccountId: principal.accountId,
          workspaceId: input.workspaceId,
          workspace,
          organizationMemberships,
        });

        return yield* makeActor({
          principal,
          workspaceMemberships,
          organizationMemberships,
        });
      }),
  });
