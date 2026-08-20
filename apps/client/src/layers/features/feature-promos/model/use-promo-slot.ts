import { useMemo } from 'react';
import type { PromoDefinition, PromoPlacement } from './promo-types';
import { PROMO_REGISTRY } from './promo-registry';
import { selectPromos } from './select-promos';
import { usePromoContext } from './use-promo-context';
import { usePromoDismissals } from '@/layers/entities/config';
import { useAppStore } from '@/layers/shared/model';

/**
 * Main consumer hook — returns filtered, sorted, capped promos for a placement slot.
 *
 * Pipeline: filter by placement -> {@link selectPromos} (dismissed, conditions,
 * priority, cap). Returns empty array when global toggle is off or no promos qualify.
 *
 * @param placement - The slot to filter promos for
 * @param maxUnits - Maximum number of promos to return
 */
export function usePromoSlot(placement: PromoPlacement, maxUnits: number): PromoDefinition[] {
  const ctx = usePromoContext();
  const { dismissedIds: dismissedPromoIds } = usePromoDismissals();
  const promoEnabled = useAppStore((s) => s.promoEnabled);

  return useMemo(() => {
    if (!promoEnabled) return [];

    return selectPromos(
      PROMO_REGISTRY.filter((p) => p.placements.includes(placement)),
      ctx,
      dismissedPromoIds,
      maxUnits
    );
  }, [placement, maxUnits, ctx, dismissedPromoIds, promoEnabled]);
}
