import type { BrowserViewerPageHandle } from '../local-browser/leases/broker-contract.js';
import type { ViewerFrame } from './viewer-contract.js';
import { startChromeScreencast } from './chrome-screencast.js';

/** Restart through physical teardown; no old document may stamp a new generation's pixels. */
export async function startBrokerPageStream(
  handle: BrowserViewerPageHandle,
  receive: (frame: ViewerFrame) => void,
  failed: () => void
): Promise<() => Promise<void>> {
  let closed = false;
  let sequence = 0;
  let revision = 0;
  let installed = -1;
  let stop: (() => Promise<void>) | undefined;
  let running: Promise<void> | undefined;
  let facts = handle.facts();
  const refresh = async () => {
    while (!closed) {
      const captured = revision;
      const previous = stop;
      stop = undefined;
      await previous?.();
      if (closed) return;
      await handle.assertAuthorized();
      if (closed) return;
      stop = await startChromeScreencast(handle, (frame) => {
        if (closed || captured !== revision) return;
        receive({ ...frame, sequence: ++sequence });
      });
      installed = captured;
      if (captured === revision) return;
    }
  };
  const schedule = () => {
    if (running || closed) return;
    running = refresh()
      .catch(() => {
        closed = true;
        failed();
      })
      .finally(() => {
        running = undefined;
        if (!closed && installed !== revision) schedule();
      });
  };
  const off = handle.onPageChange((next) => {
    if (
      next.navigationGeneration === facts.navigationGeneration &&
      next.controlEpoch === facts.controlEpoch
    )
      return;
    facts = next;
    revision++;
    schedule();
  });
  schedule();
  await running;
  if (closed) {
    off();
    await stop?.().catch(() => undefined);
    throw Error('viewer_unavailable');
  }
  let cleanup: Promise<void> | undefined;
  return () => {
    if (cleanup) return cleanup;
    closed = true;
    off();
    cleanup = (async () => {
      await running;
      await stop?.();
    })();
    return cleanup;
  };
}
