import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@nervus/capability-library": fileURLToPath(
        new URL("./packages/capability-library/src/index.ts", import.meta.url),
      ),
      "@nervus/host": fileURLToPath(
        new URL("./packages/host/src/index.ts", import.meta.url),
      ),
      "@nervus/profile": fileURLToPath(
        new URL("./packages/profile/src/index.ts", import.meta.url),
      ),
      "nervus/core": fileURLToPath(new URL("./src/core.ts", import.meta.url)),
      nervus: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
    },
    conditions: ["source"],
  },
  test: {
    coverage: {
      provider: "v8",
      thresholds: {
        statements: 80,
        branches: 65,
        functions: 85,
        lines: 80,
      },
    },
    include: ["tests/**/*.test.ts"],
  },
});
