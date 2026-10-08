/**
 * One agent's chats, arranged for choosing one (spec `your-activity-first`
 * D11, D12, D14).
 *
 * Pure and synchronous: sessions and their live signals in, sections and rows
 * out. Profile → Sessions and Switch session both draw what this returns, so
 * the two lists cannot disagree about what needs you, what is running, or
 * where a spin-off sits.
 *
 * Whose a chat is comes from `chatOwnership` (`entities/session`, D7) and from
 * nowhere else. This module only decides where each chat is drawn.
 *
 * @module features/chat-list/model/build-chat-list
 */
import type { SessionLifecycle } from '@dorkos/shared/session-stream';
import type { Session } from '@dorkos/shared/types';
import { chatOwnership, sessionDisplayTitle, type ChatOwnership } from '@/layers/entities/session';

/** The three orders a person can pick (D11). */
export type ChatListSort = 'for-you' | 'activity' | 'started';

/** Every sort, in the order the control shows them. */
export const CHAT_LIST_SORTS: readonly ChatListSort[] = ['for-you', 'activity', 'started'];

/**
 * What a chat is doing, as far as choosing one goes.
 *
 * - `needs-you`: a turn is parked on an approval or a question.
 * - `out-of-usage`: its account ran out of usage and it waits on you to
 *   continue it elsewhere or decide to wait.
 * - `failed`: the last turn stopped with an error.
 * - `running`: a turn is in flight.
 * - `idle`: none of those.
 */
export type ChatStatus = 'needs-you' | 'out-of-usage' | 'failed' | 'running' | 'idle';

/** The live facts one chat's row is built from, beside the session record. */
export interface ChatSignals {
  /**
   * Each chat's coarse phase, by session id. A missing entry falls back to the
   * session record's own `status.lifecycle`, then to idle.
   */
  lifecycles: Readonly<Record<string, SessionLifecycle | null | undefined>>;
  /** Chats with an approval or a question waiting on a person right now. */
  waitingIds: ReadonlySet<string>;
  /**
   * Chats whose account ran out of usage and that still need you: the
   * "out · needs you" and "out · handing off" states, never a chat you chose
   * to leave waiting for the reset. Absent means none.
   */
  outOfUsageIds?: ReadonlySet<string>;
}

/** Options for {@link buildChatList}. */
export interface BuildChatListOptions extends ChatSignals {
  /** The order to draw the list in. */
  sort: ChatListSort;
  /**
   * Title text to match, case-insensitive. Empty or absent matches every chat.
   * A spin-off that matches when its parent does not becomes a row of its own
   * with "Started from", exactly as if the parent were gone (D14 rule 5).
   */
  query?: string;
}

/** A spin-off folded under the chat that started it (D14 rule 1). */
export interface FoldedSpinOff {
  /** The spin-off chat. */
  session: Session;
  /** What it is doing, for the one status word the folded row shows. */
  status: ChatStatus;
  /** Its coarse phase, so a running spin-off can show its verb. */
  lifecycle: SessionLifecycle | null;
}

/** One row of the list. */
export interface ChatRow {
  /** The chat. */
  session: Session;
  /** What it is doing. */
  status: ChatStatus;
  /** Its coarse phase, handed to the verb line rather than read twice. */
  lifecycle: SessionLifecycle | null;
  /** When you last opened or wrote in it, ISO-8601, or null for never. */
  lastUsedAt: string | null;
  /**
   * The title of the chat that started it, when one did (D14 rules 3, 4 and
   * 5): its title in this list, else the title the server recorded, else
   * "another chat". Null for a chat nothing else started.
   */
  startedFrom: string | null;
  /** Spin-offs folded under it, newest first. Empty when it has none. */
  spinOffs: FoldedSpinOff[];
}

/** Which part of the list a section is. */
export type ChatListSectionId = 'needs-you' | 'running' | 'chats';

/** One labelled run of rows. */
export interface ChatListSection {
  /** Stable id, for keys and tests. */
  id: ChatListSectionId;
  /** The heading, or null when the list has only this one section. */
  label: string | null;
  /** The rows, in display order. */
  rows: ChatRow[];
}

