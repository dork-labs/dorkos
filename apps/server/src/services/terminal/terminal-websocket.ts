import type { IncomingMessage } from 'http';
import { TerminalClientMessageSchema } from '@dorkos/shared/terminal-schemas';
import type { UpgradeRoute } from '../core/streams/upgrade-router.js';
import { logger } from '../../lib/logger.js';
import type { TerminalManager, TerminalSink } from './terminal-manager.js';

/**
 * WebSocket wiring for the embedded terminal (spec right-panel-workbench,
 * Chunk E). A PTY needs a bidirectional byte channel, so terminal I/O rides a
 * dedicated WebSocket at `GET /api/terminal/:id/socket`: raw PTY output flows
 * down as binary frames, input/resize control messages flow up as JSON text
 * frames.
 *
 * It was the server's only WebSocket consumer until the durable event streams
 * moved onto sockets too (ADR 260804-030000), and it owned the lone
 * `server.on('upgrade')` listener — which destroyed every upgrade it did not
 * recognize, so a second listener beside it could never have worked. It is now
 * one route among several behind `services/core/streams/upgrade-router.ts`.
 *
 * @module services/terminal/terminal-websocket
 */

/** Matches `/api/terminal/:id/socket`, capturing the terminal id. */
const TERMINAL_SOCKET_PATH = /^\/api\/terminal\/([^/]+)\/socket$/;

/** WebSocket `readyState` for an open connection (mirrors `ws`'s `WebSocket.OPEN`). */
const WS_OPEN = 1;

/** The outcome of authorizing a WebSocket upgrade for the terminal path. */
export type TerminalUpgradeDecision =
  | { ok: true; id: string }
  /** Not the terminal socket path — some other upgrade; close silently. */
  | { ok: false; reason: 'not-terminal' }
  /** No live terminal with this id (unknown/expired); 404. */
  | { ok: false; reason: 'unknown-id' };

/**
 * Decide whether a WebSocket upgrade may attach to a terminal.
 *
 * Security model (ADR 260708-185521): a terminal id is an unguessable UUID
 * minted only by the auth-gated `POST /api/terminal`, so the socket
 * authenticates by bearer-of-id — an upgrade for an unknown id is refused.
 *
 * The cross-origin half of that model has moved: WebSocket handshakes are NOT
 * CORS-protected, and the `Origin` allowlist that blocks DNS-rebinding attach is
 * now applied to EVERY upgrade by `services/core/streams/upgrade-router.ts`, so this
 * no longer checks it itself. Same allowlist, same behaviour, one place.
 *
 * @param req - The upgrade request (reads `url`).
 * @param manager - The terminal manager (checks the id exists).
 */
export function authorizeTerminalUpgrade(
  req: Pick<IncomingMessage, 'url' | 'headers'>,
  manager: TerminalManager
): TerminalUpgradeDecision {
  const path = (req.url ?? '').split('?')[0];
  const match = TERMINAL_SOCKET_PATH.exec(path);
  if (!match) return { ok: false, reason: 'not-terminal' };

  const id = decodeURIComponent(match[1]);
  if (!manager.has(id)) return { ok: false, reason: 'unknown-id' };
  return { ok: true, id };
}

/**
 * Build the terminal's upgrade route for the shared router.
 *
 * @param manager - The terminal manager owning PTY lifecycles.
 */
export function terminalUpgradeRoute(manager: TerminalManager): UpgradeRoute {
  return {
    name: 'terminal',
    pattern: TERMINAL_SOCKET_PATH,
    authorize({ url }) {
      const decision = authorizeTerminalUpgrade({ url: url.pathname, headers: {} }, manager);
      if (!decision.ok) return { ok: false, status: 404, message: 'Not Found' };
      return {
        ok: true,
        open: (ws) => bindTerminalSocket(ws as unknown as TerminalWebSocket, decision.id, manager),
      };
    },
  };
}

/**
 * The subset of `ws`'s WebSocket this binding uses. Declared so tests can drive
 * the handler with a fake socket instead of a live connection; the concrete
 * `ws.WebSocket` satisfies it structurally.
 */
export interface TerminalWebSocket {
  /** Current connection state; {@link WS_OPEN} means writable. */
  readyState: number;
  /** Frame type for incoming binary data. */
  binaryType: string;
  /** Send an output frame to the client. */
  send(data: string | Uint8Array): void;
  /** Close the connection, optionally with a WebSocket close code and reason. */
  close(code?: number, reason?: string): void;
  /** Subscribe to an inbound message. */
  on(event: 'message', cb: (data: Buffer, isBinary: boolean) => void): void;
  /** Subscribe to connection close. */
  on(event: 'close', cb: () => void): void;
  /** Subscribe to a socket error. */
  on(event: 'error', cb: (err: Error) => void): void;
}

/**
 * Adapt a WebSocket to a {@link TerminalSink} and wire its inbound control
 * messages to the manager. Exported so tests can drive the attach / message /
 * close wiring with a fake socket.
 *
 * @param ws - The WebSocket to bind.
 * @param id - The terminal id this socket attaches to.
 * @param manager - The terminal manager owning PTY lifecycles.
 */
export function bindTerminalSocket(
  ws: TerminalWebSocket,
  id: string,
  manager: TerminalManager
): void {
  ws.binaryType = 'nodebuffer';

  const sink: TerminalSink = {
    send: (data) => {
      if (ws.readyState === WS_OPEN) ws.send(data);
    },
    close: (code, reason) => ws.close(code, reason),
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
