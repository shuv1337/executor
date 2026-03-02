import { withAuth } from "@workos-inc/authkit-nextjs";
import type { NextRequest } from "next/server";

import { isWorkosEnabled } from "../../../../lib/workos";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    path?: Array<string>;
  }>;
};

const trim = (value: string | undefined): string | undefined => {
  const candidate = value?.trim();
  return candidate && candidate.length > 0 ? candidate : undefined;
};

const defaultControlPlaneUpstreamUrl = "http://127.0.0.1:8788";

const controlPlaneUpstreamBaseUrl =
  trim(process.env.CONTROL_PLANE_SERVER_BASE_URL)
  ?? trim(process.env.CONTROL_PLANE_UPSTREAM_URL)
  ?? trim(process.env.NEXT_PUBLIC_CONVEX_URL)
  ?? trim(process.env.CONVEX_URL)
  ?? defaultControlPlaneUpstreamUrl;

const methodAllowsBody = (method: string): boolean =>
  method !== "GET" && method !== "HEAD";

const forwardableRequestHeaders = [
  "accept",
  "content-type",
  "traceparent",
  "b3",
  "x-request-id",
] as const;

const isCsrfSafeMethod = (method: string): boolean =>
  method === "GET" || method === "HEAD" || method === "OPTIONS";

const toAuthorizationHeader = (token: string): string =>
  token.toLowerCase().startsWith("bearer ") ? token : `Bearer ${token}`;

const buildUpstreamHeaders = (
  request: NextRequest,
  accessToken: string,
): Headers => {
  const headers = new Headers();

  headers.set("authorization", toAuthorizationHeader(accessToken));

  for (const name of forwardableRequestHeaders) {
    const value = request.headers.get(name);
    if (value) {
      headers.set(name, value);
    }
  }

  headers.set("accept-encoding", "identity");

  return headers;
};

const responseHeadersToStrip = [
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
] as const;

const sanitizeUpstreamResponseHeaders = (headers: Headers): Headers => {
  const sanitized = new Headers(headers);

  for (const name of responseHeadersToStrip) {
    sanitized.delete(name);
  }

  return sanitized;
};

const resolveUpstreamUrl = (
  request: NextRequest,
  pathSegments: ReadonlyArray<string>,
): URL => {
  const pathname = `/${pathSegments.join("/")}`;
  return new URL(`${pathname}${request.nextUrl.search}`, controlPlaneUpstreamBaseUrl);
};

const handle = async (request: NextRequest, context: RouteContext): Promise<Response> => {
  const method = request.method.toUpperCase();
  const { path = [] } = await context.params;

  if (path.length === 0 || path[0] !== "v1") {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  if (!isWorkosEnabled()) {
    return Response.json(
      { error: "WorkOS auth is not enabled" },
      { status: 503 },
    );
  }

  if (!isCsrfSafeMethod(method)) {
    const origin = request.headers.get("origin");
    if (origin && origin !== request.nextUrl.origin) {
      return Response.json({ error: "Invalid origin" }, { status: 403 });
    }
  }

  let accessToken: string | undefined;
  try {
    ({ accessToken } = await withAuth());
  } catch {
    return Response.json(
      { error: "Authentication unavailable" },
      { status: 503 },
    );
  }

  if (!accessToken) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = methodAllowsBody(method)
    ? await request.arrayBuffer()
    : undefined;

  const upstreamResponse = await fetch(resolveUpstreamUrl(request, path), {
    method,
    headers: buildUpstreamHeaders(request, accessToken),
    body,
    redirect: "manual",
  });

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: sanitizeUpstreamResponseHeaders(upstreamResponse.headers),
  });
};

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
