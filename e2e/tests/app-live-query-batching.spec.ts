/**
 * A live app query reruns at most once a second under a burst of writes, still shows the burst's
 * last write, and is not delayed when the first value or a lone write arrives.
 */
import { expect, layer } from "@effect/vitest";
import { Duration, Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { waitForAppUrl } from "../support/app-pages.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { withApps } from "../support/apps-release.ts";

const files = [
  {
    path: "package.json",
    content: JSON.stringify({
      dependencies: withApps({ react: "^19.2.0", "react-dom": "^19.2.0" }),
    }),
  },
  {
    path: "index.ts",
    content: `import { defineApp, mutation, number, object, query, router } from "apps";
export const latest = query({ input: object({}), output: object({ count: number(), last: number() }) },
  async ({ sql }) => sql.exec("SELECT COUNT(*) AS count, COALESCE(MAX(n), 0) AS last FROM writes").one());
export const write = mutation({ input: object({ n: number() }), output: number() }, async ({ sql }, { n }) => {
  sql.exec("INSERT INTO writes (n) VALUES (?)", n); return n;
});
export default defineApp({}, { tools: router({ latest, write }) });`,
  },
  {
    path: "migrations/0001_writes.sql",
    content: "CREATE TABLE writes (n INTEGER NOT NULL);\n",
  },
  {
    path: "ui/index.html",
    content:
      '<!doctype html><html><head><title>Live writes</title></head><body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>',
  },
  {
    path: "ui/main.tsx",
    content: `import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { number, object } from "apps";
import { createAppClient, queryReference } from "apps/client";
import { useAppQuery } from "apps/react";
import type { latest } from "../index.ts";
const client = createAppClient();
const current = client.queryAtom(queryReference<typeof latest>("latest"), {},
  object({ count: number(), last: number() }));
const updates: Array<{ at: number; count: number; last: number }> = [];
(window as unknown as { liveUpdates: typeof updates }).liveUpdates = updates;
function Page() {
  const { data } = useAppQuery(current);
  useEffect(() => {
    if (data !== undefined) updates.push({ at: Date.now(), count: data.count, last: data.last });
  }, [data]);
  return <main><h1>Live writes</h1>
    <p role="status">{data === undefined ? "Loading" : \`\${data.count} writes, last \${data.last}\`}</p></main>;
}
const root = document.getElementById("root");
if (root === null) throw new Error("Missing app root");
createRoot(root).render(<Page />);`,
  },
];

const Update = Schema.Struct({ at: Schema.Number, count: Schema.Number, last: Schema.Number });
const Updates = Schema.Array(Update);
const Latest = Schema.Struct({ count: Schema.Number, last: Schema.Number });

/** Writes in the burst, about ten a second. */
const burst = 20;
/** A rerun that waited for the one-second spacing would take at least this long. */
const prompt = 1_000;

layer(HostedLive, { excludeTestServices: true })("Live query batching", (it) => {
  it.effect(scenarios.appLiveQueryBatching.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          evidence = yield* Evidence;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Live writes ${randomUUID().slice(0, 8)}`,
          files,
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.orDie),
        );
        const write = (n: number) =>
          api
            .request(actors.owner, "POST", `${prefix}/${app.id}/data/mutate`, {
              name: "write",
              input: { n },
            })
            .pipe(
              Effect.map((response) => {
                expect(response.status, `write ${n}`).toBe(200);
              }),
            );
        const stored = api
          .request(actors.owner, "POST", `${prefix}/${app.id}/data/query`, {
            name: "latest",
            input: {},
          })
          .pipe(Effect.flatMap((response) => body(Latest, response)));
        // Load the app before the page opens, so the first value measures the subscription.
        expect(yield* stored).toEqual({ count: 0, last: 0 });
        const url = yield* waitForAppUrl(actors.owner, `${prefix}/${app.id}/ui`);
        yield* browser.login(actors.owner);
        const subscriptions: number[] = [];
        yield* browser.use("Record when the page subscribes", (page) =>
          Promise.resolve(
            page.on("request", (request) => {
              if (new URL(request.url()).pathname === "/_executor/api/subscribe")
                subscriptions.push(Date.now());
            }),
          ),
        );
        const showing = (count: number, label: string) =>
          browser.use(label, (page) =>
            page
              .getByRole("status")
              .filter({ hasText: `${count} writes, last ${count}` })
              .waitFor({ timeout: 15_000 }),
          );
        const updates = browser
          .use("Read the page's live updates", (page) =>
            page.evaluate(() => (window as unknown as { liveUpdates: unknown }).liveUpdates),
          )
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Updates)), Effect.orDie);

        yield* browser.use("Open the live page", (page) => page.goto(url));
        yield* showing(0, "The first value appears");
        const [first] = yield* updates;
        const subscribed = subscriptions[0];
        expect(first, "first value").toBeDefined();
        expect(subscribed, "subscription request").toBeDefined();
        const firstLatency = (first?.at ?? 0) - (subscribed ?? 0);
        // The first run does not wait out a batching window.
        expect(firstLatency, "first value after subscribing").toBeLessThan(prompt);

        // A lone write after an idle second is not held back either.
        yield* Effect.sleep(Duration.millis(1_500));
        const loneStarted = Date.now();
        yield* write(1);
        yield* showing(1, "A lone write appears");
        const lone = (yield* updates).find((update) => update.last === 1);
        const loneLatency = (lone?.at ?? Number.POSITIVE_INFINITY) - loneStarted;
        expect(loneLatency, "lone write to page").toBeLessThan(prompt);

        yield* Effect.sleep(Duration.millis(1_500));
        const burstStarted = Date.now();
        for (let n = 2; n <= burst + 1; n++) {
          yield* write(n);
          yield* Effect.sleep(Duration.millis(100));
        }
        const burstEnded = Date.now();
        // No lost update: the page settles on the burst's last write.
        yield* showing(burst + 1, "The page shows the burst's last write");
        const all = yield* updates;
        const duringBurst = all.filter((update) => update.at >= burstStarted);
        const settled = all.at(-1);
        // Reruns start at least a second apart. One more covers the run that reads the burst's
        // last write, and one more covers runs whose results arrive with uneven latency.
        const allowed = Math.ceil((burstEnded - burstStarted) / 1_000) + 2;
        yield* evidence.json("live-query-batching.json", {
          firstLatency,
          loneLatency,
          burst: { writes: burst, started: burstStarted, ended: burstEnded, allowed },
          updates: all,
        });
        expect(settled).toMatchObject({ count: burst + 1, last: burst + 1 });
        // The burst's last write is read by the next spaced run, not left for the 15-second refresh.
        expect(
          (settled?.at ?? Number.POSITIVE_INFINITY) - burstEnded,
          "last write to page",
        ).toBeLessThan(2 * prompt);
        expect(yield* stored).toEqual({ count: burst + 1, last: burst + 1 });
        expect(
          duringBurst.length,
          `page updates for ${burst} writes in ${burstEnded - burstStarted} ms`,
        ).toBeLessThanOrEqual(allowed);
        // Batching keeps the page current through the burst instead of waiting for it to end.
        expect(duringBurst.length, "updates while writes continue").toBeGreaterThan(1);
      }),
    ),
  );
});
