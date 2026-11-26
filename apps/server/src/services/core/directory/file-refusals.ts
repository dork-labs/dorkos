/**
 * How the file browser's doors refuse over HTTP once the capability mount serves
 * them (DOR-4978): the hand routes' problem codes and sentences, kept. A
 * capability throws a `CapabilityToolError` whose problem comes from a fixed
 * table (`routes/capability-refusals.ts`); {@link FILE_TOOL_REFUSALS} is this
 * domain's part of it, and the file capabilities throw only these sentences.
 * Never a path or a file's text in a sentence; the cause goes to the log.
 *
 * @module services/core/directory/file-refusals
 */
import type { DocSaveRefusalReason } from '@dorkos/shared/file-save/recovery';
import type { ProblemCode } from '@dorkos/shared/problem';
import { logger } from '../../../lib/logger.js';
import { CapabilityToolError } from '../capabilities/capability-definition.js';
import { pathToolError } from './path-refusal.js';

/** Every sentence the file doors refuse with, as the hand routes said it. */
export const FILE_SENTENCES = {
  fileMissing: 'That file doesn’t exist.',
  folderNotFile: 'That path is a folder, not a file.',
  tooLargeForText: 'That file is too large to open as text.',
  notText: 'That file isn’t text, so it can’t open here.',
  nameTaken: 'Something with that name is already there.',
  notAllowed: 'DorkOS isn’t allowed to change that.',
  folderNotEmpty: 'That folder isn’t empty, so nothing was deleted.',
  rootReplaced: 'The chat’s top folder can’t be replaced.',
  rootDeleted: 'The chat’s top folder can’t be deleted.',
  rootMoved: 'The chat’s top folder can’t be moved.',
  gone: 'That isn’t there anymore.',
  goneToMove: 'The item to move isn’t there anymore.',
  changedSinceOpened: 'This file changed since you opened it.',
  replacedWhileSaving: 'This file was replaced while saving. Reload it, then save again.',
  saveIdConflict: 'This save doesn’t match the one recorded under its id.',
  saveNotApplied: 'That save failed before it changed the file. Send a new save.',
  saveInDoubt: 'The last save needs checking first. Try again soon.',
  saveNotReady: 'Saving files isn’t ready yet. Try again in a moment.',
  documentUnavailable: 'The document is not available.',
  pathCheckFailed: 'Couldn’t check that path. Try again.',
  readFailed: 'Couldn’t read that file. Try again.',
  createFailed: 'Couldn’t create that. Try again.',
  deleteFailed: 'Couldn’t delete that. Try again.',
  moveFailed: 'Couldn’t move that. Try again.',
  saveFailed: 'Couldn’t save that file. Try again.',
  revealFailed: 'Couldn’t open the file manager.',
} as const;

/**
 * Why a chat's canvas will not save its file, for the owner once they are known
 * to be asking (DOR-4442): one sentence per check, never a path. The save
 * (`files.save`) and its recovery routes (`routes/file-saves/recovery.ts`) share it.
 */
export const REFUSED_BECAUSE: Readonly<Record<DocSaveRefusalReason, string>> = {
  not_session: 'Only files on a chat’s canvas can be edited here.',
  no_recorded_folder: 'This file’s folder wasn’t recorded when it was opened, so editing is off.',
  root_mismatch: 'This file isn’t in this chat’s agent folder, so editing is off.',
  folder_gone: 'This file’s folder was moved or deleted, so editing is off.',
  outside_boundary: 'This file is outside the folders this chat can edit.',
};

/** One refusal: its problem code, its fixed sentence, and what else it may carry. */
interface FileToolRefusal {
  readonly code: ProblemCode;
  readonly detail: string;
  readonly alsoSays?: readonly string[];
  readonly carries?: readonly string[];
}

const S = FILE_SENTENCES;

