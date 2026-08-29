import { toast } from 'sonner';
import { errorCodeOf } from './error-code';

/**
 * Boundary-safe CRUD error mapping for the file explorer (spec
 * right-panel-workbench, Chunk B). The Chunk-A transport attaches a stable
 * `code` to every thrown file-service error (both HttpTransport and
 * DirectTransport), so the UI branches on `err.code` rather than the message.
 *
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
export const COPY_INTO_SELF_MESSAGE = "Can't copy a folder into itself";

/** User-facing, boundary-safe message for each coded failure. */
const MESSAGES: Record<CrudErrorCode, string> = {
  CONFLICT: 'That name already exists',
  COPY_INTO_SELF: COPY_INTO_SELF_MESSAGE,
  DIR_NOT_EMPTY: "This folder isn't empty",
  NOT_FOUND: 'That item no longer exists',
  REFUSE_ROOT: "Can't modify the working directory root",
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
