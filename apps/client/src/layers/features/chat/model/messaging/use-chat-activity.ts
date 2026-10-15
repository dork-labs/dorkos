/**
 * What a chat sent other chats, and the times another chat stopped it (spec
 * `spin-off-chats` §6) — the data the Sent cards and "Stopped by" lines draw.
 *
 * @module features/chat/model/messaging/use-chat-activity
 */
import { useContext } from 'react';
import { QueryClient, QueryClientContext, useQuery } from '@tanstack/react-query';
import type { ChatActivityResponse } from '@dorkos/shared/chat-messages';
import { useOptionalTransport } from '@/layers/shared/model';
import { useChatActivityVersion } from '@/layers/entities/session';

/** The empty answer, stable so a chat with no messaging renders nothing new. */
const EMPTY: ChatActivityResponse = { sent: [], stops: [] };

/**
 * Stands in where no query provider is mounted (a component test, a
 * showcase): the read is then disabled and the answer is {@link EMPTY}, so the
 * transcript around it renders exactly as it would with no messaging.
 */
const NO_PROVIDER_CLIENT = new QueryClient();

/**
 * Read a chat's messaging, and read it again every time the chat's stream says
 * it changed (`chat_activity`). The version is part of the key, so a new
 * version is a new read, and the last answer stays on screen while it lands.
 *
 * @param sessionId - The chat, or null before one resolves.
 */
export function useChatActivity(sessionId: string | null | undefined): ChatActivityResponse {
  const transport = useOptionalTransport();
  const client = useContext(QueryClientContext);
  const version = useChatActivityVersion(sessionId ?? '');
  const { data } = useQuery(
    {
      queryKey: ['chat-activity', sessionId, version],
      queryFn: () => transport!.getChatActivity(sessionId!),
      enabled: Boolean(sessionId) && transport !== null && client !== undefined,
      // The last answer stays on screen while a new version lands — but only
      // this chat's: another chat's Sent cards must never stand in for these.
      placeholderData: (previous, previousQuery) =>
        previousQuery?.queryKey[1] === sessionId ? previous : undefined,
      staleTime: 30_000,
    },
    client ?? NO_PROVIDER_CLIENT
  );
  return data ?? EMPTY;
}
