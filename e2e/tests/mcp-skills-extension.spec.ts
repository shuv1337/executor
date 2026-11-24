/**
 * Executor's own MCP server serves the caller's skills through the MCP Skills extension
 * (`io.modelcontextprotocol/skills`): every skill of every app the caller can see, read with the
 * same grants, accounts and catalogs as the `skills` tool. The client is the official TypeScript
 * SDK's `SkillsClient`, which checks each file's size, digest and frontmatter against the entry it
 * listed, so a file that does not match its listing fails the read.
 */
import { expect, layer } from "@effect/vitest";
import type { Skill } from "@modelcontextprotocol/client/ext/skills";
import { Effect, Layer, Redacted, Schedule, Schema } from "effect";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body, type Session } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { appsManifest } from "../support/apps-release.ts";
import { HostedLive, TestLive, withCase, withHostedCase } from "../support/case.ts";
import { App, Organization } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { McpClient } from "../support/mcp-client.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { ConnectionView, consentTo, revokeClientGrants } from "../support/mcp-connections.ts";
import { pairLocalOperator } from "../support/mcp-consent.ts";
import { McpSkillsClient } from "../support/mcp-skills-client.ts";
import { Target } from "../support/platform.ts";

const Token = Schema.Struct({ key: Schema.RedactedFromValue(Schema.String), id: Schema.String });
const Access = Schema.Struct({
  audience: Schema.Struct({ kind: Schema.String }),
  revision: Schema.String,
});
const Source = Schema.Struct({
  files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
});
const INVALID_PARAMS = -32602;
/** What the 2025 revisions' base protocol answers for a resource the server does not serve. */
const RESOURCE_NOT_FOUND = -32002;

const skillMd = (name: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
/**
 * An app with a skill that has a nested reference, so a file below a subdirectory is served, and a
 * file whose name has reserved URI characters.
 */
const skillAppFiles = (skill: string, marker: string) => [
  {
    path: "index.ts",
    content: 'import { defineApp } from "apps"; export default defineApp({}, async () => ({}));',
  },
  {
    path: `skills/${skill}/SKILL.md`,
    content: skillMd(
      skill,
      `Synthetic ${skill} instructions.`,
      `Read [notes](references/deep/notes.md). ${marker}`,
    ),
  },
  { path: `skills/${skill}/references/deep/notes.md`, content: `Notes ${marker} ✓\n` },
  // Reserved characters in a file name are percent-encoded in its URI, never a query or fragment.
  { path: `skills/${skill}/references/Q&A #1.md`, content: `Answers ${marker}\n` },
  appsManifest,
];
/** An app whose skill loader fails, or never answers. */
const loaderAppFiles = (loader: string) => [
  {
    path: "index.ts",
    content: `import { defineApp, dynamicSkills } from "apps";
export default defineApp({}, async (ctx) => ({ dynamicSkills: dynamicSkills({ list: async () => { ${loader} } }) }));`,
  },
  appsManifest,
];
const failingLoader = 'throw new Error("synthetic skill source failure");';
const stalledLoader = "await new Promise(() => {}); return [];";
/** A loader that reads through the app cache, so its catalog is kept, and answers after 6.5 s. */
const slowLoader = `await ctx.cache.read?.("slow-skills");
await new Promise((done) => setTimeout(done, 6500));
return [{ name: "slow-guide", description: "Synthetic slow instructions.", files: [{ path: "SKILL.md", content: "---\\nname: slow-guide\\ndescription: Synthetic slow instructions.\\n---\\nSlow.\\n" }] }];`;

const sha256 = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const uris = (skills: ReadonlyArray<Skill>) => skills.map((skill) => skill.uri);

/** Report only whether the runtime bound the request, never the connection ID or a credential. */
const connectionProbe = Effect.gen(function* () {
  const server = createServer((request, response) => {
    response.end(
      request.headers["x-executor-caller-connection"] === undefined ? "unscoped" : "scoped",
    );
  });
  const port = yield* Effect.acquireRelease(
    Effect.callback<number>((resume) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resume(
          typeof address === "object" && address !== null
            ? Effect.succeed(address.port)
            : Effect.die("The connection probe needs a TCP listener"),
        );
      });
    }),
    () =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  );
  return `http://127.0.0.1:${port}`;
});

const issueSkillKey = (actor: Session) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const response = yield* api.request(actor, "POST", "/api/auth/api-key/create", {
      name: "MCP skills extension",
    });
    expect(response.status).toBe(200);
    const token = yield* body(Token, response);
    yield* Effect.addFinalizer(() =>
      api
        .request(actor, "POST", "/api/auth/api-key/delete", { keyId: token.id })
        .pipe(Effect.orDie),
    );
    return token.key;
  });

