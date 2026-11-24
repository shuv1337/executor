import { createFileRoute, Outlet, useLocation } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { DashboardEntryPending } from "@executor-js/hosted-web/entry";
import { PagePending } from "@executor-js/hosted-web/page-pending";
import { DashboardShell } from "@executor-js/hosted-web/shell";
import { OrganizationBoundary, OrganizationContent } from "@executor-js/hosted-web/organization";
import { NameAccountDialog } from "@executor-js/hosted-web/pages/name-account-dialog";
import { Option } from "effect";
import type { ReactNode } from "react";
import { Navigation } from "../navigation.tsx";
import { organizationCreationAtom } from "../../contracts/auth.ts";
import { SelfHostUpdateBlock, useSelfHostUpdate } from "../update.tsx";

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
      <SelfHostShell allowCreateOrganization={AsyncResult.isSuccess(creation) && creation.value}>
        <OrganizationContent pending={<PagePending />}>
          <Outlet />
          <NameAccountDialog />
        </OrganizationContent>
      </SelfHostShell>
    </OrganizationBoundary>
  );
}

/** The shell, with the update block above the links once an owner's or admin's server has one. */
function SelfHostShell({
  children,
  allowCreateOrganization,
}: {
  readonly children: ReactNode;
  readonly allowCreateOrganization: boolean;
}) {
  const update = useSelfHostUpdate();
  return (
    <DashboardShell
      allowCreateOrganization={allowCreateOrganization}
      navigation={<Navigation />}
      notice={Option.isSome(update) && <SelfHostUpdateBlock update={update.value} />}
    >
      {children}
    </DashboardShell>
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
