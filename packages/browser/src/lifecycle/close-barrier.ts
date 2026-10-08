import type { BrowserRecord } from './records.js';
import { until } from './deadline.js';

/** Join original controller closes before native stop, bounded by the existing input end. */
export function createSupervisorStopBarrier(
  record: BrowserRecord,
  owner: BrowserRecord['lifetime'],
  originals: readonly Promise<unknown>[],
  inputEnd: number
): Promise<void> {
  // The attached default context disconnects its own CDP transport. Complete that
  // original local close before the separate supervisor terminates its native peer.
  // Expiry fences success, but cannot prevent independently owned native retirement.
  const originalControllerCloses = Promise.allSettled(originals);
  return until(originalControllerCloses, inputEnd, 'CONTEXT_CLOSE_TIMEOUT').then(
    () => {},
    () => {
      record.retirementCloseRefusal ??= 'connection';
      owner.uncertain = true;
    }
  );
}

/** Retain the original controller rejection without replacing its promise or failure. */
export function watchControllerCloseRefusal(
  record: BrowserRecord,
  owner: BrowserRecord['lifetime'],
  original: Promise<unknown>
): void {
  void original.catch(() => {
    record.retirementCloseRefusal ??= 'connection';
    owner.uncertain = true;
  });
}
