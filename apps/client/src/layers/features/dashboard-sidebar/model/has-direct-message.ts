/**
 * Whether an agent is on the sidebar without a pin: it has a one-to-one direct
 * message, which Direct messages draws as the agent's own row
 * (`rules/agent-direct-messages.ts`). The ungroup paths ask it before pinning,
 * so an agent already in reach is not pinned for nothing (DOR-3092).
 *
 * @module features/dashboard-sidebar/model/has-direct-message
 */
import { useMemo } from 'react';
import { agentAuthorRef, oneToOneDmAgentRef, type RoomSummary } from '@dorkos/shared/room-schemas';
import type { HasDirectMessage } from '@/layers/entities/config';
import { useRooms } from '@/layers/entities/room';

/**
 * The answer, from a list of rooms. Archived rooms are not drawn, so they do
 * not count.
 *
 * @param rooms - Every room this cockpit can see.
 */
export function hasDirectMessageIn(rooms: readonly RoomSummary[]): HasDirectMessage {
  const refs = new Set<string>();
  for (const room of rooms) {
    if (room.archived) continue;
    const ref = oneToOneDmAgentRef(room);
    if (ref !== null) refs.add(ref);
  }
  return (agentPath) => refs.has(agentAuthorRef(agentPath));
}

/** The same answer, from the rooms query a component already shares. */
export function useHasDirectMessage(): HasDirectMessage {
  const { data } = useRooms();
  return useMemo(() => hasDirectMessageIn(data ?? []), [data]);
}
