/**
 * Fleet-row activity presentation — what an agent last did, in plain English.
 *
 * The topology payload carries a `lastSeenEvent` string written by whatever
 * touched the agent: `'heartbeat'` from `POST /api/mesh/agents/:id/heartbeat`,
 * `'message_sent'` when a message is dispatched to it, `'response_complete'`
 * when it finishes a turn. The heartbeat endpoint accepts a free-form `event`
 * string, so the set is open-ended and a value may be anything. Nothing here
 * ever renders a raw value: known events map to a phrase, and unknown ones are
 * de-underscored and sentence-cased before they reach a person.
 *
 * A brand-new agent has never checked in, so its server-computed health is
 * `stale` and its last-seen timestamp is `null` — the same shape a genuinely
 * dormant agent reaches after 24h+ of silence. Showing a just-created agent
 * (the DorkBot a user set up seconds ago in onboarding) as "Stale" reads as
 * broken, so {@link isNeverActive} separates the two and this module presents
 * the never-active case as "Not used yet".
 *
 * @module features/agents-list/lib/agent-activity-display
 */
import type { AgentHealthStatus } from '@dorkos/shared/mesh-schemas';
import { formatRelativeTime } from '@/layers/shared/lib';

/** Longest unknown-event phrase rendered before it is truncated. */
const MAX_EVENT_PHRASE_LENGTH = 32;

/** Phrase shown when an event string carries no readable words. */
const UNREADABLE_EVENT_PHRASE = 'Checked in';

/** Plain-English phrasing for the events DorkOS itself records. */
const EVENT_PHRASES: Record<string, string> = {
  heartbeat: 'Checked in',
  message_sent: 'Got a message',
  response_complete: 'Finished a reply',
};

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
 * Turn a `lastSeenEvent` value into a phrase a person can read.
 *
 * Known events get a written phrase. Anything else is treated as an identifier:
 * underscores and dashes become spaces, the result is sentence-cased and capped
 * so a long or malformed value cannot stretch the row. A value with no readable
 * words at all falls back to "Checked in", because the agent demonstrably did
 * check in — only the label for what it did is missing.
 *
 * @param raw - The `lastSeenEvent` value from the topology payload.
 */
export function humanizeAgentEvent(raw: string): string {
  const known = EVENT_PHRASES[raw.trim().toLowerCase()];
  if (known) return known;

  // Any run of separators or punctuation collapses to a single space, so
  // `tool_error`, `cron-run-finished`, and `sync::failed!` all read as words.
  const words = raw
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase();
  if (!words) return UNREADABLE_EVENT_PHRASE;

  const sentence = words.charAt(0).toUpperCase() + words.slice(1);
  if (sentence.length <= MAX_EVENT_PHRASE_LENGTH) return sentence;
  return `${sentence.slice(0, MAX_EVENT_PHRASE_LENGTH - 1).trimEnd()}…`;
}

/** The facts one fleet row's Activity cell is written from. */
export interface AgentActivityInput {
  healthStatus: AgentHealthStatus;
  lastSeenAt: string | null;
  lastSeenEvent: string | null;
  /** Sessions currently open under this agent's project path. */
  sessionCount: number;
}

/** How one fleet row's Activity cell reads. */
export interface AgentActivityDisplay {
  /** What the agent last did, or the health news when that outranks it. */
  primary: string;
  /** When it happened, plus open sessions. `null` when there is nothing to add. */
  secondary: string | null;
  /** Tailwind class for the primary line's tone. */
  toneClass: string;
}

/** Open-session phrase, or `null` when the agent has none. */
function sessionsPhrase(sessionCount: number): string | null {
  if (sessionCount <= 0) return null;
  return `${sessionCount} session${sessionCount === 1 ? '' : 's'} open`;
}

/** Join the parts of a secondary line, dropping the empty ones. */
function joinSecondary(parts: Array<string | null>): string | null {
  const kept = parts.filter((part): part is string => Boolean(part));
  return kept.length > 0 ? kept.join(' · ') : null;
}

/**
 * Resolve the Activity cell for a fleet row: what the agent last did on the
 * primary line, when it happened on the secondary.
 *
 * Two cases override the event, because an agent's last action is not the news
 * when its present state is worse than its past one:
 *
 * - **Unreachable** — the folder behind the agent is gone, so nothing it did
 *   before matters until that is fixed. The event drops to the second line.
 * - **Never active** — there is no event to report, and "Never" reads as a
 *   fault when the honest reading is "nobody has used it yet".
 *
 * @param input - Health, last-seen, and session facts for one row.
 */
export function agentActivityDisplay(input: AgentActivityInput): AgentActivityDisplay {
  const { healthStatus, lastSeenAt, lastSeenEvent, sessionCount } = input;
  const sessions = sessionsPhrase(sessionCount);
  const seenAgo = lastSeenAt ? formatRelativeTime(lastSeenAt) : null;
  const didWhat = lastSeenEvent ? humanizeAgentEvent(lastSeenEvent) : null;

  if (healthStatus === 'unreachable') {
    return {
      primary: 'Cannot be reached',
      secondary: joinSecondary([didWhat, seenAgo ?? 'never seen', sessions]),
      toneClass: 'text-destructive',
    };
  }

  if (isNeverActive(healthStatus, lastSeenAt) || !lastSeenAt) {
    return {
      primary: 'Not used yet',
      secondary: sessions,
      toneClass: 'text-muted-foreground',
    };
  }

  return {
    primary: didWhat ?? UNREADABLE_EVENT_PHRASE,
    secondary: joinSecondary([seenAgo, sessions]),
    toneClass: healthStatus === 'active' ? 'text-foreground' : 'text-muted-foreground',
  };
}
