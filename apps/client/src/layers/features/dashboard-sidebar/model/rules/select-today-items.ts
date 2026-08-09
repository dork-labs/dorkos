/**
 * Who gets into Today — the conversations, places and threads this person has
 * actually been in (BC-15, BC-19).
 *
 * @module features/dashboard-sidebar/model/rules/select-today-items
 */
import type { RoomSummary, ThreadSummary } from '@dorkos/shared/room-schemas';
import type { Session } from '@dorkos/shared/types';
import { partitionSessionsByOrigin } from '@/layers/entities/session';
import type { SessionOriginMark, SidebarRowModel } from '../build-sidebar-model';
import type { SidebarState } from '../sidebar-state';
import { deriveProjectLabel } from './derive-project-label';
import { deriveRowStatus } from './derive-row-status';
import { deriveUnreadSignal } from './derive-unread-signal';
import { anchorKey, basename, rowKey } from './targets';

/** Which trailing mark a non-user session origin draws (BC-26). */
const ORIGIN_MARK: Record<string, SessionOriginMark> = {
  task: 'timer',
  external: 'bridged',
  channel: 'room',
  room: 'room',
  agent: 'agent',
};

/**
 * The one-line summaries "Jump back in" already computed, by row key.
 *
 * Reused rather than re-derived: that model decides what a quiet channel's
 * second line says versus a busy one's, and a second derivation of the same
 * sentence is how two surfaces end up describing one room differently.
 *
 * @param state - The snapshot.
 */
function previewIndex(state: SidebarState): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of [...state.recents.items, ...state.recents.automated]) {
    if (item.summary === null) continue;
    map.set(item.kind === 'session' ? `session:${item.id}` : `room:${item.id}`, item.summary);
  }
  return map;
}

/**
 * One session as a Today row.
 *
 * A session always carries attribution — `Agent › title` — because the `›` IS
 * the session marker, and its absence means "the place, not a thread of it"
 * (BC-23). The same agent with three sessions produces three rows with the name
 * repeated, on purpose: a repeated name is a stable scan anchor, and clustering
 * would make Today's shape churn as sessions come and go.
 *
 * @param session - The session.
 * @param state - The snapshot.
 * @param preview - Its one-line summary, when there is one.
 */
function sessionRow(
  session: Session,
  state: SidebarState,
  preview: string | undefined
): SidebarRowModel {
  const agentPath = session.cwd ?? '';
  const target = {
    kind: 'session',
    sessionId: session.id,
    agentPath,
    cwd: session.cwd ?? null,
  } as const;
  const lifecycle = state.sessionStatuses[session.id];
  const streaming = state.workingSessionIds.includes(session.id);
  const projectLabel = deriveProjectLabel(session.cwd, state.projects);
  const origin = session.origin ? ORIGIN_MARK[session.origin] : undefined;
  return {
    key: rowKey(target),
    target,
    glyph: { kind: 'agent-avatar', agentPath },
    primary: state.displayNames[agentPath] ?? (agentPath ? basename(agentPath) : 'Session'),
    secondary: session.title,
    status: deriveRowStatus({ lifecycle: streaming ? 'streaming' : lifecycle }),
    reservesVerbLine: streaming,
    ...(preview !== undefined && !streaming ? { preview } : {}),
    ...(origin ? { origin } : {}),
    unread: { tier: 'none' },
    ...(projectLabel ? { projectLabel } : {}),
    muted: false,
    draggable: false,
    actions: ['open', 'pin', 'mute'],
    reason: 'today:interaction-recency',
  };
}

/**
 * One room as a Today row.
 *
 * @param room - The room.
 * @param state - The snapshot.
 * @param preview - Its one-line summary, when there is one.
 */
function roomRow(
  room: RoomSummary,
  state: SidebarState,
  preview: string | undefined
): SidebarRowModel {
  const target = {
    kind: 'room',
    roomId: room.id,
    roomKind: room.kind === 'dm' ? 'dm' : 'channel',
  } as const;
  const memberIds = (room.participants ?? []).map((p) => p.id);
  return {
    key: rowKey(target),
    target,
    glyph:
      room.kind === 'dm'
        ? memberIds.length > 1
          ? ({ kind: 'face-stack', memberIds } as const)
          : ({ kind: 'person-avatar', memberId: memberIds[0] ?? room.id } as const)
        : ({ kind: 'hash' } as const),
    primary: room.kind === 'dm' ? room.title : (room.slug ?? room.title),
    status: deriveRowStatus({ workingCount: room.working }),
    reservesVerbLine: (room.working ?? 0) > 0,
    ...(preview !== undefined && (room.working ?? 0) === 0 ? { preview } : {}),
    unread: deriveUnreadSignal({
      unreadCount: room.unreadCount,
      directed: room.kind === 'dm',
      mentionCount: state.mentions[room.id],
      muted: false,
    }),
    muted: false,
    draggable: false,
    actions: ['open', 'pin', 'mute', 'mark-read'],
    reason: 'today:interaction-recency',
  };
}

