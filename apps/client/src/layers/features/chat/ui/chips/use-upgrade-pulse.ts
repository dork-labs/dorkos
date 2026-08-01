/**
 * The once-only pulse behind a chip's read→edit morph.
 *
 * @module features/chat/ui/chips/use-upgrade-pulse
 */
import { useCallback, useState } from 'react';

/** The strip's record of which upgrades have already been celebrated. */
export interface UpgradePulses {
  /**
   * Whether this chip's upgrade still owes the reader a ring.
   *
   * @param key - The chip's stable identity.
   * @param upgraded - Whether the accumulator has marked it read→edited.
   */
  shouldPulse: (key: string, upgraded: boolean | undefined) => boolean;
  /**
   * Spend a chip's ring, so the upgrade is never announced twice.
   *
   * @param key - The chip's stable identity.
   */
  acknowledge: (key: string) => void;
}

/** The set every strip starts with: nothing upgraded, nothing spent. */
const NOTHING_ACKNOWLEDGED: ReadonlySet<string> = new Set();

/**
 * Track, for one strip, which chips have already played their upgrade ring.
 *
 * This lives at the STRIP rather than on each chip because a chip is not a
 * stable component. The live row holds the four most recent touches, so a file
 * read early in a turn leaves the row, sits in the pile, and remounts when it is
 * edited — which is precisely the moment the ring is for. A pulse remembered in
 * the chip's own state is destroyed by that remount and re-seeded from the props
 * it mounts with, so the one animation the design asks for is the one animation
 * that never played.
 *
 * Two things this deliberately does not do. It does not pulse for a chip whose
 * upgrade has already been acknowledged — a transcript being re-read is not an
 * upgrade happening, and celebrating it would make motion mean something other
 * than "this is happening now". And it is never consulted by the tray or a
 * showcase: those chips are a record being read, so they are given no pulse to
 * spend.
 *
 * @returns The ledger: what still owes a ring, and how to spend one.
 */
export function useUpgradePulses(): UpgradePulses {
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(NOTHING_ACKNOWLEDGED);

  const shouldPulse = useCallback(
    (key: string, upgraded: boolean | undefined) => upgraded === true && !acknowledged.has(key),
    [acknowledged]
  );

  const acknowledge = useCallback((key: string) => {
    setAcknowledged((spent) => (spent.has(key) ? spent : new Set(spent).add(key)));
  }, []);

  return { shouldPulse, acknowledge };
}
