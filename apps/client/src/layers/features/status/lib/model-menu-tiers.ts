/**
 * Tiered, searchable model menu — pure grouping and filtering logic.
 *
 * Backs `ModelConfigPopover`'s switch from a flat model list to a searchable
 * menu grouped into Frontier / Solid coders / Quick helpers / More models
 * once the catalog carries tier metadata or grows past a usable flat-list
 * size (spec: opencode-connect-overhaul §8).
 *
 * @module features/status/lib/model-menu-tiers
 */
import type { ModelOption, ModelTier } from '@dorkos/shared/types';

/** Fixed slug/label for each menu group, in display order. */
export const TIER_GROUP_ORDER = [
  { slug: 'frontier', label: 'Frontier' },
  { slug: 'solid-coders', label: 'Solid coders' },
  { slug: 'quick-helpers', label: 'Quick helpers' },
  { slug: 'more-models', label: 'More models' },
] as const;

/** Slug identifying one of the four fixed model-menu groups. */
export type TierGroupSlug = (typeof TIER_GROUP_ORDER)[number]['slug'];

/** Untiered list length above which the menu switches to the searchable, grouped layout. */
export const SEARCHABLE_THRESHOLD = 10;

/**
 * Maps a raw `tier` onto its menu group; no tier or a legacy/unknown value
 * (the older `flagship`/`balanced`/`fast`/`specialized`/`legacy` vocabulary)
 * falls into "More models".
 *
 * @param tier - A model option's raw `tier` field.
 */
export function tierGroupSlug(tier: ModelOption['tier']): TierGroupSlug {
  switch (tier as ModelTier | undefined) {
    case 'frontier':
      return 'frontier';
    case 'solid-coder':
      return 'solid-coders';
    case 'quick-helper':
      return 'quick-helpers';
    default:
      return 'more-models';
  }
}

/**
 * Whether to render the searchable, tier-grouped menu instead of the flat list.
 *
 * @param models - The full model catalog for the current session/runtime.
 */
export function shouldUseTieredMenu(models: ModelOption[]): boolean {
  return models.some((m) => m.tier != null) || models.length > SEARCHABLE_THRESHOLD;
}

/**
 * Case-insensitive substring match against a model's id or display name.
 *
 * @param model - The model option to test.
 * @param query - The user's search query.
 */
export function matchesQuery(model: ModelOption, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return model.value.toLowerCase().includes(q) || model.displayName.toLowerCase().includes(q);
}

/** One populated group in the tiered model menu. */
export interface TieredGroup {
  slug: TierGroupSlug;
  label: string;
  models: ModelOption[];
}

/**
 * Buckets models into the four fixed menu groups, preserving the incoming
 * order within each group (the server already sorts; this never re-sorts).
 * Groups with no matching options are omitted.
 *
 * @param models - The (already filtered, if searching) model list to bucket.
 */
export function groupByTier(models: ModelOption[]): TieredGroup[] {
  const buckets = new Map<TierGroupSlug, ModelOption[]>(
    TIER_GROUP_ORDER.map((group) => [group.slug, []])
  );
  for (const model of models) {
    buckets.get(tierGroupSlug(model.tier))!.push(model);
  }
  return TIER_GROUP_ORDER.map((group) => ({ ...group, models: buckets.get(group.slug)! })).filter(
    (group) => group.models.length > 0
  );
}
