import { Link } from "@tanstack/react-router";
import type { AppId, ApprovalRequestId } from "@executor-js/sdk";
import { toolRunApprovalAtoms } from "../../contracts/apps.ts";
import { ApprovalsPage as SharedApprovalsPage } from "@executor-js/ui/dashboard/approvals";
import { BrowserApprovalCard } from "@executor-js/ui/dashboard/browser-approval";
import { pendingApprovalsAtom, scheduledReviewAtoms } from "../../contracts/schedules.ts";
import { HostedFailure } from "../components/dashboard-bindings.tsx";
import { useOrganizationRoute } from "../components/organization.tsx";
import { AppApprovalFrame, ScheduledApprovalFrame } from "../components/page-pending.tsx";
/** Pending runs are reviewed by a signed-in human through the product's normal auth boundary. */
export function ApprovalsPage() {
  const { organization, slug: organizationSlug } = useOrganizationRoute();
  return (
    <SharedApprovalsPage
      query={pendingApprovalsAtom(organization)}
      Failure={HostedFailure}
      review={(item) => (
        <Link
          to="/org/$organizationSlug/approvals/$runId"
          params={{ organizationSlug, runId: item.run.id }}
        >
          Review
        </Link>
      )}
    />
  );
}
/** Scheduled answers continue in the background; no MCP client is required. */
export function ScheduledApprovalPage({ runId }: { readonly runId: string }) {
  const { organization, slug: organizationSlug } = useOrganizationRoute();
  return (
    <ScheduledApprovalFrame organizationSlug={organizationSlug}>
      <BrowserApprovalCard
        atoms={scheduledReviewAtoms({ organization, run: runId })}
        completion="Your response was saved. Approved runs continue in the background."
      />
    </ScheduledApprovalFrame>
  );
}
/**
 * A mutation an app's own page asked for, saved as the signed-in person's own run. Only that
 * person's dashboard reads and answers it; the app's page learns only that it was settled.
 */
export function AppApprovalPage({
  appId,
  requestId,
}: {
  readonly appId: AppId;
  readonly requestId: ApprovalRequestId;
}) {
  const { organization, slug: organizationSlug } = useOrganizationRoute();
  return (
    <AppApprovalFrame organizationSlug={organizationSlug} appId={appId}>
      <BrowserApprovalCard
        atoms={toolRunApprovalAtoms({ organization, app: appId, requestId })}
        completion="Done. You can return to the app's page."
      />
    </AppApprovalFrame>
  );
}
