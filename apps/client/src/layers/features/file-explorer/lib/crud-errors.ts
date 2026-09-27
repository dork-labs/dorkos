import { toast } from 'sonner';
import { ROOM_UPLOAD_MAX_FILES } from '@dorkos/shared/room-files';
import { errorCodeOf } from './error-code';

/**
 * @module features/file-explorer/lib/crud-errors
 */

/** The coded file-service failures the explorer distinguishes. */
export type CrudErrorCode =
  | 'CONFLICT'
  | 'COPY_INTO_SELF'
  | 'DIR_NOT_EMPTY'
  | 'NOT_FOUND'
  | 'REFUSE_ROOT'
  | 'OUTSIDE_BOUNDARY';

const KNOWN_CODES: readonly CrudErrorCode[] = [
  'CONFLICT',
  'COPY_INTO_SELF',
  'DIR_NOT_EMPTY',
  'NOT_FOUND',
  'REFUSE_ROOT',
  'OUTSIDE_BOUNDARY',
];

/** Read the stable `code` off a thrown file-service error, if present. */
export function getErrorCode(err: unknown): CrudErrorCode | undefined {
  const code = errorCodeOf(err);
  return code !== undefined && (KNOWN_CODES as readonly string[]).includes(code)
    ? (code as CrudErrorCode)
    : undefined;
}

/**
 * The one sentence the "folder into itself" refusal says.
 *
 * Exported because two things can catch it: the explorer refuses the obvious
 * cases before asking, and the server refuses the rest — including the ones the
 * client cannot see, like a case-insensitive filesystem where `SRC` and `src`
 * are the same folder. Both must read the same, or the same mistake would
 * produce two different explanations.
 */
export const COPY_INTO_SELF_MESSAGE = 'Can’t copy a folder into itself';

/**
 * The room refusing all work on its files because its shared git settings name
 * a program git would run (spec `agent-home-desk` §5.2). The server's sentence
 * names each setting and the command that removes it, so it is the one a person
 * sees wherever the refusal surfaces: the listing, a save, or any other change.
 */
export const ROOM_REPO_CONFIG_UNSAFE_CODE = 'ROOM_REPO_CONFIG_UNSAFE';

/**
 * What a person reads for {@link ROOM_REPO_CONFIG_UNSAFE_CODE} when the server
 * sent no sentence of its own. Exported so the save table says the same thing.
 */
export const ROOM_REPO_CONFIG_UNSAFE_FALLBACK =
  'This room’s git settings could make git run a program, so DorkOS has stopped working on its files until they are removed. DorkOS’s log names each setting and how to remove it.';

/** User-facing, boundary-safe message for each coded failure. */
const MESSAGES: Record<CrudErrorCode, string> = {
  CONFLICT: 'That name already exists',
  COPY_INTO_SELF: COPY_INTO_SELF_MESSAGE,
  DIR_NOT_EMPTY: 'This folder isn’t empty',
  NOT_FOUND: 'That item no longer exists',
  REFUSE_ROOT: 'Can’t modify the working directory root',
  OUTSIDE_BOUNDARY: 'That path is outside the working directory',
};

/**
 * Surface a file-service error as a toast, keyed by its code. Falls back to
 * `fallback` for an uncoded error so no raw filesystem path ever leaks.
 *
 * @param err - The thrown error (its `code` selects the message).
 * @param fallback - Message used when the error carries no known code.
 */
export function toastCrudError(err: unknown, fallback: string): void {
  const code = getErrorCode(err);
  toast.error(code ? MESSAGES[code] : fallback);
}

/**
 * The sentence for each refusal a change to a room's files can come back with
 * (spec `agent-home-desk` §7.3) — an upload, a rename or move, a delete, or a
 * file saved from the chat.
 *
 * Written for the person who pressed the button: what happened, and what they
 * can do. `FILE_CHANGED` is not here, because a person answers it with a choice
 * rather than reading a sentence; `ROOM_FILE_EXISTS` is not either, because each
 * operation asks its own question about it.
 *
 * A `Map`, for the reason `save-errors`' table is one: the key is a string off a
 * thrown error, and an object literal would answer `'constructor'`.
 */
