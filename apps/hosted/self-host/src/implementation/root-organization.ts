/**
 * The instance's root organization: the one setup created. Its owners control the instance. The
 * record is written once, by setup or by the upgrade step below, and never inferred from dates or
 * names. A database without it has no root, and every root-only operation is refused.
 */
import type { BetterAuthPlugin } from "better-auth";
import { migrateProductSteps } from "@executor-js/hosted-server/migrations";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/** The only ID the record ever has, so the primary key admits one root. */
export const rootRecordId = "root";
export const rootModel = "selfHostRoot";

/** Must follow the organization plugin: Better Auth creates tables in plugin order. */
export const selfHostRootSchema = {
  id: "executor-self-host-root",
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
} satisfies BetterAuthPlugin;

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
