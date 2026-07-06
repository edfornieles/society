/** @type {import('next').NextConfig} */

// Deployment path prefix. Empty for local dev; set NEXT_PUBLIC_BASE_PATH=/society
// in production where the app is served under edfornieles.com/society.
const basePath = (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(/\/+$/, "");

const nextConfig = {
  ...(basePath ? { basePath } : {}),
  // Disable dev-only double-invocation of effects/renders. This app drives an
  // audio/mic state machine and a session lifecycle through refs + effects;
  // StrictMode's intentional double-mount in dev races those (e.g. "New Game"
  // occasionally not activating on the first click). Production never
  // double-invokes, so turning it off just makes dev match prod behaviour.
  reactStrictMode: false,
  env: {
    // Build stamp, baked into BOTH the client bundle and the server at build
    // time. A long-lived tab keeps running old JS through many deploys — the
    // client compares its baked value against /api/version (the server's) and
    // warns the player to reload. This mismatch caused repeated "still not
    // fixed" reports from tabs running hours-old code.
    NEXT_PUBLIC_BUILD_AT: new Date().toISOString(),
  },
};

export default nextConfig;
