import { createFileRoute, redirect } from "@tanstack/react-router";

/** Tokens moved to personal settings; the organization in the old address preselects the scope. */
export const Route = createFileRoute("/org/$organizationSlug/api-keys")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/account/tokens",
      search: { organization: params.organizationSlug },
      replace: true,
    });
  },
});
