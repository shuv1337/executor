import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Result, Schema } from "effect";
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { appsManifest } from "../support/apps-release.ts";
import { releasedServer, releasedServerWith } from "../support/docker-release-server.ts";
import { connectionsPath } from "../support/app-accounts.ts";
import { httpsReceiver } from "../support/https-receiver.ts";

/**
 * A credential handle as the outbound reads it: `exsec_`, the hex of a 12-byte IV and the
 * AES-256-GCM ciphertext of its JSON contents, then `_`. The key is HKDF-SHA256 of a secret. The
 * image derives that secret from the instance's encryption key; earlier images used the constant
 * `service-binding` for every instance.
 */
const handleData = Buffer.from("executor.credential-handle.v1");
const handleKey = (secret: string) =>
  Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), "executor credential handles", 32));
const derivedHandleKey = (encryptionKey: string) =>
  handleKey(
    createHmac("sha256", encryptionKey).update("executor credential handles").digest("hex"),
  );
const formerHandleKey = handleKey("service-binding");
/** A handle's contents. Throws when `key` did not seal it. */
const openHandle = (key: Buffer, handle: string) => {
  const bytes = Buffer.from(handle.slice("exsec_".length, -1), "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  decipher.setAAD(handleData);
  decipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString();
};
const sealHandle = (key: Buffer, contents: string) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(handleData);
  const sealed = Buffer.concat([cipher.update(contents), cipher.final(), cipher.getAuthTag()]);
  return `exsec_${Buffer.concat([iv, sealed]).toString("hex")}_`;
};

// The image's Go host derives the apps Worker's credential handle secret from the instance's
// encryption key. A handle app code keeps opens again after a restart with the same key. The
// kept handle is sent to an undeclared name under the reserved `.invalid` suffix: the outbound
// refuses it as `credential_host` only after opening it, and as `credential_app` when it cannot.
// A handle sealed under the constant earlier images used is refused.
it.live(
  "released image keeps a credential handle app code kept usable across a restart",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const declared = "api.credential-restart.invalid";
        const server = yield* releasedServer;
        const source = `import { defineApp, defineProvider, secrets, object, string, query, router } from "apps";
const service = defineProvider({
  name: "Release handles",
  hosts: [${JSON.stringify(declared)}],
  auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) },
});
export default defineApp({ user: { accounts: { service } } }, {
  tools: router({
    token: query({ input: object({}) }, async (ctx) => ctx.user.accounts.service.fields.token),
    send: query({ input: object({ url: string(), token: string() }) }, async (_, { url, token }) => {
      const response = await fetch(url, { headers: { authorization: "Bearer " + token } });
      return { status: response.status, text: await response.text() };
    }),
  }),
});`;
        const app = yield* server.deploy("Release handles", [
          { path: "index.ts", content: source },
          appsManifest,
        ]);
        const path = `${server.prefix}/apps/${app.id}`;
        const Id = Schema.Struct({ id: Schema.String });
        const connection = yield* server.json(Id, connectionsPath(path, "user", "service"), {});
        const value = `synthetic-release-token-${randomUUID()}`;
        // Connecting from the app links the account to it; calls use it.
        yield* server.json(Id, `${server.prefix}/connections/${connection.id}/submit`, {
          method: "key",
          label: "Release handles",
          fields: { token: value },
        });
        const call = <S extends Schema.Top>(schema: S, tool: string, input: object) =>
          server.json(schema, `${path}/tools/call`, {
            tool,
            input,
          });
        const kept = yield* call(Schema.String, "token", {});
        expect(kept).toMatch(/^exsec_[0-9a-f]+_$/);
        const Refused = Schema.Struct({
          status: Schema.Number,
          text: Schema.fromJsonString(
            Schema.Struct({
              refusal: Schema.Struct({ reason: Schema.String }),
            }),
          ),
        });
        const replay = call(Refused, "send", {
          url: "https://undeclared.credential-restart.invalid/kept",
          token: kept,
        });
        const opened = {
          status: 421,
          text: { refusal: { reason: "credential_host" } },
        };
        expect(yield* replay).toMatchObject(opened);
        // The handle was sealed under the key derived from this instance's encryption key, not
        // the former constant. Its contents sealed again under the derived key open; sealed under
        // the constant, they are refused as not this app's.
        const derived = derivedHandleKey(server.encryptionKey);
        const contents = yield* Effect.try(() => openHandle(derived, kept));
        expect(Result.isFailure(Result.try(() => openHandle(formerHandleKey, kept)))).toBe(true);
        const resealed = (key: Buffer) =>
          call(Refused, "send", {
            url: "https://undeclared.credential-restart.invalid/resealed",
            token: sealHandle(key, contents),
          });
        expect(yield* resealed(derived)).toMatchObject(opened);
        expect(yield* resealed(formerHandleKey)).toMatchObject({
          status: 421,
          text: { refusal: { reason: "credential_app" } },
        });
        yield* server.restart;
        expect(yield* replay).toMatchObject(opened);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  240_000,
);

