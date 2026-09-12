/**
 * The canvas: the table every document on this machine sits on, whether a room
 * shares it or one person owns it (specs `room-canvas`, `canvas-agent-seat`).
 *
 * **Its own service domain, and that is the point.** A canvas that serves two
 * scopes is not a rooms concern — leaving it under `services/rooms/` would have
 * `services/session/` importing from `services/rooms/` to answer a question with
 * nothing to do with rooms. `RoomCanvasService` stays where it is and keeps the
 * room's own policy: membership, the archived refusal, the per-turn ceiling and
 * the ledger.
 *
 * **The two session listeners are wired HERE, at module scope**, the way
 * `message-dispatcher.ts` wires its own. `index.ts` is the composition root for
 * the server and the Obsidian shell never runs it, so a listener registered
 * there would exist in one shell and not the other — and the half that would go
 * missing is the one that carries a canvas across a session rename. There is
 * nothing to configure and nothing to tear down, so there is nothing for a root
 * to decide.
 *
 * @module server/services/canvas
 */
import { onProjectorRekey } from '../session/session-state-projector.js';
import { onSessionRemoved } from '../session/session-list-broadcaster.js';
import { CanvasService } from './canvas-service.js';
import { sessionScope } from './scopes.js';

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
  SESSION_AGENT_AUTHOR,
  SESSION_OWNER_AUTHOR,
  parseScope,
  roomIdForScope,
  roomScope,
  sessionScope,
  type CanvasScope,
} from './scopes.js';
export { publishSessionCanvas, sessionCanvasViewers } from './session-channel.js';
export {
  CANVAS_EDIT_HEARTBEAT_MS,
  CANVAS_EDIT_TTL_MS,
  CANVAS_VERBS,
  CanvasService,
  MAX_CANVAS_DOCUMENTS,
  NOTHING_ON_THE_CANVAS_MESSAGE,
  NO_DEFAULT_DOCUMENT_MESSAGE,
  OPEN_CANVAS_NEEDS_CONTENT_MESSAGE,
  contentFor,
  documentBeingEditedMessage,
  type CanvasApplyResult,
  type CanvasChannels,
  type CanvasDefaultTarget,
  type CanvasDeps,
  type CanvasFrame,
  type CanvasLedgerEntry,
  type CanvasOpenOptions,
  type CanvasTreePlacement,
} from './canvas-service.js';

/** The one canvas service this process serves every scope from. */
let active: CanvasService | null = null;

/**
 * Register the canvas service at bootstrap, beside `setRoomService`.
 *
 * One instance per process, because "one writer" is a claim about the table and
 * two instances over one database would each publish only half of it.
 *
 * @param service - The wired service.
 */
export function setCanvasService(service: CanvasService): void {
  active = service;
}

/**
 * The active canvas service.
 *
 * @returns The service.
 * @throws {Error} When nothing has registered one — a wiring fault, caught at boot.
 */
export function getCanvasService(): CanvasService {
  if (!active) throw new Error('CanvasService not initialized');
  return active;
}

/**
 * The active canvas service, or `undefined` when this process has none.
 *
 * For the callers that must degrade rather than throw: a snapshot decoration on
 * a host that never stood a canvas up should answer with an empty table, not
 * take the session stream down.
 *
 * @returns The service, or `undefined`.
 */
export function peekCanvasService(): CanvasService | undefined {
  return active ?? undefined;
}

// Wired on import rather than from the composition root, for the reason the
// module doc gives: both shells import this domain, and only one of them runs
// `index.ts`. Both listeners are no-ops until a service is registered.
onProjectorRekey((oldId, newId) => {
  active?.rekeyScope(sessionScope(oldId), sessionScope(newId));
});
onSessionRemoved((sessionId) => {
  active?.noteSessionOrphaned(sessionId);
});
