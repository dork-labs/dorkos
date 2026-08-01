/**
 * The once-only pulse behind a chip's read→edit morph.
 *
 * @module features/chat/ui/chips/use-upgrade-pulse
 */
import { useCallback, useState } from 'react';

/** A pulse that is either running or spent. */
export interface UpgradePulse {
  /** Whether the ring is currently expanding. */
  pulsing: boolean;
  /** Called when the ring finishes, so it leaves the tree instead of lingering. */
  end: () => void;
}

/**
 * Fire exactly one pulse, the moment a chip stops being a file that was read
 * and becomes a file that was changed.
 *
 * Two things this deliberately does not do. It does not pulse for a chip that
 * was already upgraded when it mounted — a transcript being re-read, or the
 * tray being opened, is not an upgrade happening, and celebrating it would make
 * motion mean something other than "this is happening now". And it does not
 * pulse again on later edits: `upgraded` is set once by the accumulator and
 * stays set, so there is only ever one falsy→true edge to catch.
 *
 * The edge is caught during render rather than in an effect, so the ring and the
 * diffstat sliding in beside it both start on the same commit; an effect would
 * mount the diffstat first and animate it a frame later, which reads as a stutter.
 *
 * @param upgraded - Whether the chip has been upgraded from read to edited.
 * @returns Whether the ring is running, and the callback that ends it.
 */
export function useUpgradePulse(upgraded: boolean): UpgradePulse {
  const [wasUpgraded, setWasUpgraded] = useState(upgraded);
  const [pulsing, setPulsing] = useState(false);

  if (upgraded !== wasUpgraded) {
    setWasUpgraded(upgraded);
    if (upgraded) setPulsing(true);
  }

  const end = useCallback(() => setPulsing(false), []);

  return { pulsing, end };
}
