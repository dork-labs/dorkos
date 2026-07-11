/**
 * Site-wide configuration for the DorkOS marketing site.
 *
 * Centralizes branding, URLs, and metadata so changes propagate
 * to layout metadata, JSON-LD, sitemap, robots, and OG images.
 */
export const siteConfig = {
  name: 'DorkOS',
  description:
    'Mission control for every coding agent you run: Claude Code, Codex, and OpenCode in one cockpit. Open source, self-hosted.',
  url: 'https://dorkos.ai',
  contactEmail: 'hey@dorkos.ai',
  github: 'https://github.com/dork-labs/dorkos',
  npm: 'https://www.npmjs.com/package/dorkos',
  /**
   * Disable the cookie consent banner across the entire site.
   * Set to `true` to hide the banner completely.
   */
  disableCookieBanner: true,
} as const;

export type SiteConfig = typeof siteConfig;

/**
 * `siteConfig.github` with `utm_source`/`utm_medium` link hygiene tags, for
 * every outbound-to-GitHub anchor on the site (header, footer, mobile hero
 * CTA). Attributes GitHub referral traffic back to dorkos.ai without touching
 * the plain canonical URL used elsewhere (JSON-LD `sameAs`, `llms.txt`).
 */
export const GITHUB_OUTBOUND_HREF = `${siteConfig.github}?utm_source=dorkos_site&utm_medium=website`;
