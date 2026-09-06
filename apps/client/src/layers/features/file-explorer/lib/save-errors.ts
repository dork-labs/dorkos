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
 * `REQUEST_TOO_LARGE` by the parser and never reaches the room's `FILE_TOO_LARGE`
 * at all. Both are here because a person hitting either has hit "too big", and
 * being told which ceiling it was is the difference between "split this up" and
 * "this does not belong in a room's files".
 *
 * @module features/file-explorer/lib/save-errors
 */
import { RoomFileConflictResponseSchema, type RoomFileConflict } from '@dorkos/shared/room-files';

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
  [
    'REQUEST_TOO_LARGE',
    'That is too much text to send in one go, so nothing was saved. A room’s files are for documents people read. Anything this big belongs in the room’s attachments.',
  ],
  ['FILE_TOO_LARGE', 'This file would be bigger than this room allows, so nothing was saved.'],
  [
    'REPO_CAP_EXCEEDED',
    'This room’s files are already as large as they are allowed to get, so nothing was saved.',
  ],
  [
    'MAIN_CHECKOUT_DIRTY',
    'Somebody changed this room’s files outside DorkOS, so saving is paused until that is sorted out. The warning above the files says how.',
  ],
  [
    'MERGE_IN_FLIGHT',
    'Somebody else is writing to this room’s files right now. Nothing was saved. Try again in a moment.',
  ],
  [
    'PEOPLE_ONLY',
    'Only a person can save a room’s files this way. An agent brings its work in by merging.',
  ],
  [
    'ROOM_FILE_NOT_TEXT',
    'This file has something in it that is not text, so it cannot be saved from here.',
  ],
  ['ROOM_FILE_PATH_INVALID', 'That file name could mean somewhere else, so nothing was saved.'],
  [
    'ROOM_FILE_NOT_FOUND',
    'This file is not in the room’s files any more, so there was nothing to save over.',
  ],
  ['ROOM_FILE_NOT_READABLE', 'This is not a file that can be edited here.'],
  ['ROOM_HAS_NO_REPO', 'This room does not have files of its own any more.'],
  [
    'ROOM_REPOS_DISABLED',
    'Rooms cannot have files of their own on this install right now, so nothing was saved.',
  ],
  [
    'ROOM_REPO_GIT_UNAVAILABLE',
    'This computer doesn’t have git installed, and a room’s files are a git repository.',
  ],
  ['ROOM_NOT_FOUND', 'This room is not there any more.'],
  ['ROOM_ARCHIVED', 'This room is archived, so its files cannot be changed.'],
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
