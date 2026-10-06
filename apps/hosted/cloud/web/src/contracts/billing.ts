import { browserOnly, hydrated } from "@executor-js/ui/contracts/http";
import { revalidated } from "@executor-js/ui/contracts/refresh";
import { observeBrowserTransport, observeBrowserResponse } from "@executor-js/telemetry/browser";
import { organizationHttpClient } from "@executor-js/hosted-web/contracts/organization-reference";
import { DashboardRuntime } from "@executor-js/hosted-web/contracts/telemetry";
import { Atom, AtomHttpApi } from "effect/unstable/reactivity";
import { batchReads } from "@executor-js/dashboard-start/batch-browser";
import type { OrganizationReference } from "@executor-js/hosted-server/organization";
import { ExecutorCloudApi } from "../../../src/contracts/api.ts";

const batched = batchReads(ExecutorCloudApi);

/** Only the cloud browser imports the cloud API contract. Its reads batch with the page's others. */
export class CloudClient extends AtomHttpApi.Service<CloudClient>()("CloudClient", {
  api: ExecutorCloudApi,
  httpClient: organizationHttpClient,
  runtime: DashboardRuntime,
  transformClient: (client) => observeBrowserTransport(batched(client)),
  transformResponse: observeBrowserResponse,
}) {}
/** Poll while the page is mounted so asynchronous checkout settlement becomes visible. */
export const billingAtom = Atom.family((organization: OrganizationReference) =>
  CloudClient.query("billing", "overview", hydrated({ params: { organization } })).pipe(
    revalidated,
    Atom.withRefresh("5 seconds"),
  ),
);
/** Create a checkout for the current organization. */
export const checkoutAtom = CloudClient.mutation("billing", "checkout");
/** Create a portal link for the current organization. */
export const portalAtom = CloudClient.mutation("billing", "portal");
/**
 * The member limit the server checks invitations against; only owners and admins may read it.
 * It asks the billing provider, so the server renders settings without it and the browser loads it.
 */
export const memberLimitAtom = Atom.family((organization: OrganizationReference) =>
  browserOnly(CloudClient.query("billing", "memberLimit", { params: { organization } })).pipe(
    revalidated,
  ),
);
