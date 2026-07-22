/**
 * Fleet-row health presentation. A brand-new agent has never checked in, so its
 * server-computed health is `stale` and its last-seen timestamp is `null` — the
 * same shape a genuinely dormant agent reaches after 24h+ of silence. Showing a
 * just-created agent (the DorkBot a user set up seconds ago in onboarding) as
 * "Stale" / "Never" reads as broken. This module presents that one case as
 * "New" instead, without touching the real health status a dormant agent earns.
 *
 * @module features/agents-list/lib/agent-health-display
 */
import type { AgentHealthStatus } from '@dorkos/shared/mesh-schemas';
import { formatRelativeTime } from '@/layers/shared/lib';

/** How one fleet row's status pill renders: its label and status-dot color. */
export interface AgentStatusDisplay {
  label: string;
  dotClass: string;
}

/** Status pill per server health status. */
const STATUS_DISPLAY: Record<AgentHealthStatus, AgentStatusDisplay> = {
  active: { label: 'Active', dotClass: 'bg-emerald-500' },
  inactive: { label: 'Inactive', dotClass: 'bg-amber-500' },
  stale: { label: 'Stale', dotClass: 'bg-muted-foreground/50' },
  unreachable: { label: 'Unreachable', dotClass: 'bg-red-500' },
};

/** The "New" pill for an agent that has been created but never active yet. */
const NEW_DISPLAY: AgentStatusDisplay = { label: 'New', dotClass: 'bg-sky-500' };

/**
 * Whether an agent has been created but never active. A `null` last-seen means
 * it has never sent or received a message; combined with a `stale` health
 * status that pins it to "brand new" rather than "went quiet" — a dormant agent
 * always carries the timestamp of its last activity, so `null` uniquely marks
 * never-active. `unreachable` (its path is gone) is a real problem and wins.
 *
 * @param healthStatus - Server-computed health status for the agent.
 * @param lastSeenAt - ISO timestamp of last activity, or `null` if never active.
 */
export function isNeverActive(healthStatus: AgentHealthStatus, lastSeenAt: string | null): boolean {
  return lastSeenAt === null && healthStatus === 'stale';
}

/**
 * Resolve the status pill for a fleet row — "New" for a never-active agent,
 * otherwise the health-derived label and color.
 *
 * @param healthStatus - Server-computed health status for the agent.
 * @param lastSeenAt - ISO timestamp of last activity, or `null` if never active.
 */
export function agentStatusDisplay(
  healthStatus: AgentHealthStatus,
  lastSeenAt: string | null
): AgentStatusDisplay {
  return isNeverActive(healthStatus, lastSeenAt) ? NEW_DISPLAY : STATUS_DISPLAY[healthStatus];
}

/**
 * Resolve the "last seen" cell text for a fleet row: a relative time when the
 * agent has been active, "New" for a never-active agent, and "Never" only for
 * an agent that is truly out of contact (e.g. unreachable with no history).
 *
 * @param healthStatus - Server-computed health status for the agent.
 * @param lastSeenAt - ISO timestamp of last activity, or `null` if never active.
 */
export function lastSeenLabel(healthStatus: AgentHealthStatus, lastSeenAt: string | null): string {
  if (lastSeenAt) return formatRelativeTime(lastSeenAt);
  if (isNeverActive(healthStatus, lastSeenAt)) return 'New';
  return 'Never';
}
