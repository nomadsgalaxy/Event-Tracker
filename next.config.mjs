/** @type {import('next').NextConfig} */

// A per-build stamp. Set BUILD_ID in CI/Docker (e.g. the git SHA) for a stable, meaningful id; otherwise
// fall back to the build timestamp so every build is still unique. Inlined into the client AND server
// bundles via `env`, and served live at /api/version — the client (components/shell/version-watcher)
// compares the two and reloads an open tab onto a freshly deployed build. No service worker, no offline.
const BUILD_ID = process.env.BUILD_ID || String(Date.now());

const nextConfig = {
  reactStrictMode: true,
  // Standalone server output → a small, self-contained runtime image (node .next/standalone/server.js),
  // no full node_modules in the container. Only affects `next build` (not `next dev`).
  output: 'standalone',
  // The mongodb driver is server-only; keep it out of any client bundle.
  serverExternalPackages: ['mongodb'],
  // NEXT_PUBLIC_DEMO_MODE mirrors the server EIT_DEMO_MODE so client islands can render admin/config
  // controls as visible-but-disabled + show the demo banner (the server enforces the lock either way).
  env: { NEXT_PUBLIC_BUILD_ID: BUILD_ID, NEXT_PUBLIC_DEMO_MODE: process.env.EIT_DEMO_MODE === '1' ? '1' : '' },
};

export default nextConfig;
