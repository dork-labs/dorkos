/**
 * The WebSocket implementation of {@link DurableStreamSink} — the sibling of
 * `SseStreamSink`, and the one the cockpit's streams are delivered over.
 *
 * It owns framing, liveness and backpressure for a socket; the snapshot /
 * replay / live sequencing above it is protocol-blind and lives in
 * `services/session/session-stream-delivery.ts` and
 * `services/rooms/room-stream-delivery.ts`.
 *
 * @module services/core/streams/stream-socket
 */
import type { WebSocket } from 'ws';
import { encodeStreamFrame, STREAM_HEARTBEAT_EVENT } from '@dorkos/shared/stream-socket';
import type { StreamFrame } from '@dorkos/shared/stream-socket';
import type { DurableStreamSink } from './durable-stream-sink.js';
import { SSE } from '../../../config/constants.js';

/** `WebSocket.readyState` for an open connection (mirrors `ws`'s `WebSocket.OPEN`). */
const WS_OPEN = 1;

/**
 * A durable stream's socket, framed.
 *
 * Owns exactly three things a handler would otherwise repeat: it heartbeats so
 * the client's silence watchdog can tell a quiet stream from a dead one, it
 * applies backpressure so a slow reader cannot grow this process without bound,
 * and it exposes an {@link AbortSignal} that fires the moment the client goes
 * away — which is the teardown every handler already builds its subscription
 * around.
 */
export class DurableStreamSocket implements DurableStreamSink {
  private readonly ws: WebSocket;
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private readonly controller = new AbortController();

  /**
   * Wrap an open WebSocket and start its heartbeat.
   *
   * @param ws - The socket handed over by the upgrade router.
   */
  constructor(ws: WebSocket) {
    this.ws = ws;
    this.heartbeat = setInterval(() => {
      // A protocol-level ping cannot be observed by browser JavaScript, so
      // liveness has to be an ordinary frame — see STREAM_HEARTBEAT_EVENT.
      if (this.ws.readyState !== WS_OPEN) return;
      this.ws.send(encodeStreamFrame({ event: STREAM_HEARTBEAT_EVENT }));
    }, SSE.HEARTBEAT_INTERVAL_MS);

    const teardown = (): void => {
      clearInterval(this.heartbeat);
      this.controller.abort();
    };
    ws.on('close', teardown);
    ws.on('error', teardown);
  }

  /** {@inheritDoc DurableStreamSink.signal} */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** {@inheritDoc DurableStreamSink.closed} */
  get closed(): boolean {
    return this.controller.signal.aborted || this.ws.readyState !== WS_OPEN;
  }

  /**
   * Send one frame, pausing the caller while the socket is congested.
   *
   * The fast path — a reader keeping up — does not await at all. Past
   * {@link SSE.MAX_BUFFERED_BYTES} the send resolves only once the socket has
   * taken the bytes, which pauses whichever replay or live loop is calling and
   * bounds the buffer. Gap-free delivery is preserved either way: the loop
   * waits, it never skips a frame.
   *
   * @param frame - The frame to deliver.
   */
  async send(frame: StreamFrame): Promise<void> {
    if (this.closed) return;
    const payload = encodeStreamFrame(frame);
    if (this.ws.bufferedAmount <= SSE.MAX_BUFFERED_BYTES) {
      this.ws.send(payload);
      return;
    }
    await new Promise<void>((resolve) => {
      this.ws.send(payload, () => resolve());
    });
  }

  /** {@inheritDoc DurableStreamSink.end} */
  end(): void {
    clearInterval(this.heartbeat);
    this.controller.abort();
    if (this.ws.readyState === WS_OPEN) this.ws.close();
  }
}
