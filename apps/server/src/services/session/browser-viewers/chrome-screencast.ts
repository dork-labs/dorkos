import type { CDPSession, Page } from 'playwright-core';
import { BrowserViewerError, VIEWER_LIMITS, type ViewerFrame } from './viewer-contract.js';
import { responseDeadline } from '../local-browser/lifecycle.js';

interface ScreencastEvent {
  sessionId: number;
  data: string;
}

/** Read JPEG dimensions without decoding or retaining another copy of its pixels. */
function jpegSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xda || marker === 0xd9) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 8) return null;
      return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return null;
}

/** Start a JPEG-only page stream on the browser's existing owned Playwright pipe. */
export async function startChromeScreencast(
  page: Page,
  receive: (frame: ViewerFrame) => void
): Promise<() => Promise<void>> {
  let abandoned = false;
  const attaching = page.context().newCDPSession(page);
  // A late protocol attachment is still ours to detach; a timed-out viewer never adopts it.
  void attaching
    .then((session) => {
      if (abandoned) void session.detach().catch(() => undefined);
    })
    .catch(() => undefined);
  const cdp: CDPSession = await responseDeadline(attaching, 3_000, () => {
    abandoned = true;
    return new BrowserViewerError('viewer_unavailable');
  });
  let closed = false;
  let stopping: Promise<void> | undefined;
  let sequence = 0;
  let lastSent = -Infinity;
  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    closed = true;
    cdp.off('Page.screencastFrame', frame);
    page.off('framenavigated', navigated);
    page.off('close', invalidated);
    // Detach does not wait for a stuck stop response. Publication was fenced above.
    stopping = responseDeadline(
      Promise.allSettled([cdp.send('Page.stopScreencast'), cdp.detach()]),
      2_000,
      () => new BrowserViewerError('viewer_unavailable')
    )
      .then(() => undefined)
      .catch(() => undefined);
    return stopping;
  };
  const invalidated = () => {
    void stop();
  };
  const navigated = (changed: unknown) => {
    if (changed === page.mainFrame()) invalidated();
  };
  const frame = (event: ScreencastEvent) => {
    if (closed) return;
    // Chrome ACKs do not wait for a paint receipt or a slow HTTP viewer.
    if (Number.isSafeInteger(event.sessionId))
      void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(invalidated);
    if (
      typeof event.data !== 'string' ||
      event.data.length > Math.ceil(VIEWER_LIMITS.frameBytes / 3) * 4 ||
      event.data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(event.data)
    )
      return;
    const now = performance.now();
    if (now - lastSent < VIEWER_LIMITS.frameIntervalMs) return;
    const bytes = Buffer.from(event.data, 'base64');
    const size = jpegSize(bytes);
    if (
      !size ||
      bytes.length > VIEWER_LIMITS.frameBytes ||
      size.width < 1 ||
      size.width > VIEWER_LIMITS.width ||
      size.height < 1 ||
      size.height > VIEWER_LIMITS.height
    )
      return;
    lastSent = now;
    receive({ ...size, bytes, generation: 1, sequence: ++sequence });
  };
  cdp.on('Page.screencastFrame', frame);
  page.on('framenavigated', navigated);
  page.on('close', invalidated);
  try {
    await responseDeadline(
      cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 70,
        maxWidth: VIEWER_LIMITS.width,
        maxHeight: VIEWER_LIMITS.height,
        everyNthFrame: 1,
      }),
      3_000,
      () => new BrowserViewerError('viewer_unavailable')
    );
    if (closed) throw new BrowserViewerError('viewer_unavailable');
    return stop;
  } catch {
    await stop();
    throw new BrowserViewerError('viewer_unavailable');
  }
}
