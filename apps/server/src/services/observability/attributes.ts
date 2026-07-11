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
} as const;

/**
 * Allowlist of attribute keys permitted in an exported span. The file span
 * processor drops any attribute whose key is absent here, so the trace file
 * can never leak content even if instrumentation code is later changed to set
 * an off-list attribute.
 */
export const ALLOWED_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set(Object.values(ATTR));
