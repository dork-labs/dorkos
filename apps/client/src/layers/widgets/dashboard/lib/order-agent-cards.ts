/**
 * Ordering for the dashboard "Your agents" cards: the default agent first, then
 * most-recent activity, then agents that have never been active. Pure and
 * stable, so equal-recency ties keep their input (roster) order.
 *
 * @module widgets/dashboard/lib/order-agent-cards
 */
import type { AttentionState } from '@/layers/entities/session';

/** View model for one dashboard agent card. */
export interface DashboardAgentCard {
  /** The agent's registered project path — the click target and stable key. */
  path: string;
  /** Human display name. */
  displayName: string;
  /** Avatar background color. */
  color: string;
  /** Avatar emoji. */
  emoji: string;
  /** The agent's attention state. */
  attention: AttentionState;
  /** ISO timestamp of last activity, or `null` if never active. */
  lastActivityIso: string | null;
}

/** The maximum number of agent cards shown before the overflow link. */
export const MAX_AGENT_CARDS = 6;

/** Activity time as epoch ms; a never-active agent sorts last. */
function activityRank(card: DashboardAgentCard): number {
  return card.lastActivityIso ? Date.parse(card.lastActivityIso) : -Infinity;
}

/**
 * Order agent cards: default agent first, then newest activity first, with
 * never-active agents last. Stable for ties.
 *
 * @param cards - The unordered cards.
 * @param defaultAgentDir - The default agent's registered path (pinned first).
 */
export function orderAgentCards(
  cards: DashboardAgentCard[],
  defaultAgentDir: string
): DashboardAgentCard[] {
  return [...cards].sort((a, b) => {
    const aDefault = a.path === defaultAgentDir;
    const bDefault = b.path === defaultAgentDir;
    if (aDefault !== bDefault) return aDefault ? -1 : 1;
    return activityRank(b) - activityRank(a);
  });
}
