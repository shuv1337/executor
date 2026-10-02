import { SupportDialog } from "@executor-js/ui/dashboard/support-dialog";
import { captureSupportLinkClicked, captureSupportOpened } from "../analytics.tsx";

/** Cloud's support entry, recording its use in product analytics. */
export function CloudSupport() {
  return <SupportDialog onOpen={captureSupportOpened} onLinkClick={captureSupportLinkClicked} />;
}
