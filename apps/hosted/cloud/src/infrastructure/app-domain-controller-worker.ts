/** Bind the app domain controller Worker without importing its implementation. */
import * as Cloudflare from "alchemy/Cloudflare";
import type { AppDomainCoordinator } from "./app-domains.ts";

/** Hosts the stage's app domain coordinator, so waking it never starts the API Worker. */
export class AppDomainController extends Cloudflare.Worker<
  AppDomainController,
  {},
  AppDomainCoordinator
>()("AppDomainController") {}