const deploySkillApp = (
  owner: Session,
  organization: string,
  name: string,
  files: ReadonlyArray<{ path: string; content: string }>,
) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const prefix = `/api/organizations/${organization}/apps`;
    const deployed = yield* api.request(owner, "POST", `${prefix}/deploy`, { name, files });
    expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
    const app = yield* body(App, deployed);
    const path = `${prefix}/${app.id}`;
    yield* Effect.addFinalizer(() => api.request(owner, "DELETE", path).pipe(Effect.orDie));
    const warmed = yield* api.request(owner, "GET", `${path}/skill-bundle`);
    expect(warmed.status, JSON.stringify(warmed.body)).toBe(200);
    return { app, path };
  });

type ConnectedSkills = Effect.Success<ReturnType<(typeof McpSkillsClient.Service)["connect"]>>;

const expectSkillRefused = (client: ConnectedSkills, base: string) =>
  Effect.gen(function* () {
    const uri = `${base}/SKILL.md`;
    expect(
      yield* client.refusal(`Get the excluded skill ${uri}`, (skills) => skills.get(uri)),
    ).toBe(INVALID_PARAMS);
    expect(
      yield* client.refusal(`Read the excluded skill ${uri}`, (_, client) =>
        client.readResource({ uri }),
      ),
    ).toBe(INVALID_PARAMS);
    expect(
      yield* client.refusal(`List the excluded directory ${base}`, (skills) =>
        skills.readDirectory(base),
      ),
    ).toBe(INVALID_PARAMS);
  });

/** Read every file of each skill and check what the client verified against the entry. */
const readEveryFile = (
  client: Effect.Success<ReturnType<(typeof McpSkillsClient.Service)["connect"]>>,
  skills: ReadonlyArray<Skill>,
) =>
  Effect.forEach(skills, (skill) =>
    Effect.forEach(skill.resources === "dynamic" ? [] : skill.resources, (resource) =>
      client
        .use(`Read ${resource.uri}`, (skills) => skills.read(skill, resource.uri))
        .pipe(
          Effect.tap((file) =>
            Effect.sync(() => {
              expect(file.verified).toBe(true);
              expect(file.bytes.byteLength).toBe(resource.size);
              expect(sha256(file.bytes)).toBe(resource.digest);
            }),
          ),
        ),
    ),
  );

