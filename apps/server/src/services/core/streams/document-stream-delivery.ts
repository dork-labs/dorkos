/** Document frames have their own cursor and share the existing stream's serialized sink. */
import type { CanvasChannelNotification } from '@dorkos/shared/canvas-channel-schemas';
import type { DocScopeNotifications } from '../../canvas/doc-channel/streams/registry.js';
import type { DurableStreamSink } from './durable-stream-sink.js';
import { logger } from '../../../lib/logger.js';
/** Both producers await one write lane; slow readers cannot build an unbounded queue. */
export function serializedStreamSink(sink: DurableStreamSink): DurableStreamSink {
  let last = Promise.resolve();
  return {
    get closed() {
      return sink.closed;
    },
    get signal() {
      return sink.signal;
    },
    end: () => sink.end(),
    send: (frame) => {
      const next = last.then(() => sink.send(frame));
      last = next.catch(() => {});
      return next;
    },
  };
}
/** Attach before hydration, begin sending after the enclosing scope snapshot/replay. */
export function attachDocumentStream(
  sink: DurableStreamSink,
  notifications?: DocScopeNotifications
): { start(): void; stop(): void } {
  const iterator: AsyncIterator<CanvasChannelNotification> | undefined = notifications?.(
    sink.signal
  )[Symbol.asyncIterator]();
  let started = false;
  return {
    start() {
      if (!iterator || started) return;
      started = true;
      void (async () => {
        try {
          for (;;) {
            const { value, done } = await iterator.next();
            if (done || sink.closed) break;
            await sink.send({ event: value.type, data: value });
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
      void iterator?.return?.().catch(() => sink.end());
    },
  };
}
