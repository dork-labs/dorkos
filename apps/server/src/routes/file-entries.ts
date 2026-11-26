/**
 * The one file change that stays by hand: copying an entry in a session's
 * working directory, until its path names a resource (the API lint's verb rule).
 * Making, deleting, moving and showing an entry are capabilities the mount
 * serves (`services/core/directory/file-entry-capabilities.ts`, DOR-4978).
 * `routes/files.ts` mounts it.
 *
 * @module routes/file-entries
 */
import { Hono } from 'hono';
import fs from 'fs/promises';
import path from 'path';
import { CopyEntryRequestSchema } from '@dorkos/shared/schemas';
import { resolveWithinCwd } from '../lib/file-route-guards.js';
import { logger } from '../lib/logger.js';
import type { ApiEnv } from '../http/api-chain.js';
import { problem, readJsonBody, validationProblem } from '@dorkos/http-kit';
import { NAME_TAKEN, NOT_ALLOWED_TO_CHANGE, pathCheckFailure } from './file-problems.js';

const router = new Hono<ApiEnv>();

/** A folder copied into itself or into a folder inside it. */
const INTO_ITSELF = 'A folder can’t be copied into itself.';

/**
 * Copy an entry within a session's working directory. Mirrors `files.rename`'s
 * shape and guards: both `from` and `to` are boundary-validated against `cwd`,
 * `from` must exist (404), `to` must not (409), and neither may be the `cwd`
 * root. Directories copy recursively; copying a directory into itself or into
 * its own subtree is refused (400), because the copy would otherwise recurse
 * into the destination it is still writing.
 */
router.post('/copy', async (c) => {
  const parsed = CopyEntryRequestSchema.safeParse(readJsonBody(c));
  if (!parsed.success) {
    return validationProblem(c, parsed.error);
  }
  const { cwd, from, to } = parsed.data;

  let validatedCwd: string;
  let fromResolved: string;
  let toResolved: string;
  try {
    const fromR = await resolveWithinCwd(cwd, from);
    validatedCwd = fromR.validatedCwd;
    fromResolved = fromR.resolved;
    // `to` does not exist yet, so it is confined through its deepest existing
    // ancestor — a `..` escape and a symlinked parent are both rejected.
    ({ resolved: toResolved } = await resolveWithinCwd(cwd, to));
  } catch (err) {
    return pathCheckFailure(c, err, 'POST /copy', { cwd, from, to });
  }

  if (fromResolved === validatedCwd || toResolved === validatedCwd) {
    return problem(c, 'working_folder_root', {
      detail: 'The chat’s top folder can’t be copied or replaced.',
    });
  }

  let sourceIsDir: boolean;
  try {
    sourceIsDir = (await fs.stat(fromResolved)).isDirectory();
  } catch {
    return problem(c, 'not_found', { detail: 'The item to copy isn’t there anymore.' });
  }

  // `lstat`, not `access`: `access` follows symlinks, so a DANGLING symlink at
  // the destination reads as "free" — and the rollback below would then delete
  // a link the user put there. `lstat` sees the link itself, so an occupied
  // name is an occupied name whatever it points at.
  const targetWasFree = await fs
    .lstat(toResolved)
    .then(() => false)
    .catch(() => true);
  if (!targetWasFree) {
    return problem(c, 'already_exists', { detail: NAME_TAKEN });
  }

  if (
    sourceIsDir &&
    (toResolved === fromResolved || toResolved.startsWith(fromResolved + path.sep))
  ) {
    return problem(c, 'copy_into_self', { detail: INTO_ITSELF });
  }

  try {
    await fs.mkdir(path.dirname(toResolved), { recursive: true });
    await fs.cp(fromResolved, toResolved, { recursive: true, errorOnExist: true, force: false });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;

    // Someone else took the name between the check above and the copy. `fs.cp`
    // refused to clobber it (`errorOnExist`), so there is nothing of ours to
    // undo — and deleting THEIR file is exactly the damage the rollback is
    // supposed to prevent.
    if (code === 'ERR_FS_CP_EEXIST') {
      return problem(c, 'already_exists', { detail: NAME_TAKEN });
    }
    // The prefix check above misses a case-insensitive filesystem, where
    // `src` → `SRC/inner` is the same self-copy under a different spelling.
    // Node catches it and says so; answer with the honest reason, not a 500.
    if (code === 'ERR_FS_CP_EINVAL') {
      return problem(c, 'copy_into_self', { detail: INTO_ITSELF });
    }

    // Only now, having established the destination was free before we started
    // and that we are the ones who wrote to it, is removing it safe. A
    // partially-written destination is worse than none.
    if (targetWasFree) {
      await fs.rm(toResolved, { recursive: true, force: true }).catch(() => {});
    }
    if (code === 'EACCES') {
      return problem(c, 'forbidden', { detail: NOT_ALLOWED_TO_CHANGE });
    }
    logger.error('[files] POST /copy failed', { err, fromResolved, toResolved });
    return problem(c, 'internal_error', { detail: 'Couldn’t copy that. Try again.' });
  }

  return c.json({ ok: true });
});

export default router;
