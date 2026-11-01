/**
 * The two row shapes the sections hold — an agent and a room — built once so a
 * Direct messages copy and a hand-made section's copy can never disagree about
 * one thing.
 *
 * Not a rule: the rule is `buildSections`, which decides who is in which
 * section. This is how a member is drawn once it is.
 *
 * @module features/dashboard-sidebar/model/rules/section-rows
 */
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import { basename } from '@/layers/shared/lib/basename';
import { deriveUnreadSignal } from '@/layers/shared/lib/unread-signal';
import type { SidebarRowModel, SidebarUnread } from '../build-sidebar-model';
import type { AgentRosterEntry, SidebarState } from '../sidebar-state';
import type { MuteIndex } from './apply-mute-rules';
import { liveSessionIdsForPath } from './live-sessions';
import { rowKey } from './targets';

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
 * Everything a row needs beyond its own subject and the snapshot.
 *
 * One object rather than two parameters, so a row builder's signature does not
 * grow every time the sidebar learns something new about a row. Both builders take
 * it; only the agent row reads the second field.
 */
export interface RowContext {
  /** The resolved mute sets. */
  mutes: MuteIndex;
  /**
   * What each agent's direct message has waiting, by agent path
   * (`indexAgentDms`). An agent absent from it has nothing waiting.
   */
  dmUnread: ReadonlyMap<string, SidebarUnread>;
}

/**
 * One agent's row — in Direct messages, or in a section the operator filed it
 * into.
 *
 * Clicking it opens that agent's Direct chat — an agent is a teammate, not a
 * folder — which is why the row carries no expansion affordance and the depth
 * lives in the session switcher.
 *
 * **Its liveness is the human-origin rule** ({@link liveSessionIdsForPath}), off
 * the live stream, so the dot, the "N live" chip and — through
 * `rollUpCollapsedSection`, which sums these rows — the folded section's
 * "agents working" dot all agree. They did not before (DOR-1137): this row
 * demanded the session ALSO be in the last-ten REST window, which a turn
 * started seconds ago is not.
 *
 * @param agent - The roster entry.
 * @param state - The snapshot.
 * @param ctx - The mute sets, and what each agent's direct message has waiting.
 * @param reason - Which section this copy of the row belongs to.
 */
export function agentRow(
  agent: AgentRosterEntry,
  state: SidebarState,
  ctx: RowContext,
  reason: string
): SidebarRowModel {
  const target = { kind: 'agent', path: agent.path } as const;
  const live = liveSessionIdsForPath(state, agent.path).length;
  const muted = ctx.mutes.agents.has(agent.path);
  return {
    key: rowKey(target),
    target,
    glyph: { kind: 'agent-avatar', agentPath: agent.path },
    primary: state.displayNames[agent.path] ?? basename(agent.path),
    reservesVerbLine: live > 0,
    // What the agent's direct message has for the operator: the row IS that
    // conversation, so its count is the room's.
    unread: ctx.dmUnread.get(agent.path) ?? { tier: 'none' },
    ...(live >= LIVE_CHIP_MIN ? { liveCount: live } : {}),
    muted,
    draggable: true,
    reason,
  };
}

/**
 * One room's row.
 *
 * @param room - The room.
 * @param state - The snapshot.
 * @param ctx - The mute sets, and what each agent's direct message has waiting.
 * @param reason - Which section this copy of the row belongs to.
 */
export function roomRow(
  room: RoomSummary,
  state: SidebarState,
  ctx: RowContext,
  reason: string
): SidebarRowModel {
  const target = {
    kind: 'room',
    roomId: room.id,
    roomKind: room.kind === 'dm' ? 'dm' : 'channel',
  } as const;
  const muted = ctx.mutes.rooms.has(room.id);
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
