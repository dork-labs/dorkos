/**
 * @dorkos/marketplace — What version a package has.
 *
 * DorkOS resolves a package's version the way Claude Code does, because
 * Claude Code is what actually loads the plugin:
 *
 * 1. the `version` the package declares (`plugin.json`, which wins silently
 *    over the marketplace entry);
 * 2. else the marketplace entry's `version`;
 * 3. else, for git sources, the commit the package was fetched at.
 *
 * Every reader (install, the installed list, the update check) goes through
 * {@link resolvePackageVersion}; none reimplements the chain. Reading the
 * declared version off disk is Node-only and lives beside the validator
 * (`readDeclaredVersion` in `@dorkos/marketplace/package-validator`).
 *
 * Browser-safe — no Node.js dependencies.
 *
 * @module @dorkos/marketplace/package-version
 */

/** Where a package's version came from, in Claude Code's order. */
export type VersionSource = 'package' | 'index' | 'commit';

/** A package's resolved identity for update comparison. */
export interface ResolvedPackageVersion {
  /** The version string, or the full commit SHA when `source` is `'commit'`. */
  version: string;
  /** Which step of the chain produced `version`. */
  source: VersionSource;
}

/**
 * The placeholder commit a relative-path package resolved inside an already
 * cloned (`file://`) marketplace carries. There is no commit to name, so the
 * fetcher writes this instead; {@link isRealCommitSha} rejects it.
 */
export const RELATIVE_PATH_SENTINEL_SHA = 'relative-path';

/** The placeholder a `file://` git URL resolution carries in place of a commit. */
const LOCAL_SENTINEL_SHA = 'local';

/** The fetcher's degraded fallback when `git ls-remote` fails: `tmp-<epoch ms>`. */
const LOOKUP_FAILED_SHA_RE = /^tmp-\d+$/;

/**
 * False for every placeholder the fetchers write in place of a real commit.
 *
 * The rule is "never fabricate" (DOR-147): a placeholder is neither recorded
 * as provenance nor compared as a version. The three placeholders are the
 * relative-path sentinel ({@link RELATIVE_PATH_SENTINEL_SHA}, same-repo
 * packages from a `file://` marketplace), `'local'` (a `file://` git URL), and
 * `tmp-<ms>` (a failed `git ls-remote`: offline, no git, malformed output).
 *
 * @param sha - A commit value as a fetcher or a sidecar reported it.
 * @returns `true` only for a value that can be a real commit.
 */
export function isRealCommitSha(sha: string | undefined): sha is string {
  if (!sha) return false;
  if (sha === LOCAL_SENTINEL_SHA || sha === RELATIVE_PATH_SENTINEL_SHA) return false;
  return !LOOKUP_FAILED_SHA_RE.test(sha);
}

/**
 * Resolve a package's version the way Claude Code does: the version the
 * package declares, else its marketplace entry's version, else the commit it
 * was fetched at. `undefined` when none of the three is known.
 *
 * Empty strings count as absent, and a placeholder commit (see
 * {@link isRealCommitSha}) is never used as a version.
 *
 * @param input - What is known about the package.
 * @param input.declaredVersion - The version the package tree states about
 *   itself (`readDeclaredVersion`).
 * @param input.entryVersion - The marketplace entry's own `version`.
 * @param input.commitSha - The commit the package was fetched at.
 * @returns The resolved version and where it came from, or `undefined`.
 */
export function resolvePackageVersion(input: {
  declaredVersion?: string;
  entryVersion?: string;
  commitSha?: string;
}): ResolvedPackageVersion | undefined {
  if (input.declaredVersion) return { version: input.declaredVersion, source: 'package' };
  if (input.entryVersion) return { version: input.entryVersion, source: 'index' };
  if (isRealCommitSha(input.commitSha)) return { version: input.commitSha, source: 'commit' };
  return undefined;
}
