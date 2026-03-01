import { controlPlaneOpenApiSpec } from "@executor-v2/control-plane";

export type StartPmHttpServerOptions = {
  port: number;
  handleMcp: (request: Request) => Promise<Response>;
  handleToolCall: (request: Request) => Promise<Response>;
  handleControlPlane: (request: Request) => Promise<Response>;
};

export type PmHttpServer = {
  stop: () => void;
};

const methodNotAllowed = (allowed: string): Response =>
  Response.json(
    {
      ok: false,
      error: `Method not allowed. Expected ${allowed}`,
    },
    { status: 405 },
  );

const notFound = (): Response =>
  Response.json(
    {
      ok: false,
      error: "Not found",
    },
    { status: 404 },
  );

const isControlPlaneMethod = (method: string): boolean =>
  method === "GET" ||
  method === "POST" ||
  method === "PUT" ||
  method === "PATCH" ||
  method === "DELETE" ||
  method === "OPTIONS";

export const startPmHttpServer = (options: StartPmHttpServerOptions): PmHttpServer => {
  const server = Bun.serve({
    port: options.port,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const { pathname } = new URL(request.url);

      if (pathname === "/healthz") {
        return Response.json({ ok: true, service: "pm" });
      }

      if (pathname === "/v1/mcp") {
        if (
          request.method !== "GET" &&
          request.method !== "POST" &&
          request.method !== "DELETE"
        ) {
          return methodNotAllowed("GET, POST, DELETE");
        }

        return options.handleMcp(request);
      }

      if (pathname === "/v1/runtime/tool-call") {
        if (request.method !== "POST") {
          return methodNotAllowed("POST");
        }

        return options.handleToolCall(request);
      }

      if (pathname === "/v1/openapi.json") {
        if (request.method !== "GET") {
          return methodNotAllowed("GET");
        }

        return Response.json(controlPlaneOpenApiSpec);
      }

      if (pathname.startsWith("/v1/") && isControlPlaneMethod(request.method)) {
        return options.handleControlPlane(request);
      }

      return notFound();
    },
  });

  return {
    stop: () => {
      server.stop(true);
    },
  };
};
