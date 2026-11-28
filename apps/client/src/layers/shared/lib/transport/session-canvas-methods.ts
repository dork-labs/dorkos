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
import { createTransportApiClient } from './api-client';
import { fetchJSON } from './http-client';

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
  const api = createTransportApiClient(baseUrl);
  return {
    async listSessionCanvas(sessionId: string): Promise<CanvasDocument[]> {
      const body = (await api.call('sessions.listCanvas', { path: { id: sessionId } })) as {
        documents: CanvasDocument[];
      };
      return body.documents;
    },

    async getSessionCanvasDocument(
      sessionId: string,
      documentId: string
    ): Promise<CanvasDocument | null> {
      try {
        return (await api.call('sessions.getCanvas', {
          path: { id: sessionId, documentId },
        })) as CanvasDocument;
      } catch (err: unknown) {
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
      }
    },

    // Stays hand-written: the API document can't describe a widget's definition (DOR-5473).
    openSessionCanvasDocument(
      sessionId: string,
      content: UiCanvasContent,
      opts?: { pinned?: boolean; openedBy?: { extensionId: string } }
    ): Promise<CanvasDocument> {
      return fetchJSON<CanvasDocument>(baseUrl, canvasPath(sessionId), {
        method: 'POST',
        body: JSON.stringify({
          content,
          ...(opts?.pinned !== undefined && { pinned: opts.pinned }),
          ...(opts?.openedBy && { openedBy: opts.openedBy }),
        }),
      });
    },

    // Stays hand-written: the API document can't describe a widget's definition (DOR-5473).
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

    async closeSessionCanvasDocument(sessionId: string, documentId: string): Promise<void> {
      await api.call('sessions.deleteCanvas', { path: { id: sessionId, documentId } });
    },

    async setSessionCanvasEditing(
      sessionId: string,
      documentId: string,
      editing: boolean
    ): Promise<CanvasEditingResponse> {
      return (await api.call('sessions.createCanvasEditing', {
        path: { id: sessionId, documentId },
        body: { editing },
      })) as CanvasEditingResponse;
    },
  };
}
