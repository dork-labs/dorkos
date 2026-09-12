/**
 * A room's shared canvas — the room's own policy over the one writer that
 * changes every canvas on this machine (specs `room-canvas`,
 * `canvas-agent-seat` §1.2).
 *
 * The table, the dedupe rule and the pure key functions live in
 * `services/canvas/`, because a canvas that serves two scopes is not a rooms
 * concern. What is here is what a ROOM adds: membership, the archived refusal,
 * the per-turn ceiling and the coalesced line.
 *
 * @module server/services/rooms/canvas
 */
export {
  CanvasDocumentStore,
  toCanvasDocument,
  canvasDocumentId,
  canvasSourceKey,
  canvasSourcePath,
  canvasTitle,
  type CanvasDocumentInsert,
  type CanvasDocumentRow,
} from '../../canvas/index.js';
export {
  CANVAS_EDIT_HEARTBEAT_MS,
  CANVAS_EDIT_TTL_MS,
  MAX_ROOM_CANVAS_DOCUMENTS,
  NOT_IN_A_ROOM_MESSAGE,
  NO_DEFAULT_DOCUMENT_MESSAGE,
  OPEN_CANVAS_NEEDS_CONTENT_MESSAGE,
  RoomCanvasService,
  canvasChangeSentence,
  documentBeingEditedMessage,
  roomScope,
  tooManyCanvasOpsMessage,
  type CanvasApplyResult,
  type CanvasLedgerEntry,
  type CanvasOpenOptions,
  type RoomCanvasDeps,
} from './room-canvas-service.js';
