/**
 * The in-process half of a session's own canvas (spec `canvas-agent-seat` §1.6).
 *
 * **The embed READS this machine's canvas and does not change it**, and that is
 * the same decision ADR `260825-194924` already made for the message index: the
 * database belongs to whoever installed DorkOS, DorkOS may be running right now,
 * and two programs on different versions writing one file is not worth carrying
 * to keep a tab open. So `canvas` on {@link DirectTransportServices} is a
 * READER, and every write here refuses in one plain sentence rather than
 * pretending.
 *
 * A host that wires no canvas at all — a test harness, an older embed —
 * answers the empty list and the same refusal. Never a silent success: a write
 * that reported success and changed nothing would recreate exactly the
 * divergence this whole phase removes.
 *
 * @module shared/lib/direct/session-canvas-methods
 */
import type { UiCanvasContent } from '@dorkos/shared/types';
import type {
  CanvasDocument,
  CanvasEditingResponse,
  UpdateCanvasDocumentRequest,
} from '@dorkos/shared/room-schemas';
import type { DirectTransportServices } from './services';

/** What a person is told when they try to change the canvas from the embed. */
export const EMBEDDED_CANVAS_IS_READ_ONLY =
  'DorkOS in Obsidian shows this session’s canvas but cannot change it. Open the session in the ' +
  'DorkOS app to put something on it.';

/**
 * Create the session-canvas methods bound to the injected services.
 *
 * @param services - In-process service seams wired by the embedding host.
 * @returns The six methods, for `Object.assign` onto the transport.
 */
export function createDirectSessionCanvasMethods(services: DirectTransportServices) {
  /** Refuse a write in one sentence the caller can show a person. */
  function refuseWrite(): never {
    throw new Error(EMBEDDED_CANVAS_IS_READ_ONLY);
  }

  return {
    async listSessionCanvas(sessionId: string): Promise<CanvasDocument[]> {
      return services.canvas?.list(sessionId) ?? [];
    },

    async getSessionCanvasDocument(
      sessionId: string,
      documentId: string
    ): Promise<CanvasDocument | null> {
      return services.canvas?.get(sessionId, documentId) ?? null;
    },

    async openSessionCanvasDocument(
      _sessionId: string,
      _content: UiCanvasContent,
      _opts?: { pinned?: boolean }
    ): Promise<CanvasDocument> {
      return refuseWrite();
    },

    async updateSessionCanvasDocument(
      _sessionId: string,
      _documentId: string,
      _patch: UpdateCanvasDocumentRequest
    ): Promise<CanvasDocument> {
      return refuseWrite();
    },

    async closeSessionCanvasDocument(_sessionId: string, _documentId: string): Promise<void> {
      return refuseWrite();
    },

    async setSessionCanvasEditing(
      _sessionId: string,
      _documentId: string,
      _editing: boolean
    ): Promise<CanvasEditingResponse> {
      return refuseWrite();
    },
  };
}
