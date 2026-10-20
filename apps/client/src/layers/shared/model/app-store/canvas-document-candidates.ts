import type { CanvasDocument as ServerCanvasDocument } from '@dorkos/shared/room-schemas';
import type { UiCanvasContent } from '@dorkos/shared/types';
import { canvasSourceKey as sourceKey } from '@dorkos/shared/canvas-source-key';
import { stableStringify } from '@dorkos/shared/capabilities';
import type { CanvasDocument } from './app-store-canvas';

/**
 * One canvas content, reduced to a string two equal contents share.
 *
 * Key-order-insensitive because the server re-parses what it is sent, so the
 * same document can come back with its fields in schema order.
 */
export function contentFingerprint(content: UiCanvasContent): string {
  return stableStringify(content);
}

/** A `pending:` id belongs to a row this window minted and has not heard back about. */
export function isPendingId(id: string): boolean {
  return id.startsWith('pending:');
}

/** Remember possible echoes once, so later content updates cannot erase their temporary identity. */
export function observePendingCandidates(
  documents: CanvasDocument[],
  incoming: readonly ServerCanvasDocument[]
): CanvasDocument[] {
  const presentIds = new Set([
    ...documents.filter((doc) => !isPendingId(doc.id)).map((doc) => doc.id),
    ...incoming.map((row) => row.id),
  ]);
  return documents.map((doc) => {
    if (!isPendingId(doc.id)) return doc;
    const candidates = new Set((doc.pendingCandidateIds ?? []).filter((id) => presentIds.has(id)));
    const key = sourceKey(doc.content);
    for (const row of incoming) {
      if (doc.pendingBaselineIds?.includes(row.id)) continue;
      if (
        key
          ? key === sourceKey(row.content)
          : contentFingerprint(doc.content) === contentFingerprint(row.content)
      )
        candidates.add(row.id);
    }
    const ids = [...candidates];
    const previous = doc.pendingCandidateIds ?? [];
    return ids.length === previous.length && ids.every((id, index) => id === previous[index])
      ? doc
      : { ...doc, pendingCandidateIds: ids };
  });
}

/** Bound possible echo IDs by the retained table, preserving live pinned rows over evicted twins. */
export function prunePendingCandidates(documents: CanvasDocument[]): CanvasDocument[] {
  const retained = new Set(documents.filter((doc) => !isPendingId(doc.id)).map((doc) => doc.id));
  let changed = false;
  const pruned = documents.map((doc) => {
    if (!doc.pendingCandidateIds) return doc;
    const ids = doc.pendingCandidateIds.filter((id) => retained.has(id));
    if (ids.length === doc.pendingCandidateIds.length) return doc;
    changed = true;
    return { ...doc, pendingCandidateIds: ids };
  });
  return changed ? pruned : documents;
}
