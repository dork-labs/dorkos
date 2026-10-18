/**
 * `GET /api/hub/computers/:computerId/sessions/:sessionId/stream`: one chat on
 * a linked computer as Server-Sent Events, relayed frame by frame from the
 * computer's own durable stream (`session.stream`).
 *
 * Each relayed frame is written as the session stream writes its own (the
 * same {@link SseStreamSink}): its `event`, its `data` as JSON, and its `id`,
 * the resume cursor a reconnecting browser sends back as `Last-Event-ID`. When
 * the computer ends the stream it ends here, after an `error` event when the
 * computer said why. When the browser leaves, the relay stream is closed.
 *
 * Written straight to the Node response (`http/raw-node-stream.ts`), so each
 * frame reaches the browser as it arrives.
 *
 * @module routes/hub-computer-stream
 */
import type { ServerResponse } from 'node:http';
import type { Context } from 'hono';
import type { RelayDevice, RelayError } from '@dorkos/shared/session-relay';
import type { StreamFrame } from '@dorkos/shared/stream-socket';
import type { ApiEnv } from '../http/api-chain.js';
import { streamToNodeResponse } from '../http/raw-node-stream.js';
import { logger } from '../lib/logger.js';
import { SseStreamSink } from '../services/core/streams/durable-stream-sink.js';
import type { HubComputerConnection } from '../services/core/hub-relay/index.js';

/** What one relayed stream needs. */
export interface RelayedStreamOptions {
  /** The computer's live connection. */
  computer: Pick<HubComputerConnection, 'openStream'>;
  /** The chat to stream. */
  sessionId: string;
  /** The cursor to resume after, already checked against the protocol. */
  resume: string | undefined;
  /**
   * Count one more viewer of the computer, returning how to stop counting it.
   * Opened as the stream starts and released however it ends, a throw included.
   */
  openViewer: () => () => void;
  /** The browser that asked, named to the computer; absent before it has an id. */
  device?: RelayDevice | undefined;
  /**
   * A device cookie to give a browser that has none. This response writes its
   * own head, so the chain's `Set-Cookie` never reaches it.
   */
  setCookie?: string | undefined;
}

/**
 * An event name a line break could not split. The computer is the owner's
 * own, but its frames are still written into an event stream as they are.
 */
const SAFE_EVENT = /^[^\r\n]+$/;

/**
 * Relay one chat's stream to the browser until either side ends it.
 *
 * @param c - The request's context.
 * @param options - See {@link RelayedStreamOptions}.
 */
export function relayedStream(
  c: Context<ApiEnv>,
  options: RelayedStreamOptions
): Promise<Response> {
  return streamToNodeResponse(c, async (res, { signal }) => {
    const release = options.openViewer();
    try {
      await relay(res, signal, options);
    } finally {
      release();
    }
  });
}

/** Write the relayed frames until either side ends the stream. */
function relay(
  res: ServerResponse,
  signal: AbortSignal,
  options: RelayedStreamOptions
): Promise<void> {
  if (options.setCookie) res.appendHeader('Set-Cookie', options.setCookie);
  const sink = new SseStreamSink(res);
  sink.flushHeaders();
  // Frames arrive by callback; each waits for the one before it to be
  // written, so a slow browser holds them in order rather than interleaved.
  let written: Promise<void> = Promise.resolve();
  const write = (frame: StreamFrame): void => {
    written = written.then(() => sink.send(frame)).catch(() => undefined);
  };

  return new Promise<void>((resolve) => {
    let finished = false;
    const finish = (closeRelay: boolean): void => {
      if (finished) return;
      finished = true;
      signal.removeEventListener('abort', onLeave);
      if (closeRelay) close();
      void written.then(() => {
        sink.end();
        resolve();
      });
    };
    const onLeave = (): void => finish(true);

    const close = options.computer.openStream(
      options.sessionId,
      options.resume,
      (frame) => {
        if (!SAFE_EVENT.test(frame.event)) {
          logger.warn('[HubRelay] Dropped a relayed frame with an unusable event name');
          return;
        }
        write({
          event: frame.event,
          data: frame.data,
          ...(frame.id !== undefined ? { id: frame.id } : {}),
        });
      },
      (error?: RelayError) => {
        if (error) write({ event: 'error', data: { code: error.code, message: error.message } });
        finish(false);
      },
      options.device
    );
    if (signal.aborted) onLeave();
    else signal.addEventListener('abort', onLeave, { once: true });
  });
}
