/**
 * The self-host image admits only invited members through SSO. The synthetic OpenID provider runs
 * on the runner. A sidecar owns the container network: it publishes the product's port and
 * forwards the provider's HTTPS address, so the image reads discovery from the same
 * `https://127.0.0.1` issuer and trusts its certificate through `NODE_EXTRA_CA_CERTS`, without
 * disabling TLS checks. The sign-in flow runs over HTTP exactly as a browser follows it.
 */
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Console, Effect, Exit, Schedule, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { driver } from "../support/platform.ts";
import { selfHostSsoIdp, type IdentityMode } from "../support/sso.ts";

const password = "Synthetic-release-password-123!";
const forwarder = `const net = require("node:net");
const [port, host] = [Number(process.argv[1]), process.argv[2]];
net.createServer((client) => {
  const upstream = net.connect(port, host);
  client.pipe(upstream).pipe(client);
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
}).listen(port, "127.0.0.1");`;

const freePort = driver(
  "allocate port",
  () =>
    new Promise<number>((resolve, reject) => {
      const listener = createServer();
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", () => {
        const address = listener.address();
        listener.close(() =>
          address === null || typeof address === "string"
            ? reject(new Error("No test port"))
            : resolve(address.port),
        );
      });
    }),
);

/** A cookie jar for one person's requests, following redirects by hand as a browser does. */
const client = (origin: string) => {
  const cookies = new Map<string, string>();
  const send = (url: string, init: RequestInit = {}) =>
    driver(`${init.method ?? "GET"} ${new URL(url).pathname}`, (signal) =>
      fetch(url, {
        ...init,
        signal,
        redirect: "manual",
        headers: {
          ...(new URL(url).origin === origin ? { origin } : {}),
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          ...(cookies.size === 0 || new URL(url).origin !== origin
            ? {}
            : { cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; ") }),
        },
      }),
    ).pipe(
      Effect.tap((response) =>
        Effect.sync(() => {
          if (new URL(url).origin !== origin) return;
          for (const header of response.headers.getSetCookie()) {
            const [pair = ""] = header.split(";");
            const at = pair.indexOf("=");
            const [name, value] = [pair.slice(0, at), pair.slice(at + 1)];
            if (value === "" || /max-age=0/i.test(header)) cookies.delete(name);
            else cookies.set(name, value);
          }
        }),
      ),
    );
  const json = (path: string, data?: unknown) =>
    send(
      `${origin}${path}`,
      data === undefined ? {} : { method: "POST", body: JSON.stringify(data) },
    );
  const read = (path: string) =>
    json(path).pipe(Effect.flatMap((response) => driver(`read ${path}`, () => response.json())));
  return { send, json, read, cookies };
};

/**
 * Start the provider, the sidecar and the image under test with SSO configured, and set up the
 * owner. Everything is removed when the scope closes.
 */
const ssoImage = Effect.gen(function* () {
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const image = yield* Config.String("EXECUTOR_E2E_DOCKER_IMAGE");
  const docker = (args: readonly string[]) =>
    processes.string(ChildProcess.make("docker", args, { extendEnv: true }));
  const port = yield* freePort;
  const origin = `http://127.0.0.1:${port}`;
  const idp = yield* selfHostSsoIdp(origin);
  const issuerPort = new URL(idp.issuer).port;
  const name = `executor-sso-${randomBytes(6).toString("hex")}`;
  yield* Effect.acquireRelease(
    docker([
      "run",
      "--detach",
      "--name",
      `${name}-network`,
      "--add-host",
      "sso-idp.e2e.internal:host-gateway",
      "--publish",
      `127.0.0.1:${port}:8080`,
      "node:24.22.1-bookworm-slim",
      "node",
      "-e",
      forwarder,
      issuerPort,
      "sso-idp.e2e.internal",
    ]),
    () => docker(["rm", "--force", `${name}-network`]).pipe(Effect.orDie),
  );
  const environment = {
    DO_NOT_TRACK: "1",
    PORT: "8080",
    BETTER_AUTH_URL: origin,
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    EXECUTOR_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    SSO_DISCOVERY_URL: idp.discoveryUrl,
    SSO_CLIENT_ID: "synthetic-sso-client",
    SSO_CLIENT_SECRET: "synthetic-sso-secret",
    SSO_ALLOWED_DOMAINS: "sso.example.test",
    NODE_EXTRA_CA_CERTS: "/run/sso-ca.pem",
  };
  yield* Effect.acquireRelease(
    processes.string(
      ChildProcess.make(
        "docker",
        [
          "run",
          "--detach",
          "--name",
          name,
          "--init",
          "--network",
          `container:${name}-network`,
          "--volume",
          `${idp.certificate}:/run/sso-ca.pem:ro`,
          ...Object.keys(environment).flatMap((variable) => ["--env", variable]),
          image,
        ],
        { env: environment, extendEnv: true },
      ),
    ),
    () => docker(["rm", "--force", "--volumes", name]).pipe(Effect.orDie),
  );
  yield* Effect.addFinalizer((exit) =>
    Exit.isFailure(exit)
      ? docker(["logs", name]).pipe(Effect.flatMap(Console.error), Effect.ignore)
      : Effect.void,
  );
  const owner = client(origin);
  yield* owner.json("/health").pipe(
    Effect.flatMap((response) =>
      response.status === 200 ? Effect.void : Effect.fail("not ready"),
    ),
    Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 240 }),
  );
  const imageId = (yield* docker(["inspect", "--format", "{{.Image}}", name])).trim();
  const build = (yield* owner.json("/")).headers.get("executor-build");
  expect(
    (yield* owner.json("/api/auth/self-host/setup", {
      name: "SSO Owner",
      email: "owner@sso.example.test",
      password,
      organizationName: "SSO root",
    })).status,
  ).toBe(200);
  const [organization] = yield* owner
    .read("/api/auth/organization/list")
    .pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: Schema.String }))),
      ),
    );
  if (organization === undefined) return yield* Effect.die("Setup created no organization");
  /**
   * Follow one OAuth start (`/sign-in/social` or `/link-social`, as the dashboard calls them) through the provider and back to
   * the product's callback, and return where the callback sends the browser.
   */
  const ssoFlow = (
    person: ReturnType<typeof client>,
    email: string,
    mode: IdentityMode,
    start: "/api/auth/sign-in/social" | "/api/auth/link-social",
  ) =>
    Effect.gen(function* () {
      yield* idp.configure(email, mode);
      const started = yield* person
        .json(
          start,
          start === "/api/auth/sign-in/social"
            ? { provider: "sso", callbackURL: "/", errorCallbackURL: "/login" }
            : {
                provider: "sso",
                callbackURL: "/account/security",
                errorCallbackURL: "/account/security",
              },
        )
        .pipe(
          Effect.flatMap((response) =>
            driver("read OAuth start", () => response.text()).pipe(
              Effect.map((text) => ({ status: response.status, text })),
            ),
          ),
        );
      const { url } = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Struct({ url: Schema.String })),
      )(started.text).pipe(
        Effect.mapError(
          () => new Error(`${start} answered ${started.status}: ${started.text.slice(0, 300)}`),
        ),
      );
      // The browser cannot trust the synthetic certificate; it reaches the same sign-in page on
      // the provider's loopback HTTP listener, as the browser scenarios route it.
      const authorize = new URL(url);
      const provider = yield* person.send(`${idp.origin}${authorize.pathname}${authorize.search}`);
      const callback = provider.headers.get("location");
      if (callback === null) return yield* Effect.die("The provider did not redirect back");
      const answered = yield* person.send(callback);
      return new URL(answered.headers.get("location") ?? "/", origin);
    });
  const session = (person: ReturnType<typeof client>) =>
    person
      .read("/api/auth/get-session")
      .pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.NullOr(Schema.Struct({ user: Schema.Struct({ email: Schema.String }) })),
          ),
        ),
      );
  return { origin, owner, organization, ssoFlow, session, imageId, build };
});

