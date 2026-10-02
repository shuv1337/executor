# Executor desktop

Electron owns a sandboxed window and a separate local server process. The window
uses the same dashboard, HTTP API, pairing exchange, and account model as the
browser app. No Node API or persistent API key is exposed to the renderer.

Release installers include the official Node distribution matching the CLI build
toolchain. The builder verifies its upstream checksum and retains its license
notices. The packaged backend runs with that executable; development continues
to use Electron in Node mode.

## Run

Use Node 22.23+. No configuration is needed: `scripts/local-dev.ts` supplies a
development key pair from the checkout's ignored `.local/dev/`. Variables that
you set, such as the [local server configuration](../server/README.md#configuration),
win over these defaults. Run from the repository root:

```sh
bun install
bun run desktop:dev
```

This builds the Electron main entry, creates a locally signed macOS development
bundle, and launches the app with Vite hot reload. Electron supplies the backend's
Node runtime. After changes to Electron or server source, rerun
`bun run desktop:dev` to rebuild and restart.

On macOS, reopen `.local/desktop-runtime/Executor Dev.app` from Finder. Its launcher
loads the same `scripts/local-dev.ts` defaults each time. The bundle remains attached to this
workspace, like T3 Code's development launcher. It is not a release installer.
Finder launches write diagnostics to `.local/desktop.log`.

To use the built dashboard instead of Vite:

```sh
bun run desktop:start
```

Quit the current instance before switching modes. A second launch focuses the
existing app. Closing the last macOS window keeps the server running; reopening
from the Dock restores the dashboard. **Quit Executor** stops both the app and
its server. Ctrl+C also stops a terminal launch.

Use **File → Open in browser** to connect your system browser to this desktop's
server. It opens an authenticated dashboard with a one-use link. No CLI is needed;
MCP clients can then use that browser for local consent.

## Runtime

- `.local/dev/desktop/` holds the desktop database and retained builds. Set
  `EXECUTOR_DESKTOP_DATA_DIR` to choose another directory. Do not point two running
  hosts at the same data directory.
- `.local/desktop-shell/` holds Chromium's application profile. Browser session
  cookies use an in-memory partition and are replaced by a new pairing on launch.
- The backend uses port 4312 unless **File → Server port…** saved another port in
  `desktop.json` in the data directory, or `EXECUTOR_PORT` is set. `EXECUTOR_PORT` wins and locks
  the form. Its URL, also the MCP base URL, is printed after readiness. It uses the existing explicitly configured API and
  encryption keys; startup does not generate persistent keys.
- Private fd3 carries a one-use bootstrap token. Stdout carries only readiness.
  Electron waits for the parsed ready message before loading its window.
- Private fd4 returns OAuth callbacks from the system browser. The parent accepts
  only the currently pending state and loads the callback in the original window,
  retaining its session and return intent. The server still validates the OAuth
  attempt and credentials. Closing that window during consent requires retrying.
- External HTTP(S) links open in the system browser. Other schemes and embedded
  Node access are disabled. App-origin launch links also open in the browser.
- Desktop warms the entry graph and keeps the renderer unthrottled during startup.
  HMR uses a separate ephemeral loopback listener and Vite cache, so it can
  run alongside the browser development server.
- A supervisor restarts the backend after an unexpected exit, waiting 500 ms and
  doubling to at most 10 s; readiness resets the delay. Each run gets a fresh one-use
  fd3 token and the window reloads with its new pairing link. Three unexpected exits
  within 60 seconds stop restarts and show the recovery page.
- Start, readiness and key-setup failures show the same script-free recovery page.
  Its buttons navigate to `executor-recovery:restart|logs|reset|quit`, which the
  main process intercepts; there is still no preload or IPC. Actions depend on the
  failure. Reset is never offered when the OS credential store is unavailable or
  denies access, when `EXECUTOR_KEY_STORAGE` or supplied keys do not match the
  data, or when the data is locked by another process. A denied store offers
  **Restart**, which prompts again.
- A crashed renderer reloads up to three times per minute. After that the app
  says the window kept crashing, names the diagnostics folder and quits. The native
  error box is otherwise used only when the window itself fails.
- Shutdown is scoped and force-kills an unresponsive backend after four seconds.

## Reset with backup

**Help → Reset Executor data…** and the recovery page's **Reset data…** ask for
confirmation (Cancel is the default). Reset then stops the backend, waits for its
telemetry collector to exit and takes the data directory's bootstrap lock. It
renames the whole data directory to `backups/data-<time>-<random>` beside it
(`<userData>/backups/` for installed apps) and writes `executor-backup.json` there:
app version, time, source path, installation ID, key source and, for the OS
credential store, its service/account. It never contains a key. Executor restarts with fresh data and
names the backup, with **Show in folder**.

Nothing is deleted. The old OS credential entry stays where it is, still paired
with the backup through its installation ID; a `keys.json` moves with the backup. To restore, quit Executor and move the
backup directory back to the data path. There is no restore UI or automatic cleanup.
If the rename fails, for example because another program holds a file open on
Windows, the data stays in place and Executor restarts on it. No restart can begin
while a reset holds the stopped backend. The desktop log continues in a new
`executor-desktop.jsonl` under the fresh data directory.

**Help → Show diagnostics folder** opens the directory holding the desktop,
backend and collector logs.

## Recovery scenarios

`e2e/tests/desktop-recovery.spec.ts` stops and kills the real backend to check
exit classification, restart delays, crash-loop recovery and **Restart**. It starts
from a missing key file to check the configuration recovery page, a failed move
that leaves data in place, and reset with its backup manifest, including reset of a
running server whose `keys.json` moves with the backup. It checks that a locked data
directory, supplied keys or `EXECUTOR_KEY_STORAGE` that do not match the data, and an
unusable OS credential store never offer reset. The store is made absent on Linux and
refuses access on macOS; Windows has no such case. It uses synthetic supplied keys, a
key file or an unusable store, so it never touches a real OS credential. The
release workflow runs it against each packaged desktop. Locally, build the entry
and run it; set `EXECUTOR_E2E_DESKTOP_EXECUTABLE` to test a packaged app:

```sh
bun run apps:build && bun run e2e:apps && bun run telemetry:build && bun run web:build
node apps/local/desktop/scripts/build.mjs
bunx vitest run --config e2e/desktop-recovery.config.ts
```

## Settings and diagnostics

**File → Server port…** opens a script-free form in its own sandboxed window. Submitting it is a
navigation to `executor-settings:` that the parent intercepts; there is still no preload or IPC
bridge. The parent accepts ports 1024 to 65535, refuses one another program is listening on,
writes `desktop.json` (mode `0600`) and relaunches. A bind can still race another process after
the check. An unreadable `desktop.json` stops startup rather than silently using the default.

**File → Rotate local API key…** confirms, stops the server, then runs the backend entry with
`--rotate-api-key` and relaunches. That process replaces the API key where the data directory keeps
it (OS credential store or `keys.json`) and retains the encryption key, so saved accounts and MCP
sign-ins still work. Browser sessions are unaffected; scripts and clients that send the old key
must be updated. Outstanding account-connection links are signed with the old key and stop working.
Supplied `EXECUTOR_API_KEY`/`EXECUTOR_ENCRYPTION_KEY` are never stored, so the menu explains that
they must be changed where they are set. The CLI equivalent is `executor rotate-key`.

**Help → Export diagnostics…** writes `executor-diagnostics-<UTC stamp>.zip` to Downloads and
reveals it. It contains a manifest (versions, platform, origin, port source, data directory) and
the allowlisted files from `diagnostics/`: the rotating `executor-*.jsonl` logs and
`collector.json`, at most 50 MiB each and 14 days old. Keys, `installation.json`, databases,
retained builds, the browser profile and Motel's trace store are never read. Logs are already
redacted at the source; the export additionally masks bearer values, `pair`/`token`/`code`/`state`
URL parameters, 64-digit hex runs and credential-named JSON fields.

## T3 Code reference

Reviewed `pingdotgg/t3code` at `93e04160` (2026-09-18). The ignored checkout is
`.reference/t3code-desktop/`. The main references are:

- `apps/desktop/src/backend/DesktopBackendManager.ts`: scoped backend process,
  private bootstrap pipe, readiness, and bounded shutdown.
- `apps/desktop/src/backend/DesktopBackendConfiguration.ts`: run Electron's binary
  in Node mode for the server.
- `apps/desktop/src/window/DesktopWindow.ts`: sandboxed window and native lifecycle.
- `apps/desktop/vite.config.ts`: bundled CommonJS main entry with Electron external.
- `apps/web/vite.config.ts` and `apps/web/vite/tailwind.ts`: bundled development,
  entry warmup, and Tailwind hooks for Rolldown.
- `apps/desktop/scripts/electron-launcher.mjs`: a branded development bundle with
  framework-relative symlinks preserved and local code signing.
- `scripts/build-desktop-artifact.ts`: reference for the later release pipeline.

Executor keeps its existing same-origin HTTP/cookie protocol. It does not need a
preload or an IPC bridge for ordinary dashboard operations. Distribution builds,
notarization, updates, and platform-specific release artifacts remain separate
from this workspace launcher. Windows and Linux have not been verified.

## Persistent diagnostics

Startup builds and copies the Motel collector bundle into `dist/motel`.
The backend serves it with the bundled workerd and persists traces/logs under its data directory's
`diagnostics/`. The Electron parent records startup, exits and renderer messages in
`executor-desktop.jsonl`. Each backend's last 256 KB of stderr is written there only
when that run fails; stdout and private callback
pipes remain protocol-only. See [telemetry](../../../notes/telemetry.md#frontend-lifetime-and-local-diagnostics)
for retention, query URLs, and the JSONL files an agent can inspect.

## Packaged preview

Build the CLI runtime with `bun run release:cli`, then run
`bun run release:desktop 0.0.0-preview.local`. Add `--dir` to build an unpacked
application for inspection. Output lives in `.local/releases/`.

The preview is named **Executor Preview**, with a separate app ID and persistent
Electron user-data directory. It contains the server, dashboard, framework,
compiler, Git, SDK dependencies and collector. It does not load `.env` files, call 1Password,
require a workspace or use the original Executor updater. The parent still owns
private bootstrap/callback pipes and waits for backend shutdown before updating.

The backend uses the local server's default port, 4312, or an explicit `EXECUTOR_PORT`.
It keeps the same MCP URL after a restart. Use another fixed port when running a
second installation. Development and tests can explicitly request port 0.

Windows and Linux builds, and signed macOS builds, include the channel feed in
`app-update.yml`. Unsigned macOS builds have none, and their **Updates** menu
points to the download page. See [desktop update channels](../../../RELEASING.md#desktop-update-channels).

For now start the executable with explicitly supplied API/encryption keys in its
environment. That works independently of the repository, but a complete Finder
first-run setup is still needed. See [the pending first-launch decision](../../../notes/installable-releases.md#first-launch-storage-decision-pending).
