/** Bind the API Worker without importing its routes and application initialization. */
import * as Cloudflare from "alchemy/Cloudflare";

/** Stable native Worker identity; main.ts supplies its implementation and properties. */
export class Api extends Cloudflare.Worker<Api, {}>()("Api") {}
