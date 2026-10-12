/**
 * The file routes that change something in a session's working directory:
 * create, delete, rename, copy, and show in the file manager. Split out of
 * `routes/files.ts`, which mounts them; the reading routes stay there.
 *
 * @module routes/file-entries
 */
import { Hono } from 'hono';
import { z } from 'zod';
import crypto from 'crypto';
import fs from 'fs/promises';

import path from 'path';

import {
  CreateEntryRequestSchema,
  DeleteEntryQuerySchema,
  RenameEntryRequestSchema,
  CopyEntryRequestSchema,
  RevealEntryRequestSchema,
} from '@dorkos/shared/schemas';

import { revealInFileManager } from '../lib/reveal-in-file-manager.js';
import { resolveWithinCwd, pathErrorReply } from '../lib/file-route-guards.js';

import { logger } from '../lib/logger.js';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { readQuery } from '../http/request-query.js';

const router = new Hono<ApiEnv>();

/**
 * Create a file or directory inside a session's working directory. Rejects with
 * 409 if the target already exists. A new file's write is atomic (temp +
 * rename); intermediate parent directories are created as needed. The target is
 * boundary-validated against `cwd`.
 */
router.post('/', async (c) => {
  const parsed = CreateEntryRequestSchema.safeParse(readJsonBody(c));
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', details: z.flattenError(parsed.error) }, 400);
  }
  const { cwd, path: relPath, type, content } = parsed.data;

  let validatedCwd: string;
  let resolved: string;
  try {
    ({ validatedCwd, resolved } = await resolveWithinCwd(cwd, relPath));
  } catch (err) {
    const pathRefusal = pathErrorReply(err);
    if (pathRefusal) return c.json(pathRefusal.body, pathRefusal.status);
    logger.error('[files] POST / boundary failed', { err, cwd, path: relPath });
    return c.json({ error: 'Internal server error' }, 500);
  }

  if (resolved === validatedCwd) {
    return c.json(
      { error: 'Refusing to create over the working-directory root', code: 'REFUSE_ROOT' },
      400
    );
  }

  try {
    await fs.access(resolved);
    return c.json({ error: 'Target already exists', code: 'CONFLICT' }, 409);
  } catch {
    // Does not exist — proceed to create.
  }

  const relForResponse = path.relative(validatedCwd, resolved).split(path.sep).join('/');
  try {
    if (type === 'dir') {
      await fs.mkdir(resolved, { recursive: true });
    } else {
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      const tmp = `${resolved}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      try {
        await fs.writeFile(tmp, content ?? '', 'utf8');
        await fs.rename(tmp, resolved);
      } catch (err) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EACCES') {
      return c.json({ error: 'Permission denied', code: 'EACCES' }, 403);
    }
    logger.error('[files] POST / create failed', { err, resolved });
    return c.json({ error: 'Internal server error' }, 500);
  }

  return c.json({ ok: true, path: relForResponse }, 201);
});

/**
 * Delete a file or directory inside a session's working directory. Refuses to
 * delete the `cwd` root itself. A non-empty directory requires `recursive`; a
 * bare non-empty-directory delete is rejected with 409. The target is
 * boundary-validated against `cwd`.
 */
router.delete('/', async (c) => {
  const parsed = DeleteEntryQuerySchema.safeParse(readQuery(c));
  if (!parsed.success) {
    return c.json({ error: 'Invalid query', details: z.treeifyError(parsed.error) }, 400);
  }
  const { cwd, path: relPath, recursive } = parsed.data;

  let validatedCwd: string;
  let resolved: string;
  try {
    ({ validatedCwd, resolved } = await resolveWithinCwd(cwd, relPath));
  } catch (err) {
    const pathRefusal = pathErrorReply(err);
    if (pathRefusal) return c.json(pathRefusal.body, pathRefusal.status);
    logger.error('[files] DELETE / boundary failed', { err, cwd, path: relPath });
    return c.json({ error: 'Internal server error' }, 500);
  }

  if (resolved === validatedCwd) {
    return c.json(
      { error: 'Refusing to delete the working-directory root', code: 'REFUSE_ROOT' },
      400
    );
  }

  try {
    const stat = await fs.lstat(resolved);
    if (stat.isDirectory() && !recursive) {
      const children = await fs.readdir(resolved);
      if (children.length > 0) {
        return c.json(
          { error: 'Directory is not empty; pass recursive', code: 'DIR_NOT_EMPTY' },
          409
        );
      }
    }
    await fs.rm(resolved, { recursive, force: false });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return c.json({ error: 'Path not found', code: 'NOT_FOUND' }, 404);
    }
    if (code === 'ENOTEMPTY') {
      return c.json(
        { error: 'Directory is not empty; pass recursive', code: 'DIR_NOT_EMPTY' },
        409
      );
    }
    if (code === 'EACCES') {
      return c.json({ error: 'Permission denied', code: 'EACCES' }, 403);
    }
    logger.error('[files] DELETE / failed', { err, resolved });
    return c.json({ error: 'Internal server error' }, 500);
  }

  return c.json({ ok: true });
});

/**
 * Move or rename an entry within a session's working directory. Both `from` and
 * `to` are boundary-validated against `cwd`; `from` must exist (404), `to` must
 * not (409), and neither may be the `cwd` root. The destination's parent
 * directories are created as needed.
 */
router.post('/rename', async (c) => {
  const parsed = RenameEntryRequestSchema.safeParse(readJsonBody(c));
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', details: z.flattenError(parsed.error) }, 400);
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
    const pathRefusal = pathErrorReply(err);
    if (pathRefusal) return c.json(pathRefusal.body, pathRefusal.status);
    logger.error('[files] POST /rename boundary failed', { err, cwd, from, to });
    return c.json({ error: 'Internal server error' }, 500);
  }

  if (fromResolved === validatedCwd || toResolved === validatedCwd) {
    return c.json(
      { error: 'Refusing to move the working-directory root', code: 'REFUSE_ROOT' },
      400
    );
  }

  try {
    await fs.access(fromResolved);
  } catch {
    return c.json({ error: 'Source not found', code: 'NOT_FOUND' }, 404);
  }

  try {
    await fs.access(toResolved);
    return c.json({ error: 'Target already exists', code: 'CONFLICT' }, 409);
  } catch {
    // Target free — proceed.
  }

  try {
    await fs.mkdir(path.dirname(toResolved), { recursive: true });
    await fs.rename(fromResolved, toResolved);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EACCES') {
      return c.json({ error: 'Permission denied', code: 'EACCES' }, 403);
    }
    logger.error('[files] POST /rename failed', { err, fromResolved, toResolved });
    return c.json({ error: 'Internal server error' }, 500);
  }

  return c.json({ ok: true });
});

/**
 * Copy an entry within a session's working directory. Mirrors `POST /rename`'s
 * shape and guards: both `from` and `to` are boundary-validated against `cwd`,
 * `from` must exist (404), `to` must not (409), and neither may be the `cwd`
 * root. Directories copy recursively; copying a directory into itself or into
 * its own subtree is refused (400), because the copy would otherwise recurse
 * into the destination it is still writing.
 */
router.post('/copy', async (c) => {
  const parsed = CopyEntryRequestSchema.safeParse(readJsonBody(c));
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', details: z.flattenError(parsed.error) }, 400);
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
    const pathRefusal = pathErrorReply(err);
    if (pathRefusal) return c.json(pathRefusal.body, pathRefusal.status);
    logger.error('[files] POST /copy boundary failed', { err, cwd, from, to });
    return c.json({ error: 'Internal server error' }, 500);
  }

  if (fromResolved === validatedCwd || toResolved === validatedCwd) {
    return c.json(
      { error: 'Refusing to copy over the working-directory root', code: 'REFUSE_ROOT' },
      400
    );
  }

  let sourceIsDir: boolean;
  try {
    sourceIsDir = (await fs.stat(fromResolved)).isDirectory();
  } catch {
    return c.json({ error: 'Source not found', code: 'NOT_FOUND' }, 404);
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
    return c.json({ error: 'Target already exists', code: 'CONFLICT' }, 409);
  }

  if (
    sourceIsDir &&
    (toResolved === fromResolved || toResolved.startsWith(fromResolved + path.sep))
  ) {
    return c.json({ error: 'Refusing to copy a folder into itself', code: 'COPY_INTO_SELF' }, 400);
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
      return c.json({ error: 'Target already exists', code: 'CONFLICT' }, 409);
    }
    // The prefix check above misses a case-insensitive filesystem, where
    // `src` → `SRC/inner` is the same self-copy under a different spelling.
    // Node catches it and says so; answer with the honest reason, not a 500.
    if (code === 'ERR_FS_CP_EINVAL') {
      return c.json(
        { error: 'Refusing to copy a folder into itself', code: 'COPY_INTO_SELF' },
        400
      );
    }

    // Only now, having established the destination was free before we started
    // and that we are the ones who wrote to it, is removing it safe. A
    // partially-written destination is worse than none.
    if (targetWasFree) {
      await fs.rm(toResolved, { recursive: true, force: true }).catch(() => {});
    }
    if (code === 'EACCES') {
      return c.json({ error: 'Permission denied', code: 'EACCES' }, 403);
    }
    logger.error('[files] POST /copy failed', { err, fromResolved, toResolved });
    return c.json({ error: 'Internal server error' }, 500);
  }

  return c.json({ ok: true });
});

/**
 * Show an entry in the operating system's file manager, on the machine the
 * server runs on: Finder (macOS), File Explorer (Windows), or the desktop's
 * default handler (everything else). The path is boundary-validated against
 * `cwd` and must exist (404); nothing is read or written.
 *
 * Every launcher runs through `execFile` with an argument array — never a
 * shell — so a file name containing shell metacharacters is passed through as
 * data rather than parsed as a command.
 */
router.post('/reveal', async (c) => {
  const parsed = RevealEntryRequestSchema.safeParse(readJsonBody(c));
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', details: z.flattenError(parsed.error) }, 400);
  }
  const { cwd, path: relPath } = parsed.data;

  let resolved: string;
  try {
    ({ resolved } = await resolveWithinCwd(cwd, relPath));
  } catch (err) {
    const pathRefusal = pathErrorReply(err);
    if (pathRefusal) return c.json(pathRefusal.body, pathRefusal.status);
    logger.error('[files] POST /reveal boundary failed', { err, cwd, path: relPath });
    return c.json({ error: 'Internal server error' }, 500);
  }

  try {
    await fs.access(resolved);
  } catch {
    return c.json({ error: 'Path not found', code: 'NOT_FOUND' }, 404);
  }

  try {
    await revealInFileManager(resolved);
  } catch (err) {
    logger.error('[files] POST /reveal failed', { err, resolved });
    return c.json({ error: "Couldn't open the file manager", code: 'REVEAL_UNAVAILABLE' }, 500);
  }

  return c.body(null, 204);
});

export default router;
