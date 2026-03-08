import {
  type SecretMaterial,
  SecretMaterialSchema,
} from "#schema";
import * as Option from "effect/Option";
import { Schema } from "effect";
import { eq, desc, or, and } from "drizzle-orm";

import type { DrizzleClient } from "../client";
import type { DrizzleTables } from "../schema";
import { firstOption, withoutCreatedAt } from "./shared";

const decodeSecretMaterial = Schema.decodeUnknownSync(SecretMaterialSchema);

export const createSecretMaterialsRepo = (
  client: DrizzleClient,
  tables: DrizzleTables,
) => ({
  getById: (id: SecretMaterial["id"]) =>
    client.use("rows.secret_materials.get_by_id", async (db) => {
      const rows = await db
        .select()
        .from(tables.secretMaterialsTable)
        .where(eq(tables.secretMaterialsTable.id, id))
        .limit(1);

      const row = firstOption(rows);
      return Option.isSome(row)
        ? Option.some(decodeSecretMaterial(row.value))
        : Option.none<SecretMaterial>();
    }),

  listAll: () =>
    client.use("rows.secret_materials.list_all", async (db) => {
      const rows = await db
        .select({
          id: tables.secretMaterialsTable.id,
          name: tables.secretMaterialsTable.name,
          purpose: tables.secretMaterialsTable.purpose,
          createdAt: tables.secretMaterialsTable.createdAt,
          updatedAt: tables.secretMaterialsTable.updatedAt,
        })
        .from(tables.secretMaterialsTable)
        .orderBy(desc(tables.secretMaterialsTable.updatedAt));

      return rows;
    }),

  upsert: (material: SecretMaterial) =>
    client.use("rows.secret_materials.upsert", async (db) => {
      await db
        .insert(tables.secretMaterialsTable)
        .values(material)
        .onConflictDoUpdate({
          target: [tables.secretMaterialsTable.id],
          set: {
            ...withoutCreatedAt(material),
          },
        });
    }),

  updateById: (id: SecretMaterial["id"], update: { name?: string | null; value?: string }) =>
    client.use("rows.secret_materials.update_by_id", async (db) => {
      const set: Record<string, unknown> = { updatedAt: Date.now() };
      if (update.name !== undefined) set.name = update.name;
      if (update.value !== undefined) set.value = update.value;

      const updated = await db
        .update(tables.secretMaterialsTable)
        .set(set)
        .where(eq(tables.secretMaterialsTable.id, id))
        .returning({
          id: tables.secretMaterialsTable.id,
          name: tables.secretMaterialsTable.name,
          purpose: tables.secretMaterialsTable.purpose,
          createdAt: tables.secretMaterialsTable.createdAt,
          updatedAt: tables.secretMaterialsTable.updatedAt,
        });

      const row = firstOption(updated);
      return Option.isSome(row) ? Option.some(row.value) : Option.none();
    }),

  removeById: (id: SecretMaterial["id"]) =>
    client.use("rows.secret_materials.remove", async (db) => {
      const deleted = await db
        .delete(tables.secretMaterialsTable)
        .where(eq(tables.secretMaterialsTable.id, id))
        .returning();

      return deleted.length > 0;
    }),

  /**
   * For each secret, find the sources that reference it via credentials.
   * Returns a map of secretId -> Array<{ sourceId, sourceName }>.
   */
  listLinkedSources: () =>
    client.use("rows.secret_materials.list_linked_sources", async (db) => {
      // Find all credentials that reference any postgres-stored secret
      // and join through bindings to sources.
      const rows = await db
        .select({
          tokenHandle: tables.credentialsTable.tokenHandle,
          tokenProviderId: tables.credentialsTable.tokenProviderId,
          refreshTokenHandle: tables.credentialsTable.refreshTokenHandle,
          refreshTokenProviderId: tables.credentialsTable.refreshTokenProviderId,
          sourceId: tables.sourceCredentialBindingsTable.sourceId,
          sourceName: tables.sourcesTable.name,
        })
        .from(tables.credentialsTable)
        .innerJoin(
          tables.sourceCredentialBindingsTable,
          eq(tables.credentialsTable.id, tables.sourceCredentialBindingsTable.credentialId),
        )
        .innerJoin(
          tables.sourcesTable,
          and(
            eq(tables.sourceCredentialBindingsTable.workspaceId, tables.sourcesTable.workspaceId),
            eq(tables.sourceCredentialBindingsTable.sourceId, tables.sourcesTable.sourceId),
          ),
        )
        .where(
          or(
            eq(tables.credentialsTable.tokenProviderId, "postgres"),
            eq(tables.credentialsTable.refreshTokenProviderId, "postgres"),
          ),
        );

      const result = new Map<string, Array<{ sourceId: string; sourceName: string }>>();

      for (const row of rows) {
        const addLink = (secretId: string) => {
          let links = result.get(secretId);
          if (!links) {
            links = [];
            result.set(secretId, links);
          }
          // Avoid duplicate entries
          if (!links.some((l) => l.sourceId === row.sourceId)) {
            links.push({ sourceId: row.sourceId, sourceName: row.sourceName });
          }
        };

        if (row.tokenProviderId === "postgres") {
          addLink(row.tokenHandle);
        }
        if (row.refreshTokenProviderId === "postgres" && row.refreshTokenHandle) {
          addLink(row.refreshTokenHandle);
        }
      }

      return result;
    }),
});
