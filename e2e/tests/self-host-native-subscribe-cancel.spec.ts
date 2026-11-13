/**
 * A browser that cancels its app subscriptions frees them on the packaged Go/workerd host: the
 * product closes its connections to the apps process and stops re-authorizing and re-running the
 * query. Live subscriptions to one app share one notification connection to the apps process.
 */
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { randomBytes } from "node:crypto";
import {
  createServer,
  request,
  type ClientRequest,
  type IncomingMessage,
  type Server,
} from "node:http";
import { Effect, FileSystem, Schedule, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { appsManifest } from "../support/apps-release.ts";
import { collectorRequest, nativeSelfHost } from "../support/native-self-host.ts";
import { lockedNpmRegistry } from "../support/npm-registry.ts";
import { driver } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

/** Subscriptions the browser opens and cancels. */
const subscriptions = 6;

interface Reply {
  readonly status: number;
  readonly headers: IncomingMessage["headers"];
  readonly text: string;
}

/** One request to the host's TCP listener under any Host, as a browser on an app address sends. */
const send = (
  origin: string,
  options: {
    readonly host: string;
    readonly path: string;
    readonly method?: "GET" | "POST";
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: unknown;
  },
) =>
  driver(
    `${options.method ?? "GET"} ${options.path}`,
    () =>
      new Promise<Reply>((resolve, reject) => {
        const body = options.body === undefined ? undefined : JSON.stringify(options.body);
        const outgoing = request(
          {
            host: "127.0.0.1",
            port: new URL(origin).port,
            path: options.path,
            method: options.method ?? "GET",
            headers: {
              host: options.host,
              ...(body === undefined
                ? {}
                : {
                    "content-type": "application/json",
                    "content-length": Buffer.byteLength(body),
                  }),
              ...options.headers,
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("end", () =>
              resolve({
                status: response.statusCode ?? 0,
                headers: response.headers,
                text: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        outgoing.on("error", reject);
        if (body !== undefined) outgoing.write(body);
        outgoing.end();
      }),
  );

const cookies = (reply: Reply) =>
  (reply.headers["set-cookie"] ?? []).map((cookie) => cookie.split(";")[0]!).join("; ");

/**
 * An open subscription the test can cancel the way a browser does: by dropping the connection
 * once the first snapshot arrived.
 */
const subscribe = (origin: string, host: string, cookie: string, version: string, trace: string) =>
  driver(
    "open an app subscription",
    () =>
      new Promise<{
        readonly request: ClientRequest;
        readonly headers: IncomingMessage["headers"];
      }>((resolve, reject) => {
        const body = JSON.stringify({ version, name: "latest", input: {} });
        const outgoing = request(
          {
            host: "127.0.0.1",
            port: new URL(origin).port,
            path: "/_executor/api/subscribe",
            method: "POST",
            headers: {
              host,
              origin: `http://${host}`,
              cookie,
              accept: "text/event-stream",
              "content-type": "application/json",
              "content-length": Buffer.byteLength(body),
              traceparent: `00-${trace}-${randomBytes(8).toString("hex")}-01`,
            },
          },
          (response) => {
            if (response.statusCode !== 200) {
              reject(new Error(`subscribe answered ${response.statusCode}`));
              return;
            }
            let text = "";
            response.on("data", (chunk: Buffer) => {
              text += chunk.toString("utf8");
              if (text.includes('"type":"snapshot"'))
                resolve({ request: outgoing, headers: response.headers });
            });
            response.on("error", () => {});
            response.on("end", () => reject(new Error("subscribe ended before a snapshot")));
          },
        );
        outgoing.on("error", () => {});
        outgoing.write(body);
        outgoing.end();
      }),
  );

/** Counts every query the app runs, from the app's own fetch. */
const queryCounter = Effect.acquireRelease(
  driver(
    "start the query counter",
    () =>
      new Promise<{ readonly server: Server; readonly url: string; readonly hits: () => number }>(
        (resolve, reject) => {
          let hits = 0;
          const server = createServer((_incoming, outgoing) => {
            hits++;
            outgoing.end("ok");
          });
          server.on("error", reject);
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (address === null || typeof address === "string")
              reject(new Error("No counter port"));
            else resolve({ server, url: `http://127.0.0.1:${address.port}/hit`, hits: () => hits });
          });
        },
      ),
  ),
  ({ server }) =>
    driver(
      "stop the query counter",
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ).pipe(Effect.ignore),
);

const appSource = (
  counter: string,
) => `import { defineApp, number, object, query, router } from "apps";
export const latest = query({ input: object({}), output: object({ count: number() }) }, async ({ sql }) => {
  await fetch(${JSON.stringify(counter)});
  return sql.exec("SELECT COUNT(*) AS count FROM notes").one() as { count: number };
});
export default defineApp({}, { tools: router({ latest }) });`;

const Organizations = Schema.NonEmptyArray(Schema.Struct({ id: Schema.String }));
const Deployed = Schema.Struct({ id: Schema.String });
const Location = Schema.Struct({ status: Schema.String, url: Schema.NullOr(Schema.String) });
const Spans = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      span: Schema.Struct({ operationName: Schema.String, startTime: Schema.String }),
    }),
  ),
});

