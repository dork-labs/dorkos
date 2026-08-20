/**
 * The two row shapes Library holds — an agent and a room — built once so a
 * pinned copy and a home-section copy can never disagree about one thing.
 *
 * Not a rule: the rule is {@link buildLibrarySections}, which decides who is in
 * which section. This is how a member is drawn once it is.
 *
 * @module features/dashboard-sidebar/model/rules/library-rows
 */
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import type { SidebarRowModel } from '../build-sidebar-model';
import type { AgentRosterEntry, SidebarState } from '../sidebar-state';
import type { MuteIndex } from './apply-mute-rules';
import { deriveUnreadSignal } from './derive-unread-signal';
import { liveSessionIdsForPath } from './live-sessions';
import { basename, rowKey } from './targets';

/**
 * How many concurrent sessions an agent needs before its row says so.
 *
 * Two, because "1 live" is a chip that tells the operator what the dot beside
 * it already said.
 *
 * **The one place this number lives.** The row component used to keep a
 * threshold of its own beside a count of its own, so the model and the chip
 * could have disagreed about when to draw it; now the model decides, and the
 * row draws whatever `liveCount` it is handed.
 */
export const LIVE_CHIP_MIN = 2;

/**
 * One agent's Library row.
 *
 * Clicking it opens that agent's most recent human conversation — an agent is
 * a teammate, not a folder (design-decisions §4) — which is why the row carries
 * no expansion affordance and the depth lives in the session switcher.
 *
 * **Its liveness is Heads up's liveness** ({@link liveSessionIdsForPath}): the same
 * human-origin rule, off the same stream, so the dot, the "N live" chip and —
 * through `rollUpCollapsedSection`, which sums these rows — the folded section's
 * "N agents working" all agree with the "N working" line in Heads up. They did not before
 * (DOR-1137): this row demanded the session ALSO be in the last-ten REST
 * window, which a turn started seconds ago is not.
 *
 * @param agent - The roster entry.
 * @param state - The snapshot.
 * @param mutes - The resolved mute sets.
 * @param reason - Which section this copy of the row belongs to.
 */
export function agentRow(
  agent: AgentRosterEntry,
  state: SidebarState,
  mutes: MuteIndex,
  reason: string
): SidebarRowModel {
  const target = { kind: 'agent', path: agent.path } as const;
  const live = liveSessionIdsForPath(state, agent.path).length;
  const muted = mutes.agents.has(agent.path);
  return {
    key: rowKey(target),
    target,
    glyph: { kind: 'agent-avatar', agentPath: agent.path },
    primary: state.displayNames[agent.path] ?? basename(agent.path),
    reservesVerbLine: live > 0,
    unread: { tier: 'none' },
    ...(live >= LIVE_CHIP_MIN ? { liveCount: live } : {}),
    muted,
    draggable: true,
    reason,
  };
}

/**
 * One room's Library row.
 *
 * @param room - The room.
 * @param state - The snapshot.
 * @param mutes - The resolved mute sets.
 * @param reason - Which section this copy of the row belongs to.
 */
export function roomLibraryRow(
  room: RoomSummary,
  state: SidebarState,
  mutes: MuteIndex,
  reason: string
): SidebarRowModel {
  const target = {
    kind: 'room',
    roomId: room.id,
    roomKind: room.kind === 'dm' ? 'dm' : 'channel',
  } as const;
  const muted = mutes.rooms.has(room.id);
  return {
    key: rowKey(target),
    target,
    // Every room says `hash`; `RoomRow` draws the leading slot from the roster
    // (faces for a direct message, `#` for a channel) and never reads this.
    glyph: { kind: 'hash' },
    primary: room.kind === 'dm' ? room.title : (room.slug ?? room.title),
    reservesVerbLine: (room.working ?? 0) > 0,
    unread: deriveUnreadSignal({
      unreadCount: room.unreadCount,
      directed: room.kind === 'dm',
      mentionCount: state.mentions[room.id],
      muted,
    }),
    muted,
    draggable: true,
    reason,
  };
}
