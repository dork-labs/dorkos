/**
 * The one spelling of "where a package came from" that DorkOS will trust code
 * by (spec `flow-multiproject` §9.1, D14).
 *
 * A trusted source is a GitHub `owner/repo`, lowercased, taken from the
 * `sourceRepo` DorkOS's own installer recorded, never from `installedFrom`
 * (a marketplace name the person chose) and never from a file inside a
 * project. The installer records `sourceRepo` in three shapes (see
 * `deriveSourceProvenance`): a bare `owner/repo` for `github`-form entries, and
 * an https or ssh URL for the rest. Each GitHub shape reduces to the same
 * `owner/repo`; anything else (another host, a `file://` marketplace, a local
 * folder) has no trusted source.
 *
 * ## Only branches and tags
 *
 * A GitHub repository also serves commits that are not its own: every pull
 * request's head (`refs/pull/N/head`) and any commit of any fork can be
 * fetched through the parent's URL. So an install whose ref was a `refs/…`
 * name outside `refs/heads/` and `refs/tags/`, or a bare commit id, proves
 * nothing about who wrote the code, and has no trusted source
 * ({@link isTrustableRef}). The default branch (`HEAD`) and a plain branch or
 * tag name (which the fetcher resolves only under `refs/heads/` and
 * `refs/tags/`) count.
 *
 * @module services/marketplace/lib/trusted-source
 */
import type { SourceKey } from '@dorkos/marketplace';
import { parseOriginRepo } from '../../projects/origin-repo.js';

/**
 * A bare `owner/repo`, the way a `github`-form marketplace entry names its
 * source. GitHub owners never contain a dot, so this cannot match a relative
 * path like `./plugins/flow` or a host name.
 */
const BARE_GITHUB_REPO = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/;

/**
 * Reduce a recorded `sourceRepo` to the `owner/repo` DorkOS trusts code by.
 *
 * @param sourceRepo - What the installer recorded, or undefined.
 * @returns The lowercased `owner/repo`, or null when it is not a GitHub
 *   repository DorkOS can name.
 */
export function normalizeTrustedSource(sourceRepo: string | undefined | null): string | null {
  if (!sourceRepo) return null;
  const trimmed = sourceRepo.trim();
  const bare = BARE_GITHUB_REPO.exec(trimmed);
  const repo = bare ? `${bare[1]}/${bare[2]}` : parseOriginRepo(trimmed);
  if (!repo) return null;
  const [owner, name] = repo.split('/');
  if (!owner || !name || name === '.' || name === '..') return null;
  return repo.toLowerCase();
}

/**
 * Whether code fetched at `ref` can only have come from the repository's own
 * branches or tags. See the module header for why pull-request heads, other
 * `refs/…` names and bare commit ids never count.
 *
 * @param ref - The effective ref the install was fetched at (`SourceKey.ref`).
 */
export function isTrustableRef(ref: string | undefined): boolean {
  if (!ref) return false;
  if (ref === 'HEAD') return true;
  // A bare commit id, full (SHA-1 or SHA-256) or abbreviated: whichever branch,
  // fork or pull request it came from, a commit id names none of them.
  if (/^[0-9a-f]{7,64}$/i.test(ref)) return false;
  if (ref.startsWith('refs/')) return ref.startsWith('refs/heads/') || ref.startsWith('refs/tags/');
  // A short name: the fetcher looks it up only as `refs/heads/<name>` or
  // `refs/tags/<name>` (`candidateRefNames` in `git-tree.ts`).
  return true;
}

/**
 * The trusted source of one install, from what the installer recorded: its
 * `sourceRepo`, and the ref its {@link SourceKey} says it was fetched at.
 *
 * @param install - The install's recorded `sourceRepo` and `sourceKey`.
 * @returns The normalized `owner/repo`, or null when either proves nothing.
 */
export function trustedSourceOfInstall(install: {
  sourceRepo?: string | null;
  sourceKey?: Pick<SourceKey, 'ref'> | null;
}): string | null {
  if (!install.sourceKey || !isTrustableRef(install.sourceKey.ref)) return null;
  return normalizeTrustedSource(install.sourceRepo);
}
