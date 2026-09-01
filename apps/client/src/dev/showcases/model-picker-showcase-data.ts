/**
 * Catalogs for the model-picker showcase, shaped like the ones that actually
 * break it.
 *
 * These are FIXTURES, not live data. The panel's hard case is an OpenRouter
 * catalog — hundreds of models, ids namespaced two levels deep, and rows that
 * have to admit what they cannot do — and reaching a real one needs a connected
 * provider. The values below are copied from real OpenRouter ids and names so
 * the widths are the widths the app has to survive.
 *
 * @module dev/showcases/model-picker-showcase-data
 */
import type { ModelOption } from '@dorkos/shared/types';

/**
 * A model as OpenRouter reports it: a `provider/family/model` id, a description
 * that repeats the id after the provider's human name, and a tier.
 *
 * @param overrides - The fields that differ from a plain frontier text model.
 */
function openRouterModel(
  overrides: Partial<ModelOption> & { value: string; displayName: string }
): ModelOption {
  const modelId = overrides.value.replace(/^openrouter\//, '');
  return {
    description: `OpenRouter · ${modelId}`,
    contextWindow: 200_000,
    provider: 'openrouter',
    tier: 'frontier',
    ...overrides,
  };
}

/**
 * The catalog the panel was widened for (DOR-1673): long two-segment ids, a
 * model that answers with pictures, and a model that cannot call a tool at all.
 */
export const OPENROUTER_CATALOG: ModelOption[] = [
  openRouterModel({
    value: 'openrouter/anthropic/claude-sonnet-4.5',
    displayName: 'Anthropic: Claude Sonnet 4.5',
    isDefault: true,
    contextWindow: 1_000_000,
  }),
  openRouterModel({
    value: 'openrouter/google/gemini-3-pro-preview',
    displayName: 'Google: Gemini 3 Pro Preview',
    contextWindow: 1_000_000,
  }),
  openRouterModel({
    value: 'openrouter/openai/gpt-5.2-codex',
    displayName: 'OpenAI: GPT-5.2 Codex',
    tier: 'solid-coder',
    contextWindow: 400_000,
  }),
  openRouterModel({
    value: 'openrouter/qwen/qwen3-coder-480b-a35b-instruct',
    displayName: 'Qwen: Qwen3 Coder 480B A35B Instruct',
    tier: 'solid-coder',
    contextWindow: 262_000,
  }),
  openRouterModel({
    value: 'openrouter/meta-llama/llama-3.1-nemotron-ultra-253b-v1',
    displayName: 'NVIDIA: Llama 3.1 Nemotron Ultra 253B v1 (free)',
    tier: 'quick-helper',
    contextWindow: 131_000,
  }),
  // Tool-capable and picked on purpose, but it answers with pictures nothing in
  // the app can draw yet — the longest id AND a warning, on one card.
  openRouterModel({
    value: 'openrouter/google/gemini-3-pro-image',
    displayName: 'Google: Gemini 3 Pro Image Preview',
    supportsToolUse: true,
    supportsImageOutput: true,
  }),
  // Cannot call a tool: grouped apart under "Can't do agent work", whatever its
  // tier claims, and carrying the longest warning the picker can draw.
  openRouterModel({
    value: 'openrouter/deepseek/deepseek-r1-distill-llama-70b',
    displayName: 'DeepSeek: R1 Distill Llama 70B',
    supportsToolUse: false,
    contextWindow: 131_000,
  }),
  openRouterModel({
    value: 'openrouter/openrouter/auto',
    displayName: 'Auto Router',
    tier: 'quick-helper',
    supportsToolUse: true,
    supportsImageOutput: true,
    description: 'OpenRouter · openrouter/auto',
  }),
  // Not OpenRouter, and deliberately so: OpenCode lists every provider it knows
  // in ONE menu, so a locally pulled Ollama model sits in this same list. Its id
  // is `name:tag` with no slash anywhere in it, and the tag after the colon is
  // the whole difference between two pulls of the same model — the case a
  // slash-keyed overflow rule used to miss (DOR-1673).
  {
    value: 'deepseek-r1:70b-llama-distill-q4_K_M',
    displayName: 'DeepSeek R1 70B Llama Distill',
    description: 'Ollama · deepseek-r1:70b-llama-distill-q4_K_M',
    contextWindow: 131_000,
    provider: 'ollama',
    tier: 'quick-helper',
    local: true,
  },
];

/**
 * The same catalog with nothing connected: a bounded slice of every model the
 * runtime has heard of, none of it confirmed, which is what the shortened-list
 * notice at the top of the panel exists to say out loud.
 */
export const UNVERIFIED_CATALOG: ModelOption[] = OPENROUTER_CATALOG.slice(0, 5).map((model) => ({
  ...model,
  unverified: true,
}));

/**
 * A first-party catalog: three short names, each with the tier the real
 * claude-code mapper always stamps (`inferTier` — opus→flagship,
 * sonnet→balanced, haiku→fast). The tiers matter for honesty: one tiered model
 * is enough to flip `shouldUseTieredMenu`, so the app never draws this catalog
 * as a flat list — a tierless fixture here would demo a menu the product does
 * not have (DOR-1673 review).
 */
export const CLAUDE_CODE_CATALOG: ModelOption[] = [
  {
    value: 'claude-opus-4-6',
    displayName: 'Opus',
    description: 'Most capable model',
    isDefault: true,
    contextWindow: 200_000,
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high'],
    supportsFastMode: true,
    tier: 'flagship',
  },
  {
    value: 'claude-sonnet-4-6',
    displayName: 'Sonnet',
    description: 'Balanced performance',
    contextWindow: 200_000,
    tier: 'balanced',
  },
  {
    value: 'claude-haiku-4-5',
    displayName: 'Haiku',
    description: 'Fastest responses',
    contextWindow: 200_000,
    tier: 'fast',
  },
];
