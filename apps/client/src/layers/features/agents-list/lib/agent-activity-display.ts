/**
 * Fleet-row activity presentation — what an agent last did, in plain English.
 *
 * The topology payload carries a `lastSeenEvent` string written by whatever
 * touched the agent: `'heartbeat'` from `POST /api/mesh/agents/:id/heartbeat`,
 * `'message_sent'` when a message is dispatched to it, `'response_complete'`
 * when it finishes a turn. The heartbeat endpoint accepts a free-form `event`
 * string, so the set is open-ended and a value may be anything. Nothing here
 * ever renders a raw value: known events map to a phrase, and unknown ones are
 * de-underscored and sentence-cased before they reach a person — preserving
 * acronyms, because DorkOS's vocabulary is full of them (`MCP_tool_call` reads
 * as "MCP tool call", not "Mcp tool call").
 *
 * A brand-new agent has never checked in, so its server-computed health is
 * `stale` and its last-seen timestamp is `null` — the same shape a genuinely
 * dormant agent reaches after 24h+ of silence. Showing a just-created agent
 * (the DorkBot a user set up seconds ago in onboarding) as "Stale" reads as
 * broken, so {@link isNeverActive} separates the two and this module presents
 * the never-active case as "Not used yet".
 *
 * The cell deliberately says nothing about how many chats an agent has. The
 * attention group a row sits in already carries that, and the only count
 * available to this page is a lifetime transcript count for the one folder that
 * happens to be selected — a number that cannot honestly be called "open".
 *
 * @module features/agents-list/lib/agent-activity-display
 */
import type { AgentHealthStatus } from '@dorkos/shared/mesh-schemas';
import type { AttentionState } from '@/layers/entities/session';
import { formatRelativeTime } from '@/layers/shared/lib';

/** Longest unknown-event phrase rendered before it is truncated. */
const MAX_EVENT_PHRASE_LENGTH = 32;

/**
 * Longest all-caps run still read as an acronym. Beyond this it is a shouted
 * word, not an initialism, and gets sentence-cased like any other word —
 * `A2A` stays `A2A`, `HEARTBEAT_FAILED` becomes "Heartbeat failed".
 */
const MAX_ACRONYM_LENGTH = 5;

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

/** Whether a word is a short all-caps initialism whose case must survive. */
function isAcronym(word: string): boolean {
  if (word.length < 2 || word.length > MAX_ACRONYM_LENGTH) return false;
  return word === word.toUpperCase() && /\p{Lu}/u.test(word);
}

/**
 * Turn a `lastSeenEvent` value into a phrase a person can read.
 *
 * Known events get a written phrase. Anything else is treated as an identifier:
 * underscores and dashes become spaces, each word is lowercased unless it is a
 * short all-caps initialism, the result is sentence-cased and capped so a long
 * or malformed value cannot stretch the row. A value with no readable words at
 * all falls back to "Checked in", because the agent demonstrably did check in —
 * only the label for what it did is missing.
 *
 * Splitting and truncation both work in code points, so a value carrying an
 * emoji or other astral character can never be cut into a lone surrogate.
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
    .split(' ')
    .filter(Boolean)
    .map((word) => (isAcronym(word) ? word : word.toLowerCase()));
  if (words.length === 0) return UNREADABLE_EVENT_PHRASE;

  // `.` under /u matches a whole code point, so an astral first character is
  // upper-cased intact rather than having its high surrogate mangled.
  const first = words[0]!;
  words[0] = isAcronym(first) ? first : first.replace(/^./u, (char) => char.toUpperCase());

  const sentence = words.join(' ');
  const chars = Array.from(sentence);
  if (chars.length <= MAX_EVENT_PHRASE_LENGTH) return sentence;
  return `${chars
    .slice(0, MAX_EVENT_PHRASE_LENGTH - 1)
    .join('')
    .trimEnd()}…`;
}

/** The facts one fleet row's Activity cell is written from. */
export interface AgentActivityInput {
  healthStatus: AgentHealthStatus;
  lastSeenAt: string | null;
  lastSeenEvent: string | null;
  /**
   * Fleet-wide state of the chats running under this agent's folder, from
   * `useAgentAttentionMap` (`entities/session`). Only `'needs-attention'`
   * changes the copy — a chat blocked on an approval or sitting on an error is
   * news the agent's own last event does not carry.
   */
  chatState: AttentionState;
}

/** How one fleet row's Activity cell reads. */
export interface AgentActivityDisplay {
  /** What the agent last did, or the news that outranks it. */
  primary: string;
  /** When it happened. `null` when there is nothing to add. */
  secondary: string | null;
  /** Tailwind class for the primary line's tone. */
  toneClass: string;
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
 * Three cases override the event, because an agent's last action is not the news
 * when something about its present state is worse:
 *
 * - **Unreachable** — the folder behind the agent is gone, so nothing it did
 *   before matters until that is fixed. The event drops to the second line.
 * - **A blocked chat** — a session under the agent's folder is waiting for an
 *   approval or stopped on an error. It cannot clear itself, and it is why the
 *   row sits in "Needs you". The event drops to the second line.
 * - **Never active** — there is no event to report, and "Never" reads as a
 *   fault when the honest reading is "nobody has used it yet". Unless chats
 *   ARE running under its folder: an agent only reports to the mesh when
 *   DorkOS dispatches the turn, so a session someone started with the bare
 *   `claude` CLI leaves a live agent with no last-seen at all. Saying "Not
 *   used yet" about a row sitting in "Working" would be plainly false.
 *
 * @param input - Health, last-seen, and chat facts for one row.
 */
export function agentActivityDisplay(input: AgentActivityInput): AgentActivityDisplay {
  const { healthStatus, lastSeenAt, lastSeenEvent, chatState } = input;
  const seenAgo = lastSeenAt ? formatRelativeTime(lastSeenAt) : null;
  const didWhat = lastSeenEvent ? humanizeAgentEvent(lastSeenEvent) : null;

  if (healthStatus === 'unreachable') {
    return {
      primary: 'Cannot be reached',
      secondary: joinSecondary([didWhat, seenAgo ?? 'never seen']),
      toneClass: 'text-destructive',
    };
  }

  if (chatState === 'needs-attention') {
    return {
      primary: 'A chat needs you',
      secondary: joinSecondary([didWhat, seenAgo]),
      toneClass: 'text-destructive',
    };
  }

  if (isNeverActive(healthStatus, lastSeenAt)) {
    if (chatState === 'active') {
      return { primary: 'Active in a chat', secondary: null, toneClass: 'text-foreground' };
    }
    return {
      primary: 'Not used yet',
      secondary: null,
      toneClass: 'text-muted-foreground',
    };
  }

  return {
    primary: didWhat ?? UNREADABLE_EVENT_PHRASE,
    secondary: seenAgo,
    toneClass: healthStatus === 'active' ? 'text-foreground' : 'text-muted-foreground',
  };
}
