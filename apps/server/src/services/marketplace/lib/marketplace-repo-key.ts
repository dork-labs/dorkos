/**
 * One comparable key for "which repository is this marketplace", folded from the
 * two spellings DorkOS and Claude Code each use for it.
 *
 * The two sides spell the same fact differently. Claude Code stores
 * `{ source: "github", repo: "anthropics/claude-plugins-official" }` in its
 * `extraKnownMarketplaces`; DorkOS stores the full URL
 * `https://github.com/anthropics/claude-plugins-official` in `marketplaces.json`
 * (`marketplace-source-manager.ts`). A direct `===` between those two strings is
 * false for every entry there has ever been, which is why this is a module and
 * not two lines at a call site.
 *
 * Matching on the REPOSITORY rather than on the marketplace's local name is the
 * whole point: on the machine this was measured on, Claude Code's `dorkos` and
 * DorkOS's `dorkos-community` are the same repository under two local names, so
 * a name match misses it — and a name match against a marketplace somebody
 * happened to call `dorkos-community` would be a false positive.
 *
 * Two rules keep the key from manufacturing a match:
 *
 * - **Case is preserved on the path.** GitHub compares owner and repository
 *   names case-insensitively today, but the key is a slug on a case-sensitive
 *   host in general, and lower-casing it would make `Acme/tool` and `acme/tool`
 *   one repository on the say-so of this function.
 * - **Only a GitHub address folds.** The Claude Code side is `source === 'github'`
 *   by construction, so a key from any other host could only ever be compared
 *   against a GitHub one — and `gitlab.com/acme/tool` answering `acme/tool`
 *   would offer somebody an install of a different package with the same name.
 *   Everything else answers `null` rather than guessing: a `git` or `file`
 *   source has no `owner/name` to fold, and pretending it does is how a false
 *   match is made.
 *
 * Pure: no filesystem, no network, no configuration. It lives beside
 * `locate-install.ts` because the marketplace domain owns what a source is, and
 * the harness domain should not learn to parse one.
 *
 * @module services/marketplace/lib/marketplace-repo-key
 */

/** Either spelling of where a marketplace came from. */
export type MarketplaceRepoInput =
  /** A DorkOS configured source's address, as `marketplaces.json` stores it. */
  | { kind: 'url'; url: string }
  /** Claude Code's `extraKnownMarketplaces[<name>].source` object. */
  | { kind: 'claude-source'; source: string; repo?: string | undefined };

/** The one host whose addresses fold, matching Claude Code's own `source: "github"`. */
const GITHUB_HOST = 'github.com';

/**
 * Fold a `owner/name` slug: drop a leading slash, a trailing slash, and a
 * trailing `.git`, then require exactly two non-empty segments.
 *
 * @param slug - the path half of an address, or a Claude Code `repo` string.
 * @returns `owner/name` with its case intact, or `null` when it is not that shape.
 */
function foldSlug(slug: string): string | null {
  const trimmed = slug
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  const segments = trimmed.split('/');
  if (segments.length !== 2) return null;
  const [owner, name] = segments;
  if (!owner || !name) return null;
  return `${owner}/${name}`;
}

/**
 * Fold either spelling of a marketplace's origin into one comparable
 * `owner/name` key.
 *
 * @param input - a DorkOS source URL, or Claude Code's `source` object.
 * @returns `owner/name`, case preserved, or `null` when the input names no
 *   GitHub repository this can compare — which is an answer, not a failure.
 */
export function marketplaceRepoKey(input: MarketplaceRepoInput): string | null {
  if (input.kind === 'claude-source') {
    if (input.source !== 'github' || input.repo === undefined) return null;
    return foldSlug(input.repo);
  }

  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  // `URL` already lower-cases the host; `www.` is stripped so the two spellings
  // of the same GitHub address fold together.
  if (parsed.hostname.replace(/^www\./, '') !== GITHUB_HOST) return null;
  return foldSlug(parsed.pathname);
}
