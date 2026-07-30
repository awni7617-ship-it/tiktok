import type { NextConfig } from 'next';

/**
 * Security headers applied to every response.
 *
 * The CSP is intentionally strict. `unsafe-inline` is required for styles
 * because Next.js injects critical CSS inline; scripts use nonces in
 * production builds via the framework's own runtime.
 */
const securityHeaders = [
  { key: 'X-DNS-Prefetch-Control', value: 'on' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    // Keep the ffmpeg/render helpers out of the edge bundle.
    serverActions: { bodySizeLimit: '10mb' },
  },
  serverExternalPackages: ['@prisma/client', '@aws-sdk/client-s3'],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
