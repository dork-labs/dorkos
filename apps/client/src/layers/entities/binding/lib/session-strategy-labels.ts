/**
 * Human-readable labels for binding session-strategy values.
 *
 * Single source of truth for the short badge/edge labels shown wherever a
 * binding's session strategy surfaces (adapter binding rows, topology edges).
 *
 * @module entities/binding/lib/session-strategy-labels
 */
import type { SessionStrategy } from '@dorkos/shared/relay-schemas';

/** Short display labels for each session strategy. */
export const SESSION_STRATEGY_LABELS: Record<SessionStrategy, string> = {
  'per-chat': 'Per Chat',
  'per-user': 'Per User',
  stateless: 'Stateless',
};

/**
 * Resolve a friendly session-strategy label, falling back to the raw value for
 * unknown strategies.
 *
 * @param strategy - The raw session-strategy string.
 */
export function sessionStrategyLabel(strategy: string): string {
  return SESSION_STRATEGY_LABELS[strategy as SessionStrategy] ?? strategy;
}
