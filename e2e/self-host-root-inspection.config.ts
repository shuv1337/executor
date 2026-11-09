import { defineConfig } from "vitest/config";

/** The offline self-host root gate, run as a separate process over synthetic PGlite archives. */
export default defineConfig({
  test: { include: ["e2e/tests/self-host-root-inspection.spec.ts"], testTimeout: 60_000 },
});