const ROOM_CHANGE_REFUSAL_COPY = new Map<string, string>([
  [
    'ROOM_UPLOAD_TOO_MANY_FILES',
    `One upload can carry up to ${ROOM_UPLOAD_MAX_FILES} files, so nothing was uploaded. Try again with fewer.`,
  ],
  ['FILE_TOO_LARGE', 'A file is bigger than this room allows, so nothing was changed.'],
  [
    'REPO_CAP_EXCEEDED',
    'This room’s files are already as large as they are allowed to get, so nothing was changed. Delete something first.',
  ],
  [
    'MAIN_CHECKOUT_DIRTY',
    'Somebody changed this room’s files outside DorkOS, so changes are paused until that is sorted out. The warning above the files says how.',
  ],
  [
    'MERGE_IN_FLIGHT',
    'Somebody else is changing this room’s files right now, so nothing was changed. Try again in a moment.',
  ],
  [
    'PEOPLE_ONLY',
    'Only a person can change a room’s files this way. An agent brings its work in by merging.',
  ],
  ['ROOM_FILE_PATH_INVALID', 'That name can’t be used in a room’s files, so nothing was changed.'],
  ['ROOM_FILE_NOT_READABLE', 'That isn’t something that can be changed here.'],
  [
    'ROOM_FILE_NOT_FOUND',
    'That isn’t in the room’s files any more, so nothing was changed. The list has been refreshed.',
  ],
  ['ATTACHMENT_NOT_FOUND', 'That file isn’t in this room’s chat any more.'],
  ['ROOM_HAS_NO_REPO', 'This room doesn’t have files of its own any more.'],
  [
    'ROOM_REPOS_DISABLED',
    'Rooms can’t have files of their own on this install right now, so nothing was changed.',
  ],
  [
    'ROOM_REPO_GIT_UNAVAILABLE',
    'This computer doesn’t have git installed, and a room’s files are a git repository.',
  ],
  ['ROOM_NOT_FOUND', 'This room isn’t there any more.'],
  ['ROOM_ARCHIVED', 'This room is archived, so its files can’t be changed.'],
  [ROOM_REPO_CONFIG_UNSAFE_CODE, ROOM_REPO_CONFIG_UNSAFE_FALLBACK],
]);

/**
 * The refusals whose server sentence is more useful than ours, because it names
 * the file or the limit: "This room already has `Notes/`, …", "`a/b` is a file
 * in this room, so it cannot hold other files", "… larger than this room's limit
 * for one file, 2 MB". Ours is the fallback when the server said nothing.
 */
const SERVER_SENTENCE_FIRST = new Set([
  'FILE_TOO_LARGE',
  'ROOM_FILE_PATH_INVALID',
  'ROOM_FILE_NOT_READABLE',
  ROOM_REPO_CONFIG_UNSAFE_CODE,
]);

/**
 * A server sentence made plain: the server sets file names in backticks for
 * the markdown surfaces it also writes to, and a toast is not one — so the
 * backticks become quotation marks.
 *
 * @param message - The server's `error` text.
 */
function plainServerSentence(message: string): string {
  return message.replace(/`([^`]*)`/g, '“$1”').trim();
}

/**
 * The sentence for a refused change to a room's files, or `undefined` when
 * nobody wrote one.
 *
 * A caller with `undefined` in hand rethrows, for the reason
 * `saveRefusalMessage` gives: a refusal nobody wrote copy for is a bug, and a
 * friendly sentence over it is how a bug becomes invisible.
 *
 * @param err - Whatever the transport threw.
 */
export function roomChangeRefusalMessage(err: unknown): string | undefined {
  const code = errorCodeOf(err);
  if (code === undefined) return undefined;
  const ours = ROOM_CHANGE_REFUSAL_COPY.get(code);
  if (ours === undefined) return undefined;
  return serverSentenceFirst(err) ?? ours;
}

/**
 * The server's own sentence for a refusal that names the file or the limit
 * ({@link SERVER_SENTENCE_FIRST}), made plain — or `undefined` for any other
 * refusal, or one that came with no sentence.
 *
 * Shared by every room-files write, the save included: "This room already has
 * “Notes.md”…", "The room's files are set to ignore “build/”…" and "“docs” is a
 * folder, not a file" each tell a person what to do, and a generic line in
 * their place tells them nothing.
 *
 * @param err - Whatever the transport threw.
 */
export function serverSentenceFirst(err: unknown): string | undefined {
  const code = errorCodeOf(err);
  if (code === undefined || !SERVER_SENTENCE_FIRST.has(code)) return undefined;
  if (!(err instanceof Error) || err.message.trim() === '') return undefined;
  return plainServerSentence(err.message);
}

/**
 * What a person is told when a rename, a move or a save from the chat lands
 * on a name that is already taken.
 *
 * @param name - The name that is taken.
 */
export function nameTakenMessage(name: string): string {
  return `There’s already something called “${name}” there, so nothing was changed. Pick another name.`;
}

/**
 * What to show when a room's files could not be listed at all, or `undefined`
 * to keep the pane's generic "Couldn’t load files."
 *
 * Only a refusal a person can act on earns its own sentence here. Today that is
 * {@link ROOM_REPO_CONFIG_UNSAFE_CODE}: every read of the room's files is
 * refused until somebody removes the settings, so the listing is where a person
 * meets it first. The server words it per caller (DOR-2457): the person who
 * runs DorkOS gets the settings and a `command` to paste, carried apart from
 * the sentence so nothing here rewrites it; anybody else gets a plain line and
 * no command.
 *
 * @param err - Whatever the listing threw.
 */
export function roomListRefusal(
  err: unknown
): { message: string; command: string | null } | undefined {
  if (errorCodeOf(err) !== ROOM_REPO_CONFIG_UNSAFE_CODE) return undefined;
  const body = (err as { body?: { command?: unknown } }).body;
  const command = typeof body?.command === 'string' && body.command !== '' ? body.command : null;
  return { message: serverSentenceFirst(err) ?? ROOM_REPO_CONFIG_UNSAFE_FALLBACK, command };
}
