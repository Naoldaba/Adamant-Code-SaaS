import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // DB-gated integration suites share a single test database (DATABASE_URL_TEST).
    // Run test files sequentially so their writes never interleave (e.g. a global
    // document-count delta cannot be perturbed by another suite inserting at the
    // same time). Hermetic unit tests are tiny, so the cost is negligible.
    fileParallelism: false
  }
});
