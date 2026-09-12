/**
 * A room's shared canvas — the table its members put documents on, the one
 * writer that changes it, and the pure key functions that decide when two opens
 * are the same document (spec `room-canvas`).
 *
 * @module server/services/rooms/canvas
 */
export {
  CanvasDocumentStore,
  toCanvasDocument,
  type CanvasDocumentInsert,
  type CanvasDocumentRow,
} from './canvas-document-store.js';
export {
  canvasDocumentId,
  canvasSourceKey,
  canvasSourcePath,
  canvasTitle,
} from './document-key.js';
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
