import type { IncomingMessage, Server } from 'http';
import { WebSocketServer } from 'ws';
import { TerminalClientMessageSchema } from '@dorkos/shared/terminal-schemas';
import { resolveTrustedOrigins } from '../../lib/trusted-origins.js';
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

/** WebSocket `readyState` for an open connection (mirrors `ws`'s `WebSocket.OPEN`). */
const WS_OPEN = 1;

/** The outcome of authorizing a WebSocket upgrade for the terminal path. */
export type TerminalUpgradeDecision =
  | { ok: true; id: string }
  /** Not the terminal socket path — some other upgrade; close silently. */
  | { ok: false; reason: 'not-terminal' }
  /** Browser Origin not in the trusted allowlist (DNS-rebinding guard); 403. */
  | { ok: false; reason: 'forbidden-origin' }
  /** No live terminal with this id (unknown/expired); 404. */
  | { ok: false; reason: 'unknown-id' };

/**
 * Decide whether a WebSocket upgrade may attach to a terminal.
 *
 * Security model (ADR 260708-185521):
 * - A terminal id is an unguessable UUID minted only by the auth-gated
 *   `POST /api/terminal`, so the socket authenticates by bearer-of-id — an
 *   upgrade for an unknown id is refused.
 * - WebSocket handshakes are NOT CORS-protected, so a browser Origin (when
 *   present) is checked against {@link resolveTrustedOrigins} — the same
 *   allowlist the CORS policy and `validateMcpOrigin` use — to block
 *   DNS-rebinding / cross-origin attach. Non-browser clients (CLI, tests) send
 *   no Origin and pass through, exactly like the MCP origin middleware.
 *
 * @param req - The upgrade request (reads `url` and the `origin` header).
 * @param manager - The terminal manager (checks the id exists).
 */
export function authorizeTerminalUpgrade(
  req: Pick<IncomingMessage, 'url' | 'headers'>,
  manager: TerminalManager
): TerminalUpgradeDecision {
  const path = (req.url ?? '').split('?')[0];
  const match = TERMINAL_SOCKET_PATH.exec(path);
  if (!match) return { ok: false, reason: 'not-terminal' };

  // Origin allowlist — only enforced when a browser sends one (mirrors validateMcpOrigin).
  const origin = req.headers.origin;
  if (origin && !resolveTrustedOrigins().includes(origin)) {
    return { ok: false, reason: 'forbidden-origin' };
  }

  const id = decodeURIComponent(match[1]);
  if (!manager.has(id)) return { ok: false, reason: 'unknown-id' };
  return { ok: true, id };
}

/**
 * Attach the terminal WebSocket upgrade handler to the HTTP server. It claims
 * only the terminal path; every other upgrade is destroyed.
 *
 * @param server - The HTTP server to attach the upgrade handler to.
 * @param manager - The terminal manager owning PTY lifecycles.
 */
export function attachTerminalWebSocket(server: Server, manager: TerminalManager): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const decision = authorizeTerminalUpgrade(req, manager);
    if (!decision.ok) {
      // not-terminal: some other upgrade — close silently. forbidden/unknown:
      // answer with the matching status before destroying so the client learns why.
      if (decision.reason === 'forbidden-origin') socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      else if (decision.reason === 'unknown-id') socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) =>
      bindTerminalSocket(ws as unknown as TerminalWebSocket, decision.id, manager)
    );
  });
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
  /** Close the connection. */
  close(): void;
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
