/**
 * What an enrolled agent's copy of a space holds: its channels and, where the space holds them,
 * its direct messages (DOR-2955). The subscription runtime reads both as the agent, so a direct
 * message gets the agent's copy, live stream and turns like any room the agent is in.
 *
 * @module services/communities/remote/dms/dm-rooms
 */
import type {
  CommunityAdapter,
  CommunityReadContext,
  CommunityRoom,
} from '@dorkos/shared/community-adapter';

/** The reads this needs: channels, and direct messages when the adapter can list them. */
export interface AgentRoomsAdapter extends Pick<CommunityAdapter, 'listRooms'> {
  /** The agent's direct messages as rooms of kind `dm`; absent on an adapter without them. */
  listDirectMessageRooms?(context: CommunityReadContext): Promise<CommunityRoom[]>;
}

/**
 * Every room one enrolled agent is in. A failure to list either throws, so nothing the agent
 * holds is taken for gone.
 *
 * @param adapter - The connection's adapter.
 * @param actingMemberId - The enrolled agent, by its member id in the space.
 */
export async function agentRooms(
  adapter: AgentRoomsAdapter,
  actingMemberId: string
): Promise<CommunityRoom[]> {
  const context = { actingMemberId };
  const [channels, dms] = await Promise.all([
    adapter.listRooms(context),
    adapter.listDirectMessageRooms?.(context) ?? Promise.resolve([]),
  ]);
  return [...channels, ...dms];
}
