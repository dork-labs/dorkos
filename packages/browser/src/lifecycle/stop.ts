import type { BrowserBinding } from '../contracts.js';

/** Browser-lifetime admission port; close wiring calls stop before any awaited teardown. */
export interface BrowserStopGate {
  readonly stopped: boolean;
  accepts(binding: BrowserBinding): boolean;
  register(binding: BrowserBinding, tombstone: () => void): (() => void) | null;
  stop(): void;
}

/** Reject unseen/late Pages synchronously and attempt every registered tab tombstone. */
export function createBrowserStopGate(
  browserId: string,
  browserGeneration: number
): BrowserStopGate {
  let stopped = false;
  const tabs = new Set<() => void>();
  const accepts = (binding: BrowserBinding): boolean =>
    !stopped && binding.browserId === browserId && binding.browserGeneration === browserGeneration;
  return Object.freeze({
    get stopped() {
      return stopped;
    },
    accepts,
    register(binding: BrowserBinding, tombstone: () => void) {
      if (!accepts(binding)) return null;
      tabs.add(tombstone);
      return () => tabs.delete(tombstone);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      const callbacks = [...tabs];
      tabs.clear();
      // The admission tombstone survives a faulty consumer; another tab must still stop.
      for (const callback of callbacks) {
        try {
          callback();
        } catch {
          continue;
        }
      }
    },
  });
}
