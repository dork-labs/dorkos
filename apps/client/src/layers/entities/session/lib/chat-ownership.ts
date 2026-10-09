import type { Session } from '@dorkos/shared/types';

/**
 * Whose a chat is (spec `your-activity-first` D7).
 *
 * - `yours` — you touched it (opened it on the chat page or wrote in it from
 *   the app), or a person wrote in it; or nothing but a person started it.
 * - `spinOff` — a spin-off chat: another chat started it (`session_start`)
 *   and you never touched it.
 * - `automated` — a room turn, a schedule, an agent, a channel, an external
 *   caller or an extension started it, and you never touched it.
 */
export type ChatOwnership = 'yours' | 'spinOff' | 'automated';

/** A session list split by {@link chatOwnership}, each bucket in input order. */
export interface ChatOwnershipPartition {
  /** Chats that are yours: touched by you, or started by nothing but a person. */
  yours: Session[];
  /** Chats another chat started that you never touched. */
  spinOffs: Session[];
  /** Room, schedule, agent, channel, external and extension chats you never touched. */
  automated: Session[];
}

/**
 * Decide whose a chat is from **what you did in it, not how it started**
 * (spec `your-activity-first` D7, ticket rules 2 and 5).
 *
 * 1. `yours` when the server says you touched it (`lastTouchedByYouAt`) or a
 *    person wrote in it (`userLastMessageAt`). A room-born chat you typed in is
 *    yours: the server restores your own write time on room, task and agent
 *    chats (D5), and never reports a relayed room turn as a person.
 * 2. Otherwise `spinOff` when another chat started it (`startedBy.kind === 'chat'`).
 * 3. Otherwise `yours` when nothing but a person started it: origin absent or
 *    `user` and no `startedBy`. Runtimes that report no origin (codex,
 *    opencode) land here, which is the honest default.
 * 4. Otherwise `automated`: a room, task, agent, channel or external origin, or
 *    an extension start.
 *
 * How a chat started stays visible elsewhere (origin marks, "Started from");
 * it no longer decides whose the chat is.
 *
 * @param session - The chat to classify.
 */
export function chatOwnership(session: Session): ChatOwnership {
  if (session.lastTouchedByYouAt || session.userLastMessageAt) return 'yours';
  if (session.startedBy?.kind === 'chat') return 'spinOff';
  if ((!session.origin || session.origin === 'user') && !session.startedBy) return 'yours';
  return 'automated';
}

/**
 * Split a session list by {@link chatOwnership}, preserving relative order
 * within each bucket.
 *
 * Pure and synchronous. Callers cap each bucket to their own row limit AFTER
 * partitioning, never before: partitioning must see the full list, so a chat
 * of yours is not pushed out of a cap by agent chats ahead of it in raw
 * recency order (the bug spec `your-activity-first` D10 removes). The session
 * switcher caps nothing: it is the surface opened to see everything.
 *
 * **A room turn you never touched is automated, and that is the point of it.**
 * A room turn runs under a thread the reader can already see (ADR
 * 260808-140954): the room row IS that conversation, so listing the run beside
 * it lists one thing twice. The origin is assigned server-side from the
 * `room_sessions` binding (`services/session/origin/room-origin-overlay.ts`).
 *
 * @param sessions - Sessions to partition, in their existing order.
 */
export function partitionSessionsByOwnership(sessions: readonly Session[]): ChatOwnershipPartition {
  const yours: Session[] = [];
  const spinOffs: Session[] = [];
  const automated: Session[] = [];
  for (const session of sessions) {
    const owner = chatOwnership(session);
    if (owner === 'yours') yours.push(session);
    else if (owner === 'spinOff') spinOffs.push(session);
    else automated.push(session);
  }
  return { yours, spinOffs, automated };
}

/**
 * The subset of `ids` that count as live — **the one definition of liveness the
 * whole app shares** (`design-decisions.md` §18, spec `your-activity-first` D8).
 *
 * §18's Signal → Rendering table reads "Automated session activity → Nothing.
 * No bold, no badge". So a scheduled run or a room's own turn is not in any
 * count of what is running: not the sidebar's "N working", not an agent row's
 * "N live" chip, not ⌘K's Continue. Three surfaces reading one function is what
 * stops them from disagreeing (DOR-1137).
 *
 * **Only `automated` is excluded.** A spin-off chat is work a person asked for
 * through a chat, so it still counts as running (D8).
 *
 * **The carve-out is Heads up, and it is elsewhere.** An automated chat that is
 * blocked — waiting on an approval, asking a question, wedged — still reaches
 * the operator, as an attention item through `entities/attention`, which reads
 * no ownership at all. Only the liveness COUNT excludes automation.
 *
 * **An id with no session record is kept.** Ownership lives on the session
 * record and every caller's record list is a trimmed window, so an unknown id
 * is one whose ownership is unknown rather than one known to be automated — and
 * hiding a person's turn is the worse error of the two.
 *
 * @param ids - Candidate session ids, in the caller's own order.
 * @param sessions - Every session record the caller can see. Duplicates are
 *   harmless; only the ids of the automated ones are read.
 */
export function nonAutomatedSessionIds(
  ids: readonly string[],
  sessions: readonly Session[]
): readonly string[] {
  const automated = new Set(partitionSessionsByOwnership(sessions).automated.map((s) => s.id));
  if (automated.size === 0) return ids;
  return ids.filter((id) => !automated.has(id));
}
