import { BrowserFrameBodyDecoder, type BrowserFrameBody } from '@dorkos/shared/browser-frame-wire';

/**
 * Read one already-authorized HTTP body; this helper supplies no permission, fetch, timer or ACK.
 * Caller owns the request's sole deadline/AbortSignal. Reader lock stays owned through entered
 * read and cancellation settlement. A hung native producer is not reported as completed cleanup.
 */
export async function readBrowserFrameBody(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  observeCleanupFailure: (reason: unknown) => void = () => undefined
): Promise<BrowserFrameBody> {
  const cleanupObserver = observeCleanupFailure.bind(undefined);
  const reader = body.getReader();
  const read = reader.read.bind(reader);
  const cancel = reader.cancel.bind(reader);
  const release = reader.releaseLock.bind(reader);
  const decoder = new BrowserFrameBodyDecoder();
  let failed = false;
  let first: unknown;
  let cancellation: Promise<void> | undefined;
  let result: BrowserFrameBody | undefined;
  const fail = (reason: unknown) => {
    if (!failed) {
      failed = true;
      first = reason;
    }
    decoder.discard(first);
  };
  const cleanupFailure = (error: unknown) => {
    fail(error);
    try {
      cleanupObserver(error);
    } catch (observerError) {
      fail(observerError);
    }
  };
  const stop = () => {
    if (!cancellation) {
      cancellation = Promise.resolve().then(() => cancel(first));
      // Attach immediately, retaining the same original promise for cleanup below.
      void cancellation.catch((error: unknown) => cleanupFailure(error));
    }
  };
  const abort = () => {
    fail(signal!.reason);
    stop();
  };
  try {
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    while (!failed) {
      // No race substitutes a timeout result for this original read's settlement.
      const entry = await read();
      if (failed) break;
      if (entry.done) {
        result = decoder.finish();
        break;
      }
      decoder.push(entry.value);
    }
  } catch (error) {
    fail(error);
  } finally {
    try {
      signal?.removeEventListener('abort', abort);
    } catch (error) {
      cleanupFailure(error);
    }
    if (failed) stop();
    if (cancellation) {
      try {
        await cancellation;
      } catch (error) {
        cleanupFailure(error);
      }
    }
    try {
      release();
    } catch (error) {
      cleanupFailure(error);
    }
  }
  if (failed) {
    result?.bytes.fill(0);
    throw first;
  }
  return result!;
}
