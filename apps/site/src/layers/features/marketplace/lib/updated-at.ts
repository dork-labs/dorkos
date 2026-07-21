/**
 * Marketplace registry recency — the last time each package's files actually
 * changed in the `dork-labs/marketplace` repository.
 *
 * The site fetches the registry as a static raw JSON file (see `fetch.ts`), so
 * it has no git history at request time. GitHub exposes that history over its
 * REST API instead: `GET /repos/{owner}/{repo}/commits?path={dir}&per_page=1`
 * returns the most recent commit that touched a directory, with its ISO 8601
 * date. This module resolves each package's `source` to its registry directory
 * and makes one such call per package.
 *
 * Only packages whose files live inside the registry repo (relative-path
 * sources) have a registry-derived timestamp. A package sourced from an
 * external repo (`github`/`url`/`git-subdir`/`npm`) has no directory here, so it
 * honestly carries no date — it is simply omitted from the map. The comparator
 * downstream sorts those last.
 *
 * Cached by Next.js fetch revalidation (hourly), matching the ISR the
 * marketplace pages already use, so repeat requests dedupe to the data cache and
 * the unauthenticated GitHub rate limit (60/hour) stays far from its ceiling
 * (~11 calls per refresh at the current catalog size).
 *
 * @module features/marketplace/lib/updated-at
 */

import { resolvePluginSource, type PluginSource } from '@dorkos/marketplace';

import { fetchMarketplaceJson } from './fetch';

const MARKETPLACE_REPO = 'dork-labs/marketplace';
const COMMITS_API_ROOT = `https://api.github.com/repos/${MARKETPLACE_REPO}/commits`;

/**
 * Marketplace root passed to {@link resolvePluginSource}. Only the resolved
 * relative `path` is used here (never joined with this root), so its value is
 * immaterial — a relative-path source simply requires *some* root in context.
 */
const RESOLVE_ROOT = `https://raw.githubusercontent.com/${MARKETPLACE_REPO}/main`;

const REVALIDATE_SECONDS = 3600;

/** Wire shape a single-commit GitHub response entry needs (all else ignored). */
interface GitHubCommitEntry {
  commit?: { committer?: { date?: string } };
}

/**
 * Fetch the last-modified date of a single registry directory via the GitHub
 * commits API. Returns `null` when the path has no commits (e.g. it is not a
 * directory in this repo) or the call fails — the caller then omits the package.
 *
 * @param path - Directory path within the registry repo (e.g. `plugins/flow`).
 */
async function fetchDirLastCommitDate(path: string): Promise<string | null> {
  const url = `${COMMITS_API_ROOT}?path=${encodeURIComponent(path)}&per_page=1`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: 'application/vnd.github+json' },
      next: { revalidate: REVALIDATE_SECONDS },
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  let entries: GitHubCommitEntry[];
  try {
    entries = (await res.json()) as GitHubCommitEntry[];
  } catch {
    return null;
  }
  if (!Array.isArray(entries) || entries.length === 0) return null;
  return entries[0]?.commit?.committer?.date ?? null;
}

/**
 * Resolve a package entry to its directory path within the registry repo, or
 * `null` when the package lives outside the repo (an external-repo source has no
 * registry directory to date).
 *
 * @param source - The package's `source` field from the merged entry.
 * @param pluginRoot - The registry's `metadata.pluginRoot`, if any (used to
 *   expand bare relative-path names).
 */
function resolveRegistryDir(source: PluginSource, pluginRoot: string | undefined): string | null {
  try {
    const resolved = resolvePluginSource(source, {
      marketplaceRoot: RESOLVE_ROOT,
      pluginRoot,
    });
    return resolved.type === 'relative-path' ? resolved.path : null;
  } catch {
    return null;
  }
}

/**
 * Fetch registry-derived recency for every community package: a map from
 * package name to the ISO 8601 date of the last commit that touched its
 * directory in `dork-labs/marketplace`.
 *
 * Packages sourced from outside the registry repo are omitted (no honest date).
 * All per-package lookups run in parallel; an individual failure omits that one
 * package rather than failing the whole map.
 *
 * @throws when the registry itself cannot be fetched (mirrors
 *   {@link fetchMarketplaceJson}); the route handler degrades that to an empty map.
 */
export async function fetchRegistryUpdatedAt(): Promise<Record<string, string>> {
  const { plugins, marketplace } = await fetchMarketplaceJson();
  const pluginRoot = marketplace.metadata?.pluginRoot;

  const dated = await Promise.all(
    plugins.map(async (entry) => {
      const dir = resolveRegistryDir(entry.source, pluginRoot);
      if (dir === null) return null;
      const date = await fetchDirLastCommitDate(dir);
      return date === null ? null : ([entry.name, date] as const);
    })
  );

  const updatedAt: Record<string, string> = {};
  for (const pair of dated) {
    if (pair !== null) updatedAt[pair[0]] = pair[1];
  }
  return updatedAt;
}
