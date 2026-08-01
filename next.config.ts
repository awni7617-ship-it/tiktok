import type { NextConfig } from 'next';

/** Security headers applied to every response. */
const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  /**
   * `standalone` emits a self-contained server with its own trimmed
   * `node_modules`, runnable as plain `node server.js`. That is what the
   * desktop app ships and launches.
   *
   * Opt-in rather than always on, because the standalone trace is slower to
   * build and `npm run dev` has no use for it.
   */
  output: process.env.BUILD_STANDALONE === '1' ? 'standalone' : undefined,

  /**
   * ffmpeg-static and ffprobe-static resolve a path to a native binary inside
   * their own package. Bundling them rewrites that path to something that does
   * not exist at runtime, so they stay external.
   */
  serverExternalPackages: ['ffmpeg-static', 'ffprobe-static'],

  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
