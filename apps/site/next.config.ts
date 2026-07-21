import path from 'node:path';
import { createMDX } from 'fumadocs-mdx/next';
import type { NextConfig } from 'next';
import { deriveAssetHost } from './src/lib/posthog-host';

const withMDX = createMDX();

// Pin the workspace root so Turbopack resolves the app directory from this
// package, not from an inferred ancestor. Next infers the root by walking up to
// the nearest lockfile; when this checkout is a git worktree nested under
// another repo that also has a lockfile (`.claude/worktrees/*`, the isolated
// path every agent uses), it guesses the OUTER repo and fails to discover the
// `src/app` routes — every route, including `/`, then 404s to `_not-found`,
// which stalled the e2e site webServer's readiness gate (DOR-407). Two levels
// up from `apps/site` is the monorepo root in every checkout, worktree or not.
const workspaceRoot = path.join(import.meta.dirname, '..', '..');

// Next's built-in HTML_LIMITED_BOTS pattern (from
// next/dist/shared/lib/router/utils/html-bots.js). Setting `htmlLimitedBots`
// REPLACES this default rather than extending it, so we reproduce it here and
// union our AI crawlers onto it, keeping the existing blocking-render behavior
// for the classic unfurl bots (Slack, Discord, Twitter, etc.).
const NEXT_DEFAULT_HTML_LIMITED_BOTS =
  '[\\w-]+-Google|Google-[\\w-]+|Chrome-Lighthouse|Slurp|DuckDuckBot|baiduspider|yandex|sogou|bitlybot|tumblr|vkShare|quora link preview|redditbot|ia_archiver|Bingbot|BingPreview|applebot|facebookexternalhit|facebookcatalog|Twitterbot|LinkedInBot|Slackbot|Discordbot|WhatsApp|SkypeUriPreview|Yeti|googleweblight';

// AI crawlers that fetch pages without executing JS. Forcing fully-blocking
// (non-streamed) metadata for them removes a whole class of streamed-metadata
// bugs where structured data or head tags could arrive after the bot stops
// reading. Our JSON-LD is verified present in the streamed HTML today; this is
// belt-and-suspenders so a future streaming change cannot silently regress it.
const AI_CRAWLER_BOTS =
  'GPTBot|ClaudeBot|Claude-SearchBot|Claude-User|PerplexityBot|OAI-SearchBot|ChatGPT-User|Meta-ExternalAgent|claude-code';

const htmlLimitedBots = new RegExp(`${NEXT_DEFAULT_HTML_LIMITED_BOTS}|${AI_CRAWLER_BOTS}`, 'i');

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
  // See the constants above: force blocking (non-streamed) metadata for classic
  // unfurl bots plus AI crawlers so structured data is always in the initial HTML.
  htmlLimitedBots,
  // Transpile Base UI packages for better Turbopack compatibility
  transpilePackages: ['@base-ui/react', '@base-ui/utils'],

  // See workspaceRoot above — pins Turbopack's root so nested-worktree checkouts
  // resolve routes correctly instead of 404ing every page.
  turbopack: {
    root: workspaceRoot,
  },

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
      // Industry-standard `.md` suffix alias (Cloudflare/Mintlify convention).
      // Agents trained on those hosts guess `.md`; our original `.mdx` stays
      // for back-compat. Both hit the same raw-markdown route.
      {
        source: '/docs.md',
        destination: '/llms.mdx/docs',
      },
      {
        source: '/docs/:path*.md',
        destination: '/llms.mdx/docs/:path*',
      },
    ];
  },
  // Required to support PostHog trailing slash API requests
  skipTrailingSlashRedirect: true,
};

export default withMDX(nextConfig);
