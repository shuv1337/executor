/** Desktop-owned settings. The port form is a script-free document; its submission is a navigation. */
import { createServer } from "node:net";
import { BrowserWindow, session } from "electron";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { DesktopPort, DesktopSettings, SettingsFailed } from "../contracts/desktop.ts";

/** Where the backend port comes from. An explicit EXECUTOR_PORT always wins over the setting. */
export type PortSource =
  | { readonly kind: "environment"; readonly port: string }
  | { readonly kind: "setting"; readonly port: number }
  | { readonly kind: "default" };

const settingsPath = (directory: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join(directory, "desktop.json");
  });

/** Read `desktop.json`. A missing file is the default; an unreadable one stops startup. */
export const readSettings = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = yield* settingsPath(directory);
    if (!(yield* fs.exists(file))) return Option.none<typeof DesktopSettings.Type>();
    return Option.some(
      yield* fs
        .readFileString(file)
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(DesktopSettings)))),
    );
  }).pipe(Effect.mapError(() => new SettingsFailed({ reason: "invalid" })));

const writeSettings = (directory: string, settings: typeof DesktopSettings.Type) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = yield* settingsPath(directory);
    const staged = `${file}.${process.pid}.tmp`;
    const contents = yield* Schema.encodeEffect(Schema.fromJsonString(DesktopSettings))(settings);
    yield* fs.writeFileString(staged, `${contents}\n`, { mode: 0o600 });
    yield* fs.rename(staged, file);
  }).pipe(Effect.mapError(() => new SettingsFailed({ reason: "write" })));

/** Probe the loopback address the backend binds. A later bind can still race another process. */
const portAvailable = (port: number) =>
  Effect.callback<boolean>((resume) => {
    const server = createServer();
    server.once("error", () => resume(Effect.succeed(false)));
    server.listen(port, "127.0.0.1", () => server.close(() => resume(Effect.succeed(true))));
  });

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ??
      character,
  );

const action = "executor-settings:";

const portPage = (options: {
  readonly current: number | undefined;
  readonly source: PortSource;
  readonly value: string;
  readonly error: string | undefined;
}) => {
  const locked = options.source.kind === "environment";
  const note = locked
    ? `EXECUTOR_PORT sets the port for this launch. Unset it to choose a port here.`
    : options.current === undefined
      ? `The local server is not running. Executor restarts to apply a new port.`
      : `MCP clients and scripts use http://127.0.0.1:${options.current}. Update them after a change. Executor restarts to apply it.`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action ${action}">
<title>Server port</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; font-size: 13px; }
  body { margin: 0; padding: 20px 24px; background: Canvas; color: CanvasText; }
  h1 { font-size: 15px; font-weight: 600; margin: 0 0 14px; }
  label { display: block; font-weight: 500; margin-bottom: 6px; }
  input { font: inherit; width: 120px; padding: 5px 8px; border-radius: 6px; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); background: Field; color: FieldText; }
  p { margin: 10px 0 0; line-height: 1.45; opacity: 0.7; }
  p.error { opacity: 1; color: #d93b3b; }
  .actions { display: flex; flex-direction: row-reverse; justify-content: flex-start; gap: 8px; margin-top: 20px; }
  button { font: inherit; padding: 5px 14px; border-radius: 6px; }
</style>
<form action="${action}port" method="get">
  <h1>Local server port</h1>
  <label for="port">Port</label>
  <input id="port" name="port" type="number" min="1024" max="65535" required${locked ? " disabled" : " autofocus"} value="${escape(options.value)}">
  ${options.error === undefined ? "" : `<p class="error" role="alert">${escape(options.error)}</p>`}
  <p>${escape(note)}</p>
  <div class="actions">
    ${locked ? "" : `<button type="submit">Save and restart</button>`}
    <button type="submit" formaction="${action}cancel" formnovalidate>${locked ? "Close" : "Cancel"}</button>
  </div>
</form>
</html>`)}`;
};

/**
 * Make the "Server port…" action. `current` is the port the running backend bound, if one is
 * running. Saving writes `desktop.json` and asks the caller to restart, because the listener cannot
 * move in place.
 */
export const makePortAction = (options: {
  readonly directory: string;
  readonly current: () => number | undefined;
  readonly source: PortSource;
  readonly parent: () => BrowserWindow | undefined;
  readonly restart: () => void;
}) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
      Effect.runPromise(Effect.provide(effect, services));
    let open: BrowserWindow | undefined;
    const show = Effect.sync(() => {
      if (open !== undefined && !open.isDestroyed()) return open.focus();
      const parent = options.parent();
      const current = new BrowserWindow({
        width: 420,
        height: 300,
        useContentSize: true,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        title: "Server port",
        show: false,
        ...(parent === undefined || parent.isDestroyed() ? {} : { parent, modal: true }),
        webPreferences: {
          session: session.fromPartition("executor-desktop-settings"),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
        },
      });
      open = current;
      current.once("closed", () => {
        if (open === current) open = undefined;
      });
      current.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      current.webContents.on("will-attach-webview", (event) => event.preventDefault());
      current.once("ready-to-show", () => current.show());
      // Read once per opened form, so a backend restart while it is open cannot change the page.
      const running = options.current();
      const load = (value: string, error: string | undefined) => {
        void current
          .loadURL(portPage({ current: running, source: options.source, value, error }))
          .catch(() => current.destroy());
      };
      const submit = (value: string) =>
        Effect.gen(function* () {
          const port = Schema.decodeUnknownOption(Schema.fromJsonString(DesktopPort))(value);
          if (Option.isNone(port)) return load(value, "Choose a whole number from 1024 to 65535.");
          if (port.value === running) return current.destroy();
          if (!(yield* portAvailable(port.value)))
            return load(
              value,
              `Port ${port.value} is in use by another program. Choose another port.`,
            );
          const saved = yield* writeSettings(options.directory, {
            version: 1,
            port: port.value,
          }).pipe(
            Effect.as(true),
            Effect.catch(() => Effect.succeed(false)),
          );
          if (!saved)
            return load(
              value,
              "Executor could not save this setting. Check the data directory permissions.",
            );
          current.destroy();
          options.restart();
        });
      current.webContents.on("will-navigate", (event, url) => {
        event.preventDefault();
        if (options.source.kind === "environment" || !url.startsWith(action)) {
          current.destroy();
          return;
        }
        const target = new URL(url);
        if (target.pathname === "port") void run(submit(target.searchParams.get("port") ?? ""));
        else current.destroy();
      });
      load(
        String(running ?? (options.source.kind === "setting" ? options.source.port : "")),
        undefined,
      );
    });
    return show;
  });
