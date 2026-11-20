import type { BrowserViewerPageHandle } from '../local-browser/leases/broker-contract.js';
import { BrowserViewerError, VIEWER_LIMITS, type ViewerFrame } from './viewer-contract.js';
import { jpegSize } from './jpeg-size.js';
import { responseDeadline } from '../local-browser/lifecycle.js';

/** Consume only the broker's typed screencast port; never acquire a Page or CDP target. */
export async function startChromeScreencast(
  handle: BrowserViewerPageHandle,
  receive: (frame: ViewerFrame) => void
): Promise<() => Promise<void>> {
  const stream = await handle.openScreencast();
  let closed = false;
  let stopping: Promise<void> | undefined;
  let sequence = 0;
  let lastSent = -Infinity;
  const generation = handle.facts().navigationGeneration + 1;
  const off = stream.onFrame((event) => {
    if (closed) return;
    // Protocol ACKs never wait for an HTTP paint receipt.
    void stream.acknowledge(event.sessionId).catch(() => void stop());
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
    receive({ ...size, bytes, generation, sequence: ++sequence });
  });
  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    closed = true;
    off();
    stopping = stream.close();
    return stopping;
  };
  try {
    await responseDeadline(
      stream.start({ quality: 70, maxWidth: VIEWER_LIMITS.width, maxHeight: VIEWER_LIMITS.height }),
      3_000,
      () => new BrowserViewerError('viewer_unavailable')
    );
    handle.assertCurrent();
    if (closed) throw new BrowserViewerError('viewer_unavailable');
    return stop;
  } catch {
    await stop().catch(() => undefined);
    throw new BrowserViewerError('viewer_unavailable');
  }
}
