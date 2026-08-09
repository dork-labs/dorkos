import { useMemo } from 'react';
import { useAppStore } from '@/layers/shared/model';
import { PROMO_REGISTRY } from './promo-registry';
import { selectPromos } from './select-promos';
import { usePromoContext } from './use-promo-context';
import type { PromoContent, PromoDefinition, QuietSuggestionCopy } from './promo-types';

/** A promo somebody has written a sentence for, so it can speak in a quiet room. */
export interface SuggestingPromo extends PromoDefinition {
  content: PromoContent & { suggestion: QuietSuggestionCopy };
}

/** Whether a registry entry carries the one-line copy the quiet state needs. */
function hasSuggestion(promo: PromoDefinition): promo is SuggestingPromo {
  return promo.content.suggestion !== undefined;
}

/**
 * The one suggestion DorkBot may offer in a quiet room — or nothing at all.
 *
 * Not a second eligibility system (team-room-home spec D5.3): the candidates are
 * the registry's own entries, the rules are their own `shouldShow` predicates,
 * the dismissal list is the promo dismissal list, and the Preferences switch
 * that silences promo cards silences this too. What this adds is a cap of one
 * and a copy requirement — a promo with no {@link QuietSuggestionCopy} written
 * for it has nothing to say here, however well it qualifies.
 *
 * One, rather than the best two: a quiet morning that answers with a list is not
 * a quiet morning. And because dismissal is remembered, working through the
 * short list takes one press per morning at most, then stops for good.
 *
 * @returns The promo to suggest, or `null` when there is nothing worth saying.
 */
export function useQuietSuggestion(): SuggestingPromo | null {
  const ctx = usePromoContext();
  const dismissedPromoIds = useAppStore((s) => s.dismissedPromoIds);
  const promoEnabled = useAppStore((s) => s.promoEnabled);

  return useMemo(() => {
    if (!promoEnabled) return null;

    const [top] = selectPromos(PROMO_REGISTRY.filter(hasSuggestion), ctx, dismissedPromoIds, 1);
    return top ?? null;
  }, [ctx, dismissedPromoIds, promoEnabled]);
}