/** The file doors' tool codes, each with the hand route's problem code and sentence. */
export const FILE_TOOL_REFUSALS: Readonly<Record<string, FileToolRefusal>> = {
  FILE_MISSING: { code: 'not_found', detail: S.fileMissing },
  FILE_GONE: { code: 'not_found', detail: S.gone, alsoSays: [S.goneToMove] },
  FILE_PATH_IS_FOLDER: { code: 'not_a_file', detail: S.folderNotFile },
  FILE_TOO_LARGE_FOR_TEXT: { code: 'too_large', detail: S.tooLargeForText },
  FILE_NOT_TEXT: { code: 'binary_file', detail: S.notText },
  FILE_NAME_TAKEN: { code: 'already_exists', detail: S.nameTaken },
  FILE_CHANGE_NOT_ALLOWED: { code: 'forbidden', detail: S.notAllowed },
  FILE_FOLDER_NOT_EMPTY: { code: 'folder_not_empty', detail: S.folderNotEmpty },
  FILE_WORKING_FOLDER_ROOT: {
    code: 'working_folder_root',
    detail: S.rootReplaced,
    alsoSays: [S.rootDeleted, S.rootMoved],
  },
  // The editor reconciles from the file as it is now, so the refusal carries it.
  FILE_CHANGED_SINCE_OPENED: {
    code: 'precondition_failed',
    detail: S.changedSinceOpened,
    carries: ['currentHash', 'currentContent'],
  },
  FILE_REPLACED_WHILE_SAVING: { code: 'precondition_failed', detail: S.replacedWhileSaving },
  FILE_SAVE_ID_CONFLICT: { code: 'precondition_failed', detail: S.saveIdConflict },
  FILE_SAVE_NOT_APPLIED: { code: 'save_not_applied', detail: S.saveNotApplied },
  FILE_SAVE_IN_DOUBT: { code: 'temporarily_unavailable', detail: S.saveInDoubt },
  FILE_SAVE_UNAVAILABLE: { code: 'temporarily_unavailable', detail: S.saveNotReady },
  // For the owner, the check that refused (DOR-4442); never a path.
  FILE_DOCUMENT_UNAVAILABLE: {
    code: 'not_found',
    detail: S.documentUnavailable,
    alsoSays: Object.values(REFUSED_BECAUSE),
  },
  FILE_ACTION_FAILED: {
    code: 'internal_error',
    detail: S.readFailed,
    alsoSays: [
      S.pathCheckFailed,
      S.createFailed,
      S.deleteFailed,
      S.moveFailed,
      S.saveFailed,
      S.revealFailed,
    ],
  },
};

/** The tool codes, by name, for the capabilities that throw them. */
export type FileToolCode = keyof typeof FILE_TOOL_REFUSALS;

/**
 * A file door's refusal.
 *
 * @param code - One of {@link FILE_TOOL_REFUSALS}'s codes.
 * @param error - One of {@link FILE_SENTENCES}, or for a document save, a {@link REFUSED_BECAUSE} sentence.
 * @param extra - What the refusal carries beside its sentence (a stale save's file as it is now).
 */
export function fileRefusal(
  code: FileToolCode,
  error: string,
  extra: Readonly<Record<string, string>> = {}
): CapabilityToolError {
  return new CapabilityToolError({ ...extra, error, code });
}

/**
 * The refusal for a path `resolveWithinCwd` refused; for anything else it threw,
 * the cause is logged and the answer is `500` with a fixed sentence.
 *
 * @param err - What the path check threw.
 * @param where - The door, for the log line.
 * @param context - What the log line also records (the paths asked for).
 */
export function pathCheckRefusal(
  err: unknown,
  where: string,
  context: Readonly<Record<string, unknown>>
): CapabilityToolError {
  const refusal = pathToolError(err);
  if (refusal) return refusal;
  logger.error(`[files] ${where} boundary failed`, { err, ...context });
  return fileRefusal('FILE_ACTION_FAILED', S.pathCheckFailed);
}

/** The errno an operating-system failure carries, if any. */
export function errnoOf(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}
