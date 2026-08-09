/**
 * Who gets into Today — the conversations, places and threads this person has
 * actually been in (BC-15, BC-19).
 *
 * @module features/dashboard-sidebar/model/rules/select-today-items
 */
import type { RoomSummary, ThreadSummary } from '@dorkos/shared/room-schemas';
import type { Session, SessionOrigin } from '@dorkos/shared/types';
import { partitionSessionsByOrigin } from '@/layers/entities/session';
import type { SidebarOriginMark, SidebarRowModel } from '../build-sidebar-model';
import type { SidebarState } from '../sidebar-state';
import { muteIndex, type MuteIndex } from './apply-mute-rules';
import { deriveProjectLabel } from './derive-project-label';
import { deriveRowStatus } from './derive-row-status';
import { deriveUnreadSignal } from './derive-unread-signal';
import { anchorKey, basename, rowKey } from './targets';

/**
 * Which trailing mark a non-user session origin draws (BC-26).
 *
 * **`channel` and `room` are one word apart and must not be one picture
 * apart.** `channel` is a BRIDGED chat — Telegram, Slack, a webhook — and
 * `room` is one of this machine's own rooms; `SessionOriginSchema` says so in
 * as many words, and `origin-descriptors.ts` already keeps them visually
 * distinct on the other surfaces that draw them. Folding `channel` onto the
 * room mark would tell the operator a message from Telegram came from a
 * cockpit channel.
 */
const ORIGIN_MARK: Partial<Record<SessionOrigin, SidebarOriginMark>> = {
  task: 'timer',
  external: 'bridged',
  channel: 'bridged',
  room: 'room',
  agent: 'agent',
};

/**
 * The trailing mark one session's origin draws, or `undefined` for the
 * unmarked default — a human talking to an agent.
 *
 * **Exported because it is not reachable through this module's own rows yet,
 * and that is a fact worth being honest about rather than hiding.** Every
 * origin in the table above is one `partitionSessionsByOrigin` classes as
 * automated, and BC-19 keeps automated sessions off Today's top level — so the
 * only session rows Today builds today are user-origin ones, which draw no
 * mark. The consumer that will exercise this is P2.3's "+ N automated"
 * expansion. Testing it at its own boundary now is what keeps it correct until
 * then; testing it through a path that cannot reach it would only look like
 * coverage.
 *
 * @param origin - The session's origin, absent for a session nobody marked.
 */
export function sessionOriginMark(
  origin: SessionOrigin | undefined
): SidebarOriginMark | undefined {
  return origin === undefined ? undefined : ORIGIN_MARK[origin];
}

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
 * A session with no `cwd` belongs to NO agent (DOR-203) — so it draws no agent
 * face. Hashing an empty path would produce a perfectly stable, perfectly
 * confident avatar that matches nothing, which is the mistake DOR-582 fixed in
 * a direct message's mark: the one place that guessed looked the most certain.
 *
 * @param session - The session.
 * @param state - The snapshot.
 * @param mutes - The resolved mute sets.
 * @param preview - Its one-line summary, when there is one.
 */
function sessionRow(
  session: Session,
  state: SidebarState,
  mutes: MuteIndex,
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
  const origin = sessionOriginMark(session.origin);
  const muted = agentPath !== '' && mutes.agents.has(agentPath);
  return {
    key: rowKey(target),
    target,
    glyph: agentPath
      ? { kind: 'agent-avatar', agentPath }
      : { kind: 'icon', icon: 'session' as const },
    primary: state.displayNames[agentPath] ?? (agentPath ? basename(agentPath) : 'Session'),
    secondary: session.title,
    status: deriveRowStatus({ lifecycle: streaming ? 'streaming' : lifecycle }),
    reservesVerbLine: streaming,
    ...(preview !== undefined && !streaming ? { preview } : {}),
    ...(origin ? { origin } : {}),
    unread: { tier: 'none' },
    ...(projectLabel ? { projectLabel } : {}),
    muted,
    draggable: false,
    actions: ['open', 'pin', muted ? 'unmute' : 'mute'],
    reason: 'today:interaction-recency',
  };
}

/**
 * One room as a Today row.
 *
 * @param room - The room.
 * @param state - The snapshot.
 * @param mutes - The resolved mute sets.
 * @param preview - Its one-line summary, when there is one.
 */
function roomRow(
  room: RoomSummary,
  state: SidebarState,
  mutes: MuteIndex,
  preview: string | undefined
): SidebarRowModel {
  const muted = mutes.rooms.has(room.id);
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
      muted,
    }),
    muted,
    draggable: false,
    actions: ['open', 'pin', muted ? 'unmute' : 'mute', 'mark-read'],
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
 * @param mutes - The resolved mute sets.
 */
function threadRow(thread: ThreadSummary, state: SidebarState, mutes: MuteIndex): SidebarRowModel {
  const target = { kind: 'room', roomId: thread.roomId, roomKind: 'thread' } as const;
  const muted = mutes.rooms.has(thread.roomId);
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
      muted,
    }),
    muted,
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
  const mutes = muteIndex(state.prefs);
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
    rows.push(sessionRow(session, state, mutes, previews.get(key)));
  }
  for (const room of state.rooms) {
    if (room.archived) continue;
    const key = `room:${room.id}`;
    if (!touched(key)) continue;
    rows.push(roomRow(room, state, mutes, previews.get(key)));
  }
  for (const thread of state.threads) {
    if (!touched(`room:${thread.roomId}`)) continue;
    rows.push(threadRow(thread, state, mutes));
  }
  if (automated.length > 0) rows.push(automatedRow(automated.length));
  return rows;
}
