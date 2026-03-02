import { type TaskRun } from "@executor-v2/schema";
import { v } from "convex/values";

import { internalMutation, internalQuery } from "./_generated/server";

const taskRunTerminalStatusValidator = v.union(
  v.literal("completed"),
  v.literal("failed"),
  v.literal("timed_out"),
  v.literal("denied"),
);

export const startTaskRun = internalMutation({
  args: {
    workspaceId: v.string(),
    runId: v.string(),
    accountId: v.optional(v.union(v.string(), v.null())),
    sessionId: v.optional(v.string()),
    runtimeId: v.optional(v.string()),
    codeHash: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<void> => {
    const existing = await ctx.db
      .query("taskRuns")
      .withIndex("by_domainId", (q) => q.eq("id", args.runId))
      .unique();

    if (existing) {
      if (existing.workspaceId !== args.workspaceId) {
        throw new Error(`Task run workspace mismatch: ${args.runId}`);
      }
      return;
    }

    const taskRun = {
      id: args.runId,
      workspaceId: args.workspaceId,
      accountId: args.accountId ?? null,
      sessionId: args.sessionId ?? "session_runtime",
      runtimeId: args.runtimeId ?? "runtime",
      codeHash: args.codeHash ?? "runtime",
      status: "running",
      startedAt: Date.now(),
      completedAt: null,
      exitCode: null,
      error: null,
    } as TaskRun;

    await ctx.db.insert("taskRuns", taskRun);
  },
});

export const finishTaskRun = internalMutation({
  args: {
    workspaceId: v.string(),
    runId: v.string(),
    status: taskRunTerminalStatusValidator,
    error: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args): Promise<void> => {
    const existing = await ctx.db
      .query("taskRuns")
      .withIndex("by_domainId", (q) => q.eq("id", args.runId))
      .unique();

    if (!existing) {
      return;
    }

    if (existing.workspaceId !== args.workspaceId) {
      throw new Error(`Task run workspace mismatch: ${args.runId}`);
    }

    await ctx.db.patch(existing._id, {
      status: args.status,
      completedAt: Date.now(),
      error: args.error ?? null,
    });
  },
});

export const getTaskRunContext = internalQuery({
  args: {
    runId: v.string(),
  },
  handler: async (ctx, args): Promise<{ workspaceId: string; accountId: string | null } | null> => {
    const existing = await ctx.db
      .query("taskRuns")
      .withIndex("by_domainId", (q) => q.eq("id", args.runId))
      .unique();

    if (!existing) {
      return null;
    }

    return {
      workspaceId: existing.workspaceId,
      accountId: typeof existing.accountId === "string" ? existing.accountId : null,
    };
  },
});
