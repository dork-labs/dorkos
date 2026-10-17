/**
 * `GET /api/documents/live?cwd=…&path=…` as a WebSocket: one editor joining a
 * doc's live editing (DOR-2984).
 *
 * Binary frames in the Yjs sync and awareness protocols
 * (`@dorkos/shared/doc-collab`). The router runs the same credential gate as
 * every durable stream before this is asked; this route then applies the
 * files routes' boundary checks (`resolveDoc`), and refuses everything while
 * the `docs.enabled` experiment is off. Refusals ride a close frame, because a
 * browser cannot read the status of a failed handshake, and the editor falls
 * back to saving the file on a 404.
 *
 * @module routes/documents-live-socket
 */
import { WebSocketServer, type WebSocket } from 'ws';
import { DocRefSchema } from '@dorkos/shared/doc-collab';
import { STREAM_CLOSE_CODE_BASE } from '@dorkos/shared/stream-socket';
import {
  DocRefusal,
  docsEnabled,
  getDocCollab,
  type DocJoinHandle,
  type DocPeer,
} from '../services/docs/collab/index.js';
import type { UpgradeDecision, UpgradeRoute } from '../services/core/streams/upgrade-router.js';
import { logger } from '../lib/logger.js';

/** Matches `/api/documents/live` — the whole path; the doc rides the query. */
const LIVE_DOC_PATH = /^\/api\/documents\/live$/;

/** `WebSocket.readyState` for an open connection. */
const WS_OPEN = 1;

/** How often an editor's connection is checked for life. */
const HEARTBEAT_MS = 30_000;

/**
 * Its own server, for its own frame limit: a doc's whole state rides one frame
 * on first sync, and docs are capped at 5 MB of text.
 */
const liveDocSockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });

/** Bind one upgraded socket to the doc it asked for. */
function serve(ws: WebSocket, join: (peer: DocPeer) => Promise<DocJoinHandle>): void {
  const peer: DocPeer = {
    send: (frame) => {
      if (ws.readyState === WS_OPEN) ws.send(frame);
    },
    close: () => ws.close(),
  };
  // Frames that arrive while the doc loads wait for it, in order.
  const early: Uint8Array[] = [];
  let receive: ((frame: Uint8Array) => void) | null = null;
  let leave: (() => void) | null = null;
  let closed = false;

  let alive = true;
  const heartbeat = setInterval(() => {
    if (!alive) {
      ws.terminate();
      return;
    }
    alive = false;
    ws.ping();
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  ws.on('pong', () => {
    alive = true;
  });

  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    const frame = new Uint8Array(data as Buffer);
    if (receive) receive(frame);
    else early.push(frame);
  });
  ws.on('close', () => {
    closed = true;
    clearInterval(heartbeat);
    leave?.();
  });

  join(peer).then(
    (handle) => {
      if (closed) {
        handle.leave();
        return;
      }
      receive = handle.receive;
      leave = handle.leave;
      for (const frame of early.splice(0)) handle.receive(frame);
    },
    (err: unknown) => {
      logger.warn('[docs] could not open a doc for live editing', {
        error: err instanceof Error ? err.message : String(err),
      });
      ws.close(STREAM_CLOSE_CODE_BASE + 500, 'The doc could not be opened');
    }
  );
}

/** The upgrade route for live doc editing. */
export const liveDocRoute: UpgradeRoute = {
  name: 'documents-live',
  pattern: LIVE_DOC_PATH,
  // The router runs the credential gate before this is called.
  credential: 'required',
  webSocketServer: liveDocSockets,

  async authorize({ url }): Promise<UpgradeDecision> {
    const refuse = (status: number, message: string): UpgradeDecision => ({
      ok: false,
      status,
      message,
      deliver: 'close-frame',
    });
    if (!docsEnabled()) return refuse(404, 'Not found');
    const service = getDocCollab();
    if (!service) return refuse(503, 'Service Unavailable');
    const parsed = DocRefSchema.safeParse({
      cwd: url.searchParams.get('cwd'),
      path: url.searchParams.get('path'),
    });
    if (!parsed.success) return refuse(400, 'Name a doc with cwd and path');
    try {
      const doc = await service.resolve(parsed.data);
      return { ok: true, open: (ws) => serve(ws, (peer) => service.join(doc, peer)) };
    } catch (err) {
      if (err instanceof DocRefusal) return refuse(err.status, err.message);
      throw err;
    }
  },
};
