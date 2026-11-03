/**
 * Whether this device's main pointer can hover.
 *
 * Asked as `(hover: none)` rather than `(hover: hover)`, so a browser or a test
 * that answers neither counts as a device with a mouse.
 *
 * @module @dork-labs/ui/use-can-hover
 */
import { useSyncExternalStore } from 'react';

const NO_HOVER = '(hover: none)';

function subscribe(onChange: () => void) {
  const query = window.matchMedia?.(NO_HOVER);
  query?.addEventListener?.('change', onChange);
  return () => query?.removeEventListener?.('change', onChange);
}

function canHoverNow() {
  return !window.matchMedia?.(NO_HOVER)?.matches;
}

/** True unless the device says its main pointer cannot hover. */
export function useCanHover(): boolean {
  return useSyncExternalStore(subscribe, canHoverNow, () => true);
}
