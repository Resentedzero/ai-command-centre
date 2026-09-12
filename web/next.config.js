/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pins Next/Turbopack's workspace root to `web/` itself. Without this,
  // Next auto-detects a workspace root by walking up for the nearest
  // lockfile and finds the BACKEND's root `package-lock.json` first (this
  // repo has two lockfiles: one here, one at the repo root for the Fastify
  // API) — that would make Next treat the whole backend repo as part of
  // this app's build scope, which is exactly the UI/API boundary this unit
  // must not cross (see web/lib/api.ts's header).
  turbopack: {
    root: __dirname,
  },
};

module.exports = nextConfig;
