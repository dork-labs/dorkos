/** Pure editor lock policy; no service initialization or runtime canvas dependency. */
import type { CanvasDocumentRow } from './canvas-document-store.js';

/**
 * How long a heartbeat keeps an edit lock live — three times the interval, so
 * one dropped request never drops a lock while somebody is mid-sentence.
 *
 * Evaluated LAZILY at read and write time, with no sweeper. A timer that expired
 * locks would have to be cancelled on every close, restart and room deletion,
 * and the failure mode of getting that wrong is a document nobody can ever edit
 * again. Evaluated lazily, a crashed browser simply stops holding a lock 45
 * seconds later and no code had to notice.
 */
export const CANVAS_EDIT_TTL_MS = 45_000;

/** Exact pure editor row policy shared with final checkbox authority; equality expires. */
export function canvasEditorLockHolder(
  row: Pick<CanvasDocumentRow, 'editingBy' | 'editingHeartbeatAt'>,
  now: number
): string | null {
  if (row.editingBy === null) return null;
  const heldAt = row.editingHeartbeatAt ? Date.parse(row.editingHeartbeatAt) : NaN;
  return !Number.isFinite(heldAt) || now - heldAt >= CANVAS_EDIT_TTL_MS ? null : row.editingBy;
}
