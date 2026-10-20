/**
 * A chat's durable stream, delivered over the session relay: the third sink
 * beside SSE and the app's WebSocket (`durable-stream-sink.ts`). The
 * sequencing (snapshot, gap-free replay from a cursor, live `seq`) is
 * `deliverSessionStream`'s, unchanged; this only turns each frame into a
 * `stream.frame` on the relay connection, framed exactly as `stream-socket.ts`
 * frames it (`event`, `data`, `id`), and ends the stream with one
 * `stream.end`.
 *
 * @module services/core/session-relay/relay-stream-sink
 */
import type { StreamFrame } from '@dorkos/shared/stream-socket';
import type { RelayComputerFrame, RelayError } from '@dorkos/shared/session-relay';
import type { DurableStreamSink } from '../streams/durable-stream-sink.js';

/** Why a relayed stream stopped, for whoever opened it. */
export type RelayStreamEnding =
  /** The stream ran out on this side (the session stream ended or failed). */
  | 'ended'
  /** The web side closed it with `stream.close`. */
  | 'closed-by-viewer'
  /** The relay connection itself ended; nothing more can be sent. */
  | 'connection-closed';

/** One open session stream on one relay connection. */
export class RelayStreamSink implements DurableStreamSink {
  private readonly controller = new AbortController();
  private finished = false;

  /**
   * Bind a sink to one stream id on one connection.
   *
   * @param streamId - The id the web side named the stream by.
   * @param emit - Sends a frame on the relay connection.
   * @param onFinished - Called once, when the stream stops for any reason.
   */
  constructor(
    private readonly streamId: string,
    private readonly emit: (frame: RelayComputerFrame) => void,
    private readonly onFinished: (ending: RelayStreamEnding) => void
  ) {}

  /** {@inheritDoc DurableStreamSink.signal} */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** {@inheritDoc DurableStreamSink.closed} */
  get closed(): boolean {
    return this.controller.signal.aborted;
  }

  /**
   * {@inheritDoc DurableStreamSink.send}
   *
   * Sending never waits: the relay connection is one socket that the dialer
   * writes to in order, so a frame is handed to it at once.
   */
  async send(frame: StreamFrame): Promise<void> {
    if (this.closed) return;
    this.emit({
      type: 'stream.frame',
      streamId: this.streamId,
      frame: {
        event: frame.event,
        ...(frame.data !== undefined ? { data: frame.data } : {}),
        ...(frame.id !== undefined ? { id: frame.id } : {}),
      },
    });
  }

  /** {@inheritDoc DurableStreamSink.end} */
  end(): void {
    this.finish('ended');
  }

  /**
   * Stop the stream from this side with a refusal the web side can show.
   *
   * @param error - What to tell the web side.
   */
  fail(error: RelayError): void {
    this.finish('ended', error);
  }

  /** The web side closed the stream: stop it, and confirm with `stream.end`. */
  closeByViewer(): void {
    this.finish('closed-by-viewer');
  }

  /** The relay connection ended: stop the stream without sending anything. */
  closeWithConnection(): void {
    this.finish('connection-closed');
  }

  private finish(ending: RelayStreamEnding, error?: RelayError): void {
    if (this.finished) return;
    this.finished = true;
    this.controller.abort();
    if (ending !== 'connection-closed') {
      this.emit({ type: 'stream.end', streamId: this.streamId, ...(error ? { error } : {}) });
    }
    this.onFinished(ending);
  }
}
