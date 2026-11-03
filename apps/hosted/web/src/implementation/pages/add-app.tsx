import { reportBrowserUsage } from "../../contracts/product-analytics.ts";
import { appManagement } from "../../contracts/app-management.ts";
import { useAtomMount } from "@effect/atom-react";
import { HostedFailure, useDashboardAtoms } from "../components/dashboard-bindings.tsx";
import { Link, useNavigate } from "@tanstack/react-router";
import { CatalogPage as Catalog } from "@executor-js/ui/dashboard/catalog";
import { InstallPublication } from "@executor-js/ui/dashboard/install-publication";
import { type AppAcknowledgement } from "@executor-js/ui/contracts/app-management";
import type { App, Publication } from "@executor-js/sdk";
import { useState } from "react";
import { useOrganizationRoute } from "../components/organization.tsx";
import { MakeYourOwn, AddAppBack } from "../components/add-app.tsx";
import { acknowledgeApp } from "../../contracts/apps.ts";

/** Published apps and catalog apps install into the same organization-owned app records. */
export function AddAppPage() {
  const atoms = useDashboardAtoms();
  useAtomMount(atoms.catalog);
  const { organization, slug: organizationSlug } = useOrganizationRoute();
  const navigate = useNavigate();
  const management = appManagement(organization);
  const [selection, setSelection] = useState<typeof Publication.Type>();
  const onApp: AppAcknowledgement = (get, app) => acknowledgeApp(get, organization, app);
  const installed = (app: App) =>
    navigate({
      to: "/org/$organizationSlug/apps/$appId",
      search: { view: Object.keys(app.requirements.accounts).length ? "accounts" : "overview" },
      params: { organizationSlug, appId: app.id },
    });
  if (selection)
    return (
      <InstallPublication
        key={`${selection.name}:${selection.commit}`}
        Failure={HostedFailure}
        publication={selection}
        atoms={management}
        onApp={onApp}
        onInstalled={installed}
        onBack={() => {
          reportBrowserUsage({ area: "apps", action: "install", outcome: "cancelled" });
          setSelection(undefined);
        }}
      />
    );
  return (
    <Catalog
      query={atoms.catalog}
      Failure={HostedFailure}
      publications={management.catalog}
      PublicationFailure={HostedFailure}
      onPublication={(publication) => {
        reportBrowserUsage({ area: "apps", action: "select_publication", outcome: "started" });
        setSelection(publication);
      }}
      mutation={atoms.install}
      InstallFailure={HostedFailure}
      inventory={atoms.inventory}
      open={(app) => (
        <Link
          to="/org/$organizationSlug/apps/$appId"
          search={{ view: Object.keys(app.requirements.accounts).length ? "accounts" : "overview" }}
          params={{ organizationSlug, appId: app.id }}
        >
          Open
        </Link>
      )}
      back={<AddAppBack organizationSlug={organizationSlug} />}
      action={<MakeYourOwn appearance="button" />}
      create={<MakeYourOwn />}
    />
  );
}
