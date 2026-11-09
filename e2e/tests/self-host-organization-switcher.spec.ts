/**
 * The self-host organization switcher offers creation to owners of the root organization only,
 * as the server decides, and switching shows each organization its own apps.
 */
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import type { Page } from "playwright";
import { Actors } from "../support/actors.ts";
import { Api } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";
import { targetHosts } from "../support/role-hosts.ts";
import { scenarios } from "../test-plan.ts";

const rootOnly = `import { defineApp, object, query, router } from "apps";
export default defineApp({}, async () => ({ tools: router({
  ping: query({ input: object({}) }, async () => "pong"),
}) }));`;

/** Open an organization's apps once the server has answered whether the user may create. */
const openApps = (page: Page, origin: string, slug: string) =>
  Promise.all([
    page.waitForResponse((response) => response.url().endsWith("/api/auth/self-host/capabilities")),
    page.goto(`${origin}/org/${slug}/apps`),
  ]).then(([response]) => response.json());

const switcher = (page: Page) => page.getByRole("button", { name: /^Organization: / });

layer(HostedLive, { excludeTestServices: true })("Self-host organization switcher", (it) => {
  it.effect(scenarios.selfHostOrganizationSwitcher.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const root = actors.organization;
        const origin = targetHosts(yield* Target).browser;
        expect(
          (yield* api.request(actors.owner, "POST", `/api/organizations/${root.id}/apps/deploy`, {
            name: "Root only app",
            files: [{ path: "index.ts", content: rootOnly }, appsManifest],
          })).status,
        ).toBe(200);

        yield* browser.login(actors.owner);
        expect(
          yield* browser.use("The owner opens the root's apps", (page) =>
            openApps(page, origin, root.slug),
          ),
        ).toEqual({ createOrganization: true });
        yield* browser.use("The root lists its app", (page) =>
          page.getByText("Root only app", { exact: true }).first().waitFor(),
        );
        yield* browser.use("Open the organization switcher", (page) => switcher(page).click());
        yield* browser.use("Choose Create organization", (page) =>
          page.getByRole("menuitem", { name: "Create organization", exact: true }).click(),
        );
        yield* browser.use("Name the organization", (page) =>
          page.getByRole("dialog").getByLabel("Name", { exact: true }).fill("Second team"),
        );
        yield* browser.checkpoint("The root owner creates an organization from the switcher");
        yield* browser.use("Create it", (page) =>
          page
            .getByRole("dialog")
            .getByRole("button", { name: "Create organization", exact: true })
            .click(),
        );
        yield* browser.use("The new organization opens", (page) =>
          page
            .waitForURL("**/org/second-team/apps")
            .then(() =>
              page
                .getByRole("button", { name: "Organization: Second team", exact: true })
                .waitFor(),
            )
            .then(() => page.getByRole("button", { name: "Add app", exact: true }).waitFor()),
        );
        expect(
          yield* browser.use("The new organization lists no app of the root", (page) =>
            page.getByText("Root only app", { exact: true }).count(),
          ),
        ).toBe(0);
        yield* browser.checkpoint("The new organization opens without the root's apps");

        yield* browser.use("Open the organization switcher", (page) => switcher(page).click());
        yield* browser.use("Switch back to the root", (page) =>
          page.getByRole("menuitemradio", { name: "Evidence lab", exact: true }).click(),
        );
        yield* browser.use("The root opens with its app", (page) =>
          page
            .waitForURL(`**/org/${root.slug}/apps`)
            .then(() => page.getByText("Root only app", { exact: true }).first().waitFor()),
        );

        yield* browser.login(actors.admin);
        expect(
          yield* browser.use("The admin opens the root's apps", (page) =>
            openApps(page, origin, root.slug),
          ),
        ).toEqual({ createOrganization: false });
        yield* browser.use("Open the admin's organization switcher", (page) =>
          switcher(page)
            .click()
            .then(() =>
              page.getByRole("menuitemradio", { name: "Evidence lab", exact: true }).waitFor(),
            ),
        );
        expect(
          yield* browser.use("The admin's switcher", (page) =>
            Promise.all([
              page.getByRole("menuitemradio").count(),
              page.getByRole("menuitem", { name: "Create organization", exact: true }).count(),
            ]),
          ),
        ).toEqual([1, 0]);
        yield* browser.checkpoint("An admin of the root is not offered creation");
      }),
    ),
  );
});
