/**
 * Human status line for a dashboard agent card, derived from the shared
 * attention model (`entities/session`). One source of truth: the card reuses the
 * same `AttentionState` the sidebar's filters and rollup dots read, mapped to a
 * plain, operator-facing phrase. The mapping is exhaustive against
 * `AttentionState`, so widening that union without extending this map fails the
 * build.
 *
 * @module widgets/dashboard/lib/agent-card-status
 */
import type { AttentionState } from '@/layers/entities/session';
import { formatRelativeTime } from '@/layers/shared/lib';

/**
 * Phrase a "quiet" state with its last-activity time, e.g. "Idle since 3h ago".
 * Falls back to the bare word when the agent has no recorded activity.
 *
 * @param word - The status word ("Idle" or "Resting").
 * @param lastActivityIso - ISO timestamp of last activity, or `null`.
 */
function sinceLabel(word: string, lastActivityIso: string | null): string {
  return lastActivityIso ? `${word} since ${formatRelativeTime(lastActivityIso)}` : word;
}

/**
 * Resolve the one-line human status shown on a dashboard agent card.
 *
 * @param state - The agent's attention state.
 * @param lastActivityIso - ISO timestamp of last activity, or `null` if never active.
 */
export function agentCardStatusLabel(
  state: AttentionState,
  lastActivityIso: string | null
): string {
  switch (state) {
    case 'fresh':
      return 'New, say hello';
    case 'active':
      return 'Working now';
    case 'needs-attention':
      return 'Needs your OK';
    case 'idle':
      return sinceLabel('Idle', lastActivityIso);
    case 'inactive':
      return sinceLabel('Resting', lastActivityIso);
    default: {
      // Exhaustiveness guard: a new AttentionState must extend this map.
      const unhandled: never = state;
      return unhandled;
    }
  }
}
