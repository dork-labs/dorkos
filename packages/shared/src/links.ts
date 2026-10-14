/**
 * Where DorkOS lives on the web, in one place.
 *
 * Code that links to the site, the docs, the GitHub repositories or the npm
 * package builds the URL from here rather than typing it, so a move is one
 * edit. Files that cannot import TypeScript (package.json metadata, shell
 * scripts, YAML, Markdown) hold the literal text; the published package.json
 * fields are pinned by `packages/shared/src/__tests__/company.test.ts`.
 *
 * Company facts (legal name, address, email addresses) live beside this
 * module in `@dorkos/shared/company`.
 *
 * @module shared/links
 */

/** The GitHub organization that owns the DorkOS repositories. */
const GITHUB_ORG = 'dork-labs';

/** Brand URLs and repository names. */
export const links = {
  /** The public origin of the marketing site, the docs and DorkOS Cloud. */
  site: 'https://dorkos.ai',
  /** The root of the published docs. */
  docs: 'https://dorkos.ai/docs',
  /** The GitHub organization page. */
  githubOrg: `https://github.com/${GITHUB_ORG}`,
  /** The DorkOS app repository, as `owner/repo`. */
  repoSlug: `${GITHUB_ORG}/dorkos`,
  /** The DorkOS app repository on GitHub. */
  repo: `https://github.com/${GITHUB_ORG}/dorkos`,
  /** The Dork Labs marketplace registry repository, as `owner/repo`. */
  marketplaceRepoSlug: `${GITHUB_ORG}/marketplace`,
  /** The Dork Labs marketplace registry repository on GitHub. */
  marketplaceRepo: `https://github.com/${GITHUB_ORG}/marketplace`,
  /** The `dorkos` CLI package on npm. */
  npmPackage: 'https://www.npmjs.com/package/dorkos',
} as const;

/** The shape of {@link links}. */
export type Links = typeof links;

/** Join a base URL and a path, adding the `/` between them when it is missing. */
function join(base: string, path: string): string {
  if (path === '' || /^[/?#]/.test(path)) return `${base}${path}`;
  return `${base}/${path}`;
}

/**
 * A URL on the DorkOS site: `siteUrl('/telemetry')` is
 * `https://dorkos.ai/telemetry`.
 *
 * @param path - The path, query or fragment to append; empty for the origin.
 */
export function siteUrl(path = ''): string {
  return join(links.site, path);
}

/**
 * A URL in the DorkOS docs: `docsUrl('/guides/cli-usage')` is
 * `https://dorkos.ai/docs/guides/cli-usage`.
 *
 * @param path - The path under `/docs`; empty for the docs home.
 */
export function docsUrl(path = ''): string {
  return join(links.docs, path);
}

/**
 * A URL in the DorkOS GitHub repository: `repoUrl('/issues')` is
 * `https://github.com/dork-labs/dorkos/issues`.
 *
 * @param path - The path under the repository; empty for its home page.
 */
export function repoUrl(path = ''): string {
  return join(links.repo, path);
}
