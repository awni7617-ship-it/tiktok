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
