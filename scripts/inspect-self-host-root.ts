/**
 * Offline gate for the self-host root organization record.
 *
 *   node scripts/inspect-self-host-root.ts <export.tar> <baseline.json>
 *
 * `export.tar` is an `executor-host export` archive of a stopped volume copy: a PGlite
 * data-directory dump, loaded here into an in-memory database, never the live volume.
 * `baseline.json` is the identity the operator recorded before the upgrade:
 *
 *   { "version": 1, "organizationId": "<id>", "ownerUserIds": ["<user id>", ...] }
 *
 * The gate passes only when the archive holds exactly one root record, `id = 'root'`, naming that
 * organization; the organization's owners are exactly the recorded set; and the self-host journal
 * records `1 root_organization`. Nothing is taken from the archive as the expected value.
 *
 * Exit codes: 0 pass, 1 gate failed, 2 invalid invocation or baseline, 3 the archive or PGlite
 * could not be used. Output is a fixed report: no rows, SQL errors or stack traces are printed.
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** The PGlite the self-host product bundles, and the Postgres major it runs. */
const pgliteVersion = "0.5.8";
const postgresMajor = 18;

type Baseline = { readonly organizationId: string; readonly ownerUserIds: readonly string[] };
type Exit = { readonly code: 0 | 1 | 2 | 3; readonly report: Record<string, unknown> };

const identifier = /^[A-Za-z0-9_-]{1,128}$/u;

const invalid = (reason: string): Exit => ({ code: 2, report: { gate: "invalid", reason } });
const unusable = (reason: string): Exit => ({ code: 3, report: { gate: "error", reason } });

const parseBaseline = (text: string): Baseline | string => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return "baseline is not JSON";
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return "baseline must be an object";
  const keys = Object.keys(value).toSorted();
  if (keys.join(",") !== "organizationId,ownerUserIds,version")
    return "baseline must have exactly version, organizationId and ownerUserIds";
  const { version, organizationId, ownerUserIds } = value as Record<string, unknown>;
  if (version !== 1) return "baseline version must be 1";
  if (typeof organizationId !== "string" || !identifier.test(organizationId))
    return "baseline organizationId must be an ID";
  if (!Array.isArray(ownerUserIds) || ownerUserIds.length === 0)
    return "baseline ownerUserIds must be a non-empty array";
  if (!ownerUserIds.every((id) => typeof id === "string" && identifier.test(id)))
    return "baseline ownerUserIds must be IDs";
  if (new Set(ownerUserIds).size !== ownerUserIds.length)
    return "baseline ownerUserIds must not repeat";
  return { organizationId, ownerUserIds: ownerUserIds as string[] };
};

/** The installed PGlite's version, read from its own package, or undefined when it is not one. */
const installedPgliteVersion = async (entry: string) => {
  for (let directory = dirname(entry); directory !== dirname(directory);) {
    try {
      const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as {
        readonly name?: unknown;
        readonly version?: unknown;
      };
      if (manifest.name === "@electric-sql/pglite")
        return typeof manifest.version === "string" ? manifest.version : undefined;
    } catch {
      // No manifest at this level; keep walking up.
    }
    directory = dirname(directory);
  }
  return undefined;
};

