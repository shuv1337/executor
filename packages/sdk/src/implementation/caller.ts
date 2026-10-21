/** Callers the SDK supplies itself, where no product entry point named one. */
import type { Caller, CallerChannel } from "apps/contracts";

/**
 * The caller of work whose product named none: a person for a subject, the host otherwise. Every
 * entry point that knows its channel provides `CurrentCaller`; this keeps `channel` defined.
 */
export const fallbackCaller = (
  actor: string | undefined,
  channel: CallerChannel = actor === undefined ? "workflow" : "api",
): Caller => ({
  kind: actor === undefined ? "system" : "human",
  subject: actor ?? null,
  issuer: null,
  email: null,
  organizationId: null,
  channel,
});

/**
 * The host's own background work: schedules, workflow steps and webhook deliveries. `subject` is
 * the person it runs for, when the work belongs to one.
 */
export const systemCaller = (
  channel: Extract<CallerChannel, "schedule" | "workflow" | "webhook">,
  actor: string | null | undefined,
  organizationId: string | null = null,
): Caller => ({
  kind: "system",
  subject: actor ?? null,
  issuer: null,
  email: null,
  organizationId,
  channel,
});
