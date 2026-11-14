/**
 * Desktop download lookup — resolves the newest published GitHub release of
 * dork-labs/dorkos that carries a given asset suffix (`.dmg` for macOS,
 * `.exe` for Windows), for the stable human download links `GET
 * /download/mac` and `GET /download/windows` redirect to.
 *
 * The repo's `/releases/latest` is unsuitable as a direct link target: it is
 * whichever release GitHub considers latest by publish time, which may be a
 * CLI release with no desktop asset at all. This walks the release list
 * itself and picks the newest one that actually ships the requested asset,
 * regardless of what else is tagged "latest".
 *
 * @module lib/desktop-download
 */

import { links } from '@dorkos/shared/links';

/**
 * How long one instance reuses a release list it fetched from GitHub.
 *
 * Deliberately NOT the Next.js data cache (DOR-4300): that cache is
 * stale-while-revalidate, so on a quiet link the first visit after the window
 * got the list from before the newest release, and 0.135.8 was still served
 * as 0.135.7 two hours after it shipped. An in-memory copy is never served
 * past this window, so a new release shows up within a minute. The window
 * absorbs bursts: one GitHub call a minute per instance. That alone cannot
 * promise the unauthenticated limit (60 an hour per IP, and Vercel's outbound
 * IPs are shared), which is why a refusal falls back to the last good list,
 * then to {@link RELEASES_PAGE_URL}.
 */
export const RELEASE_LIST_TTL_MS = 60_000;

/**
 * Where a download link sends a person when GitHub can't be asked and there
 * is no earlier list to fall back on (a cold instance hitting the rate limit).
 * The human release page always lists the newest installers, which beats an
 * error page on the download button.
 */
export const RELEASES_PAGE_URL = `https://github.com/${links.repoSlug}/releases/latest`;

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

/** The last list GitHub returned, and when; the fallback when GitHub refuses. */
let lastGood: { releases: GitHubRelease[]; fetchedAt: number } | null = null;
/** A fetch already on its way, shared by visits that arrive while it runs. */
let inFlight: Promise<GitHubRelease[] | null> | null = null;

/**
 * Forget the remembered release list.
 *
 * @internal For tests, which need each case to start with nothing fetched.
 */
export function resetDesktopReleaseCache(): void {
  lastGood = null;
  inFlight = null;
}

/** Ask GitHub for the release list right now, bypassing every cache. */
async function fetchReleaseList(): Promise<GitHubRelease[] | null> {
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${links.repoSlug}/releases?per_page=30`, {
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store',
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  try {
    return (await res.json()) as GitHubRelease[];
  } catch {
    return null;
  }
}

/**
 * The release list, at most {@link RELEASE_LIST_TTL_MS} old. When GitHub
 * fails or refuses (a rate limit answers 403), the last good list of any age
 * beats sending a person to an error page; `null` only when there is none.
 */
async function getReleaseList(): Promise<GitHubRelease[] | null> {
  if (lastGood && Date.now() - lastGood.fetchedAt < RELEASE_LIST_TTL_MS) {
    return lastGood.releases;
  }
  inFlight ??= fetchReleaseList().finally(() => {
    inFlight = null;
  });
  const releases = await inFlight;
  if (releases) {
    lastGood = { releases, fetchedAt: Date.now() };
    return releases;
  }
  return lastGood?.releases ?? null;
}

/**
 * Find the `browser_download_url` of the newest release asset whose name
 * ends with `assetSuffix` (e.g. `.dmg`, `.exe`) across all published
 * releases of dork-labs/dorkos.
 *
 * Uses the unauthenticated GitHub REST API (list releases), which already
 * excludes draft releases for anonymous callers — a `!draft` filter is kept
 * anyway so the guarantee doesn't silently depend on that behavior.
 * Prereleases ARE included: a release the team hasn't promoted to "latest"
 * yet may still be the only one that ships a desktop build.
 *
 * Returns {@link RELEASES_PAGE_URL} when the GitHub API call fails with no
 * earlier list to fall back on, and `null` only when GitHub answered but no
 * release with a matching asset exists yet (e.g. before the first desktop
 * build ships).
 */
async function findLatestReleaseAssetUrl(assetSuffix: string): Promise<string | null> {
  const releases = await getReleaseList();
  if (!releases) {
    console.warn(
      `[lib/desktop-download] GitHub release list unavailable, no earlier list; sending ${assetSuffix} download to the releases page`
    );
    return RELEASES_PAGE_URL;
  }

  const sorted = releases
    .filter((release) => !release.draft)
    .sort((a, b) => {
      const aDate = a.published_at ?? a.created_at;
      const bDate = b.published_at ?? b.created_at;
      return bDate.localeCompare(aDate);
    });

  for (const release of sorted) {
    const asset = release.assets.find((asset) => asset.name.endsWith(assetSuffix));
    if (asset) return asset.browser_download_url;
  }

  return null;
}

/**
 * Find the `browser_download_url` of the newest `.dmg` asset across all
 * published releases of dork-labs/dorkos. See {@link findLatestReleaseAssetUrl}
 * for the underlying lookup semantics.
 */
export async function findLatestDmgDownloadUrl(): Promise<string | null> {
  return findLatestReleaseAssetUrl('.dmg');
}

/**
 * Find the `browser_download_url` of the newest `.exe` (NSIS installer)
 * asset across all published releases of dork-labs/dorkos. See
 * {@link findLatestReleaseAssetUrl} for the underlying lookup semantics.
 */
export async function findLatestExeDownloadUrl(): Promise<string | null> {
  return findLatestReleaseAssetUrl('.exe');
}
