/** Document frames have their own cursor and share the existing stream's serialized sink. */
import type { CanvasChannelNotification } from '@dorkos/shared/canvas-channel-schemas';
import type { StreamFrame } from '@dorkos/shared/stream-socket';
import type { DocScopeNotifications } from '../../canvas/doc-channel/streams/registry.js';
import type { DurableStreamSink } from './durable-stream-sink.js';
import { logger } from '../../../lib/logger.js';
/** Document authority is refreshed after queued ordinary frames finish, before any wire effect. */
export interface SerializedStreamSink extends DurableStreamSink {
  sendCurrent(frame: StreamFrame, prepare: () => StreamFrame): Promise<void>;
}
/** Both producers await one write lane; slow readers cannot build an unbounded queue. */
export function serializedStreamSink(sink: DurableStreamSink): SerializedStreamSink {
  let last = Promise.resolve();
  const enqueue = (frame: StreamFrame, prepare?: () => StreamFrame): Promise<void> => {
    const next = last.then(() => {
      if (sink.closed || sink.signal.aborted) return;
      const current = prepare ? prepare() : frame;
      return sink.send(current);
    });
    last = next.catch(() => {});
    return next;
  };
  return {
    get closed() {
      return sink.closed;
    },
    get signal() {
      return sink.signal;
    },
    end: () => sink.end(),
    send: (frame) => enqueue(frame),
    sendCurrent: (frame, prepare) => enqueue(frame, prepare),
  };
}
/** Attach before hydration, begin sending after the enclosing scope snapshot/replay. */
export function attachDocumentStream(
  sink: SerializedStreamSink,
  notifications?: DocScopeNotifications
): { start(): void; stop(): void } {
  const stream = notifications?.(sink.signal);
  const iterator: AsyncIterator<CanvasChannelNotification> | undefined =
    stream?.[Symbol.asyncIterator]();
  let started = false;
  let stopped = false;
  return {
    start() {
      if (!iterator || !stream || started || stopped) return;
      started = true;
      void (async () => {
        try {
          for (;;) {
            const { value, done } = await iterator.next();
            if (done || sink.closed) break;
            await sink.sendCurrent({ event: value.type, data: value }, () => {
              if (stopped) throw new Error('Document stream ended.');
              const current = stream.prepareForSend(value);
              return { event: current.type, data: current };
            });
          }
          if (!sink.closed) sink.end();
        } catch (error) {
          if (!sink.closed)
            logger.warn('[document stream] unavailable', {
              error: error instanceof Error ? error.message : String(error),
            });
          sink.end();
        } finally {
          await iterator.return?.();
        }
      })().catch(() => sink.end());
    },
    stop() {
      stopped = true;
      void iterator?.return?.().catch(() => sink.end());
    },
  };
}