/** Everything a chat list draws. */
export interface ChatListModel {
  /** The sections above the Automated group, in order. Empty sections are left out. */
  sections: ChatListSection[];
  /** Automated chats with no parent chat (D14 rule 2), drawn folded at the bottom. */
  automated: ChatRow[];
  /** Whether rows show which runtime a chat runs on: only when there is more than one (D12). */
  showRuntime: boolean;
  /** How many chats the list was built from, before any search. */
  total: number;
  /** How many chats matched the search. Equal to `total` without one. */
  matched: number;
}

/** What a needs-you section is called. */
const NEEDS_YOU_LABEL = 'Needs you';
/** What the For you sort calls chats with a turn in flight. */
const RUNNING_LABEL = 'Running';
/** What the rest are called, when something sits above them. */
const CHATS_LABEL = 'Other chats';
/** The stand-in for a parent this list cannot name. */
const UNKNOWN_PARENT = 'another chat';

/**
 * When you last used a chat: your server-held touch, else the last message a
 * person wrote in it. Null when neither is known.
 *
 * @param session - The chat.
 */
export function lastUsedAt(session: Session): string | null {
  return session.lastTouchedByYouAt ?? session.userLastMessageAt ?? null;
}

/**
 * Resolve one chat's coarse phase from the live store first, then from the
 * session record the list carried.
 *
 * @param session - The chat.
 * @param lifecycles - Live phases by session id.
 */
function lifecycleOf(
  session: Session,
  lifecycles: ChatSignals['lifecycles']
): SessionLifecycle | null {
  return lifecycles[session.id] ?? session.status?.lifecycle ?? null;
}

/**
 * Decide a chat's status from its phase and whether something waits on you.
 *
 * A waiting prompt wins over a phase that has not caught up yet: the prompt
 * arrives on the fleet-wide stream, and a person should see it either way.
 *
 * @param lifecycle - The chat's coarse phase.
 * @param waiting - Whether an approval or question is waiting on a person.
 * @param outOfUsage - Whether its account ran out and it still needs you.
 */
export function chatStatus(
  lifecycle: SessionLifecycle | null,
  waiting: boolean,
  outOfUsage = false
): ChatStatus {
  if (waiting || lifecycle === 'blocked') return 'needs-you';
  if (outOfUsage) return 'out-of-usage';
  if (lifecycle === 'error') return 'failed';
  if (lifecycle === 'streaming') return 'running';
  return 'idle';
}

/** Whether a status belongs in the Needs you section. */
function isUrgent(status: ChatStatus): boolean {
  return status === 'needs-you' || status === 'out-of-usage' || status === 'failed';
}

/**
 * The time a sort orders by, in epoch milliseconds, newest first.
 *
 * For you orders by when you last used a chat (D11), falling back to the last
 * time anything happened in it, so a chat you never touched still has a place.
 * Compared as numbers, not ISO text: two writers may spell one instant with
 * different precision or offsets.
 *
 * @param session - The chat.
 * @param sort - The chosen order.
 */
function sortKey(session: Session, sort: ChatListSort): number {
  if (sort === 'started') return Date.parse(session.createdAt);
  if (sort === 'activity') return Date.parse(session.updatedAt);
  return Date.parse(lastUsedAt(session) ?? session.updatedAt);
}

/** Newest first by `key`; ties broken by id so the order never depends on input order. */
function byKeyDesc<T extends { session: Session }>(key: (session: Session) => number) {
  // A time that does not parse sorts last rather than poisoning the comparator:
  // NaN beside real numbers would make the order depend on input order.
  const safeKey = (session: Session) => {
    const value = key(session);
    return Number.isNaN(value) ? Number.NEGATIVE_INFINITY : value;
  };
  return (a: T, b: T): number => {
    const keyA = safeKey(a.session);
    const keyB = safeKey(b.session);
    if (keyA !== keyB) return keyB > keyA ? 1 : -1;
    return a.session.id < b.session.id ? -1 : a.session.id > b.session.id ? 1 : 0;
  };
}

/** Where a chat is drawn before sections are cut. */
type Placement = { kind: 'row'; group: 'main' | 'automated' } | { kind: 'folded'; hostId: string };

