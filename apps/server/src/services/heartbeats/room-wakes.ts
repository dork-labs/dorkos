/**
 * The room hook for event wakes (spec `heartbeats` §3.3): a room message from a
 * local author named an agent, or wrote to it in a DM, and its room turn did
 * not run. Its beat looks instead.
 *
 * Which reasons wake: a name (`mention`), a DM (`dm`), and the two DOR-2823
 * reasons that mean a person is owed an answer — the channel's `lead` taking a
 * post nobody else is answering, and the agent a person is in a `conversation`
 * with. A refused turn there is a person left waiting, the same as a name. The
 * ambient reasons (`window`, `always`, `seat`) never wake: nobody addressed the
 * agent, so nobody is waiting on it.
 *
 * Never a wake:
 *
 * - a stranger's message (PRINCIPLES §1);
 * - an agent's message with no `sessionId`. The room stamps an entry with a
 *   session only when the agent posted it inside its own turn in that room, so
 *   this is every agent post made from anywhere else: a beat turn's direct
 *   post, the outbox's `room` rung, a note. So two agents' beats can never wake
 *   each other in a loop, on any refusal path, whatever order the post and its
 *   refusal run in;
 * - a post the outbox made, by id: the backstop for a beat post that lands
 *   while the same agent holds a room turn there, and so borrows its session;
 * - a post written under a turn mark (DOR-3036): a stranger's words or a teammate's chain;
 * - a depth refusal for a post that is its own cascade root: an agent posting
 *   outside a turn is stamped at the depth ceiling, so that refusal is not a
 *   back-and-forth anybody is waiting on.
 *
 * @module services/heartbeats/room-wakes
 */
import type { AuthorRegistry } from '../rooms/author-registry.js';
import type { TriggerReason } from '../rooms/addressing.js';
import { isEntryAuthorExternal } from '../rooms/limits/turn-ceiling.js';
import { isBeatRoomPost, wakeAgentAt } from './event-wakes.js';
import { entryHeldToDefault, entryMarksOf } from '../core/turn-power/turn-levels.js';
import { hasMarks } from '../core/turn-power/turn-marks.js';

/** Room trigger reasons a refused turn wakes a beat for: somebody is waiting. */
const WAKING_REASONS: ReadonlySet<TriggerReason> = new Set<TriggerReason>([
  'mention',
  'dm',
  'lead',
  'conversation',
]);

/** The entry fields the hook reads. */
export interface RefusedEntry {
  /** Its id. */
  id: string;
  /** Who wrote it. */
  authorId: string;
  /** Its cascade root: its own id when it started a cascade. */
  cascadeRoot: string;
  /** The chat that produced it, when one did. */
  sessionId?: string | null;
  /** Its room, to read the marks it was written under. */
  roomId?: string;
}

/**
 * Whether a refused room turn should wake the agent's beat.
 *
 * @param target - The agent's author record, when the room knows it.
 * @param target.kind - `agent` for an agent.
 * @param reason - Why the room addressed it (`mention`, `dm`, `lead`, …).
 * @param entry - The message.
 * @param refusal - Why its turn was refused (`depth`, `repeat`, a budget scope).
 * @param authors - The author registry, to tell a local author from a stranger.
 */
export function shouldWakeForRefusal(
  target: { kind: string } | undefined,
  reason: string,
  entry: RefusedEntry,
  refusal: string,
  authors: AuthorRegistry
): boolean {
  if (target?.kind !== 'agent' || !WAKING_REASONS.has(reason as TriggerReason)) return false;
  if (refusal === 'depth' && entry.cascadeRoot === entry.id) return false;
  if (isBeatRoomPost(entry.id)) return false;
  // A post held to the default (a person's from Wi-Fi, DOR-3037) wakes no beat:
  // a beat runs at the agent's own level, so it would answer the post uncapped.
  if (entryHeldToDefault(entry.id, entry.roomId)) return false;
  const author = authors.getMany([entry.authorId]).get(entry.authorId);
  // An agent's post with no chat behind it is nobody's turn to answer for.
  if (author?.kind === 'agent' && !entry.sessionId) return false;
  // A post a teammate's chain wrote never wakes a beat (DOR-3036). One that carried an outsider's
  // words on does (DOR-3390, Security): the beat gathers the post with its marks, so it runs as
  // a marked turn whose risky actions still ask.
  const marks = entryMarksOf(entry.id, entry.roomId);
  if (marks && hasMarks(marks) && marks.teammate !== undefined) return false;
  return !isEntryAuthorExternal(authors, entry.authorId);
}

/**
 * Wake an agent whose room turn was refused, when {@link shouldWakeForRefusal}
 * says so.
 *
 * @param target - The agent's author record, when the room knows it.
 * @param target.kind - `agent` for an agent.
 * @param target.naturalKey - The agent's home directory.
 * @param reason - Why the room addressed it.
 * @param entry - The message.
 * @param refusal - Why its turn was refused.
 * @param authors - The author registry.
 */
export function wakeForRefusedRoomTurn(
  target: { kind: string; naturalKey: string } | undefined,
  reason: string,
  entry: RefusedEntry,
  refusal: string,
  authors: AuthorRegistry
): void {
  if (!target || !shouldWakeForRefusal(target, reason, entry, refusal, authors)) return;
  wakeAgentAt(target.naturalKey, { type: 'room-mention', eventId: entry.id });
}

/**
 * Wake an agent whose room turn the room's spending budget refused, when a
 * local author addressed it.
 *
 * @param agentPath - The agent's home directory.
 * @param reason - Why the room addressed it.
 * @param entry - The message.
 * @param authors - The author registry.
 */
export function wakeForBudgetRefusal(
  agentPath: string,
  reason: string,
  entry: RefusedEntry,
  authors: AuthorRegistry
): void {
  wakeForRefusedRoomTurn(
    { kind: 'agent', naturalKey: agentPath },
    reason,
    entry,
    'budget',
    authors
  );
}
