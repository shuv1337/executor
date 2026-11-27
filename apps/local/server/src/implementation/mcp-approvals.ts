import type { SqlClient } from "effect/sql";
import { GrantId, grantRefusal, permitsBrowserApproval } from "@executor-js/mcp-auth";
import { localMcpBackend } from "./mcp.ts";
import type { LocalMcpOAuth } from "./mcp-oauth.ts";
import { invocationAccounts, type Executor } from "@executor-js/sdk/core";
/** Browser approval access uses paired dashboard cookies, never the programmatic bearer key. */
import {
  BrowserApprovalAddress,
  BrowserApprovalAnswer,
  BrowserApprovalMode,
  BrowserSessionId,
  type BrowserApprovals,
} from "@executor-js/mcp/browser";
import { Effect, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { localRequest, requestOrigin, sessionCookie, type LocalAuth } from "./auth.ts";
import type { ServerConfig } from "../contracts/config.ts";

const ApprovalQuery = Schema.Struct({
  sessionId: BrowserSessionId,
  grantId: GrantId,
  mode: Schema.optionalKey(BrowserApprovalMode),
});

/** Local endpoints share the execution manager with /mcp while retaining separate cookie/Origin checks. */
export const localMcpApproval = (
  approvals: BrowserApprovals,
  auth: LocalAuth,
  config: ServerConfig,
  sql: SqlClient.SqlClient,
  executor: Executor,
  oauth: LocalMcpOAuth,
) =>
  Effect.gen(function* () {
    const request = yield* localRequest(config.port, config.browserOrigin);
    if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "POST")
      return HttpServerResponse.empty({ status: 405 });
    if (
      request.headers.authorization !== undefined ||
      (request.method === "POST" && request.headers.origin !== requestOrigin(config, request))
    )
      return HttpServerResponse.empty({ status: 403 });
    if (!(yield* auth.valid(request.cookies[sessionCookie(config)])))
      return HttpServerResponse.empty({ status: 401 });
    const url = new URL(request.url, "http://localhost");
    const query = yield* Schema.decodeUnknownEffect(ApprovalQuery)(
      HttpServerRequest.searchParamsFromURL(url),
    );
    const address = yield* Schema.decodeUnknownEffect(BrowserApprovalAddress)({
      requestId: url.pathname.split("/").at(-1),
      sessionId: query.sessionId,
      ...(query.mode === undefined ? {} : { mode: query.mode }),
    });
    const headers = new Headers(request.headers);
    headers.set("origin", oauth.origin);
    const grant =
      query.grantId === "local-administrator"
        ? {
            id: query.grantId,
            policy: { kind: "all" as const },
            target: { kind: "mcp" as const, mode: address.mode ?? ("browser" as const) },
          }
        : (yield* oauth.browserGrant(headers, query.grantId)).grant;
    // Browser-mode links name an MCP session; person-only caller-mode links name a grant and mode.
    const permitted =
      address.mode === undefined
        ? permitsBrowserApproval(grant)
        : grant.target.kind === "mcp" &&
          grant.target.mode === address.mode &&
          address.sessionId === address.mode &&
          grantRefusal(grant) === undefined;
    if (!permitted) return HttpServerResponse.empty({ status: 403 });
    const view = yield* approvals.get(grant.id, address);
    if (view.status === "pending") {
      if (
        address.mode !== undefined &&
        (view.request.status !== "approval-required" || view.request.human !== true)
      )
        return HttpServerResponse.empty({ status: 403 });
      const tool =
        view.request.status === "approval-required"
          ? {
              app: view.request.invocation.app,
              tool: view.request.invocation.tool,
              accounts: invocationAccounts(view.request.invocation),
            }
          : view.request.tool;
      // The same grant checks as the MCP route, including runs-as targets and read-only tools.
      const allowed = yield* localMcpBackend(sql, executor, grant.id, Effect.succeed(grant))
        .authorizeElicitation(tool)
        .pipe(
          Effect.as(true),
          Effect.catchTag("ElicitationFailed", () => Effect.succeed(false)),
        );
      if (!allowed) return HttpServerResponse.empty({ status: 403 });
    }
    if (request.method !== "POST") {
      if (view.status !== "pending") return HttpServerResponse.jsonUnsafe(view);
      const app = yield* executor.apps.get({
        app:
          view.request.status === "approval-required"
            ? view.request.invocation.app
            : view.request.tool.app,
      });
      return HttpServerResponse.jsonUnsafe({ ...view, appName: app.name });
    }
    const answer = yield* HttpServerRequest.schemaBodyJson(BrowserApprovalAnswer);
    return HttpServerResponse.jsonUnsafe(
      yield* approvals.answer(grant.id, address, answer.response),
    );
  }).pipe(
    Effect.catchTags({
      // Pairing was checked above; an unresolvable grant is forbidden.
      LocalMcpUnauthorized: () => Effect.succeed(HttpServerResponse.empty({ status: 403 })),
      LocalMcpAuthUnavailable: () => Effect.succeed(HttpServerResponse.empty({ status: 503 })),
      AppNotFound: () => Effect.succeed(HttpServerResponse.jsonUnsafe({ status: "unavailable" })),
      StorageError: () => Effect.succeed(HttpServerResponse.empty({ status: 503 })),
      AuthForbidden: () => Effect.succeed(HttpServerResponse.empty({ status: 403 })),
      AuthStorageError: () => Effect.succeed(HttpServerResponse.empty({ status: 503 })),
      SchemaError: () => Effect.succeed(HttpServerResponse.empty({ status: 400 })),
      HttpServerError: () => Effect.succeed(HttpServerResponse.empty({ status: 400 })),
      ElicitationResponseInvalid: () =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            { error: "The answer does not match this form." },
            { status: 400 },
          ),
        ),
    }),
    Effect.map((response) =>
      response.pipe(
        HttpServerResponse.setHeader("cache-control", "no-store"),
        HttpServerResponse.setHeader("referrer-policy", "no-referrer"),
      ),
    ),
  );