/** What every step below reads about one chat, worked out once. */
interface ChatFacts {
  session: Session;
  owner: ChatOwnership;
  status: ChatStatus;
  lifecycle: SessionLifecycle | null;
}

/**
 * Keep the chats whose title holds `needle`, or every chat for an empty one.
 *
 * @param sessions - Every chat.
 * @param needle - Lower-cased, trimmed search text.
 */
function filterByTitle(sessions: readonly Session[], needle: string): readonly Session[] {
  if (needle === '') return sessions;
  return sessions.filter((s) => sessionDisplayTitle(s.title).toLowerCase().includes(needle));
}

/**
 * Decide where each chat is drawn: its own row (in the main list or the
 * Automated group) or folded under another row (D14 rules 1 to 5).
 *
 * A spin-off folds onto the nearest ancestor that is a row, so a chain of
 * spin-offs shares one toggle. A chain that loops back on itself makes its
 * first member the row the rest fold under.
 *
 * @param facts - The visible chats, by id.
 */
function placeChats(facts: ReadonlyMap<string, ChatFacts>): Map<string, Placement> {
  const placement = new Map<string, Placement>();
  const resolving = new Set<string>();
  const row = (group: 'main' | 'automated'): Placement => ({ kind: 'row', group });

  const place = (id: string): Placement => {
    const known = placement.get(id);
    if (known) return known;
    const fact = facts.get(id);
    if (!fact) return row('main');

    let result: Placement;
    const startedBy = fact.session.startedBy;
    if (isUrgent(fact.status)) {
      result = row('main'); // Rule 3.
    } else if (fact.owner === 'automated') {
      result = row('automated'); // Rule 2.
    } else if (fact.owner === 'spinOff' && startedBy?.kind === 'chat') {
      if (!facts.has(startedBy.sessionId) || resolving.has(id)) {
        result = row('main'); // Rule 5, and a cycle guard.
      } else {
        resolving.add(id);
        const parent = place(startedBy.sessionId);
        resolving.delete(id);
        const hostId = parent.kind === 'folded' ? parent.hostId : startedBy.sessionId;
        result = hostId === id ? row('main') : { kind: 'folded', hostId }; // Rule 1.
      }
    } else {
      result = row('main'); // Yours, including rule 4.
    }
    placement.set(id, result);
    return result;
  };

  for (const id of facts.keys()) place(id);
  return placement;
}

/**
 * Build the rows, with each folded spin-off under its host, newest first.
 *
 * @param facts - The visible chats, by id.
 * @param placement - Where each is drawn.
 * @param titleById - Every chat's display title, so a parent the search hid is
 *   still named.
 */
function buildRows(
  facts: ReadonlyMap<string, ChatFacts>,
  placement: ReadonlyMap<string, Placement>,
  titleById: ReadonlyMap<string, string>
): Map<string, ChatRow> {
  const rows = new Map<string, ChatRow>();
  for (const [id, fact] of facts) {
    if (placement.get(id)?.kind !== 'row') continue;
    const startedBy = fact.session.startedBy;
    rows.set(id, {
      session: fact.session,
      status: fact.status,
      lifecycle: fact.lifecycle,
      lastUsedAt: lastUsedAt(fact.session),
      startedFrom:
        startedBy?.kind === 'chat'
          ? (titleById.get(startedBy.sessionId) ?? startedBy.title ?? UNKNOWN_PARENT)
          : null,
      spinOffs: [],
    });
  }
  for (const [id, fact] of facts) {
    const where = placement.get(id);
    if (where?.kind !== 'folded') continue;
    rows
      .get(where.hostId)
      ?.spinOffs.push({ session: fact.session, status: fact.status, lifecycle: fact.lifecycle });
  }
  const newest = byKeyDesc<FoldedSpinOff>((s) => Date.parse(s.updatedAt));
  for (const row of rows.values()) row.spinOffs.sort(newest);
  return rows;
}

/**
 * Cut the rows into Needs you, Running (For you only) and the rest, plus the
 * Automated group, each in the sort's order.
 *
 * @param rows - Every row.
 * @param facts - What is known about each chat, for its owner.
 * @param placement - Which rows belong in the Automated group.
 * @param sort - The chosen order.
 */
