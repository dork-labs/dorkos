/**
 * Read a session's turns without opening it (DOR-3075).
 *
 * @module features/chat/model/stream/use-session-readout
 */
import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { QUERY_TIMING } from '@/layers/shared/lib';
import { useTransport } from '@/layers/shared/model';
import type { ChatMessage } from '../chat-types';
import { mapHistoryMessages } from './stream-history-helpers';

/** What a readout holds. */
export interface SessionReadout {
  /** The session's messages, oldest first, or empty while unread. */
  messages: readonly ChatMessage[];
  /** True until the first read answers. */
  isLoading: boolean;
  /** True when the read failed, a 403 included. */
  isError: boolean;
}

const NO_MESSAGES: readonly ChatMessage[] = [];

/**
 * Read the newest page of a session that is not on screen, and read it again
 * every few seconds while `polling` holds, and once more when it stops, so a
 * turn's last steps arrive after the room says nobody is working.
 *
 * For a surface that only looks at another session's work, the Work tab in a
 * group DM: it binds no stream and writes nothing to the chat store, so the
 * session on screen is never disturbed by it.
 *
 * @param sessionId - The session to read, or null for none (nothing is read).
 * @param polling - Read again on the active-tab beat while true.
 */
export function useSessionReadout(sessionId: string | null, polling: boolean): SessionReadout {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const wasPolling = useRef(polling);
  useEffect(() => {
    const stopped = wasPolling.current && !polling;
    wasPolling.current = polling;
    if (stopped && sessionId !== null) {
      void queryClient.invalidateQueries({ queryKey: ['session-readout', sessionId] });
    }
  }, [polling, sessionId, queryClient]);
  const query = useQuery({
    queryKey: ['session-readout', sessionId],
    queryFn: async () => mapHistoryMessages((await transport.getMessages(sessionId!)).messages),
    enabled: sessionId !== null,
    staleTime: QUERY_TIMING.MESSAGE_STALE_TIME_MS,
    refetchInterval: polling ? QUERY_TIMING.ACTIVE_TAB_REFETCH_MS : false,
  });
  return {
    messages: query.data ?? NO_MESSAGES,
    isLoading: sessionId !== null && query.isLoading,
    isError: query.isError,
  };
}
