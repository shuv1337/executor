/** Members manage their own connections and connected agents; apps and accounts use the same access checks as calls. */
import {
  ConnectionAccessInvalid,
  ConnectionNotFound,
  type Connection,
  type ConnectionApp,
} from "@executor-js/mcp-auth/connections";
import { mcpResource } from "@executor-js/mcp-auth";
import type { App, Executor, OwnerId } from "@executor-js/sdk/core";
import { Effect, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { HostedApi } from "../contracts/api.ts";
import { CurrentPrincipal, CurrentUserId } from "../contracts/auth.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { McpAuthentication } from "../contracts/mcp.ts";
import { CurrentOrganization, OrganizationForbidden } from "../contracts/organization.ts";
import { ScheduleWakeup } from "../contracts/schedules.ts";
import { checkAccounts, currentOwner, usableApp } from "./access.ts";
import { addLink, linkedAccounts, lockedChange } from "./app-accounts.ts";
import { policyDatabase, requireAccountAccessAs } from "./resource-policy.ts";

const owner = Effect.gen(function* () {
  const organization = yield* CurrentOrganization;
  const userId = yield* CurrentUserId;
  if (userId === undefined) return yield* new OrganizationForbidden();
  return { userId, resource: organization.organization };
});

/**
 * Who may change connections through this request. A signed-in person manages their own. Without a
 * browser session the request carried a bearer that RequireOrganization accepted for `manage`, so it
 * holds its user's full authority (an API key or a full API grant; MCP tokens never reach the API);
 * of those, only an organization admin's or owner's may manage connections. Every bearer change is
 * logged, as connections decide which accounts an agent runs as.
 */
const manager = (
  action: "list" | "create" | "update" | "revoke" | "mint-key" | "list-keys" | "revoke-key",
  connection?: string,
) =>
  Effect.gen(function* () {
    const current = yield* owner;
    const person = yield* Effect.serviceOption(CurrentPrincipal);
    if (Option.isSome(person)) return current;
    const organization = yield* CurrentOrganization;
    if (organization.role !== "admin" && organization.role !== "owner")
      return yield* new OrganizationForbidden();
    // Minting and revoking a key record their own audit line for every caller, with the key.
    if (action === "create" || action === "update" || action === "revoke")
      yield* Effect.logInfo("MCP connection changed with an API credential").pipe(
        Effect.annotateLogs({
          "executor.audit": "mcp-connection",
          "executor.audit.action": action,
          "executor.user.id": current.userId,
          "executor.organization.id": current.resource,
          ...(connection === undefined ? {} : { "executor.mcp.connection": connection }),
        }),
      );
    return current;
  });

/**
 * Check one app's runs-as targets. An account target the member has not linked to any of the app's
 * user requirements is linked to each one its provider fills, as linking it from the app would: a
 * plain requirement's previous link is replaced.
 */
const resolveApp = (
  executor: Executor,
  organizationOwner: OwnerId,
  userId: string,
  input: ConnectionApp,
) =>
  Effect.gen(function* () {
    const invalid = (reason: ConnectionAccessInvalid["reason"]) =>
      new ConnectionAccessInvalid({ app: input.app, reason });
    const app: App = yield* usableApp(executor, organizationOwner, input.app).pipe(
      Effect.catchTags({
        AppNotFound: () => Effect.fail(invalid("app")),
        OrganizationForbidden: () => Effect.fail(invalid("app")),
      }),
    );
    // Grants and connections name only the caller's own accounts; app access authorizes the
    // app links.
    const requirements = Object.entries(app.requirements.accounts)
      .filter(([, requirement]) => requirement.scope === "user")
      .map(([slot, requirement]) => ({ slot, ...requirement }));
    const sql = yield* policyDatabase;
    const linked = yield* Effect.forEach(input.runsAs, (target) =>
      Effect.gen(function* () {
        if (target.kind === "app") {
          if (requirements.length > 0) return yield* invalid("target");
          return false;
        }
        const account = yield* executor.accounts
          .get({ owner: organizationOwner, account: target.id })
          .pipe(Effect.catchTag("AccountNotFound", () => Effect.fail(invalid("account"))));
        if (!requirements.some((requirement) => requirement.provider === account.provider))
          return yield* invalid("account");
        yield* checkAccounts(organizationOwner, { account: account.id }).pipe(
          Effect.catchTags({
            OrganizationForbidden: () => Effect.fail(invalid("account")),
            AccountNotFound: () => Effect.fail(invalid("account")),
          }),
        );
        const linked = yield* linkedAccounts(sql, { subject: userId, apps: [app.id] });
        if (linked.some((link) => link.id === account.id)) return false;
        // Check both again under the app's link lock: either may have been revoked while the
        // change waited for it (see `lockedChange`).
        return yield* lockedChange(executor, { app: app.id, access: "use" }, (locked, actor) =>
          Effect.gen(function* () {
            yield* requireAccountAccessAs(actor, account.id, "use").pipe(
              Effect.catchTag("OrganizationForbidden", () => Effect.fail(invalid("account"))),
            );
            return yield* Effect.forEach(
              requirements.filter((requirement) => requirement.provider === account.provider),
              (requirement) =>
                addLink(locked, executor.webhooks, {
                  app: app.id,
                  requirement: requirement.slot,
                  account: account.id,
                  subject: userId,
                  linkedBy: userId,
                }),
            );
          }),
        ).pipe(
          Effect.map((changed) => changed.some(Boolean)),
          Effect.catchTags({
            OrganizationForbidden: () => Effect.fail(invalid("app")),
            RequirementMismatch: () => Effect.fail(invalid("account")),
            AccountNotFound: () => Effect.fail(invalid("account")),
          }),
        );
      }),
    );
    if (linked.some(Boolean)) yield* Effect.flatten(ScheduleWakeup);
    return input;
  });

const resolvePolicy = (apps: readonly ConnectionApp[]) =>
  Effect.gen(function* () {
    const { userId } = yield* owner;
    const organizationOwner = yield* currentOwner;
    const executor = yield* Effect.flatten(HostedExecutor);
    return {
      apps: yield* Effect.forEach(apps, (app) =>
        resolveApp(executor, organizationOwner, userId, app),
      ),
    };
  });

/** RequireOrganization checks current membership; `manager` limits API credentials to admins. */
export const hostedMcpConnectionHandlers = HttpApiBuilder.group(
  HostedApi,
  "mcpConnections",
  (handlers) =>
    Effect.gen(function* () {
      const auth = yield* McpAuthentication;
      const view = (connection: Connection) => ({
        ...connection,
        url: mcpResource(auth.resourceOrigins.mcp[0], { mode: "model", connection: connection.id }),
      });
      return handlers
        .handle("list", () =>
          Effect.flatMap(manager("list"), (current) => auth.connections.list(current)).pipe(
            Effect.map((connections) => connections.map(view)),
          ),
        )
        .handle("create", ({ payload }) =>
          Effect.gen(function* () {
            const current = yield* manager("create", payload.id);
            const policy = yield* resolvePolicy(payload.apps);
            return view(
              yield* auth.connections.create(current, {
                id: payload.id,
                name: payload.name,
                policy,
              }),
            );
          }),
        )
        .handle("update", ({ params, payload }) =>
          Effect.gen(function* () {
            // Check ownership before linking any account for this connection.
            const current = yield* manager("update", params.connection);
            const existing = yield* auth.connections.list(current);
            if (!existing.some((connection) => connection.id === params.connection))
              return yield* new ConnectionNotFound({ connection: params.connection });
            const policy = yield* resolvePolicy(payload.apps);
            return view(
              yield* auth.connections.update(current, {
                id: params.connection,
                name: payload.name,
                policy,
              }),
            );
          }),
        )
        .handle("revoke", ({ params }) =>
          Effect.flatMap(manager("revoke", params.connection), (current) =>
            auth.connections.revoke(current, params.connection),
          ),
        )
        .handle("mintKey", ({ params, payload }) =>
          Effect.gen(function* () {
            // Only the connection's owner: the store mints only for the caller's own standing
            // connection, and reports any other as not found.
            const current = yield* manager("mint-key", params.connection);
            const minted = yield* auth.connections.mintKey(current, {
              id: params.connection,
              name: payload.name ?? `Connection key: ${params.connection}`,
              expiresIn: payload.expiresInSeconds,
            });
            const person = yield* Effect.serviceOption(CurrentPrincipal);
            yield* Effect.logInfo("MCP connection key minted").pipe(
              Effect.annotateLogs({
                "executor.audit": "mcp-connection-key",
                "executor.audit.action": "mint",
                "executor.audit.via": Option.isSome(person) ? "browser" : "api-credential",
                "executor.user.id": current.userId,
                "executor.organization.id": current.resource,
                "executor.mcp.connection": params.connection,
                "executor.api_key.id": minted.id,
                "executor.api_key.expires_at": minted.expiresAt,
              }),
            );
            return {
              id: minted.id,
              key: minted.key,
              connection: params.connection,
              url: mcpResource(auth.resourceOrigins.mcp[0], {
                mode: "model",
                connection: params.connection,
              }),
              expiresAt: minted.expiresAt,
            };
          }),
        )
        .handle("listKeys", ({ params }) =>
          // Only the connection's owner: the store reports any other connection as not found.
          Effect.flatMap(manager("list-keys", params.connection), (current) =>
            auth.connections.keys(current, params.connection),
          ),
        )
        .handle("revokeKey", ({ params }) =>
          Effect.gen(function* () {
            const current = yield* manager("revoke-key", params.connection);
            yield* auth.connections.revokeKey(current, {
              id: params.connection,
              key: params.key,
            });
            const person = yield* Effect.serviceOption(CurrentPrincipal);
            yield* Effect.logInfo("MCP connection key revoked").pipe(
              Effect.annotateLogs({
                "executor.audit": "mcp-connection-key",
                "executor.audit.action": "revoke",
                "executor.audit.via": Option.isSome(person) ? "browser" : "api-credential",
                "executor.user.id": current.userId,
                "executor.organization.id": current.resource,
                "executor.mcp.connection": params.connection,
                "executor.api_key.id": params.key,
              }),
            );
          }),
        )
        .handle("agents", () =>
          Effect.flatMap(owner, (current) => auth.connections.agents(current)),
        )
        .handle("revokeAgent", ({ params }) =>
          Effect.flatMap(owner, (current) => auth.connections.revokeAgent(current, params.agent)),
        );
    }),
);
