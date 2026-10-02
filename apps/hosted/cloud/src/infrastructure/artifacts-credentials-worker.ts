/** Bind the Artifacts credentials Worker without importing its implementation. */
import * as Cloudflare from "alchemy/Cloudflare";
import type { ArtifactsTokenCoordinator } from "./artifacts-tokens.ts";

/** Hosts every repository's token coordinator, so waking one never starts the API Worker. */
export class ArtifactsCredentials extends Cloudflare.Worker<
  ArtifactsCredentials,
  {},
  ArtifactsTokenCoordinator
>()("ArtifactsCredentials") {}