const signIn = (
  sso: Effect.Success<typeof ssoImage>,
  person: ReturnType<typeof client>,
  email: string,
  mode: IdentityMode,
) => sso.ssoFlow(person, email, mode, "/api/auth/sign-in/social");

it.live("the self-host image refuses SSO for anyone without a membership and says why", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const sso = yield* ssoImage;
      yield* Console.log(`image ${sso.imageId} build ${sso.build}`);
      const expectRefused = (email: string, mode: IdentityMode, code: string) =>
        Effect.gen(function* () {
          const person = client(sso.origin);
          const landed = yield* signIn(sso, person, email, mode);
          expect(landed.pathname, email).toBe("/login");
          expect(landed.searchParams.get("error"), email).toBe(code);
          expect(yield* sso.session(person), email).toBeNull();
        });
      // Verified, from the approved domain, never invited: SSO adds no one.
      yield* expectRefused("stranger@sso.example.test", "valid", "sso_not_member");
      yield* expectRefused("unverified@sso.example.test", "unverified", "sso_email_unverified");
      yield* expectRefused("member@outside.example.test", "valid", "sso_domain_not_allowed");
      const members = yield* sso.owner.read(
        `/api/auth/organization/list-members?organizationId=${sso.organization.id}`,
      );
      expect(members).toMatchObject({ total: 1, members: [{ role: "owner" }] });
    }),
  ).pipe(Effect.provide([NodeServices.layer, FetchHttpClient.layer])),
);

it.live(
  "the self-host image signs in an invited member through SSO and refuses them once removed",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sso = yield* ssoImage;
        yield* Console.log(`image ${sso.imageId} build ${sso.build}`);
        const invited = yield* sso.owner
          .json("/api/auth/organization/invite-member", {
            organizationId: sso.organization.id,
            email: "member@sso.example.test",
            role: "member",
          })
          .pipe(
            Effect.flatMap((response) => driver("read invitation", () => response.json())),
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))),
          );
        const member = client(sso.origin);
        expect(
          (yield* member.json("/api/auth/self-host/register", {
            invitation: invited.id,
            email: "member@sso.example.test",
            name: "SSO Member",
            password,
          })).status,
        ).toBe(200);
        expect(yield* member.read("/api/auth/organization/list")).toMatchObject([
          { id: sso.organization.id },
        ]);
        // The registered member connects SSO from Security; the link is not a sign-in.
        const linked = yield* sso.ssoFlow(
          member,
          "member@sso.example.test",
          "valid",
          "/api/auth/link-social",
        );
        expect(linked.searchParams.get("error")).toBeNull();

        const returning = client(sso.origin);
        const admitted = yield* signIn(sso, returning, "member@sso.example.test", "valid");
        expect(admitted.searchParams.get("error")).toBeNull();
        expect(yield* sso.session(returning)).toMatchObject({
          user: { email: "member@sso.example.test" },
        });

        expect(
          (yield* sso.owner.json("/api/auth/organization/remove-member", {
            organizationId: sso.organization.id,
            memberIdOrEmail: "member@sso.example.test",
          })).status,
        ).toBe(200);
        const removed = client(sso.origin);
        const refused = yield* signIn(sso, removed, "member@sso.example.test", "valid");
        expect(refused.pathname).toBe("/login");
        expect(refused.searchParams.get("error")).toBe("sso_not_member");
        expect(yield* sso.session(removed)).toBeNull();
      }),
    ).pipe(Effect.provide([NodeServices.layer, FetchHttpClient.layer])),
);
