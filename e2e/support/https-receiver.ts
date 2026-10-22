/**
 * An HTTPS service on this machine that released containers reach through Docker's host gateway.
 * It records what each request actually carried and, as httpbin does, echoes its headers back as
 * JSON: the record shows what the service received, the echo what app code reads in reply. Its
 * certificate is short-lived and names only `name`; mount `certificate` as the container's
 * `SSL_CERT_FILE` so it is the only one the container trusts.
 */
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, FileSystem, Layer } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { createServer } from "node:https";

/** One request as the receiver got it, headers by lowercase name. */
export interface DeliveredRequest {
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Start the receiver for `name` on every interface; it closes with the scope. */
export const httpsReceiver = (name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-https-receiver-" });
    const certificate = `${directory}/cert.pem`;
    const key = `${directory}/key.pem`;
    yield* processes.string(
      ChildProcess.make(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          key,
          "-out",
          certificate,
          "-days",
          "1",
          "-subj",
          `/CN=${name}`,
          "-addext",
          `subjectAltName=DNS:${name}`,
        ],
        { stderr: "pipe" },
      ),
    );
    const tls = { key: yield* fs.readFileString(key), cert: yield* fs.readFileString(certificate) };
    const delivered: DeliveredRequest[] = [];
    const routes = HttpRouter.add(
      "*",
      "/*",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const body = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
        const headers: Record<string, string> = { ...request.headers };
        delivered.push({ path: request.url, headers, body });
        return yield* HttpServerResponse.json({ headers });
      }),
    );
    const listener = yield* Effect.sync(() => createServer(tls));
    const services = yield* Layer.build(
      HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
        // Docker's host gateway reaches this machine on its network address, not loopback.
        Layer.provideMerge(NodeHttpServer.layer(() => listener, { host: "0.0.0.0", port: 0 })),
      ),
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => listener.closeAllConnections()));
    const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
    if (!("port" in server.address)) return yield* Effect.die("The receiver needs a TCP listener");
    return {
      certificate,
      port: server.address.port,
      delivered: Effect.sync(() => [...delivered]),
    };
  });
