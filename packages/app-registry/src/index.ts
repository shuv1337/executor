/** Catalog persistence; publication rules and the remote reader live in the SDK. */
export { makeRegistryStorage } from "./implementation/storage.ts";
/** Catalog reads narrowed to one publishing owner, for hosts that publish inside an organization. */
export { ownedRegistry, type OwnedRegistry } from "./implementation/owned-registry.ts";
