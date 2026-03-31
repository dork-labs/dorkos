/**
 * Feature promos — declarative feature discovery cards.
 * Registry-driven system for contextually surfacing feature education.
 *
 * @module features/feature-promos
 */
export { PROMO_REGISTRY } from './model/promo-registry';
export { PromoSlot } from './ui/PromoSlot';
export { usePromoSlot } from './model/use-promo-slot';
export type {
  PromoDefinition,
  PromoPlacement,
  PromoAction,
  PromoDialogProps,
  PromoOpenDialogProps,
  PromoContent,
  PromoContext,
} from './model/promo-types';
