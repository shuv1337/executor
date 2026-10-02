/**
 * Inboxes for synthetic agent identities: every `*@agents.executor.engineering` address delivers
 * to one receiver Worker, which keeps parsed messages in KV for a day. Agents use them to sign in
 * to production and deployed stages through the real email-code and invitation flows.
 *
 *   bun run agent-mail:deploy
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Layer } from "effect";
import AgentMailReceiverLive from "./src/agent-mail.ts";
import { agentMailDomain, agentMailStack, agentMailZone } from "./src/contracts/agent-mail.ts";
import {
  AgentMailReceiver,
  AgentMailbox,
  EmailRoutingSubdomain,
  EmailRoutingSubdomainProvider,
} from "./src/infrastructure/agent-mail.ts";

export default Alchemy.Stack(
  agentMailStack,
  {
    // The subdomain provider calls the Cloudflare API with the same credentials as Alchemy's own.
    providers: EmailRoutingSubdomainProvider().pipe(Layer.provideMerge(Cloudflare.providers())),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const routing = yield* Cloudflare.Email.Routing("Routing", { zone: agentMailZone });
    yield* EmailRoutingSubdomain("AgentSubdomain", {
      zoneId: routing.zoneId,
      name: agentMailDomain,
    });
    const mailbox = yield* AgentMailbox;
    const receiver = yield* AgentMailReceiver;
    // The zone has no other mail. The receiver rejects anything outside the agent subdomain.
    yield* Cloudflare.Email.CatchAll("CatchAll", {
      zone: routing.zoneId,
      name: "Agent mailboxes",
      actions: [{ type: "worker", value: [receiver.workerName] }],
    });
    return { namespaceId: mailbox.namespaceId, accountId: mailbox.accountId };
  }).pipe(Effect.provide(AgentMailReceiverLive)),
);
