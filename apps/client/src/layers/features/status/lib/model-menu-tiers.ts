/**
 * Tiered, searchable model menu — pure grouping, filtering, and honesty logic.
 *
 * Backs `ModelConfigPopover`'s switch from a flat model list to a searchable
 * menu grouped into Frontier / Solid coders / Quick helpers / More models
 * once the catalog carries tier metadata or grows past a usable flat-list
 * size (spec: opencode-connect-overhaul §8).
 *
 * It also carries the answer to "why did the model I picked do nothing?"
 * (DOR-1660). A catalog like OpenRouter's offers hundreds of models, and some
 * of them cannot do what a DorkOS session asks: about a quarter cannot call a
 * tool at all, and a handful answer with pictures DorkOS cannot yet show. Those
 * models stay in the menu — hiding a model someone deliberately went looking for
 * is its own bug — but they are grouped apart and labelled with the reason, so
 * the answer arrives before the click instead of after it.
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
  // Last on purpose: still reachable, never in the way.
  { slug: 'no-tools', label: "Can't do agent work" },
] as const;

/** Slug identifying one of the model-menu groups. */
export type TierGroupSlug = (typeof TIER_GROUP_ORDER)[number]['slug'];

/** Untiered list length above which the menu switches to the searchable, grouped layout. */
export const SEARCHABLE_THRESHOLD = 10;

/**
 * Why a model in the "Can't do agent work" group is there — it cannot call
 * tools, so it can only talk.
 */
const NO_TOOLS_NOTE = "Can't use tools, so it can't read files or run commands.";

/**
 * Why an image model is flagged wherever it sits. Honest about DorkOS, not about
 * the model: the model works and bills for the work, but nothing in the app can
 * render what it returns yet, so picking it looks like silence.
 *
 * This note is coupled to that gap, not to the model. **Delete it, its branch in
 * {@link modelLimitationNote}, and the matching paragraph in
 * `docs/guides/runtimes.mdx` when DOR-1663 (message images by reference) lands**
 * — a picker that keeps warning about a limit that has been lifted is lying in
 * the other direction. Named here so the removal has an owner instead of
 * depending on someone remembering.
 */
const IMAGE_OUTPUT_NOTE = 'Makes images, and DorkOS cannot show them yet.';

/**
 * Model ids that ROUTE a prompt to some other model rather than answering
 * themselves (OpenRouter's `openrouter/auto` and its variants).
 *
 * They are excluded from the image warning even though their catalog entry
 * lists image among its outputs, because that entry describes the union of
 * everything they might route to — not what they do with a coding prompt, which
 * is return text essentially every time. Warning at the moment of choice that a
 * router "makes images" is not caution, it is misinformation about the single
 * most sensible OpenRouter default.
 *
 * Their tool support is NOT waived: if a router genuinely cannot call tools,
 * that is still true of every prompt sent to it and still worth saying.
 */
const ROUTER_MODEL_PREFIXES = ['openrouter/openrouter/auto', 'openrouter/auto'] as const;

/**
 * Whether a model is a router/aggregator whose declared output modalities
 * describe its whole downstream fleet rather than any one answer.
 *
 * @param model - The model option to test.
 */
function isRouterModel(model: ModelOption): boolean {
  return ROUTER_MODEL_PREFIXES.some(
    (prefix) => model.value === prefix || model.value.startsWith(`${prefix}-`)
  );
}

/**
 * Whether a model can do agent work — the grouping rule for "Can't do agent
 * work". Only an explicit `supportsToolUse: false` counts: a runtime that does
 * not report the capability leaves it absent, and an unknown model is treated as
 * capable rather than quietly demoted.
 *
 * @param model - The model option to test.
 */
function canDoAgentWork(model: ModelOption): boolean {
  return model.supportsToolUse !== false;
}

/**
 * The one-line honest warning shown on a model's card, or `null` when the model
 * has nothing the person needs to know before picking it. The image note wins
 * when both apply: it names the surprise (a charge, and nothing to show for it)
 * rather than restating the group header the card already sits under.
 *
 * @param model - The model option to describe.
 */
export function modelLimitationNote(model: ModelOption): string | null {
  if (model.supportsImageOutput === true && !isRouterModel(model)) return IMAGE_OUTPUT_NOTE;
  if (!canDoAgentWork(model)) return NO_TOOLS_NOTE;
  return null;
}

/**
 * Maps a model onto its menu group. A model that cannot call tools is grouped by
 * that fact whatever its tier — the tier says how strong it is, which is beside
 * the point when it cannot do the job at all. Otherwise the raw `tier` decides,
 * and no tier or a legacy/unknown value (the older
 * `flagship`/`balanced`/`fast`/`specialized`/`legacy` vocabulary) falls into
 * "More models".
 *
 * @param model - The model option to place.
 */
function modelGroupSlug(model: ModelOption): TierGroupSlug {
  if (!canDoAgentWork(model)) return 'no-tools';
  switch (model.tier as ModelTier | undefined) {
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
 * Buckets models into the fixed menu groups, preserving the incoming order
 * within each group (the server already sorts; this never re-sorts). Groups with
 * no matching options are omitted.
 *
 * @param models - The (already filtered, if searching) model list to bucket.
 */
export function groupByTier(models: ModelOption[]): TieredGroup[] {
  const buckets = new Map<TierGroupSlug, ModelOption[]>(
    TIER_GROUP_ORDER.map((group) => [group.slug, []])
  );
  for (const model of models) {
    buckets.get(modelGroupSlug(model))!.push(model);
  }
  return TIER_GROUP_ORDER.map((group) => ({ ...group, models: buckets.get(group.slug)! })).filter(
    (group) => group.models.length > 0
  );
}
