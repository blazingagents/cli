import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/test/**", "src/bin/**"],
      provider: "v8",
      reporter: ["text", "json-summary"],
      thresholds: {
        branches: 99,
        functions: 99,
        lines: 99,
        statements: 99,
      },
    },
    exclude: [...configDefaults.exclude, "dist/**", "tests/**"],
  },
});
