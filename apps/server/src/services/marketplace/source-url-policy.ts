/**
 * Which addresses a marketplace source may point at.
 *
 * A configured source is the one string in the marketplace that nobody
 * validates on the way in and everybody trusts on the way out: the installer
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
 * The one address form a source may use that a package source may not is
 * `file://` — a marketplace living in a folder on this machine, which is how
 * the personal marketplace registers itself. It never reaches `git`: every
 * consumer branches on `file://` first and reads the directory directly.
 *
 * @module services/marketplace/source-url-policy
 */
import { isSafeGitUrl } from '@dorkos/marketplace';

/**
 * What an operator is told when the address they typed is not one DorkOS can
 * fetch a marketplace from. Names the forms that do work, because a refusal
 * that does not is just a dead end.
 */
export const UNSUPPORTED_SOURCE_URL_MESSAGE =
  "That address isn't one DorkOS can fetch a marketplace from. Use an https:// or git@ " +
  'address for a git repository, or a file:// path to a folder on this machine.';

/**
 * Thrown when a marketplace source address is refused. Carries the operator-
 * facing sentence as its `message` so every surface — the REST route, the CLI,
 * the app — can show it verbatim without rewriting it.
 */
export class UnsupportedSourceUrlError extends Error {
  /**
   * Build the refusal.
   *
   * @param url - The address that was refused. Kept for logs; deliberately not
   *   interpolated into the message, which is what a person reads.
   */
  constructor(public readonly url: string) {
    super(UNSUPPORTED_SOURCE_URL_MESSAGE);
    this.name = 'UnsupportedSourceUrlError';
  }
}

/**
 * True when `url` is an address a marketplace source may be configured with:
 * any git remote {@link isSafeGitUrl} accepts, or a `file://` path to a local
 * marketplace directory.
 *
 * @param url - The address an operator (or the personal-marketplace bootstrap)
 *   wants to register.
 * @returns `true` when the address may be stored as a marketplace source.
 */
export function isSupportedMarketplaceSourceUrl(url: string): boolean {
  return isSafeGitUrl(url) || url.startsWith('file://');
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

/**
 * Refuse an address that is about to be handed to `git`. Stricter than
 * {@link assertSupportedMarketplaceSourceUrl} by exactly one form: a `file://`
 * source is a directory to read, never a remote to clone, so a `file://`
 * address arriving at a git call site is itself the mistake.
 *
 * @param url - The address about to reach `git`.
 * @throws {UnsupportedSourceUrlError} When the address is not a git remote
 *   {@link isSafeGitUrl} accepts.
 */
export function assertSafeGitRemote(url: string): void {
  if (!isSafeGitUrl(url)) {
    throw new UnsupportedSourceUrlError(url);
  }
}
