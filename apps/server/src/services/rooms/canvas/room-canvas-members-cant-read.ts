/**
 * The open-time room canvas refusal for files other members cannot read.
 *
 * @module services/rooms/canvas/room-canvas-members-cant-read
 */
import { MEMBERS_CANT_READ_MESSAGE, membersCantRead } from '@dorkos/shared/room-canvas-reading';
import type { UiCanvasContent } from '@dorkos/shared/schemas';
import type { CanvasApplyResult, CanvasTreePlacement } from '../../canvas/index.js';

type CanvasRefusal = Extract<CanvasApplyResult, { applied: false }>;

/**
 * Apply the viewer's own reading rule before a room canvas card exists.
 *
 * DOR-4110's three security conditions meet here: the shared viewer rule makes
 * the decision, the write is refused rather than copied, and the fixed answer
 * reveals no path or existence detail. Media never matches this refusal.
 *
 * @param content - The content the command would store, or null for no content.
 * @param tree - The resolved tree the document would store, when it has one.
 * @returns The fixed refusal, or null when the write may continue.
 */
export function roomCanvasMembersCantReadRefusal(
  content: UiCanvasContent | null,
  tree: CanvasTreePlacement | undefined
): CanvasRefusal | null {
  if (content === null || tree === undefined || tree.treeKind === null) return null;
  const document = {
    content,
    treeKind: tree.treeKind,
    aheadOfMain: tree.aheadOfMain,
    sourceLabel: tree.sourceLabel ?? undefined,
  };
  if (!membersCantRead(document)) return null;
  return {
    applied: false,
    code: 'CANVAS_MEMBERS_CANT_READ',
    reason: MEMBERS_CANT_READ_MESSAGE,
  };
}
