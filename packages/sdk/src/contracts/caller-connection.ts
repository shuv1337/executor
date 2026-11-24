import { Context } from "effect";

/**
 * Header the app outbound sets when it places a managed credential for an invocation that arrived
 * on a scoped MCP connection. The host seals the connection id into the credential handle; app
 * code cannot choose it. The API trusts the header only as that bound id.
 */
export const callerConnectionHeader = "x-executor-caller-connection";

/** Host-only revision of a verified connection, never part of app-visible caller provenance. */
export const CurrentCallerConnectionRevision = Context.Reference<string | undefined>(
  "executor/CurrentCallerConnectionRevision",
  { defaultValue: () => undefined },
);
