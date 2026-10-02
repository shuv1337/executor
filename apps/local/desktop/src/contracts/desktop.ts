import { Schema } from "effect";
import { LocalConfigurationReason } from "@executor-js/local-server/auth";

/** Only the child server's exact loopback HTTP origin can host the dashboard. */
export const LocalOrigin = Schema.String.check(
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "http:" &&
        url.hostname === "127.0.0.1" &&
        url.port !== "" &&
        url.origin === value
      );
    } catch {
      return false;
    }
  }),
);

/** Safe desktop failures never include process output, bootstrap tokens or callback URLs. */
export class DesktopFailed extends Schema.TaggedError<DesktopFailed>()("DesktopFailed", {
  stage: Schema.Literals([
    "configuration",
    "start",
    "ready",
    "server-exit",
    "window",
    "renderer",
    "oauth",
  ]),
}) {}

/** Private fd4 message; OAuth response parameters must never be copied to a log. */
export const DesktopCallback = Schema.Struct({
  version: Schema.Literal(1),
  url: Schema.RedactedFromValue(
    Schema.String.check(
      Schema.makeFilter((value) => {
        try {
          const url = new URL(value);
          return (
            url.protocol === "http:" &&
            url.hostname === "127.0.0.1" &&
            !url.username &&
            !url.password
          );
        } catch {
          return false;
        }
      }),
    ),
  ),
});

/** Private fd4 message sent before the backend exits because its key setup refused to start. */
export const DesktopConfigurationFailed = Schema.Struct({
  version: Schema.Literal(1),
  configuration: LocalConfigurationReason,
});
/** Every fd4 line is one of these. The pipe never carries free-form output. */
export const DesktopBackendMessage = Schema.Union([DesktopCallback, DesktopConfigurationFailed]);

/**
 * Why the window shows the recovery screen instead of the dashboard. A configuration failure keeps
 * the backend's reason; its message stays in diagnostics.
 */
export type DesktopRecovery =
  | { readonly stage: "start" | "ready" | "crash-loop" }
  | { readonly stage: "configuration"; readonly reason: LocalConfigurationReason };

/** Buttons on the script-free recovery page navigate to `executor-recovery:<action>`. */
export const RecoveryAction = Schema.Literals(["restart", "logs", "reset", "quit"]);
export type RecoveryAction = typeof RecoveryAction.Type;

/**
 * `executor-backup.json` inside a reset backup. It identifies the OS credential entry that still
 * holds the backup's keys, or says they are in the backup's own `keys.json`; it never contains a key.
 */
export const BackupManifest = Schema.Struct({
  version: Schema.Literal(1),
  appVersion: Schema.String,
  createdAt: Schema.String,
  /** The data directory this backup was moved from. */
  source: Schema.String,
  installation: Schema.optionalKey(
    Schema.Struct({
      id: Schema.String,
      keySource: Schema.Literals(["os-credential-store", "key-file", "environment"]),
      credential: Schema.optionalKey(
        Schema.Struct({ service: Schema.String, account: Schema.String }),
      ),
    }),
  ),
});

/** Reset refuses before moving anything, or after leaving the data in place. */
export class ResetFailed extends Schema.TaggedError<ResetFailed>()("ResetFailed", {
  stage: Schema.Literals(["stop", "lock", "move"]),
}) {}

/** Accept ordinary web links; operating-system and executable schemes are not supported. */
export const externalUrl = (value: string): URL | undefined => {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
      ? url
      : undefined;
  } catch {
    return undefined;
  }
};

/** Update-provider failures never expose raw release-feed responses. */
export class UpdateFailed extends Schema.TaggedError<UpdateFailed>()("UpdateFailed", {}) {}

/** Browser launch failures never expose pairing links, session cookies or server responses. */
export class BrowserOpenFailed extends Schema.TaggedError<BrowserOpenFailed>()(
  "BrowserOpenFailed",
  {},
) {}

/** A listener port a user may choose. Privileged ports and port 0 are reserved for other callers. */
export const DesktopPort = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1024, maximum: 65535 }),
);

/** `desktop.json` in the desktop data directory. An absent file means the server's default port. */
export const DesktopSettings = Schema.Struct({
  version: Schema.Literal(1),
  port: DesktopPort,
});

/** Settings failures never expose the file contents. */
export class SettingsFailed extends Schema.TaggedError<SettingsFailed>()("SettingsFailed", {
  reason: Schema.Literals(["invalid", "unavailable", "write"]),
}) {}

/** Diagnostics export failures never include the files being collected. */
export class DiagnosticsFailed extends Schema.TaggedError<DiagnosticsFailed>()(
  "DiagnosticsFailed",
  {},
) {}

/** The rotation child's one stdout line. `message` is sanitized configuration text, never a key. */
export const RotationResult = Schema.Struct({
  version: Schema.Literal(1),
  rotated: Schema.Boolean,
  message: Schema.String,
});
