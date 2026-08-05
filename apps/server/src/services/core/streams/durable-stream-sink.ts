/**
 * The seam between a durable stream's SEQUENCING and its DELIVERY.
 *
 * DorkOS serves each durable stream over two protocols, and that is deliberate
 * rather than transitional (ADR 260804-030000):
 *
 * - **WebSocket**, which the cockpit uses. An SSE stream holds one of a
 *   browser's ~6 sockets per origin for as long as it is open, so three cockpit
 *   windows spent all six and the app stopped responding. WebSockets are exempt
 *   from that pool.
 * - **Server-Sent Events**, which stays as the public integration contract
 *   (`docs/integrations/sse-protocol.mdx`) and is what the Electron main
 *   process reads for its tray count. Third parties built against it; it does
 *   not get to break because the cockpit's own needs changed.
 *
 * What must NOT be doubled is the part that is hard to get right: snapshot,
 * gap-free replay, cursor framing, live dedupe. That logic is written once
 * against this interface, and the two protocols are the only thing that
 * differs — an SSE sink writes `event:`/`data:`/`id:` lines to an Express
 * response, a socket sink writes JSON frames. A bug fixed in the sequencing is
 * fixed for both by construction.
 *
 * @module services/core/durable-stream-sink
 */
import { once } from 'node:events';
import type { Response } from 'express';
import type { StreamFrame } from '@dorkos/shared/stream-socket';
import { SSE } from '../../../config/constants.js';

/** Where a durable stream's frames go, and how it learns the reader left. */
export interface DurableStreamSink {
  /**
   * Deliver one frame, pausing the caller while the reader is congested.
   *
   * Gap-free delivery is the contract: a slow reader pauses the send loop, it
   * never causes a frame to be skipped.
   */
  send(frame: StreamFrame): Promise<void>;
  /** Whether the reader has gone away. */
  readonly closed: boolean;
  /**
   * Fires when the reader disconnects. Every sequencer passes this to its
   * subscription so the projector's parked waiter is released rather than
   * leaked — a bare `iterator.return()` cannot interrupt a generator parked on
   * an un-settleable ingest wait.
   */
  readonly signal: AbortSignal;
  /** Close from the server side (the stream ended, not the reader). */
  end(): void;
}

/**
 * A durable stream delivered as Server-Sent Events over an Express response.
 *
 * Writes exactly the wire format the SSE protocol doc specifies: an optional
 * `id:` line, then `event:` and `data:`. Heartbeats are SSE comments, which the
 * protocol lets a client's parser drop without involving the application — so
 * they never surface as a frame, and the sequencer above never knows about them.
 */
export class SseStreamSink implements DurableStreamSink {
  private readonly res: Response;
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private readonly controller = new AbortController();

  /**
   * Take over an Express response for SSE, writing its headers and starting the
   * heartbeat.
   *
   * @param res - The response to stream over.
   */
  constructor(res: Response) {
    this.res = res;
    // `X-Accel-Buffering: no` defeats proxy buffering on a durable stream.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    this.heartbeat = setInterval(() => {
      try {
        res.write(': keepalive\n\n');
      } catch {
        clearInterval(this.heartbeat);
      }
    }, SSE.HEARTBEAT_INTERVAL_MS);

    res.on('close', () => {
      clearInterval(this.heartbeat);
      this.controller.abort();
    });
  }

  /** {@inheritDoc DurableStreamSink.signal} */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** {@inheritDoc DurableStreamSink.closed} */
  get closed(): boolean {
    return this.controller.signal.aborted || this.res.writableEnded;
  }

  /**
   * Flush the headers without sending a frame.
   *
   * A resume connect whose gap is empty writes nothing until the first live
   * event, and Node holds `writeHead` until the first body write — so without
   * this the client cannot tell "connected, nothing new" from "still
   * connecting". Comment lines are ignored by every SSE parser, so it costs the
   * client nothing. The socket sink needs no equivalent: a completed WebSocket
   * handshake is itself the signal.
   */
  flushHeaders(): void {
    this.res.write(': connected\n\n');
  }

  /** {@inheritDoc DurableStreamSink.send} */
  async send(frame: StreamFrame): Promise<void> {
    if (this.closed) return;
    if (frame.id !== undefined) this.res.write(`id: ${frame.id}\n`);
    const flushed = this.res.write(
      `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`
    );
    // When `write()` returns false the frame is buffered in process memory;
    // awaiting `drain` before the next one bounds that buffer for a slow
    // consumer (a long replay can be thousands of frames). A client that
    // disconnects mid-wait aborts the `once` via the same signal that tears down
    // the subscription.
    if (!flushed) await once(this.res, 'drain', { signal: this.controller.signal });
  }

  /** {@inheritDoc DurableStreamSink.end} */
  end(): void {
    clearInterval(this.heartbeat);
    if (!this.closed) this.res.end();
    this.controller.abort();
  }
}
