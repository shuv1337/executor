/** Tool-owned approval policies, evaluated after native input decoding. */
import { Schema, type Effect } from "effect";

/**
 * Approve this call, deny it, or stop for a decision. `user-approval` accepts any answer the
 * caller's client delivers, including an agent answering for itself in model mode.
 * `human-approval` accepts only a person's answer: through the browser approval page, the
 * dashboard, or the MCP client's own form.
 */
export const ApprovalDecision = Schema.Literals([
  "approved",
  "denied",
  "user-approval",
  "human-approval",
]);
/** Parsed result of one tool approval policy. */
export type ApprovalDecision = typeof ApprovalDecision.Type;

/** Context for one tool's policy. toolInput is the same decoded value passed to run. */
export interface ApprovalContext<Input = unknown> {
  readonly toolName: string;
  readonly toolInput: Input;
  readonly signal: AbortSignal;
  /** The verified caller, as on the tool's context; undefined where the host provides none. */
  readonly caller: Readonly<import("./protocols/current.ts").Caller> | undefined;
}

/** Native policy for this tool only. Failures prevent execution and remain private. */
export type Approval<Input = unknown> = (
  context: ApprovalContext<Input>,
) => Effect.Effect<ApprovalDecision, unknown>;