/**
 * One thread as a Today row.
 *
 * Threads are conversations here, not a section: a thread is a relation between
 * entries in one room's log (ADR 260728-022013), so it renders as a row with a
 * thread origin mark and inherits that room's read cursor.
 *
 * @param thread - The thread.
 * @param state - The snapshot.
 */
function threadRow(thread: ThreadSummary, state: SidebarState): SidebarRowModel {
  const target = { kind: 'room', roomId: thread.roomId, roomKind: 'thread' } as const;
  return {
    // Keyed on the thread's root entry rather than through `rowKey`, which
    // would answer with the ROOM's key: a room and a thread inside it are two
    // rows pointing at one place, and two rows may not share a React key.
    key: `thread:${thread.rootEntryId}`,
    target,
    glyph: { kind: 'hash' },
    primary: thread.roomSlug ?? thread.roomTitle,
    secondary: thread.rootPreview,
    status: 'idle',
    reservesVerbLine: false,
    origin: 'thread',
    unread: deriveUnreadSignal({
      unreadCount: thread.unreadCount,
      directed: false,
      mentionCount: state.mentions[thread.roomId],
      muted: false,
    }),
    muted: false,
    draggable: false,
    actions: ['open', 'mark-read'],
    reason: 'today:interaction-recency',
  };
}

/**
 * The `+ N automated` reveal row (BC-19).
 *
 * Automated sessions never claim a top-level row: a scheduled run or a room
 * turn is work the operator did not start, and Today is a list of what they
 * were doing. If one of them needs the operator it enters Now like anything
 * else, which is the only way it reaches the top of the panel.
 *
 * @param count - How many automated sessions are folded behind it.
 */
function automatedRow(count: number): SidebarRowModel {
  const target = { kind: 'rollup', rollup: 'automated' } as const;
  return {
    key: rowKey(target),
    target,
    glyph: { kind: 'icon', icon: 'automated' },
    primary: `+ ${count} automated`,
    status: 'idle',
    reservesVerbLine: false,
    unread: { tier: 'none' },
    muted: false,
    draggable: false,
    actions: ['open'],
    reason: 'rollup:automated',
  };
}

/**
 * Today's candidate rows: every conversation, place and thread the operator has
 * been in, plus the automated reveal when there is anything behind it.
 *
 * Membership is "have they interacted with it", read from the interaction and
 * message maps — never "has it been active", which is what would let an agent
 * put a row on screen the operator has never touched.
 *
 * Ordering, the overnight boundary, mute and the anchor are each a rule of
 * their own; this one only answers who is eligible.
 *
 * @param state - The snapshot.
 */
export function selectTodayItems(state: SidebarState): SidebarRowModel[] {
  const previews = previewIndex(state);
  const anchor = anchorKey(state);
  // The anchor is eligible whatever else is true: the conversation the operator
  // has open is by definition one they are interacting with, even on the first
  // paint after a deep link, before anything has been recorded about it.
  const touched = (key: string) =>
    key === anchor ||
    state.interactions[key] !== undefined ||
    state.userLastMessageAt[key] !== undefined;

  const { conversations, automated } = partitionSessionsByOrigin([...state.sessions]);
  const rows: SidebarRowModel[] = [];

  for (const session of conversations) {
    const key = `session:${session.id}`;
    if (!touched(key)) continue;
    rows.push(sessionRow(session, state, previews.get(key)));
  }
  for (const room of state.rooms) {
    if (room.archived) continue;
    const key = `room:${room.id}`;
    if (!touched(key)) continue;
    rows.push(roomRow(room, state, previews.get(key)));
  }
  for (const thread of state.threads) {
    if (!touched(`room:${thread.roomId}`)) continue;
    rows.push(threadRow(thread, state));
  }
  if (automated.length > 0) rows.push(automatedRow(automated.length));
  return rows;
}
