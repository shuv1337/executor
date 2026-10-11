/** An organization reads only what it published; other owners' listings do not exist for it. */
import { Effect } from "effect";
import {
  RegistryError,
  encodeBase64,
  type AppCopySnapshot,
  type AppId,
  type Executor,
  type OwnerId,
  type PublicationReference,
  type Registry,
  type SourceFile,
} from "@executor-js/sdk/core";
import { publicationFailure, publicationSource } from "./manifest.ts";
import type { RegistryStorage } from "./storage.ts";

/** A narrowed catalog also resolves the copies its reader is allowed to make. */
export interface OwnedRegistry extends Registry {
  /** The reviewed source of a listing this reader may copy. No app is created here. */
  readonly copy: (reference: PublicationReference) => Effect.Effect<AppCopySnapshot, RegistryError>;
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
  return {
    origin,
    list: (name) => storage.list(name, access),
    snapshot,
    file,
    copy: (reference) =>
      Effect.gen(function* () {
        const found = yield* snapshot(reference.package, reference.commit);
        if (
          found.publication.name !== reference.package ||
          found.publication.commit !== reference.commit
        )
          return yield* new RegistryError({ reason: "changed" });
        const manifest = yield* publicationSource(found.files).pipe(
          Effect.mapError(publicationFailure),
        );
        if (manifest.name !== reference.package)
          return yield* new RegistryError({ reason: "invalid-source" });
        // A copy carries no reader for the listing's stored public files, so inline their bytes.
        const files = yield* Effect.forEach(
          found.files,
          (source): Effect.Effect<SourceFile, RegistryError> =>
            "object" in source
              ? file(reference.package, reference.commit, source.path).pipe(
                  Effect.map((bytes) => ({
                    path: source.path,
                    content: encodeBase64(bytes),
                    encoding: "base64" as const,
                  })),
                )
              : Effect.succeed(source),
          { concurrency: 1 },
        );
        return {
          files,
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
