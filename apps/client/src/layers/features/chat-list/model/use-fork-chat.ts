/**
 * Fork a chat and land in the copy, the one way both chat lists do it.
 *
 * @module features/chat-list/model/use-fork-chat
 */
import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTransport } from '@/layers/shared/model';
import { sessionKeys } from '@/layers/entities/session';

/**
 * A callback that copies a chat's whole transcript into a new chat and opens it.
 *
 * Owned by the list rather than handed in, because the `⇧↵` hint and the
 * row's Fork item promise it unconditionally: a hint beside a call site that
 * forgot to pass a handler would be a lie the list tells about itself.
 *
 * @param agentPath - The agent's directory, so the copy belongs to the same agent.
 * @param onOpen - Opens the new chat once it exists.
 */
export function useForkChat(
  agentPath: string | null,
  onOpen: (sessionId: string) => void
): (sessionId: string) => Promise<void> {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useCallback(
    async (sessionId: string) => {
      try {
        const forked = await transport.forkSession(sessionId, undefined, agentPath ?? undefined);
        await queryClient.invalidateQueries({ queryKey: sessionKeys.listRoot });
        onOpen(forked.id);
      } catch (error) {
        // A headline a person can read, with the server's own words under it.
        toast.error('Couldn’t fork this chat.', {
          description: error instanceof Error ? error.message : 'The original is untouched.',
        });
      }
    },
    [agentPath, onOpen, queryClient, transport]
  );
}
