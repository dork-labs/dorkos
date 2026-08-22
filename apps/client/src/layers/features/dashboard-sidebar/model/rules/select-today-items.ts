/**
 * Who gets into Today — the conversations, places and threads this person has
 * actually been in (BC-15, BC-19).
 *
 * @module features/dashboard-sidebar/model/rules/select-today-items
 */
import type { RoomSummary, ThreadSummary } from '@dorkos/shared/room-schemas';
import type { Session } from '@dorkos/shared/types';
import { partitionSessionsByOrigin } from '@/layers/entities/session';
import { basename } from '@/layers/shared/lib/basename';
import type { SidebarRowModel } from '../build-sidebar-model';
import type { SidebarState } from '../sidebar-state';
import { muteIndex, type MuteIndex } from './apply-mute-rules';
import { deriveUnreadSignal } from './derive-unread-signal';
import { indexSuppressedDms } from './hand-made-dm';
import { anchorKey, rowKey } from './targets';

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
  const muted = agentPath !== '' && mutes.agents.has(agentPath);
  return {
    key: rowKey(target),
    target,
    glyph: agentPath
      ? { kind: 'agent-avatar', agentPath }
      : { kind: 'icon', icon: 'session' as const },
    primary: state.displayNames[agentPath] ?? (agentPath ? basename(agentPath) : 'Session'),
    secondary: session.title,
    reservesVerbLine: streaming,
    // The phase, for the leaf that says the words (BC-37). `workingSessionIds`
    // wins over the status map because it is the list the model's own working
    // rules are computed from, so a row cannot reserve a verb line and then be
    // handed a lifecycle that says nothing is happening.
    ...(streaming ? { lifecycle: 'streaming' as const } : lifecycle ? { lifecycle } : {}),
    ...(preview !== undefined && !streaming ? { preview } : {}),
    unread: { tier: 'none' },
    muted,
    draggable: false,
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
  return {
    key: rowKey(target),
    target,
    // Every room says `hash`; `RoomRow` draws the leading slot from the roster
    // (faces for a direct message, `#` for a channel) and never reads this.
    glyph: { kind: 'hash' },
    primary: room.kind === 'dm' ? room.title : (room.slug ?? room.title),
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
  const target = {
    kind: 'room',
    roomId: thread.roomId,
    roomKind: 'thread',
    rootEntryId: thread.rootEntryId,
  } as const;
  const muted = mutes.rooms.has(thread.roomId);
  return {
    key: rowKey(target),
    target,
    glyph: { kind: 'hash' },
    primary: thread.roomSlug ?? thread.roomTitle,
    secondary: thread.rootPreview,
    reservesVerbLine: false,
    unread: deriveUnreadSignal({
      unreadCount: thread.unreadCount,
      directed: false,
      mentionCount: state.mentions[thread.roomId],
      muted,
    }),
    muted,
    draggable: false,
    reason: 'today:interaction-recency',
  };
}

/**
 * The `+ N automated` reveal row (BC-19).
 *
 * Automated sessions never claim a top-level row: a scheduled run or a room
 * turn is work the operator did not start, and Today is a list of what they
 * were doing. If one of them needs the operator it enters Heads up like anything
 * else, which is the only way it reaches the top of the panel.
 *
 * **It is a reveal, not a count.** Pressing it unfolds the runs themselves
 * ({@link revealAutomated}), so the row says how to put them away again once
 * they are open — a "+ 3 automated" that stayed "+ 3 automated" after opening
 * would be a control with no visible off switch.
 *
 * @param count - How many automated sessions are folded behind it.
 * @param expanded - Whether they are currently unfolded.
 */
function automatedRow(count: number, expanded: boolean): SidebarRowModel {
  const target = { kind: 'rollup', rollup: 'automated' } as const;
  return {
    key: rowKey(target),
    target,
    glyph: { kind: 'icon', icon: 'automated' },
    primary: expanded ? 'Hide automated' : `+ ${count} automated`,
    reservesVerbLine: false,
    unread: { tier: 'none' },
    muted: false,
    draggable: false,
    reason: 'rollup:automated',
  };
}

/**
 * The row for the conversation the operator has open, when nothing else in
 * Today is going to draw it (BC-21).
 *
 * Three cases, in the order they are cheapest to answer:
 *
 * 1. **The session is on the wire but was filtered out.** An automated-origin
 *    session the operator opened by hand is still the conversation they are
 *    looking at, and BC-19's "automated runs never claim a top-level row" is
 *    about runs they did not start. Opening one is starting it.
 * 2. **The room is on the wire but archived.** Archiving hides a room from the
 *    lists; it does not stop somebody reading it.
 * 3. **Nothing on the wire answers to it at all** — a deep link, a reload, or
 *    the first paint before the queries land. The router still knows the
 *    session's id and its directory, or the thread's room and root entry, so
 *    the row says which conversation it is and stops there. **No title is
 *    invented**: the row grows one the moment the list arrives, under the same
 *    key, so nothing moves.
 *
 * @param state - The snapshot.
 * @param mutes - The resolved mute sets.
 * @param previews - The one-line summaries, by row key.
 */
function anchorRow(
  state: SidebarState,
  mutes: MuteIndex,
  previews: Map<string, string>
): SidebarRowModel | null {
  const active = state.activeTarget;
  if (active === null) return null;

  if (active.kind === 'room') {
    // A thread is its own row, keyed on its root entry — never the room's row
    // wearing the thread's key, which would put one place on screen twice under
    // two names.
    if (active.roomKind === 'thread') {
      const thread = state.threads.find((entry) => entry.rootEntryId === active.rootEntryId);
      if (thread !== undefined) return threadRow(thread, state, mutes);
      const room = state.rooms.find((entry) => entry.id === active.roomId);
      const muted = mutes.rooms.has(active.roomId);
      return {
        key: rowKey(active),
        target: active,
        glyph: { kind: 'hash' },
        primary: room === undefined ? 'Thread' : (room.slug ?? room.title),
        reservesVerbLine: false,
        unread: { tier: 'none' },
        muted,
        draggable: false,
        reason: 'today:open-conversation',
      };
    }
    const room = state.rooms.find((entry) => entry.id === active.roomId);
    return room === undefined ? null : roomRow(room, state, mutes, previews.get(rowKey(active)));
  }
  if (active.kind !== 'session') return null;

  const session = state.sessions.find((entry) => entry.id === active.sessionId);
  if (session !== undefined) {
    return sessionRow(session, state, mutes, previews.get(rowKey(active)));
  }

  const agentPath = active.cwd ?? '';
  const lifecycle = state.sessionStatuses[active.sessionId];
  const streaming = state.workingSessionIds.includes(active.sessionId);
  return {
    key: rowKey(active),
    target: active,
    glyph: agentPath
      ? { kind: 'agent-avatar', agentPath }
      : { kind: 'icon', icon: 'session' as const },
    primary: state.displayNames[agentPath] ?? (agentPath ? basename(agentPath) : 'Session'),
    reservesVerbLine: streaming,
    ...(streaming ? { lifecycle: 'streaming' as const } : lifecycle ? { lifecycle } : {}),
    unread: { tier: 'none' },
    muted: agentPath !== '' && mutes.agents.has(agentPath),
    draggable: false,
    reason: 'today:open-conversation',
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
 * **One clause is not about interaction, and it is the price of one door**
 * (`sidebar-simplification` D2). A hand-made 1:1 direct message no longer has a
 * Library row, so a line an agent opened by itself — `relay_notify_user`, the
 * one shape of this room the operator never starts — would have no row anywhere
 * and no way in but ⌘K. So a SUPPRESSED one with a directed unread is eligible
 * here whether or not it has ever been opened (`today:dm-suppressed-unread`).
 * It is not an agent putting itself on screen: it is an agent that addressed
 * this person by name, which is the one thing Today has always shown regardless
 * (BC-16's directed unread is exempt from the cap and from the overnight
 * boundary already). Once read it drops out on its own, because the clause is
 * the unread and nothing else.
 *
 * Ordering, the overnight boundary, mute and the anchor are each a rule of
 * their own; this one only answers who is eligible.
 *
 * @param state - The snapshot.
 */
export function selectTodayItems(state: SidebarState): SidebarRowModel[] {
  const previews = previewIndex(state);
  const mutes = muteIndex(state.prefs);
  // Built here as well as in `buildLibrarySections`, and that is the cheaper of
  // the two shapes: it is one pass over the rooms plus one hash per agent, and
  // threading it down from `buildSidebarModel` would put a parameter on both
  // rules for a cost the rebuild budget does not notice (G8).
  const suppressedDms = indexSuppressedDms(state, mutes);
  const anchor = anchorKey(state);
  // The room an open THREAD lives in, which is a different key from the thread's
  // own. A thread is keyed on its root entry (`rowKey`), so a deep link into one
  // would otherwise leave its channel out of Today entirely — the operator would
  // be reading `#design › …` with no `#design` anywhere on the panel.
  const active = state.activeTarget;
  const anchorRoom = active !== null && active.kind === 'room' ? `room:${active.roomId}` : null;
  // The anchor is eligible whatever else is true: the conversation the operator
  // has open is by definition one they are interacting with, even on the first
  // paint after a deep link, before anything has been recorded about it.
  const touched = (key: string) =>
    key === anchor ||
    key === anchorRoom ||
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
    const row = roomRow(room, state, mutes, previews.get(key));
    if (touched(key)) {
      rows.push(row);
      continue;
    }
    // The reachability clause, above. `roomRow` already derived the unread —
    // mute's silence and the `@mention` that pierces it included — so this asks
    // the row rather than deriving a second opinion of the same fact.
    if (suppressedDms.isSuppressed(room) && row.unread.tier === 'directed') {
      rows.push({ ...row, reason: 'today:dm-suppressed-unread' });
    }
  }
  for (const thread of state.threads) {
    if (!touched(`room:${thread.roomId}`)) continue;
    rows.push(threadRow(thread, state, mutes));
  }
  // **BC-21 says "always", and the three loops above cannot keep that on their
  // own.** Each one walks a list, so a conversation the operator has OPEN but
  // that is missing from every list gets no row at all — and there are three
  // ordinary ways to be missing. A deep link or a reload lands on a session
  // older than the recent window the cockpit fetched. An automated-origin
  // session opened by hand is filtered out by BC-19 before `touched` is ever
  // asked. And on the very first paint every list is still empty because the
  // queries have not answered. In all three the operator is looking at a
  // conversation the sidebar says they do not have.
  if (anchor !== null && !rows.some((row) => row.key === anchor)) {
    const missing = anchorRow(state, mutes, previews);
    if (missing !== null) rows.push(missing);
  }
  // The reveal stands FOR the list; it is not a list of its own. Appended
  // unconditionally it could be Today's only row — a heading and one inert
  // "+ 3 automated" on a fresh install where nothing has been opened yet — and
  // BC-1's "no empty zone" cannot see that, because the zone is not empty.
  // Automated runs are not what the operator was doing (BC-19), so with nothing
  // else in Today there is nothing to reveal them beside.
  if (automated.length > 0 && rows.length > 0) {
    rows.push(automatedRow(automated.length, state.todayAutomatedExpanded === true));
  }
  return rows;
}

/**
 * Today's rows with the automated runs unfolded underneath their reveal row
 * (BC-19).
 *
 * Runs last, on the composed list, and appends rather than merges — which is
 * the whole reason it is a rule of its own rather than another branch of
 * {@link selectTodayItems}. An automated run put into the candidate list would
 * be sorted by the operator's interaction recency (it has none), archived by
 * the overnight boundary (it has no staleness to measure), and above all would
 * spend places from the soft cap that belong to the conversations the operator
 * was actually in.
 *
 * Muted runs stay folded away: mute kills Today eligibility (BC-40), and a
 * reveal is not a way around that.
 *
 * @param rows - Today's composed rows, reveal row included.
 * @param state - The snapshot.
 */
export function revealAutomated(
  rows: readonly SidebarRowModel[],
  state: SidebarState
): SidebarRowModel[] {
  if (state.todayAutomatedExpanded !== true) return [...rows];
  // No reveal row means there is nothing to reveal FROM: the list is empty, or
  // Today had no top-level row to hang it under. Unfolding into that would put
  // automated runs at Today's top level, which is the one thing BC-19 forbids.
  if (!rows.some((row) => row.reason === 'rollup:automated')) return [...rows];

  const mutes = muteIndex(state.prefs);
  const previews = previewIndex(state);
  // **Whatever is already on the list stays off it.** Exactly one row can be in
  // both places and it is the ordinary flow: press the reveal, click a run, and
  // that run is now the conversation the operator has open — so the anchor
  // branch of {@link selectTodayItems} has already drawn it at the top. Without
  // this filter it is drawn twice, and both copies key `session:<id>`, which is
  // a duplicate React key inside one section rather than a cosmetic repeat.
  const drawn = new Set(rows.map((row) => row.key));
  const { automated } = partitionSessionsByOrigin([...state.sessions]);
  const revealed = automated
    .map((session) => sessionRow(session, state, mutes, previews.get(`session:${session.id}`)))
    .filter((row) => !row.muted && !drawn.has(row.key))
    .map((row) => ({ ...row, reason: 'today:automated' }));
  return [...rows, ...revealed];
}
