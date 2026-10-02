import { createFileRoute } from "@tanstack/react-router";
import { parseAccountSearch } from "@executor-js/hosted-web/contracts/navigation";
import { TokensPending } from "@executor-js/hosted-web/account";
import { TokensPage } from "@executor-js/hosted-web/pages/tokens";

/** The signed-in user's personal access tokens across every organization. */
export const Route = createFileRoute("/account/tokens")({
  validateSearch: parseAccountSearch,
  pendingComponent: TokensPending,
  component: () => <TokensPage organization={Route.useSearch().organization} />,
});
