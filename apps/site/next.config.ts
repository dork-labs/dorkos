import { createMDX } from 'fumadocs-mdx/next';
import type { NextConfig } from 'next';
import { deriveAssetHost } from './src/lib/posthog-host';

const withMDX = createMDX();

// Region-selectable via NEXT_PUBLIC_POSTHOG_HOST (see src/env.ts); matches the
// default there so an unset env var proxies to the same place in dev and prod.
const posthogIngestHost = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com';

const nextConfig: NextConfig = {
  // Transpile Base UI packages for better Turbopack compatibility
  transpilePackages: ['@base-ui/react', '@base-ui/utils'],

  // PostHog reverse proxy - routes analytics through our domain to avoid ad blockers
  async rewrites() {
    return [
      {
        source: '/ingest/static/:path*',
        destination: `${deriveAssetHost(posthogIngestHost)}/static/:path*`,
      },
      {
        source: '/ingest/:path*',
        destination: `${posthogIngestHost}/:path*`,
      },
    ];
  },
  // Required to support PostHog trailing slash API requests
  skipTrailingSlashRedirect: true,
};

export default withMDX(nextConfig);
