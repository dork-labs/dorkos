/**
 * Model tiering + stable sorting for OpenCode's long provider catalog.
 *
 * OpenCode can surface hundreds of models across cloud providers and local
 * runtimes. The picker groups them into three coarse, honest tiers so the menu
 * reads as a shortlist instead of a raw dump (spec: opencode-connect-overhaul §2):
 *
 * - `frontier` — a small, curated set of known headliner models (Claude
 *   Sonnet/Opus, GPT-5.x / o-series, Gemini Pro, DeepSeek R1/V3+, Grok 4, Qwen
 *   Max-class). Pattern-matched from a data-driven table; nothing is *guessed*
 *   into this tier — an unknown model never becomes a headliner.
 * - `solid-coder` — mid-size models, 10B–70B parameters.
 * - `quick-helper` — small models, under 10B parameters.
 *
 * Everything here is pure and unit-tested. Tiering reads only a model's id/name;
 * the OpenCode SDK is never touched.
 *
 * @module services/runtimes/opencode/model-tiers
 */
import type { ModelOption, ModelTier } from '@dorkos/shared/types';

/**
 * Curated headliner patterns, in display order. The first pattern a model id/name
 * matches makes it `frontier` and fixes its rank within the Frontier group, so
 * the shortlist leads with the best-known models. Data-driven and deliberately
 * conservative: only well-known frontier families appear, and only their
 * frontier-class members (e.g. Gemini *Pro*, not Gemini Flash).
 */
const FRONTIER_PATTERNS: readonly RegExp[] = [
  /claude.*opus/i,
  /claude.*sonnet/i,
  /gpt-?5/i,
  /\bo[134](?:[-\s]|$)/i, // OpenAI o-series reasoning models (o1/o3/o4)
  /gemini.*pro/i,
  /deepseek.*(?:r1|v3)/i,
  /grok-?4/i,
  /qwen.*max/i,
];

/** Below this many billion parameters a model is a `quick-helper`. */
const QUICK_HELPER_MAX_PARAMS_B = 10;

/** At or below this many billion parameters (and at least the quick-helper cap) a model is a `solid-coder`. */
const SOLID_CODER_MAX_PARAMS_B = 70;

/**
 * Parse a parameter count in billions from a model id/name (e.g. `qwen2.5-coder:7b`
 * → `7`, `deepseek-r1:14b` → `14`, `phi-3.5:3.8b` → `3.8`). Only a number
 * immediately suffixed with `b` at a token boundary counts, so version numbers
 * like the `2.5` in `qwen2.5` or the `5` in `gpt-5` are never mistaken for params.
 * Returns `undefined` when no parameter count is present.
 *
 * @param text - The model id and/or name to scan.
 */
export function parseParamsB(text: string): number | undefined {
  const match = text.match(/(?:^|[\s:_/-])(\d+(?:\.\d+)?)\s*b(?![a-z0-9])/i);
  return match ? Number(match[1]) : undefined;
}

/**
 * The index of the first curated frontier pattern a model matches, or
 * `Number.POSITIVE_INFINITY` when it matches none. Drives the Frontier group's
 * curated ordering.
 *
 * @param text - The model id and/or name to classify.
 */
export function frontierRank(text: string): number {
  const index = FRONTIER_PATTERNS.findIndex((pattern) => pattern.test(text));
  return index === -1 ? Number.POSITIVE_INFINITY : index;
}

/**
 * Classify a model into a coarse capability {@link ModelTier}, or `undefined`
 * when it fits none. A curated headliner match wins; otherwise the parameter
 * count decides (`<10B` → `quick-helper`, `10B–70B` → `solid-coder`). An unknown
 * model, or one above 70B without a curated match, gets **no tier** — we never
 * guess a headliner.
 *
 * @param text - The model id and/or name to classify.
 */
export function classifyTier(text: string): ModelTier | undefined {
  if (frontierRank(text) !== Number.POSITIVE_INFINITY) return 'frontier';
  const params = parseParamsB(text);
  if (params === undefined) return undefined;
  if (params < QUICK_HELPER_MAX_PARAMS_B) return 'quick-helper';
  if (params <= SOLID_CODER_MAX_PARAMS_B) return 'solid-coder';
  return undefined;
}

/** Sort priority per group: Frontier first, then Solid coders, Quick helpers, and untiered last. */
const TIER_GROUP_ORDER: Record<ModelTier, number> = {
  frontier: 0,
  'solid-coder': 1,
  'quick-helper': 2,
};

/** The catch-all group index for models with no {@link ModelTier} (legacy tiers included). */
const UNTIERED_GROUP = 3;

/** The recognized coarse tiers a model can carry (legacy claude/codex tiers are treated as untiered). */
const MODEL_TIERS: ReadonlySet<string> = new Set<ModelTier>([
  'frontier',
  'solid-coder',
  'quick-helper',
]);

/** The group index a model sorts into, from its tagged tier. */
function groupOf(option: ModelOption): number {
  if (option.tier && MODEL_TIERS.has(option.tier)) {
    return TIER_GROUP_ORDER[option.tier as ModelTier];
  }
  return UNTIERED_GROUP;
}

/** The text tiering/ordering reasons over for one option. */
function tierText(option: ModelOption): string {
  return `${option.value} ${option.displayName}`;
}

/**
 * Sort model options into the picker's reading order — Frontier (curated order)
 * → Solid coders → Quick helpers → untiered (alphabetical) — pure and stable.
 * Grouping reads each option's already-tagged {@link ModelOption.tier}; only the
 * Frontier group is re-ordered (by curated rank) and only the untiered group is
 * alphabetized. Within Solid coders and Quick helpers the input order is
 * preserved. The input array is never mutated.
 *
 * @param options - The model options to sort (tiers already tagged).
 */
export function sortModelOptions(options: ModelOption[]): ModelOption[] {
  return options
    .map((option, index) => ({ option, index }))
    .sort((a, b) => {
      const groupA = groupOf(a.option);
      const groupB = groupOf(b.option);
      if (groupA !== groupB) return groupA - groupB;

      if (groupA === TIER_GROUP_ORDER.frontier) {
        const rankDelta = frontierRank(tierText(a.option)) - frontierRank(tierText(b.option));
        if (rankDelta !== 0) return rankDelta;
      } else if (groupA === UNTIERED_GROUP) {
        const nameDelta = a.option.displayName.localeCompare(b.option.displayName);
        if (nameDelta !== 0) return nameDelta;
      }

      // Stable tiebreak: preserve original input order.
      return a.index - b.index;
    })
    .map((entry) => entry.option);
}
