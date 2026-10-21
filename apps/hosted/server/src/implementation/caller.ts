/**
 * The verified caller each hosted entry point hands the SDK as `CurrentCaller`, which apps read as
 * `ctx.caller`. Agents act for the user who owns their grant or key; the client details they
 * present are relayed as untrusted provenance only.
 */
import type { ApprovedBy, Caller } from "apps/contracts";
import type { OrganizationAccess } from "../contracts/organization.ts";
import type { McpAccess } from "../contracts/mcp.ts";

/** An MCP client acting for the user who owns its OAuth grant or personal access token. */
export const mcpCaller = (access: McpAccess, issuer: string): Caller => ({
  kind: "agent",
  subject: access.userId,
  issuer,
  email: access.email ?? null,
  organizationId: access.access.organization,
  channel: "mcp",
  provenance: {
    trusted: false,
    clientId: access.clientId,
    ...(access.grant.target.kind === "mcp" && access.grant.target.connection !== undefined
      ? { connectionId: access.grant.target.connection }
      : {}),
  },
});

/** An API client: an OAuth API grant or an API key, acting for the user who owns it. */
export const apiCaller = (
  grant: {
    readonly userId: string;
    readonly email?: string | null | undefined;
    readonly access: Pick<OrganizationAccess, "organization">;
    readonly key?: { readonly id: string } | undefined;
  },
  issuer: string,
): Caller => ({
  kind: "agent",
  subject: grant.userId,
  issuer,
  email: grant.email ?? null,
  organizationId: grant.access.organization,
  channel: "api",
  ...(grant.key === undefined
    ? {}
    : { provenance: { trusted: false, clientId: `apikey:${grant.key.id}` } }),
});

/** A signed-in person, in the dashboard or an app's own UI. */
export const personCaller = (
  person: { readonly userId: string; readonly email?: string | null | undefined },
  organization: string,
  issuer: string,
  channel: "ui" | "dashboard",
): Caller => ({
  kind: "human",
  subject: person.userId,
  issuer,
  email: person.email ?? null,
  organizationId: organization,
  channel,
});

/** A person who answered an approval request on the browser page or in the dashboard. */
export const personApprover = (caller: Caller, method: "browser" | "dashboard"): ApprovedBy => ({
  ...caller,
  method,
});
