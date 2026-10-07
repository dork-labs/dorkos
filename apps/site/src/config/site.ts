import { company } from '@dorkos/shared/company';

/**
 * Site-wide configuration for the DorkOS marketing site.
 *
 * Centralizes branding, URLs, and metadata so changes propagate
 * to layout metadata, JSON-LD, sitemap, robots, and OG images.
 */
export const siteConfig = {
  name: 'DorkOS',
  /**
   * The headline of the 2026-10-07 message stack, as it reads in titles after
   * "DorkOS: " (so the page title is exactly "DorkOS: Build and run your
   * business with an agent team"). Card alt text lowercases it, so it must
   * survive that too. No trailing period: it sits inside a title.
   */
  category: 'Build and run your business with an agent team',
  /**
   * The site-wide description: the stack's supporting line, then the
   * audience and ownership. Mini apps are "the custom tools your company runs
   * on". Never "on your computer" or "open source" here: DorkOS Cloud runs on
   * a server too, so ownership is said as "yours". Feeds the root metadata,
   * the web manifest, JSON-LD and the top of llms.txt.
   */
  description:
    'Your agents join your team chat, take on real work, and build the custom tools your company runs on. Made for founders, and yours to keep.',
  url: 'https://dorkos.ai',
  /** The company's published contact address; owned by `@dorkos/shared/company`. */
  contactEmail: company.contactEmail,
  github: 'https://github.com/dork-labs/dorkos',
  npm: 'https://www.npmjs.com/package/dorkos',
  /**
   * Disable the cookie consent banner across the entire site.
   * Set to `true` to hide the banner completely.
   *
   * Keep this `false` while site analytics is live: the banner is the only
   * opt-in path, and PostHog is opted out by default
   * (`opt_out_capturing_by_default: true` in instrumentation-client.ts), so
   * hiding the banner silently turns all capture off. See src/lib/analytics.ts.
   * Only affects apps/site; the DorkOS app (server/client/desktop) collects no
   * analytics from this setting.
   */
  disableCookieBanner: false,
} as const;

export type SiteConfig = typeof siteConfig;

/**
 * `siteConfig.github` with `utm_source`/`utm_medium` link hygiene tags, for
 * every outbound-to-GitHub anchor on the site (header, footer, mobile hero
 * CTA). Attributes GitHub referral traffic back to dorkos.ai without touching
 * the plain canonical URL used elsewhere (JSON-LD `sameAs`, `llms.txt`).
 */
export const GITHUB_OUTBOUND_HREF = `${siteConfig.github}?utm_source=dorkos_site&utm_medium=website`;
