/** An organization reads only what it published; other owners' listings do not exist for it. */
import { Effect } from "effect";
import {
  RegistryError,
  type AppId,
  type Executor,
  type OwnerId,
  type Registry,
} from "@executor-js/sdk/core";
import type { RegistryStorage } from "./storage.ts";

/**
 * Narrow the executor's stored catalog to one owner's publications. Listing filters the rows;
 * a snapshot checks the row's owner before the executor's own catalog reads the retained source,
 * so the files come from the same place every other read uses.
 */
export const ownedRegistry = (
  storage: RegistryStorage,
  catalog: Executor["registry"],
  origin: string,
  access: { readonly owner: OwnerId; readonly apps?: readonly AppId[] },
): Registry => ({
  origin,
  list: (name) => storage.list(name, access),
  snapshot: (name, commit) =>
    Effect.gen(function* () {
      const row = yield* storage.get(name);
      if (
        row.owner !== access.owner ||
        (access.apps !== undefined && !access.apps.includes(row.app))
      )
        return yield* new RegistryError({ reason: "not-found" });
      return yield* catalog.snapshot({ name, commit });
    }),
});
