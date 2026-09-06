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
 * The module also owns the narrower question one step downstream:
 * {@link assertSafeGitRemote}, asked at each place an address actually becomes
 * argv for `git`. A `name@<url>` install spec is hand-built into a source
 * descriptor the same way a source is, skips the same schema, and reached
 * `git ls-remote` unchecked for the same reason (DOR-1799).
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
 * What a person is told when an address they asked DorkOS to install a package
 * from is not one we will hand to `git`.
 *
 * A separate sentence from {@link UNSUPPORTED_SOURCE_URL_MESSAGE} because the
 * accepted set is genuinely different, and a refusal that names the wrong set
 * sends people down a dead end. A marketplace source has to serve its listing
 * over HTTP, so it is `https://` or a local folder. An install address is only
 * ever cloned, so every transport {@link isSafeGitUrl} allows works here —
 * `ssh://` and `git@host:path` included.
 */
export const UNSUPPORTED_GIT_REMOTE_MESSAGE =
  "That address isn't one DorkOS can install a package from. Use an https://, ssh:// or " +
  'git@host:path address for a git repository, or a file:// path to a folder on this machine.';

/**
 * Thrown when an address DorkOS was asked to fetch from is refused. Carries the
 * operator-facing sentence as its `message` so every surface — the REST route,
 * the CLI, the app — can show it verbatim without rewriting it.
 */
export class UnsupportedSourceUrlError extends Error {
  /**
   * Build the refusal.
   *
   * @param url - The address that was refused. Deliberately not interpolated
   *   into the message, which is what a person reads; the refusal sites log it
   *   instead, which is where the address is actually useful.
   * @param message - Which sentence the person reads. Defaults to the
   *   marketplace-source one; the git-remote door passes
   *   {@link UNSUPPORTED_GIT_REMOTE_MESSAGE}, which names a wider set of
   *   working forms. One error class, because every surface that already
   *   answers this refusal with a 400 should answer both.
   */
  constructor(
    public readonly url: string,
    message: string = UNSUPPORTED_SOURCE_URL_MESSAGE
  ) {
    super(message);
    this.name = 'UnsupportedSourceUrlError';
  }
}

/**
 * Refuse an address that is about to become argv for `git`.
 *
 * The question {@link isSafeGitUrl} answers — may this string be handed to
 * `git` — asked at the seam rather than at one of the several doors that reach
 * it. A package author's URL is checked by `marketplace.json` parsing, and a
 * configured source's by the add route, but a `name@<url>` install spec is
 * typed by an operator and hand-built into a source descriptor that no schema
 * ever sees (DOR-1799). Defense in depth rather than a patched hole: git's own
 * `GIT_ALLOW_PROTOCOL` confinement (`hardenedGitEnv`) already stands behind
 * this, and git 2.53 refuses `ext::` on its own.
 *
 * `file://` addresses do not reach here, so this predicate does not allow them
 * and does not need to: `fetchFromGit` branches on `file://` first and reads
 * the directory, and the git-subdir path never carries one — a `file://`
 * marketplace resolves through the relative-path resolver instead.
 *
 * @param url - The address about to be handed to `git`.
 * @throws {UnsupportedSourceUrlError} When the transport is not one
 *   {@link isSafeGitUrl} accepts, or the address begins with `-`.
 */
export function assertSafeGitRemote(url: string): void {
  if (!isSafeGitUrl(url)) {
    throw new UnsupportedSourceUrlError(url, UNSUPPORTED_GIT_REMOTE_MESSAGE);
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
