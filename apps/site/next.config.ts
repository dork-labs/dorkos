import { createMDX } from 'fumadocs-mdx/next';
import type { NextConfig } from 'next';

const withMDX = createMDX();

const nextConfig: NextConfig = {
  // Transpile Base UI packages for better Turbopack compatibility
  transpilePackages: ['@base-ui/react', '@base-ui/utils'],

  // Docs pages that moved in the 2026-07 docs reorganization
  async redirects() {
    return [
      {
        source: '/docs/guides/tunnel-setup',
        destination: '/docs/self-hosting/tunnel-setup',
        permanent: true,
      },
      {
        source: '/docs/guides/building-relay-adapters',
        destination: '/docs/integrations/building-relay-adapters',
        permanent: true,
      },
      {
        source: '/docs/concepts/transport',
        destination: '/docs/integrations/building-integrations',
        permanent: true,
      },
    ];
  },

  // PostHog reverse proxy - routes analytics through our domain to avoid ad blockers
  async rewrites() {
    return [
      {
        source: '/ingest/static/:path*',
        destination: 'https://us-assets.i.posthog.com/static/:path*',
      },
      {
        source: '/ingest/:path*',
        destination: 'https://us.i.posthog.com/:path*',
      },
    ];
  },
  // Required to support PostHog trailing slash API requests
  skipTrailingSlashRedirect: true,
};

export default withMDX(nextConfig);
