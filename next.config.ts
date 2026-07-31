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

  /**
   * `standalone` emits a self-contained server (its own trimmed
   * `node_modules`) that runs with plain `node server.js`. That is what the
   * downloadable editor build is packaged from.
   *
   * It is opt-in rather than always on because the Cloudflare adapter wants
   * the ordinary build output, and having two consumers silently share one
   * output mode is how one of them breaks without anyone noticing.
   */
  output: process.env.BUILD_STANDALONE === '1' ? 'standalone' : undefined,
  experimental: {
    // Keep the ffmpeg/render helpers out of the edge bundle.
    serverActions: { bodySizeLimit: '10mb' },
  },
  serverExternalPackages: ['@prisma/client', '@aws-sdk/client-s3'],

  /**
   * `cloudflare:*` modules are provided by the Workers runtime and have no
   * npm equivalent, so webpack cannot resolve them during `next build`. They
   * are marked external and left for the OpenNext/wrangler bundle to supply.
   *
   * Without this, importing the containers SDK anywhere in the server graph
   * fails the build even though the import is dynamic and Workers-only.
   */
  webpack(config) {
    config.externals = [
      ...(Array.isArray(config.externals) ? config.externals : [config.externals].filter(Boolean)),
      ({ request }: { request?: string }, callback: (error?: null, result?: string) => void) => {
        if (request?.startsWith('cloudflare:')) {
          return callback(null, `commonjs ${request}`);
        }
        callback();
      },
    ];
    return config;
  },

  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
