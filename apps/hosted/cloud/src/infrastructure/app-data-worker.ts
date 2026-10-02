/** Bind the app data Worker without importing its implementation. */
import * as Cloudflare from "alchemy/Cloudflare";
import type { Effect } from "effect";
import type { RemoteAppRunner } from "@executor-js/sdk/workerd";
import type { AppDataSupervisor } from "./app-data.ts";

/**
 * Hosts every app's data supervisor, so waking one never starts the API Worker, and runs every
 * app Worker. It serves no assets, so each app's outbound network can be this Worker's own
 * entrypoint; other Workers call the runner over RPC.
 */
export class AppData extends Cloudflare.Worker<
  AppData,
  RemoteAppRunner<Effect.Effect<string>>,
  AppDataSupervisor
>()("AppData") {}
