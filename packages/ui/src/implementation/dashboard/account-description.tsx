import { Textarea } from "../components/textarea.tsx";

/** The account metadata a dashboard can change. Only supplied fields change. */
export interface AccountMetadataUpdate {
  readonly label?: string;
  /** Null removes the description. */
  readonly description?: string | null;
}

/** Products reject longer descriptions; agents read them with every tool that uses the account. */
export const accountDescriptionMaxLength = 500;

/** A saved description, or null when the draft is blank. */
export const accountDescriptionValue = (draft: string) => {
  const trimmed = draft.trim();
  return trimmed === "" ? null : trimmed;
};

/** The agent-visible description of an account, edited with its name. */
export function AccountDescriptionField({
  value,
  onChange,
  disabled,
  disabledReason,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
  readonly disabledReason?: string | undefined;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-2 text-[13px] font-medium">
        Description for agents
        <Textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="e.g. Production workspace. Reads only; use the sandbox account for writes."
          maxLength={accountDescriptionMaxLength}
          rows={3}
          className="min-h-20"
          disabled={disabled}
          disabledReason={disabledReason}
        />
      </label>
      <span className="field-hint text-muted-foreground text-[12px] font-normal leading-[1.5]">
        Optional. Agents read it with the name to choose between accounts.
      </span>
    </div>
  );
}
