/**
 * The HTTP half of a session's own canvas (spec `canvas-agent-seat` §1.6).
 *
 * Six thin calls over `/api/sessions/:id/canvas`, mirroring the room canvas
 * routes so one client hook can serve both scopes. The only shape that differs
 * is that a session has a real list-and-get: a room's table is hydrated purely
 * from `canvas` frames on its stream, and a session's is hydrated from the
 * stream's cold snapshot — but the one-time import from `localStorage` has to be
 * able to ask "is the table already filled?" before it writes anything, and
 * that question has no stream to ask it of.
 *
 * The caller is never sent: the server resolves who is asking and refuses
 * anyone who is not the session's owner, the same way the rest of the sessions
 * router does.
 *
 * @module shared/lib/transport/session-canvas-methods
 */
import type { UiCanvasContent } from '@dorkos/shared/types';
import type {
  CanvasDocument,
  CanvasEditingResponse,
  UpdateCanvasDocumentRequest,
} from '@dorkos/shared/room-schemas';
import { fetchJSON, fetchNoContent } from './http-client';

/** The path prefix one session's canvas lives under. */
function canvasPath(sessionId: string): string {
  return `/sessions/${encodeURIComponent(sessionId)}/canvas`;
}

/**
 * Create the session-canvas methods bound to a base URL.
 *
 * @param baseUrl - The API base URL.
 * @returns The six methods, for `Object.assign` onto the transport.
 */
export function createSessionCanvasMethods(baseUrl: string) {
  return {
    listSessionCanvas(sessionId: string): Promise<CanvasDocument[]> {
      return fetchJSON<{ documents: CanvasDocument[] }>(baseUrl, canvasPath(sessionId)).then(
        (body) => body.documents
      );
    },

    getSessionCanvasDocument(
      sessionId: string,
      documentId: string
    ): Promise<CanvasDocument | null> {
      return fetchJSON<CanvasDocument>(
        baseUrl,
        `${canvasPath(sessionId)}/${encodeURIComponent(documentId)}`
      ).catch((err: unknown) => {
        // A document that is not there is an answer, not a failure: the table is
        // LRU-capped and another window may have closed it a moment ago. Read
        // off the STATUS the client attaches rather than the sentence, which is
        // the server's prose and free to change.
        if (
          typeof err === 'object' &&
          err !== null &&
          (err as { status?: number }).status === 404
        ) {
          return null;
        }
        throw err;
      });
    },

    openSessionCanvasDocument(
      sessionId: string,
      content: UiCanvasContent,
      opts?: { pinned?: boolean }
    ): Promise<CanvasDocument> {
      return fetchJSON<CanvasDocument>(baseUrl, canvasPath(sessionId), {
        method: 'POST',
        body: JSON.stringify({
          content,
          ...(opts?.pinned !== undefined && { pinned: opts.pinned }),
        }),
      });
    },

    updateSessionCanvasDocument(
      sessionId: string,
      documentId: string,
      patch: UpdateCanvasDocumentRequest
    ): Promise<CanvasDocument> {
      return fetchJSON<CanvasDocument>(
        baseUrl,
        `${canvasPath(sessionId)}/${encodeURIComponent(documentId)}`,
        { method: 'PATCH', body: JSON.stringify(patch) }
      );
    },

    closeSessionCanvasDocument(sessionId: string, documentId: string): Promise<void> {
      return fetchNoContent(baseUrl, `${canvasPath(sessionId)}/${encodeURIComponent(documentId)}`, {
        method: 'DELETE',
      });
    },

    setSessionCanvasEditing(
      sessionId: string,
      documentId: string,
      editing: boolean
    ): Promise<CanvasEditingResponse> {
      return fetchJSON<CanvasEditingResponse>(
        baseUrl,
        `${canvasPath(sessionId)}/${encodeURIComponent(documentId)}/editing`,
        { method: 'POST', body: JSON.stringify({ editing }) }
      );
    },
  };
}
