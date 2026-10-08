import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["e2e/tests/self-host-native-auth.spec.ts"],
    testTimeout: 60_000,
  },
});
