import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "test/live/**"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
        "src/domain/**": {
          branches: 100,
        },
        "src/app/services/apply-service.ts": {
          branches: 100,
        },
        "src/domain/redaction.ts": {
          branches: 100,
        },
        "src/github/allowed-operations.ts": {
          branches: 100,
        },
      },
    },
  },
});
