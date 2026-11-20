import type { BrowserBrokerSource } from './broker-source.js';
import type { BrowserPageScreencast, BrowserScreencastFrame } from './broker-contract.js';
import { LocalBrowserError } from '../errors.js';
import { PAGE_READ_RESPONSE_TIMEOUT_MS, responseDeadline } from '../lifecycle.js';

/** Attach only to the captured Page, over its existing owned Playwright pipe. */
export async function openPageScreencast(
  source: BrowserBrokerSource,
  admit: () => void
): Promise<BrowserPageScreencast> {
  admit();
  const session = await source.page.context().newCDPSession(source.page);
  let closed = false;
  const listeners = new Set<(frame: BrowserScreencastFrame) => void>();
  const current = () => {
    if (closed) throw stale();
    admit();
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    listeners.clear();
    session.off('Page.screencastFrame', onFrame);
    try {
      await responseDeadline(
        session.send('Page.stopScreencast'),
        PAGE_READ_RESPONSE_TIMEOUT_MS,
        stale
      );
    } finally {
      await session.detach();
    }
  };
  const onFrame = (frame: BrowserScreencastFrame) => {
    try {
      current();
      // Oversize data is discarded without allocating decoded bytes. The producer owns ACK policy otherwise.
      if (frame.data.length > Math.ceil((2 * 1024 * 1024) / 3) * 4) {
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
