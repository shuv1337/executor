/**
 * The instance's root organization: the one setup created. Its owners control the instance. The
 * record is written once, by setup or by the upgrade step below, and never inferred from dates or
 * names. A database without it has no root, and every root-only operation is refused.
 */
import type { AuthContext } from "@better-auth/core";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { migrateProductSteps } from "@executor-js/hosted-server/migrations";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";

/** The only ID the record ever has, so the primary key admits one root. */
export const rootRecordId = "root";
export const rootModel = "selfHostRoot";

const Root = Schema.Struct({ organizationId: Schema.NonEmptyString });
const Membership = Schema.Struct({ role: Schema.Literal("owner") });

const read = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: () =>
      new APIError("SERVICE_UNAVAILABLE", { message: "Authentication is unavailable. Try again." }),
  });

/** Whether `userId` owns the root organization. Without a root record, no one does. */
const ownsRoot = (adapter: AuthContext["adapter"], userId: string) =>
  Effect.gen(function* () {
    const root = Schema.decodeUnknownOption(Root)(
      yield* read(() =>
        adapter.findOne({
          model: rootModel,
          where: [{ field: "id", value: rootRecordId }],
          select: ["organizationId"],
        }),
      ),
    );
    if (Option.isNone(root)) return false;
    const member = yield* read(() =>
      adapter.findOne({
        model: "member",
        where: [
          { field: "userId", value: userId },
          { field: "organizationId", value: root.value.organizationId },
        ],
        select: ["role"],
      }),
    );
    return Option.isSome(Schema.decodeUnknownOption(Membership)(member));
  });

const runOwnsRoot = (adapter: AuthContext["adapter"], userId: string) =>
  Effect.runPromiseExit(ownsRoot(adapter, userId)).then(
    Exit.match({
      onSuccess: (owns) => owns,
      onFailure: (cause) => {
        throw Cause.squash(cause);
      },
    }),
  );

/**
 * The root record's table, the check organization creation asks, and the signed-in user's
 * answer to it, which the dashboard reads to offer creation. It must follow the
 * organization plugin: Better Auth creates tables in plugin order.
 */
export const selfHostRoot = () => {
  let adapter: AuthContext["adapter"] | undefined;
  return {
    plugin: {
      id: "executor-self-host-root",
      init: (context) => {
        adapter = context.adapter;
      },
      endpoints: {
        selfHostCapabilities: createAuthEndpoint(
          "/self-host/capabilities",
          { method: "GET", use: [sessionMiddleware] },
          async (ctx) =>
            ctx.json({
              createOrganization: await runOwnsRoot(
                ctx.context.adapter,
                ctx.context.session.user.id,
              ),
            }),
        ),
      },
      schema: {
        [rootModel]: {
          fields: {
            organizationId: {
              type: "string",
              required: true,
              unique: true,
              references: { model: "organization", field: "id", onDelete: "restrict" },
            },
            createdAt: { type: "date", required: true },
          },
        },
      },
    } satisfies BetterAuthPlugin,
    ownsRoot: (userId: string) =>
      adapter === undefined ? Promise.resolve(false) : runOwnsRoot(adapter, userId),
  };
};

/**
 * An install from before the record had exactly one organization, its setup's, since nothing
 * else could create one. Any other count leaves the root unset.
 */
const recordSoleOrganization = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`insert into ${sql(rootModel)} ("id", "organizationId", "createdAt")
    select ${rootRecordId}, "id", now() from "organization"
    where (select count(*) from "organization") = 1
    on conflict do nothing`;
});

export const migrateSelfHostSteps = migrateProductSteps("private_self_host_migrations", {
  "1_root_organization": recordSoleOrganization,
});
