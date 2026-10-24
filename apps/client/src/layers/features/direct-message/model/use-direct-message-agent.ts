/**
 * Who an agent is, as the DM view and an agent's card say it (DOR-3074): its
 * name, its face, its role, what it is doing, and the channels it shares with
 * the person.
 *
 * @module features/direct-message/model/use-direct-message-agent
 */
import { useCallback, useMemo } from 'react';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { getAgentDisplayName, resolveAgentVisual, type AgentVisual } from '@/layers/shared/lib';
import { useCurrentAgent } from '@/layers/entities/agent';
import { roomDisplayTitle, useRooms } from '@/layers/entities/room';
import { useMemberRooms, useTeamRoster } from '@/layers/entities/team';
import { agentStatusLine, sharedChannels, type SharedChannel } from '../lib/direct-message-rules';

/** What the DM view knows about the agent it is with. */
export interface DirectMessageAgent {
  /** The agent's own id (its manifest's), or null until its manifest arrives. */
  id: string | null;
  /** The agent's name, or null until its manifest arrives. */
  name: string | null;
  /** The agent's face, or null until its manifest arrives. */
  visual: AgentVisual | null;
  /** What the agent does, from its own description, or null when it has none. */
  role: string | null;
  /** The agent's row on the team roster, or undefined while unknown. */
  member: TeamMember | undefined;
}

/**
 * Read one agent by its directory. Every read is a shared cache other surfaces
 * already keep warm (the manifest, the roster), so this costs no new request
 * on a screen that has them.
 *
 * @param agentPath - The agent's directory, or null for none (nothing is read).
 */
export function useDirectMessageAgent(agentPath: string | null): DirectMessageAgent {
  const { data: manifest } = useCurrentAgent(agentPath);
  const { data: roster } = useTeamRoster({ enabled: agentPath !== null });
  const member = useMemo(
    () =>
      agentPath === null
        ? undefined
        : roster?.members.find((row) => row.agent?.projectPath === agentPath),
    [roster, agentPath]
  );
  const description = manifest?.description?.trim();
  return {
    id: manifest?.id ?? null,
    name: manifest ? getAgentDisplayName(manifest) : null,
    visual: manifest ? resolveAgentVisual(manifest) : null,
    role: description ? description : null,
    member,
  };
}

/**
 * The channels this person and the agent are both in, newest activity first.
 *
 * @param memberId - The agent's roster id, or null while unknown.
 * @param exclude - A room never to list: the DM under this chat.
 */
export function useSharedChannels(
  memberId: string | null,
  exclude?: string | null
): SharedChannel[] {
  const { data: agentRooms } = useMemberRooms(memberId);
  const { data: rooms } = useRooms();
  return useMemo(
    () => sharedChannels(agentRooms?.rooms, rooms, exclude),
    [agentRooms, rooms, exclude]
  );
}

/**
 * What an agent is doing, in the one line its card shows: the room it is
 * working in, named the way this client names rooms, or when it last worked.
 *
 * @param member - The agent's roster row, or undefined while unknown.
 */
export function useAgentStatusLine(member: TeamMember | undefined): string | null {
  const { data: rooms } = useRooms();
  const labelFor = useCallback(
    (roomId: string) => {
      const room = rooms?.find((candidate) => candidate.id === roomId);
      return room ? roomDisplayTitle(room) : undefined;
    },
    [rooms]
  );
  return agentStatusLine(member?.agent?.activity, labelFor);
}
