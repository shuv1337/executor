import {
  AccountConnectionId,
  AccountId,
  AppId,
  ApprovalRequestId,
  WebhookId,
} from "@executor-js/sdk";
import { notFound } from "@tanstack/react-router";
import { Option, Schema } from "effect";

/** A malformed typed identifier names no resource, so the route is missing before any read. */
const decodeParam = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: string,
): S["Type"] => {
  const decoded = Schema.decodeUnknownOption(schema)(value);
  if (Option.isNone(decoded)) throw notFound();
  return decoded.value;
};

/** Reject malformed app URLs before mounting any app reads. */
export function parseAppParams(params: { readonly appId: string }) {
  return { appId: decodeParam(AppId, params.appId) };
}

/** Reject malformed review URLs for an app page's saved request before reading it. */
export function parseAppApprovalParams(params: {
  readonly appId: string;
  readonly requestId: string;
}) {
  return {
    appId: decodeParam(AppId, params.appId),
    requestId: decodeParam(ApprovalRequestId, params.requestId),
  };
}

/** Reject malformed account URLs before mounting any account reads. */
export function parseAccountParams(params: { readonly accountId: string }) {
  return { accountId: decodeParam(AccountId, params.accountId) };
}

/** Reject malformed connection handoff URLs before reading the connection. */
export function parseConnectionParams(params: { readonly connectionId: string }) {
  return { connectionId: decodeParam(AccountConnectionId, params.connectionId) };
}

/** Reject malformed webhook setup URLs before reading the subscription. */
export function parseWebhookParams(params: {
  readonly appId: string;
  readonly subscriptionId: string;
}) {
  return {
    appId: decodeParam(AppId, params.appId),
    subscriptionId: decodeParam(WebhookId, params.subscriptionId),
  };
}
