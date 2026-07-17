import type { MetadataRoute } from 'next';
import { siteConfig } from '@/config/site';

/** Paths no crawler needs — API surface, Next internals, test routes. */
const STANDARD_DISALLOW = ['/api/', '/_next/', '/test/'];

/**
 * AI crawler tokens we explicitly welcome. Anthropic and OpenAI each document
 * their tokens as independent (a rule for `ClaudeBot` does not cover
 * `Claude-User`), so we name every one rather than relying on the `*`
 * fallthrough — an explicit allow is a clearer, more durable signal.
 *
 * - OpenAI: `GPTBot` (training/index), `OAI-SearchBot` (ChatGPT Search index),
 *   `ChatGPT-User` (live user-triggered fetch).
 * - Anthropic: `ClaudeBot` (index), `Claude-SearchBot` (search index),
 *   `Claude-User` (live user-triggered fetch), `claude-code` (Claude Code CLI).
 * - Perplexity: `PerplexityBot`.
 * - Meta: `meta-externalagent`. We allow it deliberately — our content is
 *   open-source docs with nothing to protect, and we want the reach; the
 *   trade-off is training use, which we accept.
 */
const ALLOWED_AI_AGENTS = [
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-SearchBot',
  'Claude-User',
  'claude-code',
  'PerplexityBot',
  'meta-externalagent',
];

/** Aggressive scrapers we block outright (no citation upside, heavy load). */
const BLOCKED_SCRAPERS = ['CCBot', 'Bytespider'];

/**
 * robots.txt for the DorkOS marketing site: allow everything by default, name
 * each beneficial AI crawler explicitly, and block the aggressive scrapers.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      // Default: allow all crawlers
      { userAgent: '*', allow: '/', disallow: STANDARD_DISALLOW },
      // Beneficial AI crawlers, named explicitly (each token is independent)
      ...ALLOWED_AI_AGENTS.map((userAgent) => ({
        userAgent,
        allow: '/',
        disallow: STANDARD_DISALLOW,
      })),
      // Aggressive scrapers
      ...BLOCKED_SCRAPERS.map((userAgent) => ({ userAgent, disallow: '/' })),
    ],
    sitemap: `${siteConfig.url}/sitemap.xml`,
  };
}
