/**
 * Terminal Transport methods factory — the HTTP implementation of the embedded
 * terminal (spec right-panel-workbench, Chunk E; ADR 260708-185521).
 *
 * `openTerminal` creates a server-side PTY over `POST /api/terminal`, then opens
 * the bidirectional WebSocket byte channel at `GET /api/terminal/:id/socket`.
 * Raw PTY output arrives as binary frames and is surfaced as an
 * `AsyncIterable<Uint8Array>`; input and resize go up as JSON control frames via
 * `writeTerminal` / `resizeTerminal`, correlated to the socket by handle id.
 *
 * @module shared/lib/transport/terminal-methods
 */
import {
  CreateTerminalResponseSchema,
  type TerminalClientMessage,
} from '@dorkos/shared/terminal-schemas';
import type { TerminalHandle } from '@dorkos/shared/transport';

/**
 * Derive the WebSocket URL for a terminal socket from the transport base URL,
 * which may be relative (`/api`) or absolute (`http://host:port/api`).
 */
function toWebSocketUrl(baseUrl: string, path: string): string {
  const url = new URL(baseUrl + path, window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

/** Wait for a socket to open, rejecting if it errors before opening. */
function waitForOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('terminal socket failed to open')), {
      once: true,
    });
  });
}

/**
 * Soft cap on bytes buffered while waiting for the consumer to pull. In practice
 * xterm consumes each frame synchronously in the `for await` loop, so the queue
 * stays at 0-1 frames; this only bounds memory if the consumer stalls (tab
 * backgrounded, main thread blocked) — oldest frames are dropped past the cap,
 * which is benign for a scrollback terminal.
 */
const MAX_QUEUED_BYTES = 4 * 1024 * 1024;

/**
 * Adapt a WebSocket's binary frames to an `AsyncIterable<Uint8Array>`. Ends when
 * the socket closes/errors or the abort signal fires; runs `cleanup` once on any
 * terminal condition (including generator teardown). The output is single-shot:
 * iterate it exactly once (see {@link TerminalHandle.output}).
 */
function createOutputStream(
  ws: WebSocket,
  cleanup: () => void,
  signal?: AbortSignal
): AsyncIterable<Uint8Array> {
  const queue: Uint8Array[] = [];
  let queuedBytes = 0;
  let wake: (() => void) | null = null;
  let ended = false;

  const notify = (): void => {
    if (wake) {
      const w = wake;
      wake = null;
      w();
    }
  };
  const end = (): void => {
    ended = true;
    notify();
  };
  const enqueue = (chunk: Uint8Array): void => {
    queue.push(chunk);
    queuedBytes += chunk.byteLength;
    // Drop oldest frames if a stalled consumer lets the buffer grow past the cap.
    while (queuedBytes > MAX_QUEUED_BYTES && queue.length > 1) {
      queuedBytes -= queue.shift()!.byteLength;
    }
  };

  ws.addEventListener('message', (ev: MessageEvent) => {
    if (ev.data instanceof ArrayBuffer) enqueue(new Uint8Array(ev.data));
    else if (typeof ev.data === 'string') enqueue(new TextEncoder().encode(ev.data));
    notify();
  });
  ws.addEventListener('close', end);
  ws.addEventListener('error', end);
  if (signal) {
    if (signal.aborted) cleanup();
    else signal.addEventListener('abort', () => cleanup(), { once: true });
  }

  return {
    async *[Symbol.asyncIterator]() {
      try {
        while (true) {
          if (queue.length > 0) {
            const chunk = queue.shift()!;
            queuedBytes -= chunk.byteLength;
            yield chunk;
            continue;
          }
          if (ended) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      } finally {
        cleanup();
      }
    },
  };
}

/**
 * Create the terminal Transport methods bound to a base URL.
 *
 * @param baseUrl - Server base URL (e.g. `/api` or `http://localhost:4242/api`).
 */
export function createTerminalMethods(baseUrl: string) {
  // Live sockets keyed by terminal id, so write/resize can reach the right one.
  const sockets = new Map<string, WebSocket>();

  const sendControl = (handle: TerminalHandle, message: TerminalClientMessage): void => {
    const ws = sockets.get(handle.id);
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };

  return {
    /** Whether this transport can attach an embedded terminal — always true over HTTP. */
    supportsTerminal: true as const,

    async openTerminal(cwd: string, signal?: AbortSignal): Promise<TerminalHandle> {
      const res = await fetch(`${baseUrl}/terminal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ cwd }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body.error || `Failed to open terminal (HTTP ${res.status})`);
      }
      const { id } = CreateTerminalResponseSchema.parse(await res.json());

      const ws = new WebSocket(toWebSocketUrl(baseUrl, `/terminal/${id}/socket`));
      ws.binaryType = 'arraybuffer';
      sockets.set(id, ws);

      let cleaned = false;
      const cleanup = (): void => {
        if (cleaned) return;
        cleaned = true;
        sockets.delete(id);
        try {
          ws.close();
        } catch {
          // Socket may already be closing/closed — ignore.
        }
        // Best-effort server-side teardown (idle/exit teardown also covers this).
        void fetch(`${baseUrl}/terminal/${id}`, { method: 'DELETE', credentials: 'include' }).catch(
          () => {}
        );
      };

      try {
        await waitForOpen(ws);
      } catch (err) {
        cleanup();
        throw err;
      }

      const output = createOutputStream(ws, cleanup, signal);
      return { id, output };
    },

    writeTerminal(handle: TerminalHandle, data: string): void {
      sendControl(handle, { type: 'input', data });
    },

    resizeTerminal(handle: TerminalHandle, size: { cols: number; rows: number }): void {
      sendControl(handle, { type: 'resize', cols: size.cols, rows: size.rows });
    },
  };
}
