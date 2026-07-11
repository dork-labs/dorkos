/**
 * Git-HEAD baseline helper — the diff base's fallback rung and its secondary
 * user-toggled compare mode (DOR-212 §Q1, ADR 260711-142049).
 *
 * The primary diff base is the per-session pre-edit snapshot ({@link
 * ./edit-baseline}); this helper reads a file's content at git `HEAD` only when
 * (a) no snapshot exists and the file can't be reconstructed from the tool input,
 * or (b) the operator explicitly switches the header's "Compare against: Last
 * commit (HEAD)" toggle. It runs `git show HEAD:<relpath>` via `execFile` (no
 * shell — no injection surface), cwd-confined, with a timeout, and returns `null`
 * for a non-git cwd or an untracked file rather than throwing.
 *
 * @module services/diff/git-baseline
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { GIT, FILE_LIMITS } from '../../config/constants.js';

const execFileAsync = promisify(execFile);

/**
 * Read a file's bytes at git `HEAD`, or `null` when the cwd is not a git repo,
 * the file is untracked at HEAD, or git errors. Binary-safe (returns a `Buffer`).
 *
 * @param cwd - The (already boundary-validated) git working directory.
 * @param absPath - Absolute path to the file, inside `cwd`.
 */
export async function gitShowHead(cwd: string, absPath: string): Promise<Buffer | null> {
  // `git show HEAD:<path>` wants a repo-relative, forward-slashed path.
  const rel = path.relative(cwd, absPath).split(path.sep).join('/');
  // A path that escapes cwd (leading `..`) is never a tracked file here — refuse
  // rather than hand git a traversal.
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  try {
    const { stdout } = await execFileAsync('git', ['show', `HEAD:${rel}`], {
      cwd,
      timeout: GIT.STATUS_TIMEOUT_MS,
      maxBuffer: FILE_LIMITS.GIT_MAX_BUFFER,
      encoding: 'buffer',
    });
    return stdout;
  } catch {
    // Non-git cwd, untracked file, no commits yet, or oversize — no HEAD baseline.
    return null;
  }
}
