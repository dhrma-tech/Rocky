import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
          exclude: ["packages/core/test/spikes/**", "packages/core/test/security/**"],
        },
      },
      {
        test: {
          name: "security",
          include: ["packages/core/test/security/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "spikes",
          include: ["packages/core/test/spikes/**/*.test.ts"],
          testTimeout: 180_000,
        },
      },
    ],
  },
});
