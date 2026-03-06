import { describe, expect, it } from "@effect/vitest";
import {
  AccountIdSchema,
  OrganizationIdSchema,
  OrganizationMemberIdSchema,
  WorkspaceIdSchema,
} from "#schema";

import { deriveWorkspaceMembershipsForPrincipal } from "./workspace-membership";

describe("workspace membership derivation", () => {
  it("prefers highest active role in matching organization", () => {
    const principalAccountId = AccountIdSchema.make("acc_1");
    const workspaceId = WorkspaceIdSchema.make("ws_1");
    const organizationId = OrganizationIdSchema.make("org_1");

    const memberships = deriveWorkspaceMembershipsForPrincipal({
      principalAccountId,
      workspaceId,
      workspace: {
        id: workspaceId,
        organizationId,
        name: "Main",
        createdByAccountId: null,
        createdAt: 1,
        updatedAt: 1,
      },
      organizationMemberships: [
        {
          id: OrganizationMemberIdSchema.make("mem_1"),
          organizationId,
          accountId: principalAccountId,
          role: "viewer",
          status: "active",
          billable: true,
          invitedByAccountId: null,
          joinedAt: 1,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: OrganizationMemberIdSchema.make("mem_2"),
          organizationId,
          accountId: principalAccountId,
          role: "admin",
          status: "active",
          billable: true,
          invitedByAccountId: null,
          joinedAt: 2,
          createdAt: 2,
          updatedAt: 2,
        },
      ],
    });

    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.role).toBe("admin");
  });
});
