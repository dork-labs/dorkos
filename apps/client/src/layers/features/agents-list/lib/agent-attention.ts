/**
 * Fleet attention order — which agents need you, which are working, and which
 * are quiet.
 *
 * `/agents` used to answer "who exists" by listing agents in whatever order the
 * topology returned them. The fleet question is "who needs me", and sort order
 * answers it more strongly than any column can. This module owns that answer:
 * every row resolves to one of three groups, and the table renders the groups in
 * order with a header on each.
 *
 * It is deliberately a pure function of a small fact object, with no React and
 * no clock. Health is already time-derived on the server (`active` < 1h,
 * `inactive` 1–24h, `stale` > 24h or never, `unreachable` when the agent's
 * folder is gone), so nothing here has to re-measure time — which keeps the
 * layer most likely to be argued about the cheapest one to verify.
 *
 * The honesty burden lives here, the same way it lives in the status bar's
 * promotion rules (ADR 260725-004456): a wrong rule does not merely add clutter,
 * it hides a real problem in the "Quiet" group. Every promotion below needs a
 * reason a user would agree with.
 *
 * @module features/agents-list/lib/agent-attention
 */
import type { AgentHealthStatus } from '@dorkos/shared/mesh-schemas';
import { getAgentDisplayName } from '@/layers/shared/lib';
import { isNeverActive } from './agent-activity-display';

/** The three states a fleet row can be in, most urgent first. */
export type AgentAttentionGroup = 'needs-you' | 'working' | 'quiet';

/** Render order for the groups. Index doubles as the primary sort rank. */
export const ATTENTION_GROUP_ORDER: readonly AgentAttentionGroup[] = [
  'needs-you',
  'working',
  'quiet',
] as const;

// ---------------------------------------------------------------------------
// Severity — rank within a group, higher first. Named so a change to one rule
// cannot silently reorder another.
// ---------------------------------------------------------------------------

/** An agent whose project folder is gone. Nothing it does will work. */
const SEVERITY_UNREACHABLE = 30;
/** Silent for over a day while scheduled tasks keep coming due. */
const SEVERITY_SILENT_WITH_SCHEDULE = 20;
/** Someone has sessions open with this agent right now. */
const SEVERITY_IN_SESSION = 20;
/** Checked in within the last hour, but nobody is in a session with it. */
const SEVERITY_RECENTLY_SEEN = 10;
/** Nothing to report. */
const SEVERITY_QUIET = 0;

/** The facts one fleet row contributes to its attention state. */
export interface AgentAttentionInput {
  /** Server-computed health status. */
  healthStatus: AgentHealthStatus;
  /** ISO timestamp of last activity, or `null` if never active. */
  lastSeenAt: string | null;
  /** Enabled scheduled tasks assigned to this agent. */
  taskCount: number;
  /** Sessions currently open under this agent's project path. */
  sessionCount: number;
}

/** Where one row sits in the attention order. */
export interface AgentAttention {
  group: AgentAttentionGroup;
  /** Rank within the group; higher sorts first. */
  severity: number;
}

/**
 * Resolve which attention group a fleet row belongs to.
 *
 * The rules, in order — the first match wins:
 *
 * 1. **Needs you** — the agent is `unreachable`. Its folder moved or was
 *    deleted, so every session and every scheduled run against it fails.
 * 2. **Needs you** — the agent has gone `stale` (silent for over a day) *and*
 *    has scheduled tasks assigned. Scheduled work keeps coming due against an
 *    agent that has stopped reporting, so the runs are failing quietly. A
 *    never-active agent is excluded: a DorkBot created seconds ago in
 *    onboarding is `stale` with a `null` last-seen, and flagging it would make
 *    a fresh install look broken.
 * 3. **Working** — sessions are open under the agent's folder right now.
 * 4. **Working** — the agent checked in within the last hour (`active`).
 * 5. **Quiet** — everything else: idle for hours, dormant with no schedule
 *    behind it, or brand new and never used.
 *
 * A non-zero `taskCount` on its own never promotes a row. Most agents carry the
 * same handful of schedules for months, so "has scheduled tasks" is a fixed
 * label repeated down the page, not news. It earns attention only paired with
 * silence, where it turns a dormant agent into failing work.
 *
 * There is no carve-out for system agents. A DorkBot whose folder is gone breaks
 * exactly as much as any other agent, so it is ranked by the same rules.
 *
 * @param input - Health, schedule, and session facts for one row.
 */
