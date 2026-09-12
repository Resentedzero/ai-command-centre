import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["tests/**/*.test.ts"],
    // Schema reset + migrations run once per file in beforeAll; each test then
    // runs inside a rolled-back transaction. Keep this single-threaded:
    // every file's beforeAll drops and recreates the shared test database's
    // public schema, so running files concurrently would have one file's
    // reset destroy tables another file is actively using mid-test.
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
