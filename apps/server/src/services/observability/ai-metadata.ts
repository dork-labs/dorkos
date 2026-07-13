/**
 * AI-run metadata harvesting for the runtime-turn boundary (ADR 260713-143958
 * Phase 7). One place turns the per-turn usage a runtime already reports into
 * two independent observability outputs, both metadata-only:
 *
 * - **Plane 2 — the operator's own trace.** When tracing is on, the turn's
 *   `gen_ai.*` OpenTelemetry semantic-convention attributes (model, token
 *   counts, cost) are set on the existing `runtime.send_message` span, so an
 *   operator piping spans to a file or their own OTLP stack gets standards-based
 *   LLM observability for free. Nothing reaches DorkOS.
 * - **Plane 1, Tier 2 — the opt-in bridge.** When (and only when) the operator
 *   has turned on `telemetry.aiMetadata`, a `$ai_generation` event is emitted per
 *   turn to DorkOS's own ingest. The bridge is installed as a nullable callback
 *   here by {@link setAiMetadataBridge}; when it is null the bridge is off.
 *
 * The two are wired independently: tracing gates the span, the bridge callback
 * gates the event. Either, both, or neither can be active. The harvest reads
 * ONLY specific numeric/enum fields off the runtime-neutral `session_status`
 * StreamEvent — never a prompt, a path, or content — so nothing content-shaped
 * can reach a span attribute or a bridge event even if a runtime were to attach
 * extra fields to a status event.
 *
 * @module services/observability/ai-metadata
 */
import type { StreamEvent } from '@dorkos/shared/types';
import { startSpan, isTracingEnabled } from './otel.js';
import { SPAN, ATTR } from './attributes.js';

/**
 * The non-content metadata harvested from one completed runtime turn. Every
 * field is a coarse id, a count, a duration, or a cost — the complete set of
 * things the AI-observability path may ever carry.
 */
export interface AiTurnMetadata {
  /** The DorkOS runtime id (`claude-code` | `codex` | `opencode`). Always known. */
  runtime: string;
  /** The model that answered the turn, when the runtime reported one. */
  model?: string;
  /** Turn-total input tokens (summed across the turn), when known. */
  inputTokens?: number;
  /** Turn-total output tokens (summed across the turn), when known. */
  outputTokens?: number;
  /** Turn cost in USD, when the runtime reported one. */
  costUsd?: number;
  /** Wall-clock turn duration in milliseconds. Always known. */
  latencyMs: number;
}

/** The bridge sink installed by the AI-metadata reporter; null when the bridge is off. */
type AiMetadataBridge = (metadata: AiTurnMetadata) => void;

let bridge: AiMetadataBridge | null = null;

/**
 * Install (or, with `null`, tear down) the Tier 2 bridge sink. Called once at
 * boot by the composition root after it has resolved `telemetry.aiMetadata`
 * consent: it passes the reporter's emit function when the bridge is on, and
 * `null` when off. Wiring it BEFORE runtimes register lets {@link isAiBridgeEnabled}
 * report the right state at the single runtime-wrap seam.
 *
 * @param sink - The per-turn emit function, or `null` to disable the bridge.
 */
export function setAiMetadataBridge(sink: AiMetadataBridge | null): void {
  bridge = sink;
}

/** Whether the opt-in AI-metadata bridge is currently installed. */
export function isAiBridgeEnabled(): boolean {
  return bridge !== null;
}

/** Whether either observability output (span or bridge) is active for a turn. */
export function isAiObservabilityActive(): boolean {
  return isTracingEnabled() || bridge !== null;
}

/** Mutable accumulator for the harvest loop; the last-seen value of each field wins. */
interface HarvestState {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

/**
 * Fold one StreamEvent into the harvest. Reads ONLY the allowlisted numeric/enum
 * fields off a `session_status` event's data — the model, the turn-total token
 * counts, and the cost — and nothing else. Any other event type, and any other
 * field on a status event, is ignored, so no content can enter the harvest.
 *
 * @param event - A StreamEvent from the turn.
 * @param state - The mutable accumulator (last value wins).
 */
function harvestEvent(event: StreamEvent, state: HarvestState): void {
  if (event.type !== 'session_status') return;
  const data = event.data as {
    model?: unknown;
    costUsd?: unknown;
    turnInputTokens?: unknown;
    turnOutputTokens?: unknown;
  };
  if (typeof data.model === 'string') state.model = data.model;
  if (typeof data.costUsd === 'number') state.costUsd = data.costUsd;
  if (typeof data.turnInputTokens === 'number') state.inputTokens = data.turnInputTokens;
  if (typeof data.turnOutputTokens === 'number') state.outputTokens = data.turnOutputTokens;
}

/**
 * Wrap one runtime `sendMessage` turn so its AI-run metadata is harvested. Items
 * pass through untouched. On completion (or error), sets the `gen_ai.*`
 * attributes on the `runtime.send_message` span when tracing is on, and hands
 * the metadata to the opt-in bridge when it is installed.
 *
 * Only called from {@link import('./trace-runtime.js').traceRuntime} when at
 * least one output is active, so the off-path pays nothing.
 *
 * @param runtimeType - The runtime id (`target.type`).
 * @param sessionId - The DorkOS session id (an opaque id, stamped on the span).
 * @param source - The runtime's real `sendMessage` generator.
 */
export async function* observeRuntimeTurn(
  runtimeType: string,
  sessionId: string,
  source: AsyncGenerator<StreamEvent>
): AsyncGenerator<StreamEvent> {
  // A no-op span when tracing is off (bridge-only case) — attribute writes below
  // are then free, and the bridge still fires.
  const span = isTracingEnabled()
    ? startSpan(SPAN.RUNTIME_SEND_MESSAGE, {
        [ATTR.RUNTIME]: runtimeType,
        [ATTR.SESSION_ID]: sessionId,
      })
    : null;
  const startedAt = Date.now();
  const state: HarvestState = {};
  let count = 0;
  try {
    for await (const item of source) {
      count++;
      harvestEvent(item, state);
      yield item;
    }
  } catch (err) {
    span?.markError();
    throw err;
  } finally {
    const latencyMs = Date.now() - startedAt;
    if (span) {
      span.setAttr(ATTR.EVENT_COUNT, count);
      span.setAttr(ATTR.GEN_AI_SYSTEM, runtimeType);
      if (state.model !== undefined) span.setAttr(ATTR.GEN_AI_RESPONSE_MODEL, state.model);
      if (state.inputTokens !== undefined)
        span.setAttr(ATTR.GEN_AI_USAGE_INPUT_TOKENS, state.inputTokens);
      if (state.outputTokens !== undefined)
        span.setAttr(ATTR.GEN_AI_USAGE_OUTPUT_TOKENS, state.outputTokens);
      if (state.costUsd !== undefined) span.setAttr(ATTR.GEN_AI_COST_USD, state.costUsd);
      span.end();
    }
    if (bridge) {
      bridge({
        runtime: runtimeType,
        ...(state.model !== undefined ? { model: state.model } : {}),
        ...(state.inputTokens !== undefined ? { inputTokens: state.inputTokens } : {}),
        ...(state.outputTokens !== undefined ? { outputTokens: state.outputTokens } : {}),
        ...(state.costUsd !== undefined ? { costUsd: state.costUsd } : {}),
        latencyMs,
      });
    }
  }
}
