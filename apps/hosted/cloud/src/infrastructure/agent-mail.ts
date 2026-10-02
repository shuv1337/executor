/** Resources for the agent mailbox stack; the receiver's implementation is `src/agent-mail.ts`. */
import { Resource } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Provider from "alchemy/Provider";
import * as emailRouting from "@distilled.cloud/cloudflare/email-routing";
import { Effect } from "effect";

/** Parsed messages, keyed per recipient and expired by KV. */
export const AgentMailbox = Cloudflare.KV.Namespace("AgentMailbox", {
  title: "executor-agent-mailbox",
});

/** Receives every message routed to the agent subdomain. It serves no HTTP. */
export class AgentMailReceiver extends Cloudflare.Worker<AgentMailReceiver, {}>()(
  "AgentMailReceiver",
) {}

/**
 * Email Routing for one subdomain of a zone that already has routing enabled. Cloudflare creates
 * and locks the subdomain's MX and SPF records. Its delete API is zone-wide, so destroying this
 * resource removes every routing record on the zone; the agent mail stack owns that zone's routing.
 */
export type EmailRoutingSubdomain = Resource<
  "Executor.EmailRoutingSubdomain",
  { readonly zoneId: string; readonly name: string },
  { readonly zoneId: string; readonly name: string }
>;
export const EmailRoutingSubdomain = Resource<EmailRoutingSubdomain>(
  "Executor.EmailRoutingSubdomain",
);

export const EmailRoutingSubdomainProvider = () =>
  Provider.succeed(EmailRoutingSubdomain, {
    stables: ["zoneId", "name"],
    // Cloudflare has no supported per-subdomain read; creation is idempotent, so reconcile repairs drift.
    read: ({ output }) => Effect.succeed(output),
    reconcile: ({ news }) =>
      emailRouting
        .createDns({ zoneId: news.zoneId, name: news.name })
        .pipe(Effect.as({ zoneId: news.zoneId, name: news.name })),
    delete: ({ output }) => emailRouting.deleteDns({ zoneId: output.zoneId }).pipe(Effect.asVoid),
  });
