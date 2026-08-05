/**
 * Read a durable stream socket as an async iterable of frames.
 *
 * The iterable shape of the same connection {@link WSConnection} exposes with
 * callbacks. Both exist because the two consumers want opposite things: the
 * `StreamManager` owns its reconnection and wants to be pushed at, while the
 * Transport port is contract-level — one subscription, no retries, resilience
 * supplied by the caller (`use-room-stream.ts` runs its own retry loop, and the
 * same line `session-stream-methods.ts` draws).
 *
 * @module shared/lib/transport/stream-socket-iterator
 */
import {
  decodeStreamFrame,
  statusFromCloseCode,
  STREAM_HEARTBEAT_EVENT,
  type StreamFrame,
} from '@dorkos/shared/stream-socket';

import { SSE_RESILIENCE } from '../constants';
import { toStreamSocketUrl } from './ws-connection';

/** How the socket ended, when it ended for a reason worth reporting. */
export interface StreamSocketClosed {
  /** The HTTP status the server refused with, or `null` for an ordinary drop. */
  status: number | null;
  /** Whether the socket went silent past the watchdog rather than closing. */
  silent: boolean;
}

/** Options for {@link streamSocketFrames}. */
export interface StreamSocketOptions {
  /** Aborts the subscription and closes the socket. */
  signal?: AbortSignal;
  /**
   * Called once the socket has ended, before the iterable completes, so a
   * caller can turn the ending into whatever error its retry loop reads.
   */
  onClosed?: (closed: StreamSocketClosed) => void;
}

/**
 * Open a durable stream socket and yield every frame it delivers.
 *
 * Heartbeat frames are consumed here rather than yielded: they exist so a
 * SILENT socket is distinguishable from a quiet stream, and that distinction is
 * only useful down here. Any frame at all — heartbeat included — resets the
 * watchdog, and silence past {@link SSE_RESILIENCE.HEARTBEAT_TIMEOUT_MS} closes
 * the socket so the iterable ends. That is what a half-open socket (a slept
 * laptop's) produces instead of an error.
 *
 * @param url - The stream's HTTP URL; converted to `ws:`/`wss:` here.
 * @param options - Abort signal and close callback.
 */
export async function* streamSocketFrames(
  url: string,
  options: StreamSocketOptions = {}
): AsyncIterable<StreamFrame> {
  const { signal, onClosed } = options;
  const socket = new WebSocket(toStreamSocketUrl(url));

  /** Frames delivered but not yet pulled by the consumer. */
  const queue: StreamFrame[] = [];
  /** Resolves the consumer's pending pull, when one is parked. */
  let wake: (() => void) | null = null;
  let ended = false;
  let closed: StreamSocketClosed = { status: null, silent: false };

  const notify = (): void => {
    const resume = wake;
    wake = null;
    resume?.();
  };

  const finish = (result: StreamSocketClosed): void => {
    if (ended) return;
    ended = true;
    closed = result;
    notify();
  };

  let watchdog: ReturnType<typeof setTimeout> | undefined;
  /** Restart the silence countdown. Called for every frame, heartbeats too. */
  const heard = (): void => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      finish({ status: null, silent: true });
      socket.close();
    }, SSE_RESILIENCE.HEARTBEAT_TIMEOUT_MS);
  };
  // Armed before the socket opens: a handshake that hangs without answering is
  // as dead as one that stops mid-stream, and this has no other timeout.
  heard();

  socket.onmessage = (event: MessageEvent<unknown>): void => {
    heard();
    if (typeof event.data !== 'string') return;
    const frame = decodeStreamFrame(event.data);
    if (!frame || frame.event === STREAM_HEARTBEAT_EVENT) return;
    queue.push(frame);
    notify();
  };

  socket.onclose = (event: CloseEvent): void => {
    // A refusal arrives as an application close code rather than an HTTP status,
    // because a browser cannot read the status of a failed handshake at all.
    finish({ status: statusFromCloseCode(event.code), silent: false });
  };

  const onAbort = (): void => {
    finish({ status: null, silent: false });
    socket.close();
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    for (;;) {
      while (queue.length > 0) {
        if (signal?.aborted) return;
        yield queue.shift()!;
      }
      if (ended) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    clearTimeout(watchdog);
    signal?.removeEventListener('abort', onAbort);
    socket.onmessage = null;
    socket.onclose = null;
    socket.close();
    onClosed?.(closed);
  }
}
