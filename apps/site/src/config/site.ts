/**
 * Site-wide configuration for the DorkOS marketing site.
 *
 * Centralizes branding, URLs, and metadata so changes propagate
 * to layout metadata, JSON-LD, sitemap, robots, and OG images.
 */
export const siteConfig = {
  name: 'DorkOS',
  description:
    'Mission control for every coding agent you run — Claude Code, Codex, and OpenCode in one cockpit. Open source, self-hosted.',
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
