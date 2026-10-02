/** MCP paths retain the real app and distinguish each saved profile below it. */
import type { Account, App, AppId, Profile, ProfileId } from "@executor-js/sdk/core";
/** An account-free app call or a particular revision of one personal profile. */
export type McpTarget =
  | { readonly kind: "app" }
  | {
      readonly kind: "profile";
      readonly id: ProfileId;
      readonly revision: number;
      readonly label: string;
      /** The selected accounts' descriptions, each after its account's label. */
      readonly accounts?: string;
    };
/** Products authorize these records before projection; this function grants no access. */
export function appTargets(
  app: App,
  profiles: readonly Profile[],
  accounts: readonly Pick<Account, "id" | "label" | "description">[],
): readonly McpTarget[] {
  const targets: McpTarget[] = profiles
    .filter((item) => item.enabled && item.status !== "removed" && item.status !== "removing")
    .map((item) => {
      const ids = new Set(Object.values(item.accounts).flat());
      const selected = accounts.filter((account) => ids.has(account.id));
      const labels = selected.map((account) => account.label);
      // Agents read descriptions in every tool's description, so each stays on one line.
      const described = selected.flatMap((account) =>
        account.description === null
          ? []
          : [`${account.label}: ${account.description.replace(/\s+/g, " ").trim()}`],
      );
      return {
        kind: "profile",
        id: item.id,
        revision: item.revision,
        label: item.name ?? (labels.length === 0 ? "Personal profile" : labels.join(", ")),
        ...(described.length === 0 ? {} : { accounts: described.join("; ") }),
      };
    });
  if (Object.keys(app.requirements.accounts).length === 0) targets.unshift({ kind: "app" });
  return targets;
}
/** An app filter remains separate from the profile's immutable identity. */
export interface McpTargetInput {
  readonly app: AppId;
}
