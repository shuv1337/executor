/** Pure interaction contracts shared by MCP transports and browser clients. */
import { Schema } from "effect";
import {
  AppAccounts,
  AppId,
  ApprovalRequestId,
  ToolName,
  ToolPending,
} from "@executor-js/sdk/core";
import { FormElicitation } from "apps/contracts";
/** Live tool questions have ephemeral identities, separate from persisted SDK approval IDs. */
export const ElicitationRequestId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^elc_[\s\S]+$/u)),
  Schema.brand("elc"),
);
/** Both delivery modes answer one pending interaction through the same resume operation. */
export const InteractionId = Schema.Union([ApprovalRequestId, ElicitationRequestId]);
export type InteractionId = typeof InteractionId.Type;
/**
 * A request ID as MCP `resume` advertises it: a plain string, with no `pattern` and no `anyOf`.
 *
 * The hosted Apps connector full-matches JSON Schema patterns and reduces ones it does not keep
 * to a literal prefix. Both the original `anyOf` of `^apr_[\s\S]+$` / `^elc_[\s\S]+$` and the
 * later `^(?:apr|elc)_.+$` were applied as `^apr_`, so a real `apr_<uuid>` never matched.
 * `^apr_.+$` and an `anyOf` of that with `^elc_.+$` still end in a variable suffix, which is the
 * part that reduction drops, so they are not safer. Omitting `pattern` leaves nothing to reduce.
 * Handlers still decode the value as an `InteractionId`, which rejects a bare prefix and any
 * string that does not start with `apr_` or `elc_`.
 */
export const AdvertisedInteractionId = Schema.String;
/**
 * The running call that asked. A call without accounts, such as one to an account-free app, omits
 * the accounts key: pending interactions are MCP results, and JSON has no undefined.
 */
export const InteractionTool = Schema.Struct({
  app: AppId,
  tool: ToolName,
  accounts: Schema.optionalKey(AppAccounts),
});
export type InteractionTool = typeof InteractionTool.Type;
/** A question from an already-running tool. It is not a new tool invocation or a stored approval. */
export const ToolInputPending = Schema.Struct({
  status: Schema.Literal("input-required"),
  requestId: ElicitationRequestId,
  tool: InteractionTool,
  elicitation: FormElicitation,
  expiresAt: Schema.Number,
});
/** Transport-neutral pending interaction; its status distinguishes the continuation it owns. */
export const PendingInteraction = Schema.Union([ToolPending, ToolInputPending]);
export type PendingInteraction = typeof PendingInteraction.Type;
/**
 * The resume answer or its request id is not usable. It does not consume the SDK request or its
 * live continuation. `request-id` means the id is not an approval or elicitation id.
 */
export class ElicitationResponseInvalid extends Schema.TaggedError<ElicitationResponseInvalid>()(
  "ElicitationResponseInvalid",
  { reason: Schema.optionalKey(Schema.Literal("request-id")) },
) {
  override get message(): string {
    return this.reason === "request-id" ? "Approval ids start with apr_ or elc_." : "";
  }
}
