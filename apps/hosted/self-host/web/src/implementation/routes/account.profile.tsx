import { createFileRoute } from "@tanstack/react-router";
import { parseAccountSearch } from "@executor-js/hosted-web/contracts/navigation";
import { ProfilePending } from "@executor-js/hosted-web/account";
import { ProfilePage } from "@executor-js/hosted-web/pages/profile";

/** The signed-in person's name, email and memberships. */
export const Route = createFileRoute("/account/profile")({
  validateSearch: parseAccountSearch,
  pendingComponent: ProfilePending,
  component: ProfilePage,
});
