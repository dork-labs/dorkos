import { createMDX } from 'fumadocs-mdx/next';
import type { NextConfig } from 'next';
import { deriveAssetHost } from './src/lib/posthog-host';

const withMDX = createMDX();

// Region-selectable via NEXT_PUBLIC_POSTHOG_HOST (see src/env.ts); matches the
// default there so an unset env var proxies to the same place in dev and prod.
const posthogIngestHost = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com';

const nextConfig: NextConfig = {
  // Emit browser source maps for the production build so the post-build script
  // (scripts/upload-sourcemaps.mjs) can inject PostHog chunk ids and upload the
  // maps to PostHog error tracking, then delete them from the output so they
  // never ship publicly. Next 16 + Turbopack does NOT emit these unless this is
  // set (verified empirically), and without them PostHog cannot resolve minified
  // browser stack traces back to the original TS/TSX.
  productionBrowserSourceMaps: true,
  // Transpile Base UI packages for better Turbopack compatibility
  transpilePackages: ['@base-ui/react', '@base-ui/utils'],

  // Docs pages that moved in the 2026-07 docs reorganization
  async redirects() {
    return [
      // /download is a guessable URL people type; the real routes are
      // /download/mac and /download/windows. Send it to the install page.
      {
        source: '/download',
        destination: '/install',
        permanent: false,
      },
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

  // PostHog reverse proxy - routes analytics through our domain to avoid ad
  // blockers. The path is `/hub`, not PostHog's `/ingest` default, because
  // `/ingest` matches common blocklist patterns; the neutral name slips past
  // more blockers. Must match `api_host` in instrumentation-client.ts.
  async rewrites() {
    return [
      {
        source: '/hub/static/:path*',
        destination: `${deriveAssetHost(posthogIngestHost)}/static/:path*`,
      },
      {
        source: '/hub/:path*',
        destination: `${posthogIngestHost}/:path*`,
      },
      // Raw-markdown docs route (DOR-165). A route handler co-located with
      // the docs page at docs/[[...slug]].mdx/route.ts fails to statically
      // export ("Cannot destructure property 'slug'" — Next.js cannot
      // resolve generateStaticParams for a segment whose folder name mixes
      // the [[...slug]] catch-all syntax with a literal .mdx suffix). The
      // fumadocs-blessed fallback is a plain, unambiguous [[...slug]]
      // segment under its own route, rewritten here so /docs/<slug>.mdx
      // still serves it — see
      // https://fumadocs.dev/docs/integrations/llms#md-extension.
      {
        source: '/docs.mdx',
        destination: '/llms.mdx/docs',
      },
      {
        source: '/docs/:path*.mdx',
        destination: '/llms.mdx/docs/:path*',
      },
    ];
  },
  // Required to support PostHog trailing slash API requests
  skipTrailingSlashRedirect: true,
};

export default withMDX(nextConfig);