/**
 * A provider shaped like a peer mesh's: a secret key placed as `Bearer {key}` in `authorization`
 * and as itself in `x-automation-key`, a `raw()` signing secret app code signs with, and `plain()`
 * fields. App code writes both headers itself and sends them with `ctx.fetch`.
 */
const placedSource = (
  host: string,
) => `import { defineApp, defineProvider, header, object, plain, query, raw, router, secrets, string, t } from "apps";
const mesh = defineProvider({
  name: "Release placed handles",
  hosts: [${JSON.stringify(host)}],
  auth: {
    key: secrets({
      label: "Key",
      fields: object({ key: string(), signingSecret: raw(string()), peerId: plain(string()), url: plain(string()) }),
      request: ({ key }) => [header("authorization", t\`Bearer \${key}\`), header("x-automation-key", key)],
    }),
  },
});
const hex = (bytes) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const sign = async (secret, body) => {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
};
export default defineApp({ user: { accounts: { mesh } } }, {
  tools: router({
    fields: query({ input: object({}) }, async ({ user: { accounts } }) => accounts.mesh.fields),
    probe: query({ input: object({ origin: string(), undeclared: string() }) }, async ({ user: { accounts }, fetch }, { origin, undeclared }) => {
      const { key, signingSecret, peerId } = accounts.mesh.fields;
      const body = JSON.stringify({ peerId, event: "probe" });
      const headers = {
        authorization: "Bearer " + key,
        "x-automation-key": key,
        "x-signature": await sign(signingSecret, body),
        "content-type": "application/json",
      };
      // ctx.fetch rejects with Executor's refusal instead of returning it.
      const attempt = (url, init) =>
        fetch(url, init).then(
          async (response) => ({ status: response.status, text: await response.text(), refusal: null }),
          (error) => ({ status: 0, text: "", refusal: { reason: error?.refusal?.reason ?? String(error), location: error?.refusal?.location ?? null } }),
        );
      return {
        written: await attempt(origin + "/written", { method: "POST", headers, body }),
        helper: await attempt(origin + "/helper", { headers: accounts.mesh.headers() }),
        undeclared: await attempt(undeclared + "/refused", { method: "POST", headers, body }),
        otherHeader: await attempt(origin + "/refused", { headers: { "x-note": key } }),
        inBody: await attempt(origin + "/refused", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key }),
        }),
      };
    }),
  }),
});`;

const Attempt = Schema.Struct({
  status: Schema.Number,
  text: Schema.String,
  refusal: Schema.NullOr(
    Schema.Struct({ reason: Schema.String, location: Schema.NullOr(Schema.String) }),
  ),
});
const Echo = Schema.fromJsonString(
  Schema.Struct({ headers: Schema.Record(Schema.String, Schema.String) }),
);

