/**
 * Each agent's one standing Direct chat (rule S12, DOR-2997).
 *
 * **The view follows who is in the conversation.** You plus one agent is
 * always the 1:1 view. So every door that leads to an agent's conversation
 * with you (its row, Open chat, a ping, an old link to its direct message)
 * opens the same session, the agent's Direct chat, and never the room view.
 *
 * The server owns which session that is (`POST /api/direct-chats`) and makes it
 * the first time anything asks. A new one has no transcript yet, so it is
 * opened the way a new chat is (`newSessionTarget`); the session route drops
 * the draft flag again for one that already exists.
 *
 * @module entities/room/model/direct/use-direct-chat
 */
import { useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  oneToOneDmAgentRef,
  type DirectChat,
  type OpenDirectChatRequest,
} from '@dorkos/shared/room-schemas';
import { newSessionTarget } from '@/layers/shared/lib';
import { useTransport } from '@/layers/shared/model';
import { useRooms } from '../use-rooms';

/** Query key for the Direct chat a session is. */
export const directChatKey = (sessionId: string) => ['direct-chat', sessionId] as const;

/**
 * The Direct chat this session is, or `null` when it is an ordinary chat.
 *
 * @param sessionId - The session on screen, or null for none.
 */
export function useDirectChat(sessionId: string | null): UseQueryResult<DirectChat | null> {
  const transport = useTransport();
  return useQuery({
    queryKey: directChatKey(sessionId ?? ''),
    queryFn: () => transport.findDirectChat(sessionId!),
    enabled: sessionId !== null,
    // Which session is a Direct chat changes only when its DM gains a member.
    staleTime: 60_000,
  });
}

/** How {@link useOpenDirectChat} navigates. */
export interface OpenDirectChatOptions {
  /** Replace the current history entry, so Back skips a redirect. */
  replace?: boolean;
}

/**
 * Open an agent's Direct chat: by its Mesh id, or by the direct message it is.
 *
 * @returns A function that opens it, resolving `false` when it could not.
 */
export function useOpenDirectChat(): (
  req: OpenDirectChatRequest,
  opts?: OpenDirectChatOptions
) => Promise<boolean> {
  const transport = useTransport();
  const navigate = useNavigate();
  return useCallback(
    async (req, opts = {}) => {
      try {
        const chat = await transport.openDirectChat(req);
        const target = await newSessionTarget(transport, {
          session: chat.sessionId,
          dir: chat.agentPath,
        });
        await navigate({ ...target, ...(opts.replace && { replace: true }) });
        return true;
      } catch (err) {
        toast.error('Couldn’t open that chat', {
          description: err instanceof Error ? err.message : undefined,
        });
        return false;
      }
    },
    [transport, navigate]
  );
}

/**
 * Whether this room is the person's one-to-one with an agent, which reads as
 * that agent's Direct chat rather than as a room.
 *
 * @param roomId - The room, or undefined for none.
 */
export function useIsDirectChatRoom(roomId: string | undefined): boolean {
  const rooms = useRooms();
  if (roomId === undefined) return false;
  const room = rooms.data?.find((candidate) => candidate.id === roomId);
  return room !== undefined && oneToOneDmAgentRef(room) !== null;
}
