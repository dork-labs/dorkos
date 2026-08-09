/**
 * Feature promos — declarative feature discovery cards.
 * Registry-driven system for contextually surfacing feature education.
 *
 * @module features/feature-promos
 */
export { PROMO_REGISTRY } from './model/promo-registry';
export { PromoSlot } from './ui/PromoSlot';
export { usePromoSlot } from './model/use-promo-slot';
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
  PromoOpenDialogProps,
  PromoContent,
  PromoContext,
  QuietSuggestionCopy,
} from './model/promo-types';
