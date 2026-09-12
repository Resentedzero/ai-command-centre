import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Matches the backend's own Vitest convention (../vitest.config.ts) for
// consistency: globals: false (explicit `import { describe, it, expect } from
// "vitest"` in every test file), no hidden global test API. `environment:
// "jsdom"` and `setupFiles` are the two additions a component-testing setup
// needs on top of that shared convention.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: false,
    include: ["tests/**/*.test.tsx", "tests/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
  },
});
