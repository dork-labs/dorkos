/**
 * The promo's entry in a sidebar's bottom slot.
 *
 * The slot shows one card at a time and promos are the lowest-priority
 * candidate, so a placement contributes exactly one: the highest-priority promo
 * this person still qualifies for (spec `sidebar-simplification` D4). This is
 * what replaced `PromoSlot`, which stacked up to three of them inside the
 * scroller.
 *
 * @module features/feature-promos/ui/use-promo-candidate
 */
import { useMemo } from 'react';
import type { BottomSlotCandidate } from '@/layers/shared/ui';
import type { PromoPlacement } from '../model/promo-types';
import { usePromoSlot } from '../model/use-promo-slot';
import { PromoCard } from './PromoCard';

/**
 * How many promos a bottom slot takes: one.
 *
 * The slot arbitrates against the getting-started card, the update pill and the
 * profile prompt, so "how many promos" was never the question — it is "does a
 * promo win the one card there is room for".
 */
const BOTTOM_SLOT_PROMO_UNITS = 1;

/**
 * The promo candidate for a bottom slot, or a candidate that never shows.
 *
 * Always returns a candidate rather than `null` so the caller's priority list
 * is a fixed shape and the slot's arbitration reads as a list of `show` flags
 * rather than a list with holes in it.
 *
 * @param placement - Which sidebar is asking.
 */
export function usePromoCandidate(placement: PromoPlacement): BottomSlotCandidate {
  const [promo] = usePromoSlot(placement, BOTTOM_SLOT_PROMO_UNITS);

  return useMemo(() => {
    if (promo === undefined) {
      return { id: 'promo', show: false, render: () => null };
    }
    // Keyed by the promo's own id, so one promo giving way to another after a
    // dismissal reads as a card changing rather than as the same card
    // rewriting itself.
    return { id: `promo:${promo.id}`, show: true, render: () => <PromoCard promo={promo} /> };
  }, [promo]);
}
