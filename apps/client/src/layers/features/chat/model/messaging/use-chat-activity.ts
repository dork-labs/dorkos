/**
 * What a chat sent other chats, and the times another chat stopped it (spec
 * `spin-off-chats` §6) — the data the Sent cards and "Stopped by" lines draw.
 *
 * @module features/chat/model/messaging/use-chat-activity
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { ChatActivityResponse } from '@dorkos/shared/chat-messages';
import { useTransport } from '@/layers/shared/model';
import { useChatActivityVersion } from '@/layers/entities/session';

/** The empty answer, stable so a chat with no messaging renders nothing new. */
const EMPTY: ChatActivityResponse = { sent: [], stops: [] };

/**
 * Read a chat's messaging, and read it again every time the chat's stream says
 * it changed (`chat_activity`). The version is part of the key, so a new
 * version is a new read, and the last answer stays on screen while it lands.
 *
 * @param sessionId - The chat, or null before one resolves.
 */
export function useChatActivity(sessionId: string | null | undefined): ChatActivityResponse {
  const transport = useTransport();
  const version = useChatActivityVersion(sessionId ?? '');
  const { data } = useQuery({
    queryKey: ['chat-activity', sessionId, version],
    queryFn: () => transport.getChatActivity(sessionId!),
    enabled: Boolean(sessionId),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  return data ?? EMPTY;
}
