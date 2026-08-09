import type { PromoContext, PromoDefinition } from './promo-types';

/**
 * The qualification pipeline, once: drop what the reader has already waved away,
 * ask each promo its own question, order by priority, cap.
 *
 * Shared by every surface that can offer a promo — the card slots and the quiet
 * state on home — so that "does this person qualify" has exactly one answer.
 * Surfaces differ in which promos they put in, and how many they take out; they
 * do not differ in the rules (team-room-home spec D5.3).
 *
 * Pure, and deliberately not a hook: the callers already hold the context and
 * the dismissal list, and a function is the easy thing to test. Generic in the
 * candidate type so a caller that narrowed its input — the quiet state keeps
 * only the promos with a sentence written for them — gets the narrowed type
 * back rather than having to re-prove it.
 *
 * @param candidates - The promos this surface is willing to show at all.
 * @param ctx - What is true about this install right now.
 * @param dismissedIds - Promos the reader has dismissed, and meant it.
 * @param maxUnits - How many the surface has room for.
 * @returns The qualifying promos, highest priority first.
 */
export function selectPromos<T extends PromoDefinition>(
  candidates: T[],
  ctx: PromoContext,
  dismissedIds: string[],
  maxUnits: number
): T[] {
  return candidates
    .filter((promo) => !dismissedIds.includes(promo.id))
    .filter((promo) => promo.shouldShow(ctx))
    .sort((a, b) => b.priority - a.priority)
    .slice(0, maxUnits);
}
