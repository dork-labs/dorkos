/**
 * Span names and the attribute allowlist for DorkOS tracing.
 *
 * This module is the single source of truth for WHAT a span may record. The
 * file span processor filters every exported span's attributes through
 * {@link ALLOWED_ATTRIBUTE_KEYS}, so a debug trace can only ever contain the
 * keys named here — durations, counts, opaque ids, and coarse enums. Prompts,
 * file paths, tokens, env, hostnames, usernames, and session content have no
 * key to ride on and are dropped even if a future seam sets them by mistake.
 *
 * @module services/observability/attributes
 */

/** Stable span names, one per instrumented seam. */
export const SPAN = {
  /** Interactive session turn orchestration (trigger-turn). */
  SESSION_TURN: 'session.turn',
  /** A single AgentRuntime `sendMessage` invocation (the runtime boundary). */
  RUNTIME_SEND_MESSAGE: 'runtime.send_message',
  /** Publishing a message onto the relay bus. */
  RELAY_DISPATCH: 'relay.dispatch',
  /** A scheduled or manual task run. */
  TASK_RUN: 'task.run',
} as const;

/**
 * The complete set of attribute keys a DorkOS span may carry. Every value is an
 * opaque id, a count, a duration, or a coarse enum — never user content. This
 * set IS the no-PII contract: {@link ALLOWED_ATTRIBUTE_KEYS} enforces it at the
 * export seam.
 */
export const ATTR = {
  /**
   * Opaque session id (random UUID / run id) for correlating spans in a file.
   * The one allowlisted key carrying an id rather than a count/enum: it MUST
   * stay an opaque identifier — never a filesystem-derived or otherwise
   * content-bearing value — which is a precondition on any future runtime.
   */
  SESSION_ID: 'dorkos.session_id',
  /** Runtime type, e.g. `'claude-code'` | `'codex'` | `'opencode'`. */
  RUNTIME: 'dorkos.runtime',
  /** Number of stream events observed during a runtime turn. */
  EVENT_COUNT: 'dorkos.event_count',
  /** Coarse relay subject bucket: `'system'` | `'agent'` (never the raw subject). */
  SUBJECT_KIND: 'dorkos.subject_kind',
  /** Number of relay endpoints a publish was delivered to. */
  DELIVERED_TO: 'dorkos.delivered_to',
  /** Task trigger: `'scheduled'` | `'manual'`. */
  TASK_TRIGGER: 'dorkos.task_trigger',
  /** Task dispatch path: `'relay'` | `'direct'`. */
  TASK_DISPATCH: 'dorkos.task_dispatch',

  // --- OpenTelemetry GenAI semantic-convention attributes (ADR 260713-143958
  // Phase 7). Set on the runtime-turn span so an operator's own trace/OTLP stack
  // gets standards-based LLM observability of their agent runs. All are coarse
  // metadata — model names, token counts, cost — never a prompt, path, or
  // content. The value of `gen_ai.system` is the DorkOS runtime id (not a raw
  // provider name), per the ADR. ---
  /** GenAI system: the DorkOS runtime id (`claude-code` | `codex` | `opencode`). */
  GEN_AI_SYSTEM: 'gen_ai.system',
  // `gen_ai.request.model` is deliberately absent: no runtime distinguishes a
  // requested vs answering model today; reinstate when one does.
  /** The model that answered the turn, when the runtime reports one. */
  GEN_AI_RESPONSE_MODEL: 'gen_ai.response.model',
  /** Turn-total input tokens (summed across the turn's requests), when known. */
  GEN_AI_USAGE_INPUT_TOKENS: 'gen_ai.usage.input_tokens',
  /** Turn-total output tokens (summed across the turn's requests), when known. */
  GEN_AI_USAGE_OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',
  /**
   * Turn cost in USD, when the runtime reports one. Not an OTel-standard GenAI
   * key (the convention leaves cost vendor-specific), so it stays in the
   * `dorkos.` namespace — still a plain number, never content.
   */
  GEN_AI_COST_USD: 'dorkos.gen_ai.cost_usd',
} as const;

/**
 * Allowlist of attribute keys permitted in an exported span. The file span
 * processor drops any attribute whose key is absent here, so the trace file
 * can never leak content even if instrumentation code is later changed to set
 * an off-list attribute.
 */
export const ALLOWED_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set(Object.values(ATTR));
