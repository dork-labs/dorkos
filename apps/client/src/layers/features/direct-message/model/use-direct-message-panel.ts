/**
 * Whether the right panel sits beside a DM, and whose (DOR-3075).
 *
 * @module features/direct-message/model/use-direct-message-panel
 */
import { useMemo } from 'react';
import { SESSION_ROUTE } from '@dorkos/shared/session-link';
import { useSafePathname, useSafeSearch } from '@/layers/shared/model';
import { useDmViewEnabled, useShowSessions } from '@/layers/entities/config';
import { useMeshAgentPaths } from '@/layers/entities/mesh';
import { routeShowsRoom, useRooms, useRoomWorking } from '@/layers/entities/room';
import { useSessionId } from '@/layers/entities/session';
import { groupDmMembers, isGroupDm, type GroupDmMember } from '../lib/group-dm';
import { useDirectMessageView } from './use-direct-message-view';

/**
 * The DM the right panel sits beside.
 *
 * - `one-to-one` — a chat with one agent drawn as a DM. The agent is implied,
 *   so every tab is about it.
 * - `group` — a direct message with more than one agent or person. Its tabs
 *   are about the member picked at the top of the panel.
 */
export type DirectMessagePanel =
  | {
      kind: 'one-to-one';
      /** The session behind the DM, which the Work tab shows. */
      sessionId: string;
      /** The agent's directory. */
      agentPath: string;
      /** Whether Show sessions is on. */
      showSessions: boolean;
    }
  | {
      kind: 'group';
      /** The group DM on screen. */
      roomId: string;
      /** Its agents, in roster order: who the picker offers. */
      members: GroupDmMember[];
      /** Whether any agent is working in it right now. */
      working: boolean;
      /** Whether Show sessions is on. */
      showSessions: boolean;
    };

/**
 * The DM beside the right panel, or `null` beside anything else.
 *
 * Always `null` while the DM view experiment is off, and nothing extra is read
 * then, so the panel is exactly what it was. The session view behind a DM is
 * not a DM: its panel is a session's.
 */
export function useDirectMessagePanel(): DirectMessagePanel | null {
  const enabled = useDmViewEnabled();
  const showSessions = useShowSessions();
  const pathname = useSafePathname();
  const [routeSessionId] = useSessionId();
  const onSession = enabled && pathname === SESSION_ROUTE;
  const view = useDirectMessageView(onSession ? (routeSessionId ?? null) : null);
  // A group DM is only ever addressed by its id: Home's room is #team.
  const search = useSafeSearch() as { id?: string };
  const roomId = enabled && routeShowsRoom(pathname) ? (search.id ?? null) : null;
  const { data: rooms } = useRooms({ enabled: roomId !== null });
  const room = roomId === null ? undefined : rooms?.find((candidate) => candidate.id === roomId);
  const group = room !== undefined && isGroupDm(room) ? room : undefined;
  const { data: fleet } = useMeshAgentPaths({ enabled: group !== undefined });
  const fleetAgents = fleet?.agents;
  // Live presence, not the list's snapshot: it is what says a turn has ended.
  const working = useRoomWorking(group?.id ?? '', group?.working) > 0;
  const chat = view.mode === 'dm' ? view.chat : null;

  return useMemo<DirectMessagePanel | null>(() => {
    if (onSession && chat !== null && routeSessionId) {
      return {
        kind: 'one-to-one',
        sessionId: routeSessionId,
        agentPath: chat.agentPath,
        showSessions,
      };
    }
    if (group !== undefined) {
      return {
        kind: 'group',
        roomId: group.id,
        members: groupDmMembers(group, fleetAgents),
        working,
        showSessions,
      };
    }
    return null;
  }, [onSession, chat, routeSessionId, showSessions, group, fleetAgents, working]);
}