// A method that declares placements gets placed (`exsec2_`) handles. The released image opens
// them in its app outbound and sends the real key in exactly the headers the method places, over
// HTTPS, in both app process topologies. An HMAC app code computes from a `raw()` field verifies.
// The service's echo reaches app code with the key replaced by its handle again, so app code
// reading an echo service such as httpbin sees handles even though the service got the key. The
// key is never sent to an undeclared host, in another header or in a body.
for (const appProcess of ["separate", "shared"] as const)
  it.live(
    `released image sends placed credential handles as their values (${appProcess} app process)`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const name = "receiver.credential-placement.e2e.internal";
          const undeclaredName = "undeclared.credential-placement.e2e.internal";
          const receiver = yield* httpsReceiver(name);
          const declared = `${name}:${receiver.port}`;
          const server = yield* releasedServerWith({
            environment: {
              EXECUTOR_APP_PROCESS: appProcess,
              // The receiver is on this machine, which is a private address to the container.
              EXECUTOR_APPS_ALLOW_PRIVATE_FETCH: "true",
              SSL_CERT_FILE: "/run/executor-e2e/receiver.pem",
            },
            docker: [
              "--add-host",
              `${name}:host-gateway`,
              "--add-host",
              `${undeclaredName}:host-gateway`,
              "--volume",
              `${receiver.certificate}:/run/executor-e2e/receiver.pem:ro`,
            ],
          });
          const app = yield* server.deploy("Release placed handles", [
            { path: "index.ts", content: placedSource(declared) },
            appsManifest,
          ]);
          const path = `${server.prefix}/apps/${app.id}`;
          const Id = Schema.Struct({ id: Schema.String });
          const connection = yield* server.json(Id, connectionsPath(path, "user", "mesh"), {});
          const values = {
            key: `synthetic-mesh-key-${randomUUID()}`,
            signingSecret: `synthetic-mesh-signing-${randomUUID()}`,
            peerId: `peer-${randomUUID()}`,
            url: "https://peer.example.test",
          };
          yield* server.json(Id, `${server.prefix}/connections/${connection.id}/submit`, {
            method: "key",
            label: "Release placed handles",
            fields: values,
          });
          const call = <S extends Schema.Top>(schema: S, tool: string, input: object) =>
            server.json(schema, `${path}/tools/call`, { tool, input });

          // App code holds a placed handle for the key and real values for the other fields.
          const fields = yield* call(
            Schema.Struct({
              key: Schema.String,
              signingSecret: Schema.String,
              peerId: Schema.String,
            }),
            "fields",
            {},
          );
          expect(fields.key).toMatch(/^exsec2_[0-9a-f]+_$/);
          expect(fields.signingSecret).toBe(values.signingSecret);
          expect(fields.peerId).toBe(values.peerId);

          const probe = yield* call(
            Schema.Struct({
              written: Attempt,
              helper: Attempt,
              undeclared: Attempt,
              otherHeader: Attempt,
              inBody: Attempt,
            }),
            "probe",
            {
              origin: `https://${declared}`,
              undeclared: `https://${undeclaredName}:${receiver.port}`,
            },
          );
          expect(probe.written).toMatchObject({ status: 200, refusal: null });
          expect(probe.helper).toMatchObject({ status: 200, refusal: null });
          expect(probe.undeclared.refusal?.reason).toBe("credential_host");
          expect(probe.otherHeader.refusal).toEqual({
            reason: "credential_placement",
            location: "x-note header",
          });
          expect(probe.inBody.refusal).toEqual({
            reason: "credential_placement",
            location: "request body",
          });

          const delivered = yield* receiver.delivered;
          const at = (pathname: string) => {
            const found = delivered.find((entry) => entry.path === pathname);
            if (found === undefined) return expect.fail(`The receiver never got ${pathname}`);
            return found;
          };
          // The receiver got the real key in both placed headers, written by app code or by the
          // account's helper, and a signature over the body made with the real signing secret.
          const written = at("/written");
          expect(written.headers.authorization).toBe(`Bearer ${values.key}`);
          expect(written.headers["x-automation-key"]).toBe(values.key);
          expect(written.headers["x-signature"]).toBe(
            createHmac("sha256", values.signingSecret).update(written.body).digest("hex"),
          );
          expect(at("/helper").headers.authorization).toBe(`Bearer ${values.key}`);
          expect(at("/helper").headers["x-automation-key"]).toBe(values.key);
          // The echo returns to app code with the key as this invocation's handle, never as the
          // value. Every invocation seals afresh, so it is not the handle `fields` returned.
          const echoed = yield* Schema.decodeUnknownEffect(Echo)(probe.written.text);
          expect(echoed.headers.authorization).toMatch(/^Bearer exsec2_[0-9a-f]+_$/);
          expect(echoed.headers["x-automation-key"]).toBe(
            echoed.headers.authorization?.slice("Bearer ".length),
          );
          expect(probe.written.text).not.toContain(values.key);
          // Refused requests were never sent.
          expect(delivered.map((entry) => entry.path).toSorted()).toEqual(["/helper", "/written"]);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    240_000,
  );
