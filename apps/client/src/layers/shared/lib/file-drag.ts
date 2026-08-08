/**
 * The drag payload a dragged file row carries, and the readers for it.
 *
 * The file tree and the chat composer are separate features, so the thing they
 * both have to agree on — what a dragged file looks like on the wire — lives
 * here rather than in either of them. A row keeps `text/plain` too, so dragging
 * one into an outside editor still drops the path as text; the custom type is
 * what tells our own surfaces "this is a file reference, not a file upload".
 *
 * @module shared/lib/file-drag
 */

/**
 * The `dataTransfer` type carrying a working-directory-relative file path.
 *
 * Lowercase on purpose: browsers lowercase custom drag types on the way in, so
 * a mixed-case constant would never match what comes back out.
 */
export const FILE_PATH_DRAG_TYPE = 'application/x-dorkos-file-path';

/**
 * Whether a drag carries one of our file references.
 *
 * Safe to call during `dragover`, where the payload itself is unreadable and
 * only the type list is exposed. Compared case-insensitively, because the type
 * list is the browser's spelling of the types, not ours.
 *
 * @param types - `DataTransfer.types` from a drag event.
 */
export function hasFilePathDrag(types: readonly string[]): boolean {
  return types.some((type) => type.toLowerCase() === FILE_PATH_DRAG_TYPE);
}

/**
 * The dragged file's working-directory-relative path, or `null` when the drag
 * carries no file reference (an operating-system file drop, say).
 *
 * @param dataTransfer - The drop event's `dataTransfer`.
 */
export function readFilePathDrag(dataTransfer: DataTransfer): string | null {
  if (!hasFilePathDrag(dataTransfer.types)) return null;
  return dataTransfer.getData(FILE_PATH_DRAG_TYPE) || null;
}