export function resolveAgentAttention(input: AgentAttentionInput): AgentAttention {
  const { healthStatus, lastSeenAt, taskCount, sessionCount } = input;

  if (healthStatus === 'unreachable') {
    return { group: 'needs-you', severity: SEVERITY_UNREACHABLE };
  }

  if (healthStatus === 'stale' && taskCount > 0 && !isNeverActive(healthStatus, lastSeenAt)) {
    return { group: 'needs-you', severity: SEVERITY_SILENT_WITH_SCHEDULE };
  }

  if (sessionCount > 0) {
    return { group: 'working', severity: SEVERITY_IN_SESSION };
  }

  if (healthStatus === 'active') {
    return { group: 'working', severity: SEVERITY_RECENTLY_SEEN };
  }

  return { group: 'quiet', severity: SEVERITY_QUIET };
}

/** A row this module can order: attention facts plus a label to break ties on. */
export type AgentAttentionRow = AgentAttentionInput & {
  name: string;
  displayName?: string;
};

/** Milliseconds since the epoch for a last-seen value; never-seen sorts last. */
function lastSeenMs(lastSeenAt: string | null): number {
  if (!lastSeenAt) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(lastSeenAt);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

/**
 * Compare two rows by attention order: group first, then severity within the
 * group, then most recently active, then display name.
 *
 * The name tie-break is what makes the order total — without it two agents in
 * the same state with the same last-seen timestamp would swap places between
 * renders, which reads as the table twitching on every refetch.
 *
 * @param a - First row.
 * @param b - Second row.
 */
export function compareAgentAttention(a: AgentAttentionRow, b: AgentAttentionRow): number {
  const left = resolveAgentAttention(a);
  const right = resolveAgentAttention(b);

  const byGroup =
    ATTENTION_GROUP_ORDER.indexOf(left.group) - ATTENTION_GROUP_ORDER.indexOf(right.group);
  if (byGroup !== 0) return byGroup;

  const bySeverity = right.severity - left.severity;
  if (bySeverity !== 0) return bySeverity;

  const byRecency = lastSeenMs(b.lastSeenAt) - lastSeenMs(a.lastSeenAt);
  if (byRecency !== 0) return byRecency;

  return getAgentDisplayName(a).localeCompare(getAgentDisplayName(b));
}

/**
 * Order fleet rows by attention, returning a new array.
 *
 * @param rows - Rows to order.
 * @param direction - `'asc'` puts the agents that need you first (the default);
 *   `'desc'` reverses the whole comparison, so the quiet fleet leads.
 */
export function sortAgentsByAttention<TRow extends AgentAttentionRow>(
  rows: TRow[],
  direction: 'asc' | 'desc' = 'asc'
): TRow[] {
  const sign = direction === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => sign * compareAgentAttention(a, b));
}

/** How one attention group's header row reads. */
export interface AgentAttentionGroupDisplay {
  label: string;
  /** Tailwind class for the header's tone. */
  toneClass: string;
}

/** Header copy and tone per attention group. */
export const ATTENTION_GROUP_DISPLAY: Record<AgentAttentionGroup, AgentAttentionGroupDisplay> = {
  'needs-you': { label: 'Needs you', toneClass: 'text-destructive' },
  working: { label: 'Working', toneClass: 'text-foreground' },
  quiet: { label: 'Quiet', toneClass: 'text-muted-foreground' },
};
