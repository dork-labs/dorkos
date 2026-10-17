/**
 * Live doc editing (DOR-2984): the doc socket, and a doc's saved versions.
 *
 * The socket carries Yjs bytes both ways and knows nothing about Yjs; the
 * provider that speaks the protocol lives in `features/docs`.
 *
 * @module shared/lib/transport/doc-collab-methods
 */
import {
  DOC_COLLAB_GENERATION_PARAM,
  type DocRef,
  type DocVersion,
  type DocVersionList,
  type RestoreDocVersionResponse,
} from '@dorkos/shared/doc-collab';
import type {
  DocCollabConnectOptions,
  DocCollabConnection,
  DocCollabHandlers,
} from '@dorkos/shared/transport-doc-collab';
import { statusFromCloseCode } from '@dorkos/shared/stream-socket';
import { buildQueryString, fetchJSON } from './http-client';

/** The socket URL for a doc, from a base URL that may be relative (`/api`). */
function socketUrl(baseUrl: string, doc: DocRef, generation?: string): string {
  const query = buildQueryString({
    cwd: doc.cwd,
    path: doc.path,
    [DOC_COLLAB_GENERATION_PARAM]: generation,
  });
  const url = new URL(`${baseUrl}/documents/live${query}`, window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

/** Create the live doc methods bound to a base URL. */
export function createDocCollabMethods(baseUrl: string) {
  return {
    connectDocCollab(
      doc: DocRef,
      handlers: DocCollabHandlers,
      options: DocCollabConnectOptions = {}
    ): DocCollabConnection {
      const ws = new WebSocket(socketUrl(baseUrl, doc, options.generation));
      ws.binaryType = 'arraybuffer';
      let closed = false;
      const close = (status?: number) => {
        if (closed) return;
        closed = true;
        handlers.onClose(status === undefined ? {} : { status });
      };
      ws.addEventListener('open', () => handlers.onOpen());
      ws.addEventListener('message', (event: MessageEvent) => {
        if (event.data instanceof ArrayBuffer) handlers.onMessage(new Uint8Array(event.data));
      });
      // The server states a refusal as a close code; a drop has none it set.
      ws.addEventListener('close', (event: CloseEvent) =>
        close(statusFromCloseCode(event.code) ?? undefined)
      );
      return {
        send: (frame) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(frame);
        },
        close: () => {
          ws.close();
          close();
        },
      };
    },

    listDocVersions(doc: DocRef): Promise<DocVersionList> {
      return fetchJSON(
        baseUrl,
        `/documents/versions${buildQueryString({ cwd: doc.cwd, path: doc.path })}`
      );
    },

    keepDocDraft(doc: DocRef, markdown: string): Promise<{ ok: true; version: DocVersion | null }> {
      return fetchJSON(baseUrl, '/documents/versions', {
        method: 'POST',
        body: JSON.stringify({ ...doc, markdown }),
      });
    },

    restoreDocVersion(doc: DocRef, versionId: string): Promise<RestoreDocVersionResponse> {
      return fetchJSON(baseUrl, '/documents/versions/restore', {
        method: 'POST',
        body: JSON.stringify({ ...doc, versionId }),
      });
    },
  };
}
