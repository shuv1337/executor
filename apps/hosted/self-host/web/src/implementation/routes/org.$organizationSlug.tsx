import { createFileRoute, Outlet, useLocation } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { DashboardEntryPending } from "@executor-js/hosted-web/entry";
import { PagePending } from "@executor-js/hosted-web/page-pending";
import { DashboardShell } from "@executor-js/hosted-web/shell";
import { OrganizationBoundary, OrganizationContent } from "@executor-js/hosted-web/organization";
import { NameAccountDialog } from "@executor-js/hosted-web/pages/name-account-dialog";
import { Navigation } from "../navigation.tsx";
import { organizationCreationAtom } from "../../contracts/auth.ts";

/** The URL owns this tab's organization; all product pages inherit this boundary. */
export const Route = createFileRoute("/org/$organizationSlug")({
  component: OrganizationLayout,
  // The server streams the dashboard frame and navigation first, then the organization.
  pendingComponent: OrganizationPending,
});
function OrganizationLayout() {
  const { organizationSlug } = Route.useParams();
  const creation = useAtomValue(organizationCreationAtom);
  return (
    <OrganizationBoundary slug={organizationSlug}>
      <DashboardShell
        allowCreateOrganization={AsyncResult.isSuccess(creation) && creation.value}
        navigation={<Navigation />}
      >
        <OrganizationContent pending={<PagePending />}>
          <Outlet />
          <NameAccountDialog />
        </OrganizationContent>
      </DashboardShell>
    </OrganizationBoundary>
  );
}

function OrganizationPending() {
  const { pathname } = useLocation();
  return (
    <DashboardEntryPending pathname={pathname}>
      <PagePending />
    </DashboardEntryPending>
  );
}
