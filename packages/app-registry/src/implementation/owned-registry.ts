/** An organization reads only what it published; other owners' listings do not exist for it. */
import { Effect } from "effect";
import {
  RegistryError,
  resolvePublication,
  SourceError,
  type AppCopySnapshot,
  type AppId,
  type Executor,
  type OwnerId,
  type PublicationReference,
  type Registry,
} from "@executor-js/sdk/core";
import type { RegistryStorage } from "./storage.ts";

/**
 * A copy snapshot with the reader for its stored public files. The SDK's copy reads `stored` for
 * each stored file the new app's store lacks, one large file at a time, and checks the bytes
 * against the file's Git object, as it does for its own publication copies.
 */
export type OwnedCopySnapshot = AppCopySnapshot & {
  readonly stored: (file: {
    readonly path: string;
    readonly object: string;
  }) => Effect.Effect<Uint8Array, SourceError>;
};
/** A narrowed catalog also resolves the copies its reader is allowed to make. */
export interface OwnedRegistry extends Registry {
  /** The reviewed source of a listing this reader may copy. No app is created here. */
  readonly copy: (
    reference: PublicationReference,
  ) => Effect.Effect<OwnedCopySnapshot, RegistryError>;
}

/**
 * Narrow the executor's stored catalog to one owner's publications. Listing filters the rows;
 * a snapshot checks the row's owner before the executor's own catalog reads the retained source,
 * so the files come from the same place every other read uses. A copy records `sourcePath` on
 * `origin` as its provenance: the authenticated route that serves this catalog's source.
 */
export const ownedRegistry = (
  storage: RegistryStorage,
  catalog: Executor["registry"],
  origin: string,
  sourcePath: string,
  access: { readonly owner: OwnerId; readonly apps?: readonly AppId[] },
): OwnedRegistry => {
  const readable = (name: string) =>
    Effect.gen(function* () {
      const row = yield* storage.get(name);
      if (
        row.owner !== access.owner ||
        (access.apps !== undefined && !access.apps.includes(row.app))
      )
        return yield* new RegistryError({ reason: "not-found" });
    });
  const snapshot = (name: string, commit: string) =>
    readable(name).pipe(Effect.andThen(catalog.snapshot({ name, commit })));
  const file = (name: string, commit: string, path: string) =>
    readable(name).pipe(Effect.andThen(catalog.file({ name, commit, path })));
  const registry: Registry = {
    origin,
    list: (name) => storage.list(name, access),
    snapshot,
    file,
    files: (name, commit) =>
      readable(name).pipe(Effect.as((path: string) => file(name, commit, path))),
  };
  return {
    ...registry,
    copy: (reference) =>
      Effect.gen(function* () {
        const found = yield* resolvePublication(registry, reference);
        return {
          ...found,
          stored: ({ path }) =>
            file(reference.package, reference.commit, path).pipe(
              Effect.mapError(() => new SourceError({ reason: "not-found" })),
            ),
          origin: {
            reference: new URL(
              `${sourcePath}?name=${encodeURIComponent(reference.package)}&commit=${encodeURIComponent(reference.commit)}`,
              origin,
            ).href,
            name: reference.package,
            commit: reference.commit,
          },
          activation: "deploy",
        };
      }),
  };
};
