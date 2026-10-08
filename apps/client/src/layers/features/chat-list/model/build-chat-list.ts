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

/** Where a row says it came from, when another chat started it. */
export interface StartedFrom {
  /** The chat that started it, or null when this list cannot name one. */
  sessionId: string | null;
  /** What to call it: its title, or a stand-in when it has none here. */
  title: string;
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
  /** The chat that started it, when one did (D14 rules 3, 4 and 5). */
  startedFrom: StartedFrom | null;
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
 * The time a sort orders by, newest first.
 *
 * For you orders by when you last used a chat (D11), falling back to the last
 * time anything happened in it, so a chat you never touched still has a place.
 *
 * @param session - The chat.
 * @param sort - The chosen order.
 */
function sortKey(session: Session, sort: ChatListSort): string {
  if (sort === 'started') return session.createdAt;
  if (sort === 'activity') return session.updatedAt;
  return lastUsedAt(session) ?? session.updatedAt;
}

/** Newest first by `key`; ties broken by id so the order never flickers. */
function byKeyDesc<T extends { session: Session }>(key: (session: Session) => string) {
  return (a: T, b: T): number => {
    const ka = key(a.session);
    const kb = key(b.session);
    if (ka !== kb) return ka < kb ? 1 : -1;
    return a.session.id < b.session.id ? -1 : 1;
  };
}

/** Where a chat is drawn before sections are cut. */
type Placement = { kind: 'row'; group: 'main' | 'automated' } | { kind: 'folded'; hostId: string };

/**
 * Arrange one agent's chats into the list both chat surfaces draw.
 *
 * The folding rules (D14), in the order they are applied:
 *
 * 1. A spin-off you never touched is not its own row. It folds under the row
 *    of the chat that started it, or under that chat's own host when the
 *    parent is itself folded, so a chain of spin-offs shares one toggle.
 * 2. An automated chat goes in the Automated group.
 * 3. A chat that needs you, ran out of usage, or stopped with an error is never folded: it is a
 *    row in Needs you, wherever it would otherwise sit, saying where it
 *    started.
 * 4. A spin-off you opened or wrote in is `yours` by `chatOwnership`, so it is
 *    an ordinary row ranked like any chat you touched, saying where it started.
 * 5. A spin-off whose parent is not in the list is an ordinary row saying
 *    where it started, by the title the server recorded or "another chat".
 * 6. A row's place comes from its own times only. Folded spin-offs never move
 *    their parent; one that needs you is lifted out instead (rule 3).
 *
 * Sections: Needs you first on every sort. For you then lists running chats
 * that are yours, then the rest by when you last used them. Recent activity
 * and Started list the rest by their own time.
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
  // Titles for "Started from" come from every chat, so a parent the search hid
  // is still named rather than called "another chat".
  const titleById = new Map(sessions.map((s) => [s.id, sessionDisplayTitle(s.title)]));
  const visible =
    needle === ''
      ? sessions
      : sessions.filter((s) => sessionDisplayTitle(s.title).toLowerCase().includes(needle));

  const byId = new Map(visible.map((s) => [s.id, s]));
  const owner = new Map<string, ChatOwnership>(visible.map((s) => [s.id, chatOwnership(s)]));
  const lifecycle = new Map(visible.map((s) => [s.id, lifecycleOf(s, lifecycles)]));
  const status = new Map(
    visible.map((s) => [
      s.id,
      chatStatus(lifecycle.get(s.id) ?? null, waitingIds.has(s.id), outOfUsageIds.has(s.id)),
    ])
  );

  // ── Placement ──
  const placement = new Map<string, Placement>();
  const resolving = new Set<string>();

  /** Where `id` is drawn, folding chains of spin-offs onto one visible host. */
  const place = (id: string): Placement => {
    const known = placement.get(id);
    if (known) return known;
    const session = byId.get(id);
    // Callers only pass ids in the list; this keeps the type honest.
    if (!session) return { kind: 'row', group: 'main' };

    let result: Placement;
    const own = owner.get(id);
    if (isUrgent(status.get(id) ?? 'idle')) {
      result = { kind: 'row', group: 'main' }; // Rule 3.
    } else if (own === 'automated') {
      result = { kind: 'row', group: 'automated' }; // Rule 2.
    } else if (own === 'spinOff' && session.startedBy?.kind === 'chat') {
      const parentId = session.startedBy.sessionId;
      if (!byId.has(parentId) || resolving.has(id)) {
        result = { kind: 'row', group: 'main' }; // Rule 5, and a cycle guard.
      } else {
        resolving.add(id);
        const parent = place(parentId);
        resolving.delete(id);
        const hostId = parent.kind === 'folded' ? parent.hostId : parentId;
        // A chain that leads back to this chat has no host above it: it is the
        // row the rest of the chain folds under.
        result = hostId === id ? { kind: 'row', group: 'main' } : { kind: 'folded', hostId };
      }
    } else {
      result = { kind: 'row', group: 'main' }; // Yours, including rule 4.
    }
    placement.set(id, result);
    return result;
  };
  for (const session of visible) place(session.id);

