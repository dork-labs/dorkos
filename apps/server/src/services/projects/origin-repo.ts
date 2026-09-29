/**
 * `owner/name` from a GitHub remote URL (spec `flow-multiproject` §6.1).
 *
 * Flow maps `fleet.json`'s `owner/name` rules to project roots with it, so it
 * must only answer for a GitHub repository: a GitLab or self-hosted remote has
 * no `owner/name` that means the same thing, and answers null.
 *
 * @module services/projects/origin-repo
 */

/** One `owner` or `name` segment as GitHub allows it. */
const SEGMENT = '[A-Za-z0-9._-]+';

/**
 * The forms a GitHub remote takes: `https://github.com/owner/name(.git)`
 * (credentials allowed), `ssh://git@github.com(:port)/owner/name(.git)`, and
 * the scp-like `git@github.com:owner/name(.git)`.
 */
const GITHUB_REMOTE = new RegExp(
  `^(?:(?:https?|ssh|git)://(?:[^@/]+@)?github\\.com(?::\\d+)?/|[^@\\s/]+@github\\.com:)` +
    `(${SEGMENT})/(${SEGMENT}?)(?:\\.git)?/?$`,
  'i'
);

/**
 * Parse a remote URL for its GitHub `owner/name`.
 *
 * @param remoteUrl - What `git remote get-url origin` printed.
 * @returns `owner/name`, or null for anything that is not a GitHub repository.
 */
export function parseOriginRepo(remoteUrl: string): string | null {
  const match = GITHUB_REMOTE.exec(remoteUrl.trim());
  if (!match) return null;
  const owner = match[1];
  const name = match[2]?.replace(/\.git$/i, '');
  if (!owner || !name) return null;
  return `${owner}/${name}`;
}