function cutSections(
  rows: ReadonlyMap<string, ChatRow>,
  facts: ReadonlyMap<string, ChatFacts>,
  placement: ReadonlyMap<string, Placement>,
  sort: ChatListSort
): Pick<ChatListModel, 'sections' | 'automated'> {
  const order = byKeyDesc<ChatRow>((s) => sortKey(s, sort));
  const needsYou: ChatRow[] = [];
  const running: ChatRow[] = [];
  const rest: ChatRow[] = [];
  const automated: ChatRow[] = [];
  for (const [id, row] of rows) {
    const where = placement.get(id);
    if (where?.kind === 'row' && where.group === 'automated') automated.push(row);
    else if (isUrgent(row.status)) needsYou.push(row);
    else if (sort === 'for-you' && row.status === 'running' && facts.get(id)?.owner === 'yours')
      running.push(row);
    else rest.push(row);
  }

  const sections: ChatListSection[] = [
    { id: 'needs-you' as const, label: NEEDS_YOU_LABEL, rows: needsYou.sort(order) },
    { id: 'running' as const, label: RUNNING_LABEL, rows: running.sort(order) },
    { id: 'chats' as const, label: CHATS_LABEL, rows: rest.sort(order) },
  ].filter((section) => section.rows.length > 0);
  // A lone section needs no heading: "Other chats" over the only chats there
  // are is a label for nothing.
  const only = sections.length === 1 ? sections[0] : undefined;
  if (only && only.id === 'chats') only.label = null;
  return { sections, automated: automated.sort(order) };
}

/**
 * Arrange one agent's chats into the list both chat surfaces draw.
 *
 * The folding rules (D14), in the order they are applied:
 *
 * 1. A spin-off you never touched is not its own row. It folds under the row
 *    of the chat that started it, or under that chat's own host when the
 *    parent is itself folded, so a chain of spin-offs shares one toggle.
 * 2. An automated chat goes in the Automated group.
 * 3. A chat that needs you, ran out of usage, or stopped with an error is never
 *    folded: it is a row in Needs you, wherever it would otherwise sit, saying
 *    where it started. So a folded spin-off is only ever running or done.
 * 4. A spin-off you opened or wrote in is `yours` by `chatOwnership`, so it is
 *    an ordinary row ranked like any chat you touched, saying where it started.
 * 5. A spin-off whose parent is not in the list is an ordinary row saying
 *    where it started, by the title the server recorded or "another chat".
 * 6. A row's place comes from its own times only. Folded spin-offs never move
 *    their parent; one that needs you is lifted out instead (rule 3).
 *
 * Sections: Needs you first on every sort. For you then lists running chats
 * that are yours, then the rest by when you last used them. Recent activity
 * and Started list the rest by their own time. A running spin-off that is a row
 * of its own (rule 5) is not yours, so it sits with the rest, not in Running.
 *
 * @param sessions - The agent's chats, in any order.
 * @param options - The sort, the live signals and an optional title search.
 */
export function buildChatList(
  sessions: readonly Session[],
  options: BuildChatListOptions
): ChatListModel {
  const { sort, lifecycles, waitingIds } = options;
  const outOfUsageIds = options.outOfUsageIds ?? new Set<string>();
  const needle = options.query?.trim().toLowerCase() ?? '';
  const visible = filterByTitle(sessions, needle);

  const facts = new Map<string, ChatFacts>();
  for (const session of visible) {
    const lifecycle = lifecycleOf(session, lifecycles);
    facts.set(session.id, {
      session,
      owner: chatOwnership(session),
      lifecycle,
      status: chatStatus(lifecycle, waitingIds.has(session.id), outOfUsageIds.has(session.id)),
    });
  }
  const titleById = new Map(sessions.map((s) => [s.id, sessionDisplayTitle(s.title)]));
  const placement = placeChats(facts);
  const rows = buildRows(facts, placement, titleById);

  return {
    ...cutSections(rows, facts, placement, sort),
    // From every chat, not the search results: the marks should not come and
    // go as you type.
    showRuntime: new Set(sessions.map((s) => s.runtime)).size > 1,
    total: sessions.length,
    matched: visible.length,
  };
}