  // ── Rows ──
  const rowFor = (session: Session): ChatRow => ({
    session,
    status: status.get(session.id) ?? 'idle',
    lifecycle: lifecycle.get(session.id) ?? null,
    lastUsedAt: lastUsedAt(session),
    startedFrom:
      session.startedBy?.kind === 'chat'
        ? {
            sessionId: titleById.has(session.startedBy.sessionId)
              ? session.startedBy.sessionId
              : null,
            title:
              titleById.get(session.startedBy.sessionId) ??
              session.startedBy.title ??
              UNKNOWN_PARENT,
          }
        : null,
    spinOffs: [],
  });

  const rows = new Map<string, ChatRow>();
  for (const session of visible) {
    if (placement.get(session.id)?.kind === 'row') rows.set(session.id, rowFor(session));
  }
  for (const session of visible) {
    const where = placement.get(session.id);
    if (where?.kind !== 'folded') continue;
    rows.get(where.hostId)?.spinOffs.push({
      session,
      status: status.get(session.id) ?? 'idle',
      lifecycle: lifecycle.get(session.id) ?? null,
    });
  }
  for (const row of rows.values()) {
    row.spinOffs.sort(byKeyDesc((s) => s.updatedAt));
  }

  // ── Sections ──
  const order = byKeyDesc<ChatRow>((s) => sortKey(s, sort));
  const needsYou: ChatRow[] = [];
  const running: ChatRow[] = [];
  const rest: ChatRow[] = [];
  const automated: ChatRow[] = [];
  for (const row of rows.values()) {
    const where = placement.get(row.session.id);
    if (where?.kind === 'row' && where.group === 'automated') automated.push(row);
    else if (isUrgent(row.status)) needsYou.push(row);
    else if (
      sort === 'for-you' &&
      row.status === 'running' &&
      owner.get(row.session.id) === 'yours'
    ) {
      running.push(row);
    } else rest.push(row);
  }

  const cut: ChatListSection[] = [
    { id: 'needs-you' as const, label: NEEDS_YOU_LABEL, rows: needsYou.sort(order) },
    { id: 'running' as const, label: RUNNING_LABEL, rows: running.sort(order) },
    { id: 'chats' as const, label: CHATS_LABEL, rows: rest.sort(order) },
  ].filter((section) => section.rows.length > 0);
  // A lone section needs no heading: "Other chats" over the only chats there
  // are is a label for nothing.
  const only = cut.length === 1 ? cut[0] : undefined;
  if (only && only.id === 'chats') only.label = null;

  return {
    sections: cut,
    automated: automated.sort(order),
    showRuntime: new Set(sessions.map((s) => s.runtime)).size > 1,
    total: sessions.length,
    matched: visible.length,
  };
}