it.live(
  scenarios.selfHostNativeSubscribeCancel.title,
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
        const registry = yield* lockedNpmRegistry;
        const counter = yield* queryCounter;
        const host = yield* nativeSelfHost({
          EXECUTOR_NPM_REGISTRY: `${registry.url}/`,
          EXECUTOR_APPS_ALLOW_PRIVATE_FETCH: "true",
        });
        const dashboard = new URL(host.origin).host;
        const json = <S extends Schema.Top>(schema: S, reply: Reply, label: string) => {
          expect(reply.status, `${label}: ${reply.text.slice(0, 300)}`).toBe(200);
          return Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(reply.text);
        };

        // The owner and an app with a database, whose query the page subscribes to.
        const setup = yield* send(host.origin, {
          host: dashboard,
          path: "/api/auth/self-host/setup",
          method: "POST",
          headers: { origin: host.origin },
          body: {
            name: "Subscribe Owner",
            email: "subscribe@example.test",
            password: "Synthetic-subscribe-password-123!",
            organizationName: "Subscribe lab",
          },
        });
        expect(setup.status, setup.text).toBe(200);
        const owner = { origin: host.origin, cookie: cookies(setup) };
        const [organization] = yield* json(
          Organizations,
          yield* send(host.origin, {
            host: dashboard,
            path: "/api/auth/organization/list",
            headers: owner,
          }),
          "organizations",
        );
        const prefix = `/api/organizations/${organization.id}/apps`;
        const app = yield* json(
          Deployed,
          yield* send(host.origin, {
            host: dashboard,
            path: `${prefix}/deploy`,
            method: "POST",
            headers: owner,
            body: {
              name: "Live notes",
              files: [
                appsManifest,
                { path: "index.ts", content: appSource(counter.url) },
                {
                  path: "migrations/0001_notes.sql",
                  content: "CREATE TABLE notes (id TEXT PRIMARY KEY NOT NULL);\n",
                },
                {
                  path: "ui/index.html",
                  content:
                    "<!doctype html><html><head><title>Live notes</title></head><body></body></html>",
                },
              ],
            },
          }),
          "deploy",
        );
        const location = yield* send(host.origin, {
          host: dashboard,
          path: `${prefix}/${app.id}/ui`,
          headers: owner,
        }).pipe(
          Effect.flatMap((reply) => json(Location, reply, "app location")),
          Effect.filterOrFail(
            (found) => found.status === "ready" && found.url !== null,
            () => "The app address is not ready",
          ),
          Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 40 }),
        );
        const appHost = new URL(location.url!).host;

        // Sign in to the app the way a browser does: page, dashboard approval, callback.
        const visit = yield* send(host.origin, {
          host: appHost,
          path: "/",
          headers: { accept: "text/html", "sec-fetch-mode": "navigate" },
        });
        expect(visit.status, visit.text.slice(0, 300)).toBe(302);
        const login = new URL(visit.headers.location!);
        const approve = yield* send(host.origin, {
          host: dashboard,
          path: `${login.pathname}${login.search}`,
          headers: { cookie: owner.cookie, accept: "text/html", "sec-fetch-mode": "navigate" },
        });
        expect(approve.status, approve.text.slice(0, 300)).toBe(302);
        const callback = new URL(approve.headers.location!);
        const signedIn = yield* send(host.origin, {
          host: appHost,
          path: `${callback.pathname}${callback.search}`,
          headers: { cookie: cookies(visit), accept: "text/html", "sec-fetch-mode": "navigate" },
        });
        expect(signedIn.status, signedIn.text.slice(0, 300)).toBe(302);
        const session = cookies(signedIn);
        const page = yield* send(host.origin, {
          host: appHost,
          path: "/",
          headers: { cookie: session, accept: "text/html", "sec-fetch-mode": "navigate" },
        });
        expect(page.status, page.text.slice(0, 300)).toBe(200);
        const context = /<script[^>]*id="executor-context"[^>]*>([^<]+)<\/script>/u.exec(page.text);
        const version = Schema.decodeUnknownSync(
          Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
        )(context?.[1] ?? "").version;

        // The product's connections to the apps process: the accepted ends of its apps socket.
        const product = yield* processes
          .lines(ChildProcess.make("pgrep", ["-f", "--", "--external-addr=apps=unix:"]))
          .pipe(
            Effect.flatMap((pids) =>
              Effect.forEach(
                pids.filter((pid) => pid.trim() !== ""),
                (pid) =>
                  fs.readFileString(`/proc/${pid.trim()}/cmdline`).pipe(
                    Effect.map((line) => line.split("\0")),
                    Effect.orElseSucceed(() => []),
                  ),
              ),
            ),
            Effect.map((commands) =>
              commands.find((args) => args.some((arg) => arg.includes(host.dataDirectory))),
            ),
          );
        const appsSocket = product
          ?.find((arg) => arg.startsWith("--external-addr=apps=unix:"))
          ?.slice("--external-addr=apps=unix:".length);
        expect(appsSocket, "the product's apps socket").toBeDefined();
        const appsConnections = processes.lines(ChildProcess.make("ss", ["-xHn"])).pipe(
          Effect.map(
            (lines) =>
              lines.filter((line) => {
                const fields = line.trim().split(/\s+/u);
                return fields[1] === "ESTAB" && fields[4] === appsSocket;
              }).length,
          ),
        );
        // Settle any connection a previous call left open, then take the idle count.
        yield* Effect.sleep("6 seconds");
        const idle = yield* appsConnections;

        const trace = randomBytes(16).toString("hex");
        const open = yield* Effect.forEach(
          Array.from({ length: subscriptions }),
          () => subscribe(host.origin, appHost, session, version, trace),
          { concurrency: "unbounded" },
        );
        // Live subscriptions to one app share one notification connection, beside short calls.
        yield* Effect.sleep("2 seconds");
        const live = yield* appsConnections;

        // The browser goes away.
        for (const { request: outgoing } of open) outgoing.destroy();
        const cancelledAt = Date.now();
        // The product notices within a heartbeat or two.
        yield* Effect.sleep("12 seconds");
        const queriesAfterCancel = counter.hits();
        const connectionsAfterCancel = yield* appsConnections;
        // A leaked subscription re-runs its query every 15 seconds and re-authorizes every 5.
        yield* Effect.sleep("20 seconds");
        const queriesLater = counter.hits();
        const connectionsLater = yield* appsConnections;
        const heartbeats = yield* collectorRequest(
          host.collectorSocket,
          `/api/traces/${trace}/spans`,
        ).pipe(
          Effect.flatMap((reply) =>
            reply.status === 200
              ? Schema.decodeUnknownEffect(Schema.fromJsonString(Spans))(reply.text)
              : Effect.succeed({ data: [] }),
          ),
          Effect.map(({ data }) => {
            const all = data.filter(
              ({ span }) => span.operationName === "app.ui.heartbeat.authorize",
            );
            return {
              total: all.length,
              afterCancel: all.filter(
                ({ span }) => Date.parse(span.startTime) > cancelledAt + 10_000,
              ).length,
            };
          }),
        );

        const evidence = {
          subscribeHeaders: {
            contentType: open[0]?.headers["content-type"],
            contentLength: open[0]?.headers["content-length"],
            transferEncoding: open[0]?.headers["transfer-encoding"],
          },
          idle,
          live,
          connectionsAfterCancel,
          connectionsLater,
          queriesAfterCancel,
          queriesLater,
          heartbeats: heartbeats.total,
          heartbeatsAfterCancel: heartbeats.afterCancel,
        };
        yield* Effect.log(`subscribe-cancel evidence ${JSON.stringify(evidence)}`);
        // The product cancels only open-ended bodies, so the stream must name its media type.
        expect
          .soft(open[0]?.headers["content-type"]?.split(";")[0], "subscribe media type")
          .toBe("text/event-stream");
        expect
          .soft(live - idle, "notification connections while subscribed")
          .toBeLessThanOrEqual(1);
        expect
          .soft(connectionsAfterCancel, "apps connections after cancel")
          .toBeLessThanOrEqual(idle);
        expect.soft(connectionsLater, "apps connections later").toBeLessThanOrEqual(idle);
        expect.soft(queriesLater - queriesAfterCancel, "queries run after cancel").toBe(0);
        expect.soft(heartbeats.afterCancel, "heartbeat re-authorizations after cancel").toBe(0);
      }),
    ).pipe(Effect.provide(NodeServices.layer), Effect.provide(FetchHttpClient.layer)),
  180_000,
);
