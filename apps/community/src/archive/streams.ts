import type { Transform } from 'node:stream';

/** Bytes an archive entry reads from: one buffer, or a sync or async sequence of chunks. */
export type ByteSource = Uint8Array | Iterable<Uint8Array> | AsyncIterable<Uint8Array>;

/** Iterate any {@link ByteSource} as chunks, without copying. */
export async function* chunksOf(source: ByteSource): AsyncGenerator<Uint8Array> {
  if (source instanceof Uint8Array) {
    yield source;
    return;
  }
  for await (const chunk of source) yield chunk;
}

/**
 * Stream `source` through a Node transform (deflate or inflate) with backpressure. Ending the
 * iteration early destroys the transform; a source or transform error rejects the iteration.
 */
export async function* throughTransform(
  source: AsyncIterable<Uint8Array>,
  transform: Transform
): AsyncGenerator<Buffer> {
  const feed = (async () => {
    try {
      for await (const chunk of source) {
        if (transform.destroyed) return;
        if (!transform.write(chunk)) await drainedOrClosed(transform);
      }
      if (!transform.destroyed) transform.end();
    } catch (error) {
      transform.destroy(error instanceof Error ? error : new Error('Stream source failed'));
    }
  })();
  try {
    for await (const chunk of transform) yield chunk as Buffer;
    await feed;
  } finally {
    transform.destroy();
  }
}

function drainedOrClosed(stream: Transform): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      stream.off('drain', done);
      stream.off('close', done);
      resolve();
    };
    stream.on('drain', done);
    stream.on('close', done);
  });
}

/**
 * Gather chunks smaller than `minBytes` into one buffer so a consumer (a blob upload) is not
 * handed thousands of tiny writes. A chunk of at least `minBytes` passes through as the same
 * object after the pending small ones are flushed.
 */
export async function* coalesce(
  source: AsyncIterable<Uint8Array>,
  minBytes = 64 * 1024
): AsyncGenerator<Uint8Array> {
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  for await (const chunk of source) {
    if (chunk.length === 0) continue;
    if (chunk.length >= minBytes) {
      if (pendingBytes > 0) {
        yield Buffer.concat(pending, pendingBytes);
        pending = [];
        pendingBytes = 0;
      }
      yield chunk;
      continue;
    }
    pending.push(chunk);
    pendingBytes += chunk.length;
    if (pendingBytes >= minBytes) {
      yield Buffer.concat(pending, pendingBytes);
      pending = [];
      pendingBytes = 0;
    }
  }
  if (pendingBytes > 0) yield Buffer.concat(pending, pendingBytes);
}

/** Read a whole (small) byte stream into one buffer. */
export async function collectBytes(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return Buffer.concat(chunks);
}
