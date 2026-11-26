/**
 * The file browser's changes to a folder as capabilities (DOR-4978, ADR
 * 261123-170830), on the paths the app always used:
 *
 * - `files.create`: `POST /api/files` (201), a new file or folder.
 * - `files.delete`: `DELETE /api/files`, its target in the query string.
 * - `files.rename`: `POST /api/files/rename`, move or rename.
 * - `files.reveal`: `POST /api/files/reveal` (204), show it in Finder or File
 *   Explorer on the computer DorkOS runs on.
 *
 * Copying (`POST /api/files/copy`) stays a hand route in `routes/file-entries.ts`
 * until its path names a resource (the API lint's verb rule).
 *
 * Each is a person's (`http.audience: 'person'`): an agent changes files with its
 * own runtime's tools, so these doors give it nothing. Every path keeps the hand
 * routes' checks exactly: confined to `cwd` by `resolveWithinCwd` (a `..` walk
 * or a symlinked parent is refused), and the chat's top folder is never
 * replaced, deleted or moved. From another device on the Wi-Fi, all of them
 * stay refused by the Wi-Fi level (`wifi-level.ts`), as before.
 *
 * @module services/core/directory/file-entry-capabilities
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  CreateEntryRequestSchema,
  CreateEntryResponseSchema,
  DeleteEntryQuerySchema,
  FileMutationResponseSchema,
  RenameEntryRequestSchema,
  RevealEntryRequestSchema,
} from '@dorkos/shared/schemas';
import { z } from 'zod';

import { resolveWithinCwd } from '../../../lib/file-route-guards.js';
import { logger } from '../../../lib/logger.js';
import { revealInFileManager } from '../../../lib/reveal-in-file-manager.js';
import { CapabilityToolError, defineCapability } from '../capabilities/capability-definition.js';
import { errnoOf, FILE_SENTENCES as S, fileRefusal, pathCheckRefusal } from './file-refusals.js';
import { FILE_WRITE_AREA_NOTE } from './file-deps.js';

/** Both ends of a move, confined to `cwd`. */
async function bothEnds(cwd: string, from: string, to: string, where: string) {
  try {
    const fromR = await resolveWithinCwd(cwd, from);
    // `to` does not exist yet, so it is confined through its deepest existing
    // ancestor: a `..` escape and a symlinked parent are both refused.
    const { resolved: toResolved } = await resolveWithinCwd(cwd, to);
    return { validatedCwd: fromR.validatedCwd, fromResolved: fromR.resolved, toResolved };
  } catch (err) {
    throw pathCheckRefusal(err, where, { cwd, from, to });
  }
}

/** `files.create`: a new file (with optional text) or folder. */
export const filesCreateCapability = defineCapability({
  id: 'files.create',
  title: 'Make a file or folder',
  description:
    'Make a file (`type: "file"`, with optional `content`) or a folder (`type: "dir"`) at ' +
    '`path` under `cwd`, with any folders above it. Refused when something already has the ' +
    'name. A person’s door: agents make files with their own tools.',
  tier: 'act',
  area: null,
  areaNote: FILE_WRITE_AREA_NOTE,
  input: CreateEntryRequestSchema,
  output: CreateEntryResponseSchema,
  surfaces: { http: { method: 'post', path: '/api/files', success: 201, audience: 'person' } },
  invoke: async (_deps, { cwd, path: relPath, type, content }) => {
    let validatedCwd: string;
    let resolved: string;
    try {
      ({ validatedCwd, resolved } = await resolveWithinCwd(cwd, relPath));
    } catch (err) {
      throw pathCheckRefusal(err, 'create', { cwd, path: relPath });
    }
    if (resolved === validatedCwd) throw fileRefusal('FILE_WORKING_FOLDER_ROOT', S.rootReplaced);
    const taken = await fs
      .access(resolved)
      .then(() => true)
      .catch(() => false);
    if (taken) throw fileRefusal('FILE_NAME_TAKEN', S.nameTaken);

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
      if (errnoOf(err) === 'EACCES') throw fileRefusal('FILE_CHANGE_NOT_ALLOWED', S.notAllowed);
      logger.error('[files] create failed', { err, resolved });
      throw fileRefusal('FILE_ACTION_FAILED', S.createFailed);
    }
    return { ok: true as const, path: relForResponse };
  },
});

/** `files.delete`: a file, or a folder (`recursive` for one with something in it). */
/**
 * The delete's input as the capability takes it: `recursive` stays the literal
 * `'true'` or `'false'`, because a capability's input must be describable as JSON
 * Schema (the catalog and the API document render it), and a transform is not.
 * Only the literal `'true'` deletes recursively: never `z.coerce.boolean`, which
 * reads `'false'` as true (data loss).
 */
const DeleteEntryInputSchema = DeleteEntryQuerySchema.extend({
  recursive: z.enum(['true', 'false']).optional(),
});

