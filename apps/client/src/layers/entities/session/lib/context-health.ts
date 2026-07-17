/**
 * The ONE client-side source for context-window percent, thresholds, and
 * severity. Every context surface — the status-bar `ContextItem`, the proactive
 * compaction chip, the status-bar stream derivation, `use-session-status`, and
 * the fleet-level gauge/summary — imports its formula and its amber/red
 * thresholds from here, so the four historically-duplicated percent
 * computations can never drift into a fifth copy.
 *
 * Pure and dependency-light (one type import from `@dorkos/shared`), sitting in
 * the lowest FSD layer every consumer reaches (`entities/session`), so a
 * sibling feature no longer has to duplicate the threshold it cannot import
 * across `features/*`.
 *
 * @module entities/session/lib/context-health
 */
import type { ContextUsage } from '@dorkos/shared/types';

/** Context usage at/above which a session is "near full" — amber. */
export const CONTEXT_WARNING_PERCENT = 80;

/** Context usage at/above which a session is "at the ceiling" — red. */
export const CONTEXT_CRITICAL_PERCENT = 95;

/** Severity band for a context-usage percent. */
export type ContextSeverity = 'ok' | 'warning' | 'critical';

/**
 * Map a 0-100 context-usage percent to its severity band: `critical` at/above
 * {@link CONTEXT_CRITICAL_PERCENT}, else `warning` at/above
 * {@link CONTEXT_WARNING_PERCENT}, else `ok`.
 *
 * @param percent - Context-window utilization percent (0-100).
 */
export function contextSeverity(percent: number): ContextSeverity {
  if (percent >= CONTEXT_CRITICAL_PERCENT) return 'critical';
  if (percent >= CONTEXT_WARNING_PERCENT) return 'warning';
  return 'ok';
}

/**
 * Derive context-window utilization percent (0-100) with the single formula
 * `min(100, round(tokens / maxTokens * 100))`. Returns `null` when either input
 * is missing or non-positive — guarding a divide-by-zero and a non-positive
 * window (an unknown catalog window), so callers render an honest "unknown"
 * rather than a fabricated 0%.
 *
 * @param tokens - Tokens currently occupying the context window.
 * @param maxTokens - The model's context-window size.
 */
export function deriveContextPercent(
  tokens: number | null | undefined,
  maxTokens: number | null | undefined
): number | null {
  if (tokens == null || tokens <= 0) return null;
  if (maxTokens == null || maxTokens <= 0) return null;
  return Math.min(100, Math.round((tokens / maxTokens) * 100));
}

/**
 * Resolve the percent to DISPLAY: the SDK breakdown's own `percentage` (rounded
 * to a whole percent, exactly as the badge shows it) when a rich
 * {@link ContextUsage} is present — it is more accurate than the client's
 * coarser catalog-derived estimate — else the passed `estimatePercent`.
 *
 * @param estimatePercent - The client's coarse estimate (may be `null`).
 * @param contextUsage - The SDK usage breakdown, when available.
 */
export function resolveDisplayContextPercent(
  estimatePercent: number | null,
  contextUsage?: ContextUsage | null
): number | null {
  if (contextUsage) return Math.round(contextUsage.percentage);
  return estimatePercent;
}
