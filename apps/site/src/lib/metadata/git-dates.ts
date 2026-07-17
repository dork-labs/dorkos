/**
 * @module lib/metadata/git-dates
 *
 * Looks up a repo-tracked file's real last-commit date, for pages that want an
 * honest freshness signal (sitemap `lastModified`, blog `article:modified_time`)
 * instead of a fabricated one. Shared so every caller reads the same memoized
 * cache within a build.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/** Repo root, resolved from `apps/site` (the build-time cwd). */
const REPO_ROOT = join(process.cwd(), '../..');

/** Per-build memo of git dates so a repeated path never re-shells. */
const gitDateCache = new Map<string, string | null>();

/**
 * Real last-commit date for a repo-relative file, as an ISO string, or
 * `undefined` when git can't answer (shallow clone, untracked file, no git).
 *
 * We deliberately omit the date on failure rather than fabricate one: an
 * unreliable freshness signal is worse than none for both search engines and
 * social unfurls. Runs at build only (callers are statically generated pages),
 * so shelling out once per file is acceptable; results are memoized per path
 * within the build.
 *
 * @param relPath - File path relative to the repo root (e.g. `docs/index.mdx`).
 */
export function gitLastModified(relPath: string): string | undefined {
  const cached = gitDateCache.get(relPath);
  if (cached !== undefined) return cached ?? undefined;
  let result: string | null = null;
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cI', '--', relPath], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    result = out.length > 0 ? out : null;
  } catch {
    result = null;
  }
  gitDateCache.set(relPath, result);
  return result ?? undefined;
}