export const filesDeleteCapability = defineCapability({
  id: 'files.delete',
  title: 'Delete a file or folder',
  description:
    'Delete the file or folder at `path` under `cwd`. A folder with something in it needs ' +
    '`recursive`. The chat’s top folder is never deleted. A person’s door: agents delete ' +
    'files with their own tools.',
  // Not `destructive`: that tier asks a person to approve, and only a person calls this.
  tier: 'act',
  area: null,
  areaNote: FILE_WRITE_AREA_NOTE,
  input: DeleteEntryInputSchema,
  output: FileMutationResponseSchema,
  surfaces: { http: { method: 'delete', path: '/api/files', audience: 'person' } },
  invoke: async (_deps, { cwd, path: relPath, recursive: recursiveFlag }) => {
    const recursive = recursiveFlag === 'true';
    let validatedCwd: string;
    let resolved: string;
    try {
      ({ validatedCwd, resolved } = await resolveWithinCwd(cwd, relPath));
    } catch (err) {
      throw pathCheckRefusal(err, 'delete', { cwd, path: relPath });
    }
    if (resolved === validatedCwd) throw fileRefusal('FILE_WORKING_FOLDER_ROOT', S.rootDeleted);
    try {
      const stat = await fs.lstat(resolved);
      if (stat.isDirectory() && !recursive && (await fs.readdir(resolved)).length > 0) {
        throw fileRefusal('FILE_FOLDER_NOT_EMPTY', S.folderNotEmpty);
      }
      await fs.rm(resolved, { recursive, force: false });
    } catch (err) {
      if (err instanceof CapabilityToolError) throw err;
      const code = errnoOf(err);
      if (code === 'ENOENT') throw fileRefusal('FILE_GONE', S.gone);
      if (code === 'ENOTEMPTY') throw fileRefusal('FILE_FOLDER_NOT_EMPTY', S.folderNotEmpty);
      if (code === 'EACCES') throw fileRefusal('FILE_CHANGE_NOT_ALLOWED', S.notAllowed);
      logger.error('[files] delete failed', { err, resolved });
      throw fileRefusal('FILE_ACTION_FAILED', S.deleteFailed);
    }
    return { ok: true as const };
  },
});

/** `files.rename`: move or rename an entry; the destination must be free. */
export const filesRenameCapability = defineCapability({
  id: 'files.rename',
  title: 'Move or rename a file or folder',
  description:
    'Move the entry at `from` to `to`, both under `cwd`, making any folders above `to`. ' +
    'Refused when `from` is gone or `to` is taken. A person’s door: agents move files with ' +
    'their own tools.',
  tier: 'act',
  area: null,
  areaNote: FILE_WRITE_AREA_NOTE,
  input: RenameEntryRequestSchema,
  output: FileMutationResponseSchema,
  surfaces: { http: { method: 'post', path: '/api/files/rename', audience: 'person' } },
  invoke: async (_deps, { cwd, from, to }) => {
    const { validatedCwd, fromResolved, toResolved } = await bothEnds(cwd, from, to, 'rename');
    if (fromResolved === validatedCwd || toResolved === validatedCwd) {
      throw fileRefusal('FILE_WORKING_FOLDER_ROOT', S.rootMoved);
    }
    const present = await fs
      .access(fromResolved)
      .then(() => true)
      .catch(() => false);
    if (!present) throw fileRefusal('FILE_GONE', S.goneToMove);
    const taken = await fs
      .access(toResolved)
      .then(() => true)
      .catch(() => false);
    if (taken) throw fileRefusal('FILE_NAME_TAKEN', S.nameTaken);
    try {
      await fs.mkdir(path.dirname(toResolved), { recursive: true });
      await fs.rename(fromResolved, toResolved);
    } catch (err) {
      if (errnoOf(err) === 'EACCES') throw fileRefusal('FILE_CHANGE_NOT_ALLOWED', S.notAllowed);
      logger.error('[files] rename failed', { err, fromResolved, toResolved });
      throw fileRefusal('FILE_ACTION_FAILED', S.moveFailed);
    }
    return { ok: true as const };
  },
});

/** `files.reveal`: show an entry in the file manager of the computer DorkOS runs on. */
export const filesRevealCapability = defineCapability({
  id: 'files.reveal',
  title: 'Show a file in Finder',
  description:
    'Open the file manager on the computer DorkOS runs on (Finder, File Explorer or the ' +
    'desktop’s own) at the entry at `path` under `cwd`. Nothing is read or written. A ' +
    'person’s door.',
  tier: 'act',
  area: null,
  areaNote: 'opens a window on this computer for the person using the app',
  input: RevealEntryRequestSchema,
  output: z.null(),
  surfaces: {
    http: { method: 'post', path: '/api/files/reveal', success: 204, audience: 'person' },
  },
  invoke: async (_deps, { cwd, path: relPath }) => {
    let resolved: string;
    try {
      ({ resolved } = await resolveWithinCwd(cwd, relPath));
    } catch (err) {
      throw pathCheckRefusal(err, 'reveal', { cwd, path: relPath });
    }
    const present = await fs
      .access(resolved)
      .then(() => true)
      .catch(() => false);
    if (!present) throw fileRefusal('FILE_GONE', S.gone);
    try {
      // Every launcher runs through `execFile` with an argument array, never a shell.
      await revealInFileManager(resolved);
    } catch (err) {
      logger.error('[files] reveal failed', { err, resolved });
      throw fileRefusal('FILE_ACTION_FAILED', S.revealFailed);
    }
    return null;
  },
});
