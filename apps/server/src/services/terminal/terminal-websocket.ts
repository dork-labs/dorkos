import type { Server } from 'http';
import { WebSocketServer, type WebSocket } from 'ws';
import { TerminalClientMessageSchema } from '@dorkos/shared/terminal-schemas';
import { logger } from '../../lib/logger.js';
import type { TerminalManager, TerminalSink } from './terminal-manager.js';

/**
 * WebSocket wiring for the embedded terminal (spec right-panel-workbench,
 * Chunk E). A PTY needs a bidirectional byte channel, which the JSON-only SSE
 * streams cannot provide — so terminal I/O rides a dedicated WebSocket at
 * `GET /api/terminal/:id/socket`: raw PTY output flows down as binary frames,
 * input/resize control messages flow up as JSON text frames.
 *
 * This is the server's sole WebSocket upgrade consumer; the handler claims only
 * the terminal path and rejects every other upgrade.
 *
 * @module services/terminal/terminal-websocket
 */

/** Matches `/api/terminal/:id/socket`, capturing the terminal id. */
const TERMINAL_SOCKET_PATH = /^\/api\/terminal\/([^/]+)\/socket$/;

/**
 * Attach the terminal WebSocket upgrade handler to the HTTP server.
 *
 * Security model (ADR 260708-185521): a terminal id is an unguessable UUID
 * minted only by `POST /api/terminal`, which passes through the same auth gate
 * as every `/api/*` route. The socket therefore authenticates by bearer-of-id —
 * an upgrade for an unknown id is rejected. A terminal is arbitrary code
 * execution by design, at the same trust level the agent already holds.
 *
 * @param server - The HTTP server to attach the upgrade handler to.
 * @param manager - The terminal manager owning PTY lifecycles.
 */
export function attachTerminalWebSocket(server: Server, manager: TerminalManager): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = req.url ?? '';
    const path = url.split('?')[0];
    const match = TERMINAL_SOCKET_PATH.exec(path);

    // Sole upgrade consumer: reject anything that is not a terminal socket.
    if (!match) {
      socket.destroy();
      return;
    }
    const id = decodeURIComponent(match[1]);
    if (!manager.has(id)) {
      // Unknown/expired terminal id — refuse the handshake.
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => bindSocket(ws, id, manager));
  });
}

/** Adapt a live WebSocket to a {@link TerminalSink} and wire its inbound messages. */
function bindSocket(ws: WebSocket, id: string, manager: TerminalManager): void {
  ws.binaryType = 'nodebuffer';

  const sink: TerminalSink = {
    send: (data) => {
      if (ws.readyState === ws.OPEN) ws.send(data);
    },
    close: () => ws.close(),
  };
  manager.attach(id, sink);

  ws.on('message', (raw, isBinary) => {
    // Control messages are JSON text frames; binary frames are not expected.
    if (isBinary) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      return; // Ignore malformed frames rather than tearing down the shell.
    }
    const message = TerminalClientMessageSchema.safeParse(parsed);
    if (!message.success) return;
    if (message.data.type === 'input') {
      manager.write(id, message.data.data);
    } else {
      manager.resize(id, { cols: message.data.cols, rows: message.data.rows });
    }
  });

  ws.on('close', () => manager.detach(id, sink));
  ws.on('error', (err) => {
    logger.warn('[terminal] socket error', { id, err });
    manager.detach(id, sink);
  });
}
