/**
 * Resolves DorkOS session thinking/effort preferences into Claude Agent SDK
 * `thinking` and `effort` options.
 *
 * Two model-default behaviors make this non-trivial:
 *
 * 1. **Omitted thinking on Opus 4.8/4.7.** These models default `thinking.display`
 *    to `"omitted"` — the API streams only a signature, no readable `thinking_delta`
 *    text, so our ThinkingBlock UI renders nothing. Setting
 *    `thinking: { type: 'adaptive', display: 'summarized' }` restores streamed
 *    thinking text. Opus 4.6 / Sonnet 4.6 already default to `"summarized"`; setting
 *    it explicitly is a harmless no-op there.
 *
 * 2. **Adaptive thinking is model-gated.** `thinking: { type: 'adaptive' }` is only
 *    valid on adaptive-capable models. Sending it to a non-adaptive model (Haiku,
 *    Opus/Sonnet 4.5, etc.) returns a 400. So we only attach a `thinking` config when
 *    the model reports `supportsAdaptiveThinking`; otherwise we leave `thinking` unset
 *    and rely on the model's own (already-summarized) default — which is exactly the
 *    behavior that works today.
 *
 * Effort is also normalized here: DorkOS's `EffortLevel` is a superset of the SDK's
 * (`none`/`minimal` are DorkOS-only), so we map them to valid SDK values before the
 * value reaches the query — replacing the previous unchecked cast.
 *
 * @module services/runtimes/claude-code/messaging/thinking-config
 */
import type { EffortLevel as SdkEffortLevel, ThinkingConfig } from '@anthropic-ai/claude-agent-sdk';
import type { EffortLevel } from '@dorkos/shared/types';

/** Effort levels the Claude Agent SDK accepts (a subset of DorkOS `EffortLevel`). */
const SDK_EFFORT_LEVELS = new Set<SdkEffortLevel>(['low', 'medium', 'high', 'xhigh', 'max']);

/** Per-model thinking capability — the subset of `ModelOption` this resolver needs. */
export interface ModelThinkingCapability {
  /** Whether the model supports adaptive thinking (`thinking: { type: 'adaptive' }`). */
  supportsAdaptiveThinking?: boolean;
}

/** Resolved SDK options derived from a session's thinking/effort preferences. */
export interface ThinkingResolution {
  /** SDK `thinking` config, or undefined to inherit the model/CLI default. */
  thinking?: ThinkingConfig;
  /** SDK `effort` value, or undefined to inherit the default (`high`). */
  effort?: SdkEffortLevel;
}

/**
 * Map a DorkOS `EffortLevel` to a valid SDK effort value.
 *
 * `none` and `minimal` are DorkOS-only: `none` carries "no reasoning" (handled by the
 * caller via disabled thinking, so it maps to no effort) and `minimal` collapses to the
 * SDK's lowest level, `low`. Any value outside the SDK set returns undefined so we never
 * forward an unsupported effort string.
 *
 * @param effort - The DorkOS session effort level, if set.
 */
function toSdkEffort(effort: EffortLevel | undefined): SdkEffortLevel | undefined {
  if (!effort || effort === 'none') return undefined;
  if (effort === 'minimal') return 'low';
  return SDK_EFFORT_LEVELS.has(effort as SdkEffortLevel) ? (effort as SdkEffortLevel) : undefined;
}

/**
 * Resolve a session's thinking/effort preferences into SDK `thinking` and `effort`
 * options, gated by the selected model's capabilities.
 *
 * @param args - The session's effort preference and the model's thinking capability.
 */
export function resolveThinkingOptions(args: {
  effort: EffortLevel | undefined;
  capability: ModelThinkingCapability | undefined;
}): ThinkingResolution {
  const { effort, capability } = args;
  const sdkEffort = toSdkEffort(effort);

  if (!capability?.supportsAdaptiveThinking) {
    // Non-adaptive or unknown model: never attach a `thinking` config (adaptive would
    // 400; manual budgets are deprecated). The model's default streams summarized
    // thinking already, so the UI keeps working unchanged.
    return { effort: sdkEffort };
  }

  // "None" means no reasoning — disable thinking outright on adaptive models.
  if (effort === 'none') {
    return { thinking: { type: 'disabled' } };
  }

  // Force summarized display so Opus 4.8/4.7 stream readable thinking text instead of
  // an empty (omitted) thinking block. Effort is the depth dial alongside it.
  return {
    thinking: { type: 'adaptive', display: 'summarized' },
    effort: sdkEffort,
  };
}
