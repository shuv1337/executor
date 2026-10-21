import { createFileRoute } from "@tanstack/react-router";
import { AppApprovalPage } from "@executor-js/hosted-web/pages/approvals";
import { parseAppApprovalParams } from "@executor-js/hosted-web/route-params";

/** The signed-in person reviews a mutation the app's own page saved for them. */
export const Route = createFileRoute("/org/$organizationSlug/apps/$appId_/approve/$requestId")({
  params: { parse: parseAppApprovalParams },
  component: Review,
});
function Review() {
  const { appId, requestId } = Route.useParams();
  return <AppApprovalPage appId={appId} requestId={requestId} />;
}
