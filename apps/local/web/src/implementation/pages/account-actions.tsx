import type { DashboardError } from "../../contracts/errors.ts";
import type { AccountSummary } from "@executor-js/ui/contracts/dashboard";
import { accountNeedsSignIn } from "@executor-js/ui/contracts/dashboard";
import {
  AccountActionsMenu,
  AccountDialog,
  DisconnectAccountForm,
  EditAccountForm,
} from "@executor-js/ui/dashboard/account-actions";
import { QueryView } from "@executor-js/ui/dashboard/context";
import { Button } from "@executor-js/ui/components/button";
import { DropdownMenuItem, DropdownMenuSeparator } from "@executor-js/ui/components/dropdown-menu";
import { useAtomSet } from "@effect/atom-react";
import type { AccountId } from "@executor-js/sdk";
import type { DashboardAccountDetail } from "@executor-js/local-server/contracts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  accountAtom,
  checkAccountAtom,
  disconnectAccountAtom,
  updateAccountAtom,
} from "../../contracts/accounts.ts";
import { AccountHealthPanel } from "@executor-js/ui/dashboard/account-health";
import { Failure, LoadingRows } from "../components/common.tsx";

/** The list page owns an open dialog, so it outlives the row if the account changes underneath it. */
export type AccountDialogKind = "edit" | "disconnect" | "health";

const managed = "This account is managed by the local server.";

/** Row actions replace the account page; credential replacement keeps its own form page. */
export function LocalAccountActions({
  account,
  open,
}: {
  readonly account: AccountSummary;
  readonly open: (dialog: AccountDialogKind) => void;
}) {
  const needsSignIn = accountNeedsSignIn(account);
  const credentials = needsSignIn ? "Reconnect" : "Update credentials";
  return (
    <>
      {needsSignIn && (
        <Button variant="outline" size="sm" asChild>
          <Link to="/accounts/$accountId/credentials" params={{ accountId: account.id }}>
            {credentials}
          </Link>
        </Button>
      )}
      <AccountActionsMenu account={account}>
        <DropdownMenuItem onSelect={() => open("edit")}>Edit details</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => open("health")}>Check health</DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/accounts/$accountId/credentials" params={{ accountId: account.id }}>
            {credentials}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => open("disconnect")}>
          Disconnect account
        </DropdownMenuItem>
      </AccountActionsMenu>
    </>
  );
}

/** Editing and disconnecting load the account themselves and report it if it disappears. */
export function LocalAccountDialog({
  id,
  dialog,
  onClose,
}: {
  readonly id: AccountId;
  readonly dialog: AccountDialogKind;
  readonly onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const title =
    dialog === "edit"
      ? "Edit account"
      : dialog === "health"
        ? "Account health"
        : "Disconnect account?";
  return (
    <AccountDialog
      title={title}
      description={`${title} for this saved account.`}
      busy={busy}
      onClose={onClose}
    >
      <QueryView query={accountAtom(id)} Failure={Failure} pending={<LoadingRows />}>
        {(data) =>
          dialog === "edit" ? (
            <EditBody data={data} onPendingChange={setBusy} onClose={onClose} />
          ) : dialog === "health" ? (
            <HealthBody data={data} onClose={onClose} />
          ) : (
            <DisconnectBody data={data} onPendingChange={setBusy} onClose={onClose} />
          )
        }
      </QueryView>
    </AccountDialog>
  );
}

function HealthBody({
  data,
  onClose,
}: {
  readonly data: DashboardAccountDetail;
  readonly onClose: () => void;
}) {
  const check = useAtomSet(checkAccountAtom(data.account.id), { mode: "promiseExit" });
  return (
    <AccountHealthPanel<DashboardError>
      data={data}
      check={() => check()}
      Failure={Failure}
      actions={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    />
  );
}

function EditBody({
  data,
  onPendingChange,
  onClose,
}: {
  readonly data: DashboardAccountDetail;
  readonly onPendingChange: (pending: boolean) => void;
  readonly onClose: () => void;
}) {
  const update = useAtomSet(updateAccountAtom(data.account.id), { mode: "promiseExit" });
  return (
    <EditAccountForm<DashboardError>
      account={data.account}
      update={update}
      Failure={Failure}
      disabledReason={data.canManage ? undefined : managed}
      onPendingChange={onPendingChange}
      onDone={onClose}
      cancel={
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      }
    />
  );
}

function DisconnectBody({
  data,
  onPendingChange,
  onClose,
}: {
  readonly data: DashboardAccountDetail;
  readonly onPendingChange: (pending: boolean) => void;
  readonly onClose: () => void;
}) {
  const disconnect = useAtomSet(disconnectAccountAtom(data.account.id), { mode: "promiseExit" });
  return (
    <DisconnectAccountForm<DashboardError>
      data={data}
      Failure={Failure}
      disabledReason={data.canManage ? undefined : managed}
      disconnect={() => disconnect()}
      onPendingChange={onPendingChange}
      onDisconnected={onClose}
      cancel={
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      }
    />
  );
}
