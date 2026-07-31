/**
 * The working-directory → project-slug mapping the Claude Agent SDK uses to name
 * a session's transcript directory (`{claudeRoot}/projects/{slug}/`).
 *
 * DorkOS does not own this name — the SDK subprocess writes it and DorkOS reads
 * it — so this module exists to mirror the SDK's computation EXACTLY. Any
 * divergence is silent and total: DorkOS looks in a directory that does not
 * exist, `readdir` returns ENOENT, the listing degrades to "no sessions here",
 * and a session that is sitting on disk cold-starts instead of resuming
 * (DOR-782).
 *
 * The SDK does not export a helper for this, so it is reimplemented from the
 * shipped bundle at 0.3.177 (`sdk.mjs` → `So`, `My`, `a6`, `Di`; the native CLI
 * carries the identical logic and the `realpathSync` entry point). Verified
 * against 104 real transcript directories on a developer machine, and the hash
 * verified byte-identically against an on-disk 207-character truncated name.
 *
 * Three clauses matter and all three were missing before DOR-782 — a symlinked
 * checkout, a decomposed-Unicode path, and a path past 200 characters each
 * produced a slug that pointed nowhere.
 *
 * @module services/runtimes/claude-code/sessions/project-slug
 */
import { realpathSync } from 'fs';
import path from 'path';

/**
 * Slug length past which the SDK truncates and appends a hash. Its `Di = 200`.
 */
const PROJECT_SLUG_MAX_LENGTH = 200;

/**
 * The SDK's string hash (`sdk.mjs`'s `My`): `h = h * 31 + charCode`, seeded at
 * 0, truncated to a signed 32-bit int on EVERY iteration, over UTF-16 code
 * units.
 *
 * Each detail is load-bearing for byte-identical output, so none of it may be
 * "cleaned up": the per-iteration `| 0` is what makes it 32-bit (a plain
 * accumulate then truncate gives a different number), and the caller must take
 * `Math.abs` rather than `>>> 0` — the two disagree for every negative hash.
 */
function pathHash(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return hash;
}

/**
 * Put a working directory into the canonical form the SDK slugs: resolved
 * against the process cwd, then through `realpath`, then NFC-normalized.
 *
 * `realpath` is why a symlinked checkout works at all — the agent subprocess
 * runs in the real directory, so that is the name its transcript lands under.
 * A path that cannot be resolved (deleted, or not yet created) falls back to
 * the resolved-but-unfollowed path, which is exactly what the SDK does with its
 * own failure, so a brand-new session still gets the name it will be written
 * under.
 *
 * @param cwd - A working directory, absolute or relative. Defaults to `.`.
 */
export function canonicalizeCwd(cwd?: string): string {
  const resolved = path.resolve(cwd ?? '.');
  let real: string;
  try {
    real = realpathSync(resolved);
  } catch {
    real = resolved;
  }
  return real.normalize('NFC');
}

/**
 * Slug a CANONICAL path — feed it {@link canonicalizeCwd} output, never a raw
 * cwd, or the realpath/NFC clauses are skipped and the result can point nowhere.
 *
 * Every non-alphanumeric character becomes a dash. Past
 * {@link PROJECT_SLUG_MAX_LENGTH} the slug is truncated and a base36 hash is
 * appended — of the ORIGINAL path, not of the replaced string, which is the
 * detail an approximation gets wrong.
 *
 * @param canonicalPath - An already-canonicalized absolute path.
 */
export function slugForCanonicalPath(canonicalPath: string): string {
  const replaced = canonicalPath.replace(/[^a-zA-Z0-9]/g, '-');
  if (replaced.length <= PROJECT_SLUG_MAX_LENGTH) return replaced;
  const suffix = Math.abs(pathHash(canonicalPath)).toString(36);
  return `${replaced.slice(0, PROJECT_SLUG_MAX_LENGTH)}-${suffix}`;
}

/**
 * The SDK project-slug for a working directory: {@link canonicalizeCwd} then
 * {@link slugForCanonicalPath}.
 *
 * @param cwd - The session's working directory.
 */
export function projectSlug(cwd: string): string {
  return slugForCanonicalPath(canonicalizeCwd(cwd));
}
