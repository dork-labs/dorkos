/**
 * The problem documents the file routes (`routes/files.ts`,
 * `routes/file-entries.ts`) share (DOR-4979): one fixed sentence per case,
 * never a path or an error's own text. The cause goes to the log.
 *
 * @module routes/file-problems
 */
import type { Context } from 'hono';
import { problem } from '@dorkos/http-kit';
import { pathRefusalProblem } from '../http/problems/boundary-refusal.js';
import { logger } from '../lib/logger.js';

/** A thing that already has the name a create, move or copy asked for. */
export const NAME_TAKEN = 'Something with that name is already there.';

/** The operating system refused DorkOS a change in the chat's folder. */
export const NOT_ALLOWED_TO_CHANGE = 'DorkOS isn’t allowed to change that.';

/** A file a read or a save named is not there. */
export const FILE_MISSING = 'That file doesn’t exist.';

/** A path that names a folder where a file was needed. */
export const FOLDER_NOT_FILE = 'That path is a folder, not a file.';

/** A path the operating system could not follow (a loop, a file used as a folder). */
export const PATH_UNFOLLOWABLE = 'That path can’t be followed.';

/**
 * Answer a path `resolveWithinCwd` refused, or, for anything else it threw,
 * log the cause and answer `500 internal_error`.
 *
 * @param c - The Hono context.
 * @param err - What the path check threw.
 * @param where - The route, for the log line (`POST /rename`).
 * @param context - What the log line also records (the paths asked for).
 * @returns The response.
 */
export function pathCheckFailure(
  c: Context,
  err: unknown,
  where: string,
  context: Readonly<Record<string, unknown>>
): Response {
  const refusal = pathRefusalProblem(c, err);
  if (refusal) return refusal;
  logger.error(`[files] ${where} boundary failed`, { err, ...context });
  return problem(c, 'internal_error', { detail: 'Couldn’t check that path. Try again.' });
}
