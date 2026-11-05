/**
 * Header the app outbound sets when it places a managed credential for an invocation that arrived
 * on a scoped MCP connection. The host seals the connection id into the credential handle; app
 * code cannot choose it. The API trusts the header only as that bound id.
 */
export const callerConnectionHeader = "x-executor-caller-connection";
