/**
 * Which addresses a marketplace source may point at.
 *
 * A configured source is the one string in the marketplace that nobody
 * validated on the way in and everybody trusted on the way out: the installer
 * hands it straight to `git` when it sparse-clones a package out of a remote
 * marketplace. Package authors' URLs have been confined to safe transports at
 * parse time since the `marketplace.json` schema shipped; the addresses an
 * operator types into "Add Source" were not, so `ext::sh -c …` and a
 * leading-dash `--upload-pack=…` reached the same code path unchecked
 * (DOR-1710). This module asks the package's own question — `isSafeGitUrl` —
 * of that string too, so the two answers cannot drift apart.
 *
 * Defense in depth, not a patched hole: git's `GIT_ALLOW_PROTOCOL` backstop
 * and the operator-only gate on the add route both already stood in the way.
 * This closes the gap between them.
 *
 * A source is narrower than a package source in one direction and wider in the
 * other, and both differences are measured rather than assumed:
 *
 * - **Narrower.** A source's listing is fetched over HTTP, not git:
 *   `PackageFetcher.fetchMarketplaceJson` calls `fetch()` on
 *   `<source>/raw/main/.claude-plugin/marketplace.json`. `git://`, `ssh://`
 *   and scp-style `git@host:path` are all things `fetch()` cannot request, so
 *   a source in one of those forms saves fine and then never lists a single
 *   package. Accepting them would be accepting a dead entry, so `https://` is
 *   the only remote form allowed here.
 * - **Wider.** `file://` — a marketplace living in a folder on this machine,
 *   which is how the personal marketplace registers itself. It never reaches
 *   `git`: every consumer branches on `file://` first and reads the directory.
 *
 * @module services/marketplace/source-url-policy
 */
import { fileURLToPath } from 'node:url';
import { isSafeGitUrl } from '@dorkos/marketplace';

/**
 * What an operator is told when the address they typed is not one DorkOS can
 * fetch a marketplace from. Names the forms that do work, because a refusal
 * that does not is just a dead end — and names only the forms that genuinely
 * work, which is why `git@`/`ssh://` are absent (see the module comment).
 */
export const UNSUPPORTED_SOURCE_URL_MESSAGE =
  "That address isn't one DorkOS can fetch a marketplace from. Use an https:// address for a " +
  'git repository, or a file:// path to a folder on this machine.';

/**
 * Thrown when a marketplace source address is refused. Carries the operator-
 * facing sentence as its `message` so every surface — the REST route, the CLI,
 * the app — can show it verbatim without rewriting it.
 */
export class UnsupportedSourceUrlError extends Error {
  /**
   * Build the refusal.
   *
   * @param url - The address that was refused. Deliberately not interpolated
   *   into the message, which is what a person reads; the refusal sites log it
   *   instead, which is where the address is actually useful.
   */
  constructor(public readonly url: string) {
    super(UNSUPPORTED_SOURCE_URL_MESSAGE);
    this.name = 'UnsupportedSourceUrlError';
  }
}

/**
 * True when `url` is a `file://` address that names a real local path.
 *
 * Parsing is part of the question, not a detail of using the answer: a
 * `file://host/share` form and a path with an encoded separator (`%2F`) both
 * look like local marketplaces and both make `fileURLToPath` throw at first
 * use. Saving one and failing later is exactly the behaviour this module
 * exists to stop, so the conversion is attempted here, once, at the door.
 *
 * @param url - The candidate address.
 * @returns `true` when the address is a usable local marketplace path.
 */
function isLocalMarketplaceUrl(url: string): boolean {
  if (!url.startsWith('file://') || !URL.canParse(url)) {
    return false;
  }
  try {
    fileURLToPath(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when `url` is an address a marketplace source may be configured with:
 * an `https://` git repository, or a `file://` path to a local marketplace
 * directory.
 *
 * The remote arm runs {@link isSafeGitUrl} first and then narrows it — the
 * transport allowlist is the security question and belongs to the package that
 * owns it, while `https://`-only is the separate, boring fact that the listing
 * is fetched over HTTP.
 *
 * @param url - The address an operator (or the personal-marketplace bootstrap)
 *   wants to register.
 * @returns `true` when the address may be stored as a marketplace source.
 */
export function isSupportedMarketplaceSourceUrl(url: string): boolean {
  if (isLocalMarketplaceUrl(url)) {
    return true;
  }
  return isSafeGitUrl(url) && url.startsWith('https://');
}

/**
 * Refuse an unsupported marketplace source address.
 *
 * @param url - The address to check.
 * @throws {UnsupportedSourceUrlError} When the address is not one
 *   {@link isSupportedMarketplaceSourceUrl} accepts.
 */
export function assertSupportedMarketplaceSourceUrl(url: string): void {
  if (!isSupportedMarketplaceSourceUrl(url)) {
    throw new UnsupportedSourceUrlError(url);
  }
}
