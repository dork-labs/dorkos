/**
 * What an agent's card says and offers while the DM view is on (DOR-3074):
 * its role and what it is doing, Message (its DM), Profile, and, with Show
 * sessions on, the session it works in inside the room on screen.
 *
 * @module features/direct-message/model/use-agent-card
 */
import { useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import type { IdentityHoverCardProps } from '@/layers/shared/ui';
import { useSafeNavigate } from '@/layers/shared/model';
import { toSession } from '@/layers/shared/lib';
import { useDmViewEnabled, useShowSessions } from '@/layers/entities/config';
import { useInteractionStore } from '@/layers/entities/interactions';
import {
  roomDisplayTitle,
  useOpenDirectChat,
  useRoomBoundSession,
  useRouteRoom,
  useRooms,
} from '@/layers/entities/room';
import { useAgentStatusLine, useDirectMessageAgent } from './use-direct-message-agent';

/** Who the card is about, and the door it already had. */
export interface AgentCardInput {
  /** The agent's directory, or undefined when the surface cannot name it. */
  agentPath: string | undefined;
  /** The agent's name, for the words a failed session lookup says. */
  displayName: string;
  /** Open the agent's profile, the door the surface already offers. */
  onViewProfile?: () => void;
  /**
   * Whether the card has been opened yet. Nothing is read until it has, so a
   * room with forty messages asks nothing for forty faces nobody pointed at.
   */
  engaged: boolean;
}

/** The card's extra lines and actions, in the shapes the card takes. */
export interface AgentCard {
  /** The role and status lines under the name. */
  about: NonNullable<IdentityHoverCardProps['about']>;
  /** Message, Profile and the session here. */
  actions: NonNullable<IdentityHoverCardProps['actions']>;
}

/**
 * The card for one agent, or `null` while the DM view is off (the card then
 * stays exactly what it was) or when the surface cannot name the agent.
 *
 * @param input - See {@link AgentCardInput}.
 */
export function useAgentCard(input: AgentCardInput): AgentCard | null {
  const { agentPath, displayName, onViewProfile, engaged } = input;
  const enabled = useDmViewEnabled();
  const showSessions = useShowSessions();
  const reading = enabled && engaged && agentPath !== undefined;
  const agent = useDirectMessageAgent(reading ? agentPath : null);
  const status = useAgentStatusLine(agent.member);
  const openDirectChat = useOpenDirectChat();
  const resolveRoomSession = useRoomBoundSession();
  const navigate = useSafeNavigate();
  const route = useRouteRoom();
  const { data: rooms } = useRooms({ enabled: reading && showSessions });
  const routeRoomId = route.status === 'ready' ? route.roomId : null;
  const routeRoom = rooms?.find((room) => room.id === routeRoomId);
  const roomLabel = routeRoom ? roomDisplayTitle(routeRoom) : null;
  const runtime = agent.member?.agent?.effectiveRuntimeId;

  const onMessage = useCallback(() => {
    if (agentPath === undefined) return;
    useInteractionStore.getState().recordOpened('agent', agentPath);
    void openDirectChat({ agentPath }, runtime ? { runtime } : {});
  }, [agentPath, openDirectChat, runtime]);

  const openRoomSession = useCallback(async () => {
    if (agentPath === undefined || !navigate) return;
    const session = await resolveRoomSession(agentPath);
    if (session === null) {
      toast(`${displayName} has no session in ${roomLabel ?? 'this room'} yet`);
      return;
    }
    void navigate(toSession({ session }));
  }, [agentPath, navigate, resolveRoomSession, displayName, roomLabel]);

  return useMemo(() => {
    if (!enabled || agentPath === undefined) return null;
    return {
      about: { role: agent.role, status },
      actions: {
        onMessage,
        ...(onViewProfile ? { onViewProfile } : {}),
        ...(showSessions && roomLabel
          ? { session: { label: `Session in ${roomLabel}`, onOpen: () => void openRoomSession() } }
          : {}),
      },
    };
  }, [
    enabled,
    agentPath,
    agent.role,
    status,
    onMessage,
    onViewProfile,
    showSessions,
    roomLabel,
    openRoomSession,
  ]);
}
