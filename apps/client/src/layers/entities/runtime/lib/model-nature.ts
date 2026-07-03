/**
 * Per-model "nature" — the honest privacy/cost + capability read shown at the
 * point of model choice (spec effortless-runtime-switching, decision 11).
 *
 * The tradeoff a local model makes is real and must be legible, never hidden and
 * never oversold: 🔒 local · private · free vs $ cloud · per-token, plus an
 * honest capability line. Nature is DERIVED from the model's provider/locality
 * (a local provider such as Ollama vs a cloud gateway), not a hardcoded
 * per-model table — so it holds for models we have never seen.
 *
 * @module entities/runtime/lib/model-nature
 */

/** Whether a model runs on the user's machine or in the cloud. */
export type ModelLocality = 'local' | 'cloud';

/**
 * Provider ids that run models on the user's own machine (private + free).
 * Ollama is the zero-auth hero; the rest are common OpenAI-compatible local
 * servers. Anything not listed is treated as cloud — the honest default, so a
 * model is never falsely badged "free".
 */
const LOCAL_PROVIDERS = new Set(['ollama', 'lmstudio', 'llamacpp', 'llama.cpp', 'vllm', 'local']);

/** Below this parameter count, local tool-calling is unreliable (DOR-180 research). */
const FRONTIER_PARAM_FLOOR_B = 14;

/** The honest, derived nature of a model at the point of choice. */
export interface ModelNature {
  /** Where the model runs. */
  locality: ModelLocality;
  /** Compact badge label, e.g. `local · private · free` or `cloud · per-token`. */
  badgeLabel: string;
  /** One honest line on the privacy/cost tradeoff. */
  benefit: string;
  /**
   * Honest capability line — never claims a local model equals a frontier one.
   * For small local models (under ~14B) it names the tool-calling caveat
   * explicitly.
   */
  capability: string;
  /** Approximate parameter count in billions parsed from the id, or `null`. */
  paramsB: number | null;
}

/**
 * Parse an approximate parameter count (in billions) from a model id.
 *
 * Reads a trailing `<n>b` token (e.g. `qwen2.5-coder:7b` → `7`, `llama3.1:70b`
 * → `70`). Returns `null` when the id carries no size — callers then fall back
 * to the size-agnostic honest capability line.
 *
 * @param modelId - The model identifier, e.g. `ollama/qwen2.5-coder:7b`.
 */
export function parseParamsB(modelId: string): number | null {
  const match = modelId.match(/(\d+(?:\.\d+)?)\s*b\b/i);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) ? value : null;
}

/**
 * Resolve whether a model is local or cloud from its provider and/or id.
 *
 * Prefers an explicit `provider`; otherwise reads the `provider/` prefix of the
 * id (OpenCode's `provider/model` convention). Unknown → cloud (the honest
 * default — never falsely "local · free").
 */
function resolveLocality(provider: string | null | undefined, modelId: string): ModelLocality {
  const explicit = provider?.trim().toLowerCase();
  if (explicit) return LOCAL_PROVIDERS.has(explicit) ? 'local' : 'cloud';
  const slash = modelId.indexOf('/');
  const prefix = slash >= 0 ? modelId.slice(0, slash).toLowerCase() : '';
  return prefix && LOCAL_PROVIDERS.has(prefix) ? 'local' : 'cloud';
}

/**
 * Derive a model's honest nature (privacy/cost + capability) from its
 * provider/locality.
 *
 * @param params - The model's provider id (when known) and its model id.
 */
export function deriveModelNature(params: {
  provider?: string | null;
  modelId: string;
}): ModelNature {
  const locality = resolveLocality(params.provider, params.modelId);
  const paramsB = parseParamsB(params.modelId);

  if (locality === 'local') {
    const small = paramsB !== null && paramsB < FRONTIER_PARAM_FLOOR_B;
    return {
      locality,
      badgeLabel: 'local · private · free',
      benefit:
        'Private and free — it runs on your machine, so your code never leaves it and there are no per-token bills.',
      capability: small
        ? `Capable for everyday coding, but not frontier — small local models (under ~${FRONTIER_PARAM_FLOOR_B}B) are unreliable at tool-calling. For frontier quality, reach for Claude, Codex, or a top cloud model.`
        : 'Runs entirely on your machine — capable, though frontier quality still comes from Claude, Codex, or a top cloud model.',
      paramsB,
    };
  }

  return {
    locality,
    badgeLabel: 'cloud · per-token',
    benefit: 'Runs in the cloud, billed per token — nothing to install, no local hardware needed.',
    capability: 'Frontier quality — Claude, Codex, and top cloud models live here.',
    paramsB,
  };
}
