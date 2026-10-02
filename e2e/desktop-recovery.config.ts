import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["e2e/tests/desktop-recovery.spec.ts"],
    testTimeout: 180_000,
    // Each scenario owns a desktop window; keep them from competing for focus and CPU.
    fileParallelism: false,
  },
});
