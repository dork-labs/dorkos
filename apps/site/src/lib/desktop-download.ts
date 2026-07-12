/**
 * Desktop `.dmg` download lookup — resolves the newest published GitHub
 * release of dork-labs/dorkos that carries a `.dmg` asset, for the stable
 * human download link `GET /download/mac` redirects to.
 *
 * The repo's `/releases/latest` is unsuitable as a direct link target: it is
 * whichever release GitHub considers latest by publish time, which may be a
 * CLI release with no desktop asset at all. This walks the release list
 * itself and picks the newest one that actually ships a `.dmg`, regardless
 * of what else is tagged "latest".
 *
 * @module lib/desktop-download
 */

const OWNER = 'dork-labs';
const REPO = 'dorkos';
const REVALIDATE_SECONDS = 300;

interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface GitHubRelease {
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  created_at: string;
  assets: GitHubReleaseAsset[];
}

/**
 * Find the `browser_download_url` of the newest `.dmg` asset across all
 * published releases of dork-labs/dorkos.
 *
 * Uses the unauthenticated GitHub REST API (list releases), which already
 * excludes draft releases for anonymous callers — a `!draft` filter is kept
 * anyway so the guarantee doesn't silently depend on that behavior.
 * Prereleases ARE included: a release the team hasn't promoted to "latest"
 * yet may still be the only one that ships a desktop build.
 *
 * Cached for 5 minutes (Next.js fetch revalidation) so repeat visits to
 * `/download/mac` don't burn the unauthenticated GitHub rate limit.
 *
 * Returns `null` when no release with a `.dmg` asset exists yet (e.g. before
 * the first desktop build ships) or the GitHub API call fails.
 */
export async function findLatestDmgDownloadUrl(): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases?per_page=30`, {
      headers: { Accept: 'application/vnd.github+json' },
      next: { revalidate: REVALIDATE_SECONDS },
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  let releases: GitHubRelease[];
  try {
    releases = (await res.json()) as GitHubRelease[];
  } catch {
    return null;
  }

  const withDmg = releases
    .filter((release) => !release.draft)
    .sort((a, b) => {
      const aDate = a.published_at ?? a.created_at;
      const bDate = b.published_at ?? b.created_at;
      return bDate.localeCompare(aDate);
    });

  for (const release of withDmg) {
    const dmg = release.assets.find((asset) => asset.name.endsWith('.dmg'));
    if (dmg) return dmg.browser_download_url;
  }

  return null;
}
