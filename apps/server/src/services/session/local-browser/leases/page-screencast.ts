import type { Page } from 'playwright-core';
import type { BrowserBrokerSource } from './broker-source.js';
import type { BrowserPageScreencast, BrowserScreencastFrame } from './broker-contract.js';
import { LocalBrowserError } from '../errors.js';
import { PAGE_READ_RESPONSE_TIMEOUT_MS, responseDeadline } from '../lifecycle.js';

// The lock follows physical protocol work, including timed-out attachments and late stops.
// A new viewer cannot overlap an old session whose teardown has not settled.
const physical = new WeakMap<Page, symbol>();

/** Attach only to the captured Page, over its existing owned Playwright pipe. */
export async function openPageScreencast(
  source: BrowserBrokerSource,
  admit: () => void
): Promise<BrowserPageScreencast> {
  admit();
  if (physical.has(source.page))
    throw new LocalBrowserError('busy', 'The browser view is finishing. Wait a moment.');
  const token = Symbol('screencast');
  physical.set(source.page, token);
  const release = () => {
    if (physical.get(source.page) === token) physical.delete(source.page);
  };
  let abandoned = false;
  const attaching = source.page.context().newCDPSession(source.page);
  void attaching.then(async (late) => {
    if (abandoned) {
      try {
        await late.detach();
        release();
      } catch {
        /* Keep uncertain attachment reserved. */
      }
    }
  }, release);
  const session = await responseDeadline(attaching, 3_000, () => {
    abandoned = true;
    return stale();
  });
  let closed = false;
  const listeners = new Set<(frame: BrowserScreencastFrame) => void>();
  const current = () => {
    if (closed) throw stale();
    admit();
  };
  let stopping: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (stopping) return stopping;
    closed = true;
    listeners.clear();
    session.off('Page.screencastFrame', onFrame);
    // Detach starts even if stop never answers. Release the reservation only after
    // both settle: a late stop must never hit a replacement producer.
    const cleanup = Promise.allSettled([
      Promise.resolve().then(() => session.send('Page.stopScreencast')),
      Promise.resolve().then(() => session.detach()),
    ]).then((results) => {
      if (results.every((result) => result.status === 'fulfilled') || source.page.isClosed())
        release();
    });
    stopping = responseDeadline(cleanup, PAGE_READ_RESPONSE_TIMEOUT_MS, stale);
    // A bounded caller may leave; physical cleanup retains its own reservation.
    void stopping.catch(() => undefined);
    return stopping;
  };
  const onFrame = (frame: BrowserScreencastFrame) => {
    try {
      current();
      // Oversize data is discarded without allocating decoded bytes. The producer owns ACK policy otherwise.
      if (
        typeof frame.data !== 'string' ||
        frame.data.length > Math.ceil((2 * 1024 * 1024) / 3) * 4
      ) {
        void session
          .send('Page.screencastFrameAck', { sessionId: frame.sessionId })
          .catch(() => undefined);
        return;
      }
      for (const listener of listeners) listener(frame);
    } catch {
      void close().catch(() => undefined);
    }
  };
  try {
    current();
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
  session.on('Page.screencastFrame', onFrame);
  return {
    async start(options) {
      current();
      if (
        !Number.isInteger(options.quality) ||
        options.quality < 1 ||
        options.quality > 100 ||
        !Number.isInteger(options.maxWidth) ||
        options.maxWidth < 1 ||
        options.maxWidth > 1280 ||
        !Number.isInteger(options.maxHeight) ||
        options.maxHeight < 1 ||
        options.maxHeight > 960
      )
        throw new LocalBrowserError('invalid_input', 'That browser image size is not supported.');
      await session.send('Page.startScreencast', {
        format: 'jpeg',
        everyNthFrame: 1,
        quality: options.quality,
        maxWidth: options.maxWidth,
        maxHeight: options.maxHeight,
      });
      current();
    },
    async acknowledge(sessionId) {
      current();
      if (!Number.isSafeInteger(sessionId) || sessionId < 0) throw stale();
      await session.send('Page.screencastFrameAck', { sessionId });
      current();
    },
    onFrame(listener) {
      current();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close,
  };
}

function stale(): LocalBrowserError {
  return new LocalBrowserError('stale_page', 'The page changed. Open its view again.');
}