layer(HostedLive, { excludeTestServices: true })("MCP Skills extension", (it) => {
  it.effect(scenarios.mcpSkillsScopedCredentials.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          clients = yield* McpSkillsClient;
        const organization = actors.organization.id;
        const prefix = `/api/organizations/${organization}/mcp-connections`;
        const marker = randomUUID();
        const probe = yield* connectionProbe;
        const { app: visible } = yield* deploySkillApp(
          actors.owner,
          organization,
          "Connection skills",
          loaderAppFiles(`
await ctx.cache.read?.("scope-probe");
const scope = await (await ctx.fetch(${JSON.stringify(probe)}, { signal: ctx.signal })).text();
return [{
  name: "allowed-guide", description: "Synthetic connection scope probe.",
  files: [{ path: "SKILL.md", content: ${JSON.stringify(
    skillMd("allowed-guide", "Synthetic connection scope probe.", ""),
  )} + "Outbound scope: " + scope + "\\n" }],
}];`),
        );
        const { app: hidden } = yield* deploySkillApp(
          actors.owner,
          organization,
          "Unscoped skills",
          skillAppFiles("outside-guide", marker),
        );
        const allowed = `skill://${visible.slug}/allowed-guide`;
        const outside = `skill://${hidden.slug}/outside-guide`;
        const created = yield* api.request(actors.owner, "POST", prefix, {
          id: randomUUID(),
          name: "Skills for one app",
          apps: [{ app: visible.id, runsAs: [{ kind: "app" }], tools: { kind: "all" } }],
        });
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        const connection = yield* body(ConnectionView, created);
        const connectionPath = `${prefix}/${connection.id}`;
        const issued = yield* api.request(actors.owner, "POST", `${connectionPath}/keys`, {
          name: "Only one app",
          expiresInSeconds: 3600,
        });
        expect(issued.status, JSON.stringify(issued.body)).toBe(200);
        const { key } = yield* body(Token, issued);
        const consent = yield* consentTo(actors.owner, connection.url);
        expect(consent.status).toBe(200);
        yield* revokeClientGrants(actors.owner, () => [consent.clientId]);
        const grant = yield* consent.tokens;
        const options = {
          organization,
          revision: "2026-07-28",
          connection: connection.id,
        } as const;
        const full = yield* clients.connect(yield* issueSkillKey(actors.owner), "unscoped", {
          organization,
          revision: options.revision,
        });
        const listing = yield* full.use("Verify the excluded skills are present", (skills) =>
          skills.list(),
        );
        expect(uris(listing.skills)).toEqual(
          expect.arrayContaining([`${outside}/SKILL.md`, "skill://executor/executor/SKILL.md"]),
        );
        const allowedUri = `${allowed}/SKILL.md`;
        const broadEntry = listing.skills.find((skill) => skill.uri === allowedUri);
        if (broadEntry === undefined) return yield* Effect.die("The dynamic skill was not listed");
        const broadFile = yield* full.use("Read the cached unscoped skill", (skills) =>
          skills.read(broadEntry),
        );
        expect(broadFile.body).toContain("Outbound scope: unscoped");
        for (const [name, secret] of [
          ["connection-key", key],
          ["connection-grant", grant],
        ] as const) {
          const scoped = yield* clients.connect(secret, name, options);
          const listing = yield* scoped.use(`List skills for the ${name}`, (skills) =>
            skills.list(),
          );
          expect(uris(listing.skills)).toEqual([allowedUri]);
          const entry = yield* scoped.use(`Get the allowed skill for the ${name}`, (skills) =>
            skills.get(allowedUri),
          );
          expect(entry.skill.uri).toBe(allowedUri);
          // The listing's manifest must be built under the scoped outbound, not
          // borrowed from the unscoped caller's kept catalog.
          expect(listing.skills).toEqual([entry.skill]);
          const file = yield* scoped.use(
            `Read the scoped dynamic skill for the ${name}`,
            (skills) => skills.read(entry.skill),
          );
          expect(file.body).toContain("Outbound scope: scoped");
          yield* expectSkillRefused(scoped, outside);
          yield* expectSkillRefused(scoped, "skill://executor/executor");
        }

        const revoked = yield* api.request(actors.owner, "POST", `${connectionPath}/revoke`);
        expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
        const anonymous = yield* api.session();
        for (const secret of [key, grant]) {
          for (const method of ["skills/list", "skills/get", "resources/read"]) {
            const response = yield* api.request(
              anonymous,
              "POST",
              `/mcp?connection=${encodeURIComponent(connection.id)}`,
              {
                jsonrpc: "2.0",
                id: 1,
                method,
                params: method === "skills/list" ? {} : { uri: `${allowed}/SKILL.md` },
              },
              {
                accept: "application/json, text/event-stream",
                authorization: `Bearer ${Redacted.value(secret)}`,
                "x-executor-organization": organization,
                "mcp-protocol-version": options.revision,
                "mcp-method": method,
              },
            );
            expect(response.status, `${method} after connection revocation`).toBe(401);
          }
        }
      }).pipe(Effect.provide(McpSkillsClient.layer)),
    ),
  );

  it.effect(scenarios.mcpSkillsOrganizationIsolation.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          clients = yield* McpSkillsClient;
        const created = yield* api.request(actors.owner, "POST", "/api/auth/organization/create", {
          name: "Other skills organization",
          slug: `other-skills-${randomUUID().slice(0, 8)}`,
          keepCurrentActiveOrganization: true,
        });
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        const second = yield* body(Organization, created);
        const firstMarker = randomUUID();
        const secondMarker = randomUUID();
        const name = "Identically named skills";
        const first = yield* deploySkillApp(
          actors.owner,
          actors.organization.id,
          name,
          skillAppFiles("first-guide", firstMarker),
        );
        const other = yield* deploySkillApp(
          actors.owner,
          second.id,
          name,
          skillAppFiles("second-guide", secondMarker),
        );
        expect(first.app.slug).toBe(other.app.slug);
        expect(first.app.id).not.toBe(other.app.id);
        const access = yield* body(
          Access,
          yield* api.request(actors.owner, "GET", `${first.path}/access`),
        );
        const shared = yield* api.request(actors.owner, "PATCH", `${first.path}/access`, {
          audience: { kind: "everyone" },
          revision: access.revision,
        });
        expect(shared.status).toBe(200);
        const firstGuide = `skill://${first.app.slug}/first-guide`;
        const secondGuide = `skill://${other.app.slug}/second-guide`;
        const owner = yield* clients.connect(yield* issueSkillKey(actors.owner), "other-org", {
          revision: "2026-07-28",
          organizationSlug: second.slug,
        });
        const otherListing = yield* owner.use(
          "Warm and read the second organization's skill",
          (skills) => skills.list(),
        );
        expect(uris(otherListing.skills)).toContain(`${secondGuide}/SKILL.md`);
        const member = yield* clients.connect(yield* issueSkillKey(actors.member), "first-org", {
          revision: "2026-07-28",
          organizationSlug: actors.organization.slug,
        });
        const listing = yield* member.use("List the member's organization by URL", (skills) =>
          skills.list(),
        );
        expect(uris(listing.skills)).toContain(`${firstGuide}/SKILL.md`);
        expect(uris(listing.skills)).not.toContain(`${secondGuide}/SKILL.md`);
        const ownEntry = yield* member.use("Get the first organization's skill", (skills) =>
          skills.get(`${firstGuide}/SKILL.md`),
        );
        const own = yield* member.use("Read the first organization's skill", (skills) =>
          skills.read(ownEntry.skill),
        );
        expect(own.body).toContain(firstMarker);
        expect(own.body).not.toContain(secondMarker);
        yield* expectSkillRefused(member, secondGuide);
      }).pipe(Effect.provide(McpSkillsClient.layer)),
    ),
  );

  it.effect(scenarios.mcpSkillsExtension.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence,
          skillsClients = yield* McpSkillsClient,
          mcp = yield* McpClient,
          browser = yield* Browser,
          oauth = yield* McpOAuth;
        const organization = actors.organization.id,
          prefix = `/api/organizations/${organization}`;
        const marker = randomUUID();
        const keys: { actor: Session; id: string }[] = [];
        const created: (typeof App.Type)[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const app of created)
              yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`);
            for (const key of keys)
              yield* api.request(key.actor, "POST", "/api/auth/api-key/delete", { keyId: key.id });
          }).pipe(Effect.orDie),
        );
        const keyFor = (actor: Session) =>
          Effect.gen(function* () {
            const response = yield* api.request(actor, "POST", "/api/auth/api-key/create", {
              name: "MCP skills extension",
            });
            expect(response.status).toBe(200);
            const token = yield* body(Token, response);
            keys.push({ actor, id: token.id });
            return token.key;
          });
        const deploy = (name: string, files: ReadonlyArray<{ path: string; content: string }>) =>
          Effect.gen(function* () {
            const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name: `${name} ${marker.slice(0, 8)}`,
              files,
            });
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            const app = yield* body(App, response);
            created.push(app);
            return app;
          });
        const [shared, hidden, failing, stalled] = yield* Effect.all(
          [
            deploy("Shared skills", skillAppFiles("shared-guide", marker)),
            deploy("Private skills", skillAppFiles("private-plan", marker)),
            deploy("Failing skills", loaderAppFiles(failingLoader)),
            deploy("Stalled skills", loaderAppFiles(stalledLoader)),
          ],
          { concurrency: 4 },
        );
        // A new app is the owner's alone; sharing the first gives the member its skills too.
        const access = yield* body(
          Access,
          yield* api.request(actors.owner, "GET", `${prefix}/apps/${hidden.id}/access`),
        );
        expect(access.audience.kind).toBe("private");
        const sharing = yield* body(
          Access,
          yield* api.request(actors.owner, "GET", `${prefix}/apps/${shared.id}/access`),
        );
        const shareResponse = yield* api.request(
          actors.owner,
          "PATCH",
          `${prefix}/apps/${shared.id}/access`,
          { audience: { kind: "everyone" }, revision: sharing.revision },
        );
        expect(shareResponse.status, JSON.stringify(shareResponse.body)).toBe(200);
        // The skills a listing serves are each app's kept catalog; read them once, as the
        // dashboard does, so a slow first build cannot leave a working app out of the listing.
        for (const app of [shared, hidden]) {
          const bundle = yield* api.request(
            actors.owner,
            "GET",
            `${prefix}/apps/${app.id}/skill-bundle`,
          );
          expect(bundle.status, JSON.stringify(bundle.body)).toBe(200);
        }
        const [ownerKey, memberKey] = yield* Effect.all([
          keyFor(actors.owner),
          keyFor(actors.member),
        ]);
        const sharedGuide = `skill://${shared.slug}/shared-guide/SKILL.md`;
        const privatePlan = `skill://${hidden.slug}/private-plan/SKILL.md`;

        const owner = yield* skillsClients.connect(ownerKey, "owner", {
          revision: "2026-07-28",
          organization,
        });
        expect(owner.revision).toBe("2026-07-28");
        const capabilities = owner.client.getServerCapabilities();
        expect(capabilities?.extensions?.["io.modelcontextprotocol/skills"]).toEqual({
          directoryRead: true,
        });
        expect(capabilities?.resources).toBeDefined();
        // A failing app and an app whose loader never answers are left out, not the listing.
        const listing = yield* owner.use("List the owner's skills", (skills) => skills.list());
        yield* evidence.json("owner-listing.json", listing);
        expect(listing.invalid).toEqual([]);
        expect(listing.cacheScope).toBe("private");
        const listed = uris(listing.skills);
        expect(listed).toEqual(
          expect.arrayContaining([sharedGuide, privatePlan, "skill://executor/executor/SKILL.md"]),
        );
        expect(listed.some((uri) => uri.startsWith(`skill://${failing.slug}/`))).toBe(false);
        expect(listed.some((uri) => uri.startsWith(`skill://${stalled.slug}/`))).toBe(false);
        // Every file of the listed skills is served with the bytes the manifest describes.
        const own = listing.skills.filter((skill) =>
          [sharedGuide, privatePlan].includes(skill.uri),
        );
        expect(own.map((skill) => skill.resources)).toEqual(
          own.map(() =>
            expect.arrayContaining([expect.objectContaining({ size: expect.any(Number) })]),
          ),
        );
        yield* readEveryFile(owner, listing.skills);
        const guideEntry = own.find((skill) => skill.uri === sharedGuide)!;
        const notes = yield* owner.use("Read the nested reference", (skills) =>
          skills.read(guideEntry, "references/deep/notes.md"),
        );
        expect(notes.text).toBe(`Notes ${marker} ✓\n`);
        expect(
          guideEntry.resources === "dynamic"
            ? []
            : guideEntry.resources.map((resource) => resource.uri),
        ).toContain(`skill://${shared.slug}/shared-guide/references/Q%26A%20%231.md`);
        const answers = yield* owner.use(
          "Read a file whose name has reserved characters",
          (skills) =>
            skills.read(
              guideEntry,
              `skill://${shared.slug}/shared-guide/references/Q%26A%20%231.md`,
            ),
        );
        expect(answers.text).toBe(`Answers ${marker}\n`);
        // skills/get answers one skill by URI with the same entry the listing gave.
        const got = yield* owner.use("Get one skill", (skills) => skills.get(sharedGuide));
        expect(got.skill).toEqual(guideEntry);
        const directory = yield* owner.use("Read a skill directory", (skills) =>
          skills.readDirectory(`skill://${shared.slug}/shared-guide/references`),
        );
        expect(directory.resources.map((entry) => entry.uri).toSorted()).toEqual([
          `skill://${shared.slug}/shared-guide/references/Q%26A%20%231.md`,
          `skill://${shared.slug}/shared-guide/references/deep`,
        ]);

        // Unknown and malformed names and URIs are invalid parameters.
        const refusals = yield* Effect.all({
          unknownSkill: owner.refusal("Get a skill the app does not have", (skills) =>
            skills.get(`skill://${shared.slug}/no-such-skill/SKILL.md`),
          ),
          unknownApp: owner.refusal("Get a skill of no app", (skills) =>
            skills.get("skill://no-such-app/shared-guide/SKILL.md"),
          ),
          notSkillMd: owner.refusal("Get a skill by a file that is not its SKILL.md", (skills) =>
            skills.get(`skill://${shared.slug}/shared-guide/references/deep/notes.md`),
          ),
          malformed: owner.refusal("Get a URI that is not a skill URI", (skills) =>
            skills.get("not a skill uri"),
          ),
          unknownFile: owner.refusal("Read a file the skill does not have", (_, client) =>
            client.readResource({ uri: `skill://${shared.slug}/shared-guide/missing.md` }),
          ),
          traversal: owner.refusal("Read a path that leaves the skill", (_, client) =>
            client.readResource({
              uri: `skill://${shared.slug}/shared-guide/../private-plan/SKILL.md`,
            }),
          ),
          notDirectory: owner.refusal("Read a file as a directory", (skills) =>
            skills.readDirectory(sharedGuide),
          ),
        });
        expect(refusals).toEqual({
          unknownSkill: INVALID_PARAMS,
          unknownApp: INVALID_PARAMS,
          notSkillMd: INVALID_PARAMS,
          malformed: INVALID_PARAMS,
          unknownFile: INVALID_PARAMS,
          traversal: INVALID_PARAMS,
          notDirectory: INVALID_PARAMS,
        });

        // The member sees the shared app's skills and never the owner's private app's.
        const member = yield* skillsClients.connect(memberKey, "member", {
          revision: "2026-07-28",
          organization,
        });
        const memberListing = yield* member.use("List the member's skills", (skills) =>
          skills.list(),
        );
        yield* evidence.json("member-listing.json", memberListing);
        const memberListed = uris(memberListing.skills);
        expect(memberListed).toContain(sharedGuide);
        expect(memberListed.some((uri) => uri.startsWith(`skill://${hidden.slug}/`))).toBe(false);
        expect(
          yield* Effect.all({
            get: member.refusal("The member gets the owner's private skill", (skills) =>
              skills.get(privatePlan),
            ),
            read: member.refusal("The member reads the owner's private skill", (_, client) =>
              client.readResource({ uri: privatePlan }),
            ),
          }),
        ).toEqual({ get: INVALID_PARAMS, read: INVALID_PARAMS });

        // An OAuth grant narrowed to one app serves that app's skills alone, live.
        yield* browser.login(actors.owner);
        const grant = yield* oauth.authorize;
        const granted = yield* skillsClients.connect(
          Redacted.make(Redacted.value(grant.tokens).access_token),
          "owner-oauth",
          { revision: "2026-07-28" },
        );
        const grants = yield* body(
          Schema.Array(
            Schema.Struct({ clientId: Schema.String, grant: Schema.Struct({ id: Schema.String }) }),
          ),
          yield* api.request(actors.owner, "GET", "/api/auth/mcp/grants"),
        );
        const record = grants.find((item) => item.clientId === grant.clientId);
        if (record === undefined) return yield* Effect.die("The OAuth grant was not persisted");
        const narrowed = yield* api.request(actors.owner, "POST", "/api/auth/mcp/grants/narrow", {
          id: record.grant.id,
          policy: {
            kind: "tools",
            approval: "client",
            apps: [{ app: shared.id, tools: { kind: "all" } }],
          },
        });
        expect(narrowed.status, JSON.stringify(narrowed.body)).toBe(200);
        const narrowedListing = yield* granted.use("List the narrowed grant's skills", (skills) =>
          skills.list(),
        );
        expect(uris(narrowedListing.skills)).toEqual([sharedGuide]);
        expect(
          yield* Effect.all({
            get: granted.refusal("Get a skill of an app the grant excludes", (skills) =>
              skills.get(privatePlan),
            ),
            read: granted.refusal("Read a skill of an app the grant excludes", (_, client) =>
              client.readResource({ uri: privatePlan }),
            ),
            executor: granted.refusal(
              "Read the Executor app's skill the grant excludes",
              (_, client) => client.readResource({ uri: "skill://executor/executor/SKILL.md" }),
            ),
            directory: granted.refusal("Read a directory of an app the grant excludes", (skills) =>
              skills.readDirectory(`skill://${hidden.slug}/private-plan/references`),
            ),
          }),
        ).toEqual({
          get: INVALID_PARAMS,
          read: INVALID_PARAMS,
          executor: INVALID_PARAMS,
          directory: INVALID_PARAMS,
        });

        // A sessionful 2025-11-25 client gets the same skills and files.
        const legacy = yield* skillsClients.connect(ownerKey, "owner-legacy", {
          revision: "2025-11-25",
          organization,
        });
        expect(legacy.revision).toBe("2025-11-25");
        const legacyListing = yield* legacy.use("List skills on 2025-11-25", (skills) =>
          skills.list(),
        );
        expect(uris(legacyListing.skills).toSorted()).toEqual(listed.toSorted());
        yield* readEveryFile(
          legacy,
          legacyListing.skills.filter((skill) => skill.uri === sharedGuide),
        );
        expect(
          yield* legacy.refusal("Read a missing file on 2025-11-25", (_, client) =>
            client.readResource({ uri: `skill://${shared.slug}/shared-guide/missing.md` }),
          ),
        ).toBe(RESOURCE_NOT_FOUND);

        // A client that does not use the extension is offered no skill file as a resource.
        const plain = yield* mcp.connect(ownerKey, "plain", { organization });
        const offered = yield* plain.use("A plain client lists resources", (client, signal) =>
          Promise.all([
            client.listResources(undefined, { signal }),
            client.listResourceTemplates(undefined, { signal }),
          ]),
        );
        expect(offered.map((page) => Object.values(page).find(Array.isArray))).toEqual([[], []]);
      }).pipe(
        Effect.provide(Layer.mergeAll(McpSkillsClient.layer, McpClient.layer, McpOAuth.layer)),
      ),
    ),
  );

  it.effect(scenarios.mcpSkillsExtensionExecutorEdits.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          skillsClients = yield* McpSkillsClient;
        const organization = actors.organization.id,
          prefix = `/api/organizations/${organization}`;
        const response = yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
          name: "MCP skills extension",
        });
        expect(response.status).toBe(200);
        const token = yield* body(Token, response);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: token.id })
            .pipe(Effect.orDie),
        );
        const apps = yield* body(
          Schema.Array(App),
          yield* api.request(actors.owner, "GET", `${prefix}/apps`),
        );
        const executor = apps.find((app) => app.slug === "executor");
        if (executor === undefined)
          return yield* Effect.die("The organization must have its Executor app");
        // The organization adds a skill of its own to its Executor app and deploys it.
        const source = yield* body(
          Source,
          yield* api.request(actors.owner, "GET", `${prefix}/apps/${executor.id}/source`),
        );
        const marker = randomUUID();
        const deployed = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/apps/${executor.id}/deploy`,
          {
            files: [
              ...source.files,
              {
                path: "skills/house-rules/SKILL.md",
                content: skillMd(
                  "house-rules",
                  "This organization's own rules.",
                  `Rules ${marker}.`,
                ),
              },
            ],
          },
        );
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        // Read the new version's skills once, as the dashboard does, so the listing serves them
        // kept rather than waiting on the first load.
        const bundle = yield* api.request(
          actors.owner,
          "GET",
          `${prefix}/apps/${executor.id}/skill-bundle`,
        );
        expect(bundle.status, JSON.stringify(bundle.body)).toBe(200);
        const client = yield* skillsClients.connect(token.key, "executor-edits", {
          revision: "2026-07-28",
          organization,
        });
        const listing = yield* client.use("List the edited Executor app's skills", (skills) =>
          skills.list(),
        );
        const houseRules = listing.skills.find(
          (skill) => skill.uri === "skill://executor/house-rules/SKILL.md",
        );
        expect(houseRules).toBeDefined();
        expect(uris(listing.skills)).toContain("skill://executor/executor/SKILL.md");
        const document = yield* client.use("Read the organization's own Executor skill", (skills) =>
          skills.read(houseRules!),
        );
        expect(document.verified).toBe(true);
        expect(document.body).toContain(`Rules ${marker}.`);
      }).pipe(Effect.provide(McpSkillsClient.layer)),
    ),
  );
});

layer(TestLive, { excludeTestServices: true })("Local MCP Skills extension", (it) => {
  it.effect(scenarios.localMcpSkillsExtension.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          target = yield* Target,
          evidence = yield* Evidence,
          skillsClients = yield* McpSkillsClient;
        const operator = yield* pairLocalOperator;
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const marker = randomUUID();
        const deploy = (name: string, files: ReadonlyArray<{ path: string; content: string }>) =>
          Effect.gen(function* () {
            const response = yield* operator.send(
              "POST",
              "/v1/apps/deploy",
              { owner: "local", name: `${name} ${marker.slice(0, 8)}`, files },
              headers,
            );
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            const { app } = yield* body(Schema.Struct({ app: App }), response);
            yield* Effect.addFinalizer(() =>
              operator.send("DELETE", `/v1/apps/${app.id}`, undefined, headers).pipe(Effect.orDie),
            );
            return app;
          });
        const [granted, other, failing, slow] = yield* Effect.all(
          [
            deploy("Granted skills", skillAppFiles("granted-guide", marker)),
            deploy("Other skills", skillAppFiles("other-guide", marker)),
            deploy("Failing skills", loaderAppFiles(failingLoader)),
            deploy("Slow skills", loaderAppFiles(slowLoader)),
          ],
          { concurrency: 4 },
        );
        const grantedGuide = `skill://${granted.slug}/granted-guide/SKILL.md`;
        const otherGuide = `skill://${other.slug}/other-guide/SKILL.md`;

        // The local key reaches every app.
        const local = yield* skillsClients.connect(target.apiKey, "local", {
          revision: "2026-07-28",
        });
        const listing = yield* local.use("List every local app's skills", (skills) =>
          skills.list(),
        );
        yield* evidence.json("local-listing.json", listing);
        expect(listing.invalid).toEqual([]);
        const listed = uris(listing.skills);
        expect(listed).toEqual(
          expect.arrayContaining([grantedGuide, otherGuide, "skill://executor/executor/SKILL.md"]),
        );
        expect(listed.some((uri) => uri.startsWith(`skill://${failing.slug}/`))).toBe(false);
        // An app slower than the listing waits for is left out of it, and its load runs on, so a
        // later listing serves its skills.
        const slowGuide = `skill://${slow.slug}/slow-guide/SKILL.md`;
        expect(listed).not.toContain(slowGuide);
        const later = yield* local
          .use("List again until the slow app's load has finished", (skills) => skills.list())
          .pipe(
            Effect.repeat({
              schedule: Schedule.spaced("500 millis"),
              until: (listing) => uris(listing.skills).includes(slowGuide),
            }),
            Effect.timeout("20 seconds"),
          );
        expect(uris(later.skills)).toContain(slowGuide);
        yield* readEveryFile(local, listing.skills);
        expect(
          yield* local.refusal("Get a skill the app does not have", (skills) =>
            skills.get(`skill://${granted.slug}/no-such-skill/SKILL.md`),
          ),
        ).toBe(INVALID_PARAMS);

        // A connection scoped to one app lists and serves only that app's skills.
        const clients: string[] = [];
        yield* revokeClientGrants(operator, () => clients);
        const created = yield* api.request(operator, "POST", "/dashboard/api/mcp/connections", {
          id: randomUUID(),
          name: "One app",
          apps: [{ app: granted.id, runsAs: [{ kind: "app" }], tools: { kind: "readOnly" } }],
        });
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        const connection = yield* body(ConnectionView, created);
        const consent = yield* consentTo(operator, connection.url);
        clients.push(consent.clientId);
        expect(consent.status).toBe(200);
        const tokens = yield* consent.tokens;
        const scoped = yield* skillsClients.connect(tokens, "local-scoped", {
          revision: "2026-07-28",
          connection: connection.id,
        });
        const scopedListing = yield* scoped.use("List the scoped connection's skills", (skills) =>
          skills.list(),
        );
        expect(uris(scopedListing.skills)).toEqual([grantedGuide]);
        expect(
          yield* Effect.all({
            get: scoped.refusal("Get a skill of an app the connection excludes", (skills) =>
              skills.get(otherGuide),
            ),
            read: scoped.refusal("Read a skill of an app the connection excludes", (_, client) =>
              client.readResource({ uri: otherGuide }),
            ),
          }),
        ).toEqual({ get: INVALID_PARAMS, read: INVALID_PARAMS });
      }).pipe(Effect.provide(McpSkillsClient.layer)),
    ),
  );
});

