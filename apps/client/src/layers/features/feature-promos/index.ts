/**
 * Feature promos — declarative feature discovery cards.
 * Registry-driven system for contextually surfacing feature education.
 *
 * @module features/feature-promos
 */
export { PROMO_REGISTRY } from './model/promo-registry';
export { usePromoSlot } from './model/use-promo-slot';
// The promo's entry in a sidebar's bottom slot — one card, arbitrated against
// the getting-started card, the update pill and the profile prompt. It replaced
// `PromoSlot`, which stacked three of them inside the scroller (spec
// `sidebar-simplification` D4).
export { usePromoCandidate } from './ui/use-promo-candidate';
export { PromoCard } from './ui/PromoCard';
// The quiet-state suggestion (spec D5.3), in two halves: the wired one the home
// quiet state mounts, and the presentational one behind it, which the Dev
// Playground draws without waiting for a cockpit that happens to be idle.
export { QuietSuggestion } from './ui/QuietSuggestion';
export { QuietSuggestionView } from './ui/QuietSuggestionView';
export type { QuietSuggestionViewProps } from './ui/QuietSuggestionView';
export type {
  PromoDefinition,
  PromoPlacement,
  PromoAction,
  PromoDialogProps,
  PromoContent,
  PromoContext,
  QuietSuggestionCopy,
} from './model/promo-types';
