import { useEffect, useState } from 'react';

import { tourAnchorSelector, type TourAnchorId } from '@/layers/shared/config';

/** How long to wait for an async-mounted anchor before skipping the step. */
export const ANCHOR_TIMEOUT_MS = 4000;

/** How often to re-check the DOM for the anchor while resolving. */
export const ANCHOR_POLL_INTERVAL_MS = 100;

/** The lifecycle of one anchor resolution. */
export type AnchorStatus = 'resolving' | 'found' | 'timeout';

/** The result of resolving a single tour anchor. */
export interface AnchorResolution {
  /** The resolved element, or null while resolving or after a timeout. */
  element: HTMLElement | null;
  /** Where this resolution is in its lifecycle. */
  status: AnchorStatus;
}

/**
 * Resolve a tour anchor to a live DOM element, polling until it mounts.
 *
 * A tour deep-links to a route and then waits for the target to appear — a list
 * or a nav item may mount a beat after navigation. This polls
 * `[data-testid="<anchor>"]` every {@link ANCHOR_POLL_INTERVAL_MS} up to
 * {@link ANCHOR_TIMEOUT_MS}; on success it returns the element and scrolls it
 * into view, on timeout it reports `'timeout'` so the caller skips the step
 * honestly rather than spotlighting nothing. Passing `null` disables resolution
 * (used while no step is active).
 *
 * @param anchor - The anchor to resolve, or null to stay idle.
 */
export function useAnchorResolver(anchor: TourAnchorId | null): AnchorResolution {
  const [resolution, setResolution] = useState<AnchorResolution>({
    element: null,
    status: 'resolving',
  });
  const [trackedAnchor, setTrackedAnchor] = useState<TourAnchorId | null>(anchor);

  // Restart the poll when the target anchor changes — React's blessed "adjust
  // state during render" pattern, so the reset never rides an effect.
  if (anchor !== trackedAnchor) {
    setTrackedAnchor(anchor);
    setResolution({ element: null, status: 'resolving' });
  }

  useEffect(() => {
    if (anchor === null) return;

    const selector = tourAnchorSelector(anchor);
    const deadline = Date.now() + ANCHOR_TIMEOUT_MS;

    // Returns true once the anchor resolves or times out, so the caller stops
    // polling. setState here rides the interval callback, never the effect body.
    const check = (): boolean => {
      const found = document.querySelector<HTMLElement>(selector);
      if (found) {
        found.scrollIntoView({ block: 'center', inline: 'center' });
        setResolution({ element: found, status: 'found' });
        return true;
      }
      if (Date.now() >= deadline) {
        setResolution({ element: null, status: 'timeout' });
        return true;
      }
      return false;
    };

    const intervalId = setInterval(() => {
      if (check()) clearInterval(intervalId);
    }, ANCHOR_POLL_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, [anchor]);

  return resolution;
}
