/** A launch-time profile choice leaves arbitrary authored layouts untouched. */
import type { ReactNode } from "react";
import type { App, ProfileId } from "@executor-js/sdk";
import { ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "../components/button.tsx";
import { appLaunchUrl, type AppReturnPath } from "../../contracts/app-launch.ts";
import {
  appToolReadiness,
  type AccountSelectionIssue,
  type AccountSummary,
} from "../../contracts/dashboard.ts";
import type { AccountContext } from "./account-group.tsx";
import { describeAccountCheck } from "./account-health.tsx";

interface LaunchNote {
  readonly text: string;
  readonly tone: "bad" | "warn";
}

const noteTones = { bad: "bg-destructive", warn: "bg-amber-500" };

const accountName = (account: AccountSummary) =>
  account.label || account.providerName || "Unnamed account";

const issueText = (app: App, issue: AccountSelectionIssue) => {
  const provider = app.requirements.accounts[issue.slot]?.definition.name ?? issue.slot;
  switch (issue.reason) {
    case "missing":
      return `No ${provider} account chosen`;
    case "disconnected":
      return `${provider} account was removed or is no longer shared`;
    case "incompatible":
      return `Chosen account can't be used as the ${provider} account`;
  }
};

/** Whether a profile can open now, and why not or what to watch for. */
function launchStatus(
  context: AccountContext,
  accounts: readonly AccountSummary[],
): { readonly open: boolean; readonly notes: readonly LaunchNote[] } {
  const bad = (text: string) => ({ open: false, notes: [{ text, tone: "bad" as const }] });
  if (context.profile !== undefined && !context.profile.enabled) return bad("Profile is disabled");
  if (context.profile?.status === "removing") return bad("Profile is being removed");
  const readiness = appToolReadiness(context.app, context.accounts, accounts);
  switch (readiness.state) {
    case "not-deployed":
      return bad("App has no deployment");
    case "selection":
      return {
        open: false,
        notes: readiness.issues.map((issue) => ({
          text: issueText(context.app, issue),
          tone: "bad",
        })),
      };
    case "unavailable":
      return {
        open: false,
        notes: readiness.accounts.map((account) => ({
          text: `${accountName(account)}: sign-in status unavailable`,
          tone: "bad",
        })),
      };
    case "reconnect":
      return {
        open: false,
        notes: readiness.accounts.map((account) => ({
          text: `${accountName(account)}: needs sign-in`,
          tone: "bad",
        })),
      };
    case "rejected":
      return {
        open: false,
        notes: readiness.accounts.map((account) => ({
          text: `${accountName(account)}: sign-in rejected at last check`,
          tone: "bad",
        })),
      };
    case "ready":
      return {
        open: true,
        notes: readiness.warnings.map(({ account, status }) => ({
          text: `${accountName(account)}: ${describeAccountCheck(status).label.toLowerCase()} at last check`,
          tone: "warn",
        })),
      };
  }
}

function Notes({ notes }: { readonly notes: readonly LaunchNote[] }) {
  if (notes.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5 text-[13px] font-normal text-muted-foreground">
      {notes.map((note) => (
        <li key={note.text} className="flex items-center gap-2" data-launch-note={note.tone}>
          <span className={`size-1.5 shrink-0 rounded-full ${noteTones[note.tone]}`} aria-hidden />
          {note.text}
        </li>
      ))}
    </ul>
  );
}

/**
 * Every profile is listed. Ready ones open with their saved accounts; blocked ones say why and
 * link to their accounts. Account changes remain in Accounts.
 */
export function AppLaunch({
  app,
  origin,
  returnTo,
  contexts,
  accounts,
  manage,
  review,
}: {
  readonly app: App;
  readonly origin: string;
  readonly returnTo: AppReturnPath;
  readonly contexts: readonly AccountContext[];
  readonly accounts: readonly AccountSummary[];
  readonly manage: ReactNode;
  /** A link to one profile's accounts, labelled by the host. */
  readonly review: (profile: ProfileId) => ReactNode;
}) {
  const choices = contexts.map((context) => ({ context, ...launchStatus(context, accounts) }));
  const openable = choices.filter((choice) => choice.open);
  return (
    <section className="mx-auto w-full max-w-lg px-6 py-10">
      <h1 className="text-xl font-semibold">Open {app.name}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {choices.length === 0
          ? "Choose accounts in Accounts to open this app."
          : openable.length === 0
            ? choices.length === 1
              ? "This profile can't open yet. Fix its accounts to continue."
              : "None of these profiles can open yet. Fix one's accounts to continue."
            : openable.some((choice) => choice.context.profile !== undefined)
              ? "Choose a profile to open. Each uses its saved accounts."
              : "Open the app below."}
      </p>
      <div className="mt-6 divide-y rounded-lg border empty:hidden">
        {choices.map(({ context, open, notes }) =>
          open ? (
            <a
              key={context.key}
              href={appLaunchUrl(origin, returnTo, context.profile?.id, window.location.hash)}
              className="flex min-h-12 items-center justify-between gap-4 px-4 py-3 text-sm font-medium hover:bg-muted focus-visible:outline-ring"
            >
              <span className="min-w-0">
                <span className="block truncate">{context.label}</span>
                <Notes notes={notes} />
              </span>
              <HugeiconsIcon icon={ArrowUpRight01Icon} size={16} aria-hidden />
            </a>
          ) : (
            <div
              key={context.key}
              role="group"
              aria-label={context.label}
              className="flex min-h-12 items-center justify-between gap-4 px-4 py-3 text-sm font-medium"
            >
              <span className="min-w-0">
                <span className="block truncate text-muted-foreground">{context.label}</span>
                <Notes notes={notes} />
              </span>
              {context.profile !== undefined && (
                <Button variant="outline" size="sm" asChild>
                  {review(context.profile.id)}
                </Button>
              )}
            </div>
          ),
        )}
      </div>
      <Button className="mt-5" variant="ghost" size="sm" asChild>
        {manage}
      </Button>
    </section>
  );
}