const inspect = async (archivePath: string, baselinePath: string): Promise<Exit> => {
  let baselineText: string;
  try {
    baselineText = await readFile(baselinePath, "utf8");
  } catch {
    return invalid("baseline file cannot be read");
  }
  const baseline = parseBaseline(baselineText);
  if (typeof baseline === "string") return invalid(baseline);

  let archive: Buffer;
  try {
    archive = await readFile(archivePath);
  } catch {
    return unusable("archive file cannot be read");
  }

  // The version is checked before PGlite's code runs, so another PGlite never opens the archive.
  let entry: string;
  try {
    entry = createRequire(import.meta.url).resolve("@electric-sql/pglite");
  } catch {
    return unusable("PGlite cannot be loaded");
  }
  const installed = await installedPgliteVersion(entry);
  if (installed !== pgliteVersion)
    return unusable(`PGlite ${installed ?? "of unknown version"} is not ${pgliteVersion}`);
  let PGlite: typeof import("@electric-sql/pglite").PGlite;
  try {
    ({ PGlite } = await import("@electric-sql/pglite"));
  } catch {
    return unusable("PGlite cannot be loaded");
  }

  let db: InstanceType<typeof PGlite>;
  try {
    db = new PGlite({ loadDataDir: new Blob([archive]) });
    await db.waitReady;
  } catch {
    return unusable("archive cannot be loaded as a PGlite data directory");
  }
  try {
    const rows = async (sql: string, params: unknown[] = []) =>
      (await db.query<Record<string, unknown>>(sql, params)).rows;
    const [server] = await rows("select current_setting('server_version_num')::int as number");
    if (Math.floor(Number(server?.number) / 10000) !== postgresMajor)
      return unusable(`archive does not run Postgres ${postgresMajor}`);
    const tables = new Set(
      (
        await rows(
          `select table_name as name from information_schema.tables
           where table_schema = 'public'
             and table_name in ('selfHostRoot', 'private_self_host_migrations', 'organization', 'member')`,
        )
      ).map((row) => row.name),
    );
    const root = tables.has("selfHostRoot")
      ? await rows(`select "id", "organizationId" from "selfHostRoot"`)
      : [];
    const organizationExists =
      tables.has("organization") &&
      (await rows(`select 1 from "organization" where "id" = $1`, [baseline.organizationId]))
        .length === 1;
    const owners = tables.has("member")
      ? (
          await rows(`select "userId", "role" from "member" where "organizationId" = $1`, [
            baseline.organizationId,
          ])
        )
          .filter((row) =>
            String(row.role)
              .split(",")
              .map((role) => role.trim())
              .includes("owner"),
          )
          .map((row) => String(row.userId))
      : [];
    const journal = tables.has("private_self_host_migrations")
      ? await rows(
          "select migration_id::int as id, name from private_self_host_migrations where migration_id = 1",
        )
      : [];
    const recorded = new Set(baseline.ownerUserIds);
    const found = new Set(owners);
    const missingOwners = baseline.ownerUserIds.filter((id) => !found.has(id));
    const unexpectedOwners = owners.filter((id) => !recorded.has(id)).length;
    const checks = {
      rootTableExists: tables.has("selfHostRoot"),
      exactlyOneRootRow: root.length === 1,
      rootIdIsRoot: root.length === 1 && root[0]?.id === "root",
      rootIsRecordedOrganization:
        root.length === 1 && root[0]?.organizationId === baseline.organizationId,
      recordedOrganizationExists: organizationExists,
      ownerMembershipsUnique: found.size === owners.length,
      ownersMatchRecordedSet: missingOwners.length === 0 && unexpectedOwners === 0,
      journalRecordsRootOrganization:
        journal.length === 1 && journal[0]?.name === "root_organization",
    };
    const pass = Object.values(checks).every(Boolean);
    return {
      code: pass ? 0 : 1,
      report: {
        gate: pass ? "pass" : "fail",
        pglite: installed,
        rootRows: root.length,
        recordedOwners: baseline.ownerUserIds.length,
        ownersFound: owners.length,
        missingOwners,
        unexpectedOwners,
        checks,
      },
    };
  } catch {
    return unusable("archive could not be queried");
  } finally {
    await db.close().catch(() => undefined);
  }
};

const main = async (): Promise<Exit> => {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args.some((arg) => arg === ""))
    return invalid("usage: node scripts/inspect-self-host-root.ts <export.tar> <baseline.json>");
  try {
    return await inspect(args[0]!, args[1]!);
  } catch {
    return unusable("inspection failed unexpectedly");
  }
};

const result = await main().catch((): Exit => unusable("inspection failed unexpectedly"));
process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
process.exitCode = result.code;
