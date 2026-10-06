import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/api/test/**/*.test.ts"],
    testTimeout: 120_000,
    coverage: {
      provider: "v8",
      include: ["packages/domain/src/**", "packages/motion/src/**"],
      exclude: [],
      thresholds: { lines: 85, statements: 85, functions: 85, branches: 75 },
    },
  },
});
