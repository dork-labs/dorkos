/**
 * What a person is told when a room refuses to save their file (spec
 * `project-rooms` §3.10).
 *
 * Every sentence here is written for the person who pressed Save, not for the
 * developer reading the log: it says what happened and what they can do about
 * it, and it never blames them for a rule they could not have known.
 *
 * **The refusals that are FACTS about the file or the room live here; the
 * refusal that is a RACE does not.** `FILE_CHANGED` is the one a person answers
 * with a decision rather than an acknowledgement, so it comes back as a
 * conflict outcome with the other version's commit attached, and none of these
 * sentences would fit it.
 *
 * **Two ceilings, two answers.** The server accepts 1 MB of request body, which
 * is well under a room's own per-file cap — so a very large save is refused
 * `request_too_large` by the parser and never reaches the room's `file_too_large`
 * at all. Both are here because a person hitting either has hit "too big", and
 * being told which ceiling it was is the difference between "split this up" and
 * "this does not belong in a room's files".
 *
 * @module features/file-explorer/lib/save-errors
 */
import { RoomFileConflictResponseSchema, type RoomFileConflict } from '@dorkos/shared/room-files';
import { ROOM_REPO_CONFIG_UNSAFE_CODE, ROOM_REPO_CONFIG_UNSAFE_FALLBACK } from './crud-errors';

/**
 * The sentence for each refusal a save can come back with.
 *
 * A `Map` rather than an object literal, for the reason
 * `room-files-source`'s read table is one: the key is a string off a thrown
 * error, and an object would answer `'constructor'` with something from its
 * prototype — turning a refusal nobody wrote copy for into a sentence that is
 * not a sentence.
 */
const SAVE_REFUSAL_COPY = new Map<string, string>([
  ['request_too_large', 'Too much text to save here. Put big files in the room’s attachments.'],
  ['file_too_large', 'This file is bigger than the room allows, so it wasn’t saved.'],
  ['repo_cap_exceeded', 'This room’s files are full, so nothing was saved.'],
  [
    'main_checkout_dirty',
    'Saving is paused. Somebody changed these files outside DorkOS. See the warning above.',
  ],
  [
    'merge_in_flight',
    'Somebody else is saving these files. Nothing was saved. Try again in a moment.',
  ],
  ['person_only', 'Only a person can save here. Agents bring work in by merging.'],
  ['room_file_not_text', 'This file isn’t plain text, so it can’t be saved here.'],
  ['room_file_path_invalid', 'That file name points somewhere else, so nothing was saved.'],
  ['room_file_not_found', 'This file is gone from the room, so there was nothing to save over.'],
  ['room_file_not_readable', 'This file can’t be edited here.'],
  ['room_has_no_repo', 'This room no longer has its own files.'],
  ['room_repos_disabled', 'Room files are turned off on this install, so nothing was saved.'],
  ['room_repo_git_unavailable', 'Room files need git, and git isn’t installed on this computer.'],
  ['room_not_found', 'This room no longer exists.'],
  ['room_archived', 'This room is archived, so its files can’t be changed.'],
  [ROOM_REPO_CONFIG_UNSAFE_CODE, ROOM_REPO_CONFIG_UNSAFE_FALLBACK],
]);

/**
 * The sentence for a save refusal, or `undefined` when nobody wrote one.
 *
 * A caller with `undefined` in hand rethrows: a refusal this table does not
 * know is a bug rather than a rule, and swallowing it into a friendly sentence
 * is how a bug becomes invisible.
 *
 * @param code - The `code` the transport put on the thrown error.
 */
export function saveRefusalMessage(code: string | undefined): string | undefined {
  return code === undefined ? undefined : SAVE_REFUSAL_COPY.get(code);
}

/**
 * The conflict a `FILE_CHANGED` refusal carries, or `null` when it does not
 * carry one this client can use.
 *
 * **Parsed rather than cast.** The commit that comes back here is sent straight
 * out again as the next save's `baseCommit`, so it decides which version gets
 * overwritten; a shape that merely looked right would be the one bug on this
 * path nobody sees until somebody loses work. The schema is the same one the
 * server answers with.
 *
 * @param err - Whatever the transport threw.
 */
export function roomFileConflictOf(err: unknown): RoomFileConflict | null {
  if (typeof err !== 'object' || err === null) return null;
  const parsed = RoomFileConflictResponseSchema.safeParse((err as { body?: unknown }).body);
  return parsed.success ? parsed.data.conflict : null;
}