/** A loopback service that counts the requests to `/stall` and answers none until it closes. */
const holdingUpstream = Effect.gen(function* () {
  let arrivals = 0;
  const held: ServerResponse[] = [];
  const server = createServer((request, response) => {
    if (request.url === "/stall") {
      arrivals += 1;
      held.push(response);
      return;
    }
    response.writeHead(404).end();
  });
  const port = yield* Effect.acquireRelease(
    Effect.callback<number>((resume) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resume(
          typeof address === "object" && address !== null
            ? Effect.succeed(address.port)
            : Effect.die("The holding upstream needs a TCP listener"),
        );
      });
    }),
    () =>
      Effect.callback<void>((resume) => {
        for (const response of held) response.destroy();
        server.closeAllConnections();
        server.close(() => resume(Effect.void));
      }),
  );
  return { origin: `http://127.0.0.1:${port}`, arrivals: Effect.sync(() => arrivals) };
});

layer(HostedLive, { excludeTestServices: true })("MCP Skills extension loads", (it) => {
  it.effect(scenarios.mcpSkillsExtensionStalledLoad.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          skillsClients = yield* McpSkillsClient;
        const organization = actors.organization.id,
          prefix = `/api/organizations/${organization}`;
        const upstream = yield* holdingUpstream;
        const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Stalled source ${randomUUID().slice(0, 8)}`,
          files: loaderAppFiles(
            `await ctx.fetch(${JSON.stringify(`${upstream.origin}/stall`)}, { signal: ctx.signal }); return [];`,
          ),
        });
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const app = yield* body(App, response);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        // The stalled app is shared, so both callers list it; a second app stays the owner's own.
        const access = yield* body(
          Access,
          yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/access`),
        );
        const shared = yield* api.request(
          actors.owner,
          "PATCH",
          `${prefix}/apps/${app.id}/access`,
          {
            audience: { kind: "everyone" },
            revision: access.revision,
          },
        );
        expect(shared.status, JSON.stringify(shared.body)).toBe(200);
        const privateResponse = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Owner only ${randomUUID().slice(0, 8)}`,
          files: skillAppFiles("owner-only", randomUUID()),
        });
        expect(privateResponse.status, JSON.stringify(privateResponse.body)).toBe(200);
        const ownerOnly = yield* body(App, privateResponse);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${ownerOnly.id}`).pipe(Effect.orDie),
        );
        // Read its skills once, as the dashboard does, so the listings serve them kept.
        const warmed = yield* api.request(
          actors.owner,
          "GET",
          `${prefix}/apps/${ownerOnly.id}/skill-bundle`,
        );
        expect(warmed.status, JSON.stringify(warmed.body)).toBe(200);
        const keyFor = (actor: Session) =>
          Effect.gen(function* () {
            const created = yield* api.request(actor, "POST", "/api/auth/api-key/create", {
              name: "MCP skills extension",
            });
            expect(created.status).toBe(200);
            const token = yield* body(Token, created);
            yield* Effect.addFinalizer(() =>
              api
                .request(actor, "POST", "/api/auth/api-key/delete", { keyId: token.id })
                .pipe(Effect.orDie),
            );
            return token.key;
          });
        const [ownerKey, memberKey] = yield* Effect.all([
          keyFor(actors.owner),
          keyFor(actors.member),
        ]);
        // The member can see the stalled app, so its listing reaches the app's load.
        const memberApps = yield* body(
          Schema.Array(App),
          yield* api.request(actors.member, "GET", `${prefix}/apps`),
        );
        expect(memberApps.map((listed) => listed.id)).toContain(app.id);
        const [owner, member, ownerLegacy] = yield* Effect.all([
          skillsClients.connect(ownerKey, "stalled-owner", {
            revision: "2026-07-28",
            organization,
          }),
          skillsClients.connect(memberKey, "stalled-member", {
            revision: "2026-07-28",
            organization,
          }),
          skillsClients.connect(ownerKey, "stalled-owner-legacy", {
            revision: "2025-11-25",
            organization,
          }),
        ]);
        const list = (
          client: Effect.Success<ReturnType<(typeof McpSkillsClient.Service)["connect"]>>,
          label: string,
        ) =>
          client
            .use(`List as ${label} while the source holds`, (skills) => skills.list())
            .pipe(Effect.map((listing) => uris(listing.skills)));
        // The owner's listing leaves the app out and starts its one load, which reaches the source
        // and is held there.
        const first = yield* list(owner, "owner");
        expect(first.some((uri) => uri.startsWith(`skill://${app.slug}/`))).toBe(false);
        expect(first).toContain(`skill://${ownerOnly.slug}/owner-only/SKILL.md`);
        const held = yield* upstream.arrivals.pipe(
          Effect.repeat({ schedule: Schedule.spaced("100 millis"), until: (count) => count > 0 }),
          Effect.timeout("30 seconds"),
        );
        expect(held).toBe(1);
        // While it is held, the member's and the owner's next listings leave the app out without
        // asking the source again, and the member's holds nothing of the owner's own app.
        for (const [client, label] of [
          [member, "member"],
          [ownerLegacy, "owner-legacy"],
        ] as const) {
          const listed = yield* list(client, label);
          expect(listed.some((uri) => uri.startsWith(`skill://${app.slug}/`))).toBe(false);
          expect(listed.includes(`skill://${ownerOnly.slug}/owner-only/SKILL.md`)).toBe(
            label !== "member",
          );
          expect(yield* upstream.arrivals).toBe(1);
        }
      }).pipe(Effect.provide(McpSkillsClient.layer)),
    ),
  );
});
