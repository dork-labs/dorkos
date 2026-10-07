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
   * The lead line, as it reads in titles and card alt text, so it is a noun
   * phrase that survives being lowercased after "DorkOS: ". The 2026-10-06
   * positioning leads with mini apps (the hero says "Ask for a tool. Your
   * agents build it."); a chat workspace with agents in it is table stakes,
   * so it describes what DorkOS is further down and never leads a title.
   */
  category: 'The workspace where agents build your tools',
  /**
   * The site-wide description: the three differentiators in order (mini
   * apps, built for founders, ownership). Feeds the root metadata, the web
   * manifest, JSON-LD and the top of llms.txt.
   */
  description:
    'Ask for a tool, and your agents build it inside DorkOS. Made for founders. Your computer, your files, your AI plan. Free and open source.',
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
