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
 * folder is gone), and the two facts that DO need something from outside — the
 * fleet-wide chat state and the onboarding-grace check — are resolved at the
 * edge and passed in. That keeps the layer most likely to be argued about the
 * cheapest one to verify.
 *
 * The honesty burden lives here, the same way it lives in the status bar's
 * promotion rules (ADR 260725-004456): a wrong rule does not merely add clutter,
 * it hides a real problem in the "Quiet" group. Every promotion below needs a
 * reason a user would agree with — and every input has to mean what the rule
 * reading it assumes it means. Chat state comes from `useAgentAttentionMap`
 * rather than a per-page count precisely because that hook is fleet-wide; a
 * count scoped to the selected working directory would make "Working" reachable
 * for exactly one row and invisible for the rest of the fleet.
 *
 * @module features/agents-list/lib/agent-attention
 */
import type { AgentHealthStatus } from '@dorkos/shared/mesh-schemas';
import type { AttentionState } from '@/layers/entities/session';
import { getAgentDisplayName } from '@/layers/shared/lib';

/** The three states a fleet row can be in, most urgent first. */
export type AgentAttentionGroup = 'needs-you' | 'working' | 'quiet';

/** Render order for the groups. Index doubles as the primary sort rank. */
export const ATTENTION_GROUP_ORDER: readonly AgentAttentionGroup[] = [
  'needs-you',
  'working',
  'quiet',
] as const;

/**
 * How long after registration an agent's silence starts to mean something.
 *
 * Matched to the server's own `stale` threshold: health only reads `stale` after
 * 24h of silence (or none ever), so an agent has to have existed at least that
 * long before "it has not reported" is a fact about the agent rather than a fact
 * about how recently it was created. A DorkBot set up seconds ago in onboarding
 * is `stale` with a `null` last-seen and may carry scheduled tasks whose first
 * run has not come due — flagging it would make a fresh install look broken.
 */
export const ONBOARDING_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Whether an agent has existed longer than {@link ONBOARDING_GRACE_MS}.
 *
 * This is the clock-dependent half of rule 2, kept out of
 * {@link resolveAgentAttention} so that function stays clock-free. Registration
 * age is the right discriminator: "has never reported" is not the same fact as
 * "was created recently", and an agent registered months ago that has never
 * reported while carrying enabled schedules is exactly the quietly-failing case
 * rule 2 exists to surface.
 *
 * @param registeredAt - ISO timestamp from the agent manifest.
 * @param now - Clock reading in epoch ms; defaults to the current time.
 */
export function isPastOnboardingGrace(registeredAt: string, now: number = Date.now()): boolean {
  const parsed = Date.parse(registeredAt);
  // An unparseable registration date cannot prove the agent is new, and the
  // rule it gates only fires alongside 24h+ of silence, so treat it as old.
  if (Number.isNaN(parsed)) return true;
  return now - parsed >= ONBOARDING_GRACE_MS;
}

// ---------------------------------------------------------------------------
// Severity — rank within a group, higher first. Named so a change to one rule
// cannot silently reorder another.
// ---------------------------------------------------------------------------

/** An agent whose project folder is gone. Nothing it does will work. */
const SEVERITY_UNREACHABLE = 30;
/** A chat under this agent is waiting on an approval, or it hit an error. */
const SEVERITY_CHAT_BLOCKED = 25;
/** Silent for over a day while scheduled tasks keep coming due. */
const SEVERITY_SILENT_WITH_SCHEDULE = 20;
/** Chats under this agent are live, or were live within the hour. */
const SEVERITY_IN_CHAT = 20;
/** Checked in within the last hour, with no live chat behind it. */
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
  /**
   * Fleet-wide state of the chats running under this agent's folder, from
   * `useAgentAttentionMap` (`entities/session`) — live session lifecycle off the
   * global event stream, joined with cross-agent session recency. Every agent in
   * the fleet gets a real reading, not just the one whose folder happens to be
   * the selected working directory.
   */
  chatState: AttentionState;
  /**
   * Whether the agent is old enough for silence to be meaningful — see
   * {@link isPastOnboardingGrace}.
   */
  isPastOnboardingGrace: boolean;
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
 * The rules, in order — the first match wins, and rule order matches severity
 * order so the two can never disagree:
 *
 * 1. **Needs you** — the agent is `unreachable`. Its folder moved or was
 *    deleted, so every session and every scheduled run against it fails.
 * 2. **Needs you** — a chat under the agent's folder is blocked on you: it is
 *    waiting for an approval, or it ended in an error. Neither resolves itself.
 * 3. **Needs you** — the agent has gone `stale` (silent for over a day) *and*
 *    has scheduled tasks assigned *and* has existed longer than the onboarding
 *    grace. Scheduled work keeps coming due against an agent that has stopped
 *    reporting, so the runs are failing quietly.
 * 4. **Working** — chats under the agent's folder are live, or were live within
 *    the hour.
 * 5. **Working** — the agent checked in within the last hour (`active`).
 * 6. **Quiet** — everything else: idle for hours, dormant with no schedule
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
 * @param input - Health, schedule, chat, and age facts for one row.
 */
export function resolveAgentAttention(input: AgentAttentionInput): AgentAttention {
  const { healthStatus, taskCount, chatState } = input;

  if (healthStatus === 'unreachable') {
    return { group: 'needs-you', severity: SEVERITY_UNREACHABLE };
  }

  if (chatState === 'needs-attention') {
    return { group: 'needs-you', severity: SEVERITY_CHAT_BLOCKED };
  }

  if (healthStatus === 'stale' && taskCount > 0 && input.isPastOnboardingGrace) {
    return { group: 'needs-you', severity: SEVERITY_SILENT_WITH_SCHEDULE };
  }

  if (chatState === 'active') {
    return { group: 'working', severity: SEVERITY_IN_CHAT };
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
