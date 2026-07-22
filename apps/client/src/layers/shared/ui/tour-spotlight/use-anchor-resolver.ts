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
 * Resolve a tour anchor to a live DOM element, polling until it mounts and
 * re-resolving if it later leaves the DOM.
 *
 * A tour deep-links to a route and then waits for the target to appear — a list
 * or a nav item may mount a beat after navigation. This polls
 * `[data-testid="<anchor>"]` every {@link ANCHOR_POLL_INTERVAL_MS} up to
 * {@link ANCHOR_TIMEOUT_MS}; on success it returns the element and scrolls it
 * into view, on timeout it reports `'timeout'` so the caller skips the step
 * honestly rather than spotlighting nothing.
 *
 * The poll keeps watching after a hit and a step, once reached, is sticky: a
 * query-driven section re-render can unmount and re-stamp the same `data-testid`
 * on a fresh node mid-tour, so a resolved step keeps its spotlight up (on the
 * last element) and swaps in the new node when it re-appears — it is never torn
 * down or auto-advanced on a transient disappearance. The `'timeout'` skip
 * applies ONLY to a step whose anchor never resolved at all (so a truly missing
 * surface still skips honestly). Passing `null` disables resolution.
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
    // The element currently spotlighted, whether the step was ever reached, and
    // the wait budget that applies ONLY while the step has never resolved.
    let current: HTMLElement | null = null;
    let everFound = false;
    const deadline = Date.now() + ANCHOR_TIMEOUT_MS;

    // Runs on every interval tick (never synchronously in the effect body, so no
    // setState rides the effect body). Returns true only to give up (a genuine
    // never-resolved timeout), so the caller can stop polling.
    const tick = (): boolean => {
      const found = document.querySelector<HTMLElement>(selector);
      if (found) {
        // First hit, or a re-render re-stamped the anchor on a fresh node: attach
        // (or swap) and scroll it into view. The `found !== current` guard means a
        // stable node never re-renders the spotlight.
        if (found !== current) {
          found.scrollIntoView({ block: 'center', inline: 'center' });
          current = found;
          everFound = true;
          setResolution({ element: found, status: 'found' });
        }
        return false;
      }

      // The anchor is not in the DOM right now.
      if (everFound) {
        // A step that was genuinely reached stays put: keep the spotlight on the
        // last element and keep polling to swap the anchor back in when a
        // query-driven re-render re-stamps it. A reached step is NEVER torn down
        // or auto-advanced on a transient disappearance — doing so was the
        // first-launch self-advance cascade (a lost found-step timing out, then
        // skipping through every step in ~4s increments).
        return false;
      }

      // The anchor never resolved — enforce the wait budget, then skip honestly.
      if (Date.now() >= deadline) {
        setResolution({ element: null, status: 'timeout' });
        return true;
      }
      return false;
    };

    const intervalId = setInterval(() => {
      if (tick()) clearInterval(intervalId);
    }, ANCHOR_POLL_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, [anchor]);

  return resolution;
}
