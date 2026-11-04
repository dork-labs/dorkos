/**
 * Who an agent is, as the DM view and an agent's card say it (DOR-3074): its
 * name, its face, its role, what it is doing, and the channels it shares with
 * the person.
 *
 * @module features/direct-message/model/use-direct-message-agent
 */
import { useCallback, useMemo } from 'react';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import {
  AGENT_IDENTITY_LIMIT_MS,
  getAgentDisplayName,
  resolveAgentVisual,
  useGaveUpWaiting,
  type AgentVisual,
} from '@/layers/shared/lib';
import { useCurrentAgent } from '@/layers/entities/agent';
import { dmCounterpart, roomDisplayTitle, useRooms } from '@/layers/entities/room';
import { useMemberRooms, useTeamRoster } from '@/layers/entities/team';
import { agentStatusLine, sharedChannels, type SharedChannel } from '../lib/direct-message-rules';

/** What to call an agent whose manifest is gone and whose name no record keeps. */
export const UNKNOWN_AGENT_NAME = 'Unknown agent';

/** What the DM view knows about the agent it is with. */
export interface DirectMessageAgent {
  /** The agent's own id (its manifest's), or null without a manifest. */
  id: string | null;
  /** Whether its name is still on its way. False once read, even if there is none. */
  pending: boolean;
  /**
   * The agent's name, or null until it arrives. With a `roomId`, a manifest that
   * is gone or unreadable falls back to the name the DM's roster keeps, then to
   * {@link UNKNOWN_AGENT_NAME}. Without one, it stays null.
   */
  name: string | null;
  /**
   * The name the DM's roster keeps, as soon as it has answered, for rows shown
   * before {@link name} settles. Null when there is a manifest, or none is kept.
   */
  keptName: string | null;
  /** Whether {@link name} is only the stand-in, so nothing should address it. */
  unknown: boolean;
  /** The agent's face, or null without a manifest. */
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
 * @param roomId - The DM under the chat, whose roster outlives the agent's manifest.
 */
export function useDirectMessageAgent(
  agentPath: string | null,
  roomId: string | null = null
): DirectMessageAgent {
  const { data: manifest, isPending } = useCurrentAgent(agentPath);
  const { data: roster } = useTeamRoster({ enabled: agentPath !== null });
  // A DM keeps its agent after the agent's file is gone, so without a manifest its
  // room says who it is. Until both have answered the name is still on its way,
  // never a guess, up to the limit: then whatever is known, and a late answer
  // still corrects it.
  const asksRoom = roomId !== null && agentPath !== null && !manifest;
  const { data: rooms, isPending: roomPending } = useRooms({ enabled: asksRoom });
  const room = asksRoom ? rooms?.find((candidate) => candidate.id === roomId) : undefined;
  const lastKnownName = dmCounterpart(room?.participants)?.displayName.trim();
  const stillOut = asksRoom && (isPending || roomPending);
  const gaveUp = useGaveUpWaiting(stillOut, agentPath ?? '', AGENT_IDENTITY_LIMIT_MS);
  const fallbackReady = asksRoom && (!stillOut || gaveUp);
  const member = useMemo(
    () =>
      agentPath === null
        ? undefined
        : roster?.members.find((row) => row.agent?.projectPath === agentPath),
    [roster, agentPath]
  );
  const description = manifest?.description?.trim();
  return {
    pending: agentPath !== null && (isPending || (asksRoom && roomPending)),
    id: manifest?.id ?? null,
    name: manifest
      ? getAgentDisplayName(manifest)
      : fallbackReady
        ? lastKnownName || UNKNOWN_AGENT_NAME
        : null,
    keptName: lastKnownName || null,
    unknown: !manifest && fallbackReady && !lastKnownName,
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
