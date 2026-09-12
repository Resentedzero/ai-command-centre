// Extends Vitest's `expect` with jest-dom's DOM matchers (toBeInTheDocument,
// toHaveTextContent, etc.) for every test file, via vitest.config.ts's
// `setupFiles`.
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// @testing-library/react's own auto-cleanup only registers itself against a
// GLOBAL `afterEach` (it feature-detects the global, framework-provided
// one). This project's vitest.config.ts sets `globals: false` to match the
// backend's own Vitest convention (explicit imports, no implicit test
// globals), so that auto-detection never fires and unmounted trees from a
// previous test would otherwise silently accumulate in `document.body`
// across tests in the same file. Registered explicitly here instead.
afterEach(() => {
  cleanup();
});
