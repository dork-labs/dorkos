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
 * @module services/marketplace/lib/trusted-source
 */
import { parseOriginRepo } from '../../../projects/origin-repo.js';

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
