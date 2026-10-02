/** Run the shipped collector as a separate process; query only its public HTTP API. */
import { Deferred, Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

/** workerd's control message once the collector socket accepts connections. */
const Listening = Schema.Struct({
  event: Schema.Literal("listen"),
  socket: Schema.Literal("motel"),
  port: Schema.Number,
});

/** Each managed Cloud target owns an isolated on-disk collector and its lifetime. */
export const startOtlpCollector = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const diagnostics = path.join(directory, "data/diagnostics");
    const data = path.join(diagnostics, "motel");
    yield* fs.makeDirectory(data, { recursive: true });
    const built = yield* processes.exitCode(
      ChildProcess.make("bun", ["run", "telemetry:build"], {
        stdout: "inherit",
        stderr: "inherit",
      }),
    );
    if (built !== 0) return yield* Effect.die("Could not build the shipped telemetry collector");
    const bundle = path.resolve("packages/telemetry/dist/motel");
    // The bundle's config names its directories and socket; this supplies their paths and a free port.
    const child = yield* processes.spawn(
      ChildProcess.make(
        path.resolve("node_modules/.bin", process.platform === "win32" ? "workerd.exe" : "workerd"),
        [
          "serve",
          "--control-fd=3",
          `--directory-path=motel-data=${data}`,
          `--directory-path=motel-assets=${path.join(bundle, "web/dist")}`,
          "--socket-addr=motel=127.0.0.1:0",
          path.join(bundle, "motel.capnp"),
        ],
        {
          cwd: data,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          additionalFds: { fd3: { type: "output" } },
          forceKillAfter: "3 seconds",
        },
      ),
    );
    yield* Effect.forEach(
      [child.stdout, child.stderr],
      (output) =>
        output.pipe(
          Stream.decodeText,
          Stream.runForEach((text) =>
            fs.writeFileString(path.join(directory, "collector.log"), text, {
              flag: "a",
              mode: 0o600,
            }),
          ),
          Effect.forkScoped,
        ),
      { discard: true },
    );
    const ready = yield* Deferred.make<string>();
    yield* child.getOutputFd(3).pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.runForEach((line) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Listening))(line).pipe(
          Effect.flatMap(({ port }) => Deferred.succeed(ready, `http://127.0.0.1:${port}`)),
          Effect.ignore,
        ),
      ),
      Effect.forkScoped,
    );
    const url = yield* Deferred.await(ready).pipe(Effect.timeout("20 seconds"));
    yield* fs.writeFileString(
      path.join(diagnostics, "collector.json"),
      JSON.stringify({ state: "running", url }),
      { mode: 0o600 },
    );
    return url;
  });
