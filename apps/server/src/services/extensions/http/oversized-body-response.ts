import type { IncomingMessage } from 'node:http';
import type { Context } from 'hono';
import type { ApiEnv } from '../../../http/api-chain.js';
import { streamToNodeResponse } from '../../../http/raw-node-stream.js';
import { TOO_LARGE } from './extension-http.js';

// Match the pinned Node adapter's disposal bounds, without enabling its global
// cleanup. These bound discarded input, never the extension's 1 MiB allowance.
const DRAIN_MS = 500;
const DRAIN_BYTES = 64 * 1024 * 1024;

/** Discard without buffering, with one deadline and one owner for every exit. */
function discardBody(incoming: IncomingMessage, signal: AbortSignal) {
  let settled = false;
  let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolve!: () => void;
  const done = new Promise<void>((finish) => {
    resolve = finish;
  });
  const stop = () => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    incoming.off('readable', onReadable);
    incoming.off('end', stop);
    incoming.off('error', stop);
    incoming.off('aborted', stop);
    incoming.off('close', stop);
    signal.removeEventListener('abort', stop);
    incoming.pause();
    resolve();
  };
  const onReadable = () => {
    while (!settled && incoming.readableLength > 0) {
      const chunk: Buffer | null = incoming.read(
        Math.min(incoming.readableLength, DRAIN_BYTES - bytes)
      );
      if (chunk === null) break;
      bytes += chunk.byteLength;
      if (bytes >= DRAIN_BYTES) stop();
    }
    // An empty readable notification can carry EOF after earlier bytes drained.
    // Let Node emit end, without consuming past the byte cap once settled.
    if (!settled && incoming.readableLength === 0) incoming.read(0);
  };
  incoming.on('readable', onReadable);
  incoming.once('end', stop);
  incoming.once('error', stop);
  incoming.once('aborted', stop);
  incoming.once('close', stop);
  signal.addEventListener('abort', stop, { once: true });
  if (incoming.readableEnded || incoming.destroyed || signal.aborted) stop();
  else {
    timer = setTimeout(stop, DRAIN_MS);
    timer.unref();
    onReadable();
  }
  return { done, stop };
}

/**
 * Flush the complete refusal before closing a connection still carrying input.
 * Known-length JSON lets the caller finish reading even if it stops uploading;
 * bounded disposal delays Node's response-end socket close, not the reply bytes.
 *
 * @param c - The real request/response pair behind the API chain.
 * @returns The raw-response marker, after disposal or departure.
 */
export function rejectOversizedBody(c: Context<ApiEnv>): Promise<Response> {
  return streamToNodeResponse(c, async (outgoing, { signal }) => {
    if (signal.aborted) return;
    const drain = discardBody(c.env.incoming, signal);
    try {
      const text = JSON.stringify({ error: TOO_LARGE });
      outgoing.writeHead(413, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(text),
        connection: 'close',
      });
      outgoing.flushHeaders();
      outgoing.write(text);
      await drain.done;
      if (!outgoing.destroyed && !outgoing.writableEnded) outgoing.end();
    } finally {
      drain.stop();
    }
  });
}
