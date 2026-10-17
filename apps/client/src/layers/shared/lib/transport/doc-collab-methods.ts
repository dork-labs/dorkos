/**
 * Live doc editing (DOR-2984): the doc socket, and a doc's saved versions.
 *
 * The socket carries Yjs bytes both ways and knows nothing about Yjs; the
 * provider that speaks the protocol lives in `features/docs`.
 *
 * @module shared/lib/transport/doc-collab-methods
 */
import type { DocRef, DocVersionList, RestoreDocVersionResponse } from '@dorkos/shared/doc-collab';
import type { DocCollabConnection, DocCollabHandlers } from '@dorkos/shared/transport-doc-collab';
import { statusFromCloseCode } from '@dorkos/shared/stream-socket';
import { buildQueryString, fetchJSON } from './http-client';

/** The socket URL for a doc, from a base URL that may be relative (`/api`). */
function socketUrl(baseUrl: string, doc: DocRef): string {
  const url = new URL(
    `${baseUrl}/documents/live${buildQueryString({ cwd: doc.cwd, path: doc.path })}`,
    window.location.href
  );
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

/** Create the live doc methods bound to a base URL. */
export function createDocCollabMethods(baseUrl: string) {
  return {
    connectDocCollab(doc: DocRef, handlers: DocCollabHandlers): DocCollabConnection {
      const ws = new WebSocket(socketUrl(baseUrl, doc));
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

    restoreDocVersion(doc: DocRef, versionId: string): Promise<RestoreDocVersionResponse> {
      return fetchJSON(baseUrl, '/documents/versions/restore', {
        method: 'POST',
        body: JSON.stringify({ ...doc, versionId }),
      });
    },
  };
}
