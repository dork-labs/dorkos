import { toast } from 'sonner';

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
  | 'DIR_NOT_EMPTY'
  | 'NOT_FOUND'
  | 'REFUSE_ROOT'
  | 'OUTSIDE_BOUNDARY';

const KNOWN_CODES: readonly CrudErrorCode[] = [
  'CONFLICT',
  'DIR_NOT_EMPTY',
  'NOT_FOUND',
  'REFUSE_ROOT',
  'OUTSIDE_BOUNDARY',
];

/** Read the stable `code` off a thrown file-service error, if present. */
export function getErrorCode(err: unknown): CrudErrorCode | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && (KNOWN_CODES as readonly string[]).includes(code)
    ? (code as CrudErrorCode)
    : undefined;
}

/** User-facing, boundary-safe message for each coded failure. */
const MESSAGES: Record<CrudErrorCode, string> = {
  CONFLICT: 'That name already exists',
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
