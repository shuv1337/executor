/**
 * An app's own page asks for an approval-gated mutation. The host saves it as the signed-in
 * person's own dashboard run and tells the page only its ID, its review page on the dashboard and
 * whether it still waits. The person approves it on the dashboard; the page, and anyone else,
 * cannot.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body, type Session } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { openPrivateApp, waitForAppUrl } from "../support/app-pages.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Target } from "../support/platform.ts";
import { targetHosts } from "../support/role-hosts.ts";
import { withApps } from "../support/apps-release.ts";

const files = [
  {
    path: "index.ts",
    content: `import { defineApp, mutation, query, object, string, router } from "apps";
export const decisions = query({ input: object({}) }, async ({ sql }) =>
  sql.exec("SELECT title, caller, approver FROM decisions ORDER BY seq").toArray());
export const resolve = mutation(
  { input: object({ title: string() }), output: object({ resolved: string() }), approval: () => "user-approval" },
  async (ctx, input) => {
    ctx.sql.exec(
      "INSERT INTO decisions (title, caller, approver) VALUES (?, ?, ?)",
      input.title,
      JSON.stringify(ctx.caller ?? null),
      JSON.stringify(ctx.approvedBy ?? null),
    );
    return { resolved: input.title };
  },
);
export default defineApp({}, { tools: router({ decisions, resolve }) });`,
  },
  {
    path: "migrations/0001_decisions.sql",
    content:
      "CREATE TABLE decisions (seq INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, caller TEXT NOT NULL, approver TEXT NOT NULL);\n",
  },
  {
    path: "package.json",
    content: JSON.stringify({
      dependencies: withApps({ react: "^19.2.0", "react-dom": "^19.2.0" }),
    }),
  },
  {
    path: "ui/index.html",
    content:
      '<!doctype html><html><head><title>Decisions</title></head><body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>',
  },
  {
    path: "ui/main.tsx",
    content: `import { useState } from "react";
import { createRoot } from "react-dom/client";
import { object, string } from "apps";
import { createAppClient, mutationReference, UiFailed } from "apps/client";
import type { resolve } from "../index.ts";
const client = createAppClient();
const resolveRef = mutationReference<typeof resolve>("resolve");
function Page() {
  const [outcome, setOutcome] = useState("");
  const [review, setReview] = useState<{ requestId: string; url: string }>();
  const [requestId, setRequestId] = useState("");
  const [status, setStatus] = useState("");
  return <main><h1>Decisions</h1>
    <button onClick={() => {
      setOutcome("Sending");
      client.mutate(resolveRef, { title: "Alpha" }, object({ resolved: string() })).then(
        (value) => setOutcome("Resolved " + value.resolved),
        (error) => {
          if (error instanceof UiFailed && error.reason === "approval_required" && error.approval !== undefined) {
            setReview(error.approval);
            setRequestId(error.approval.requestId);
            setOutcome("Waiting for approval");
          } else setOutcome("Failed " + String(error?.reason ?? error));
        });
    }}>Resolve Alpha</button>
    <p role="status" aria-label="Outcome">{outcome}</p>
    {review !== undefined && <a href={review.url} target="_blank" rel="noopener">Review request</a>}
    <label>Request<input value={requestId} onChange={(event) => setRequestId(event.target.value)} /></label>
    <button onClick={() => {
      setStatus("Checking");
      client.approvalStatus(requestId).then((value) => setStatus(value.status), () => setStatus("failed"));
    }}>Check approval</button>
    <p role="status" aria-label="Approval">{status}</p>
  </main>;
}
const root = document.getElementById("root");
if (root === null) throw new Error("Missing app root");
createRoot(root).render(<Page />);`,
  },
];

const Caller = Schema.Struct({
  kind: Schema.String,
  subject: Schema.NullOr(Schema.String),
  channel: Schema.String,
});
const Decisions = Schema.Array(
  Schema.Struct({ title: Schema.String, caller: Schema.String, approver: Schema.String }),
);
const accept = { response: { action: "accept", content: {} } };
const anotherPerson = { _tag: "ToolRunApprovalRefused", reason: "another-person" };

layer(HostedLive, { excludeTestServices: true })("App page approvals", (it) => {
  it.effect(scenarios.appPageApprovals.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const dashboard = targetHosts(yield* Target).browser;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Decisions ${randomUUID().slice(0, 8)}`,
          files,
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.orDie),
        );
        // Everyone in the organization may use the app, so another person can open its page.
        const access = yield* body(
          Schema.Struct({ revision: Schema.String }),
          yield* api.request(actors.owner, "GET", `${prefix}/${app.id}/access`),
        );
        expect(
          (yield* api.request(actors.owner, "PATCH", `${prefix}/${app.id}/access`, {
            revision: access.revision,
            audience: { kind: "everyone" },
          })).status,
        ).toBe(200);
        const decisions = (actor: Session) =>
          Effect.flatMap(
            api.request(actor, "POST", `${prefix}/${app.id}/data/query`, {
              name: "decisions",
              input: {},
            }),
            (response) => body(Decisions, response),
          );
        const url = yield* waitForAppUrl(actors.owner, `${prefix}/${app.id}/ui`);
        const appOrigin = new URL(url).origin;
        const checkStatus = (label: string, requestId: string) =>
          Effect.gen(function* () {
            yield* browser.use(`${label}: ask the page`, (page) =>
              page
                .getByLabel("Request", { exact: true })
                .fill(requestId)
                .then(() => page.getByRole("button", { name: "Check approval" }).click()),
            );
            yield* browser.use(`${label}: wait for the answer`, (page) =>
              page
                .getByRole("status", { name: "Approval" })
                .filter({ hasText: /^(pending|settled|failed)$/ })
                .waitFor(),
            );
            return yield* browser.use(`${label}: read the answer`, (page) =>
              page.getByRole("status", { name: "Approval" }).innerText(),
            );
          });

        // The page asks for the gated write; the host saves it for the person and does not run it.
        yield* browser.login(actors.owner);
        yield* openPrivateApp(url);
        yield* browser.use("The page asks to resolve a decision", (page) =>
          page.getByRole("button", { name: "Resolve Alpha" }).click(),
        );
        yield* browser.use("The page learns the write waits for approval", (page) =>
          page
            .getByRole("status", { name: "Outcome" })
            .filter({ hasText: "Waiting for approval" })
            .waitFor(),
        );
        const review = yield* browser.use("Read the review link", (page) =>
          page.getByRole("link", { name: "Review request" }).getAttribute("href"),
        );
        const requestId = yield* browser.use("Read the request ID", (page) =>
          page.getByLabel("Request", { exact: true }).inputValue(),
        );
        expect(requestId).toMatch(/^apr_/);
        expect(review).not.toBeNull();
        const reviewUrl = new URL(review ?? "");
        // The review lives on the dashboard's origin, never on the app's.
        expect(reviewUrl.origin).toBe(new URL(dashboard).origin);
        expect(reviewUrl.origin).not.toBe(appOrigin);
        expect(reviewUrl.pathname).toBe(
          `/org/${actors.organization.slug}/apps/${app.id}/approve/${requestId}`,
        );
        expect(yield* decisions(actors.owner), "the gated write did not run").toEqual([]);
        expect(yield* checkStatus("The owner's request waits", requestId)).toBe("pending");
        yield* browser.checkpoint("The page shows the saved request and its review link");

        // Nothing on the app's origin answers the request: the page's API has no answer route, and
        // the dashboard's answer route refuses the app's origin.
        const approval = `${prefix}/${app.id}/tools/approvals/${requestId}`;
        const probes = yield* browser.use("The page tries to approve its own request", (page) =>
          page.evaluate(
            ({ approval, dashboard, requestId }) => {
              const json = JSON.stringify({ response: { action: "accept", content: {} } });
              const local = Promise.all(
                [
                  "/_executor/api/approve",
                  "/_executor/api/answer",
                  "/_executor/api/approval-status/answer",
                  `/_executor/api/approvals/${requestId}`,
                  `/api${approval.slice(4)}`,
                ].map((path) =>
                  fetch(path, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: json,
                  }).then((response) => response.status),
                ),
              );
              // A simple cross-origin request reaches the dashboard with its cookies if any are
              // sent; the page cannot read its answer.
              const crossOrigin = fetch(new URL(approval, dashboard).href, {
                method: "POST",
                mode: "no-cors",
                credentials: "include",
                headers: { "content-type": "text/plain" },
                body: json,
              }).then(
                (response) => response.type,
                () => "refused",
              );
              return Promise.all([local, crossOrigin]).then(([local, crossOrigin]) => ({
                local,
                crossOrigin,
              }));
            },
            { approval, dashboard, requestId },
          ),
        );
        for (const status of probes.local) expect([404, 405]).toContain(status);
        expect(["opaque", "refused"]).toContain(probes.crossOrigin);
        // The dashboard's own answer route refuses a request from the app's origin.
        expect(
          (yield* api.request(actors.owner, "POST", approval, accept, { origin: appOrigin }))
            .status,
        ).toBe(403);
        expect(yield* checkStatus("The page's attempts left it waiting", requestId)).toBe(
          "pending",
        );
        expect(yield* decisions(actors.owner)).toEqual([]);

        // Another person can neither read nor answer it, and their page learns nothing about it.
        const read = yield* api.request(actors.member, "GET", approval);
        expect(read.status).toBe(403);
        expect(read.body).toMatchObject(anotherPerson);
        expect(JSON.stringify(read.body)).not.toContain("Alpha");
        const answered = yield* api.request(actors.member, "POST", approval, accept);
        expect(answered.status).toBe(403);
        expect(answered.body).toMatchObject(anotherPerson);
        yield* browser.login(actors.member);
        yield* browser.use("Another person opens the review link", (page) =>
          page.goto(reviewUrl.href),
        );
        yield* browser.use("The dashboard refuses another person's request", (page) =>
          page.getByRole("alert").filter({ hasText: "Another person’s run" }).waitFor(),
        );
        expect(
          yield* browser.use("The refusal shows no arguments", (page) =>
            page.getByText("Alpha").count(),
          ),
        ).toBe(0);
        yield* browser.checkpoint("Another person cannot review the request");
        yield* openPrivateApp(url);
        expect(yield* checkStatus("Another person's page asks about it", requestId)).toBe(
          "settled",
        );
        expect(yield* checkStatus("An unknown request", "apr_unknown")).toBe("settled");
        expect(yield* decisions(actors.owner)).toEqual([]);

        // The person approves it on the dashboard; it runs once, as them, from the app's page.
        yield* browser.login(actors.owner);
        yield* browser.use("The person opens the review link", (page) => page.goto(reviewUrl.href));
        yield* browser.use("The review shows the saved call", (page) =>
          page.getByText('"title": "Alpha"').waitFor(),
        );
        yield* browser.checkpoint("The person reviews the page's request on the dashboard");
        yield* browser.use("The person approves", (page) =>
          page.getByRole("button", { name: "Approve", exact: true }).click(),
        );
        yield* browser.use("The dashboard confirms it", (page) =>
          page.getByText("Done. You can return to the app's page.").waitFor(),
        );
        yield* browser.checkpoint("The approval is saved");
        const written = yield* decisions(actors.owner);
        expect(written).toHaveLength(1);
        expect(written[0]?.title).toBe("Alpha");
        const caller = Schema.decodeUnknownSync(Schema.fromJsonString(Caller))(written[0]?.caller);
        const approver = Schema.decodeUnknownSync(
          Schema.fromJsonString(Schema.Struct({ ...Caller.fields, method: Schema.String })),
        )(written[0]?.approver);
        expect(caller).toMatchObject({ kind: "human", channel: "ui" });
        expect(approver).toMatchObject({
          kind: "human",
          method: "dashboard",
          subject: caller.subject,
        });
        yield* openPrivateApp(url);
        expect(yield* checkStatus("The answered request", requestId)).toBe("settled");
        // An answered request cannot run again.
        expect((yield* api.request(actors.owner, "POST", approval, accept)).body).toEqual({
          status: "unavailable",
        });
        expect(yield* decisions(actors.owner)).toHaveLength(1);
      }),
    ),
  );
});
