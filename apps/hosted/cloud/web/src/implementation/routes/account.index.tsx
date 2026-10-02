import { createFileRoute, redirect } from "@tanstack/react-router";

/** The account root opens the profile. */
export const Route = createFileRoute("/account/")({
  beforeLoad: () => {
    throw redirect({ to: "/account/profile", replace: true });
  },
});
