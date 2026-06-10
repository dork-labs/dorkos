/**
 * Session history loading and seeding for a single chat session.
 *
 * Encapsulates the TanStack Query fetch for message history, the history-seed
 * effects, and the Path A pending-interaction pull. Live cross-client sync is
 * owned by the always-on durable `/events` stream via the StreamManager
 * (`use-session-stream`), not this hook (spec chat-stream-reconnection, ADR-0266).
 */
import { useEffect, useRef } from 'react';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { useTabVisibility, useTransport } from '@/layers/shared/model';
import { QUERY_TIMING } from '@/layers/shared/lib';
import { useSessionChatStore } from '@/layers/entities/session';
import { mapHistoryMessage, reconcileTaggedMessages } from './stream/stream-history-helpers';
import { usePendingInteractions } from './use-pending-interactions';
import type { ChatMessage } from './chat-types';

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

interface UseSessionHistoryParams {
  sessionId: string | null;
  sid: string;
  transport: ReturnType<typeof useTransport>;
  selectedCwd: string | null;
  enableMessagePolling: boolean;
  isStreaming: boolean;
  setMessages: (update: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => void;
  queryClient: QueryClient;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Manages history fetching and seeding for a chat session.
 *
 * @returns The TanStack Query result for history.
 */
export function useSessionHistory({
  sessionId,
  sid,
  transport,
  selectedCwd,
  enableMessagePolling,
  isStreaming,
  setMessages,
}: UseSessionHistoryParams) {
  const isTabVisible = useTabVisibility();

  // Ref for stable async access inside effects without stale closures.
  const selectedCwdRef = useRef(selectedCwd);

  useEffect(() => {
    selectedCwdRef.current = selectedCwd;
  }, [selectedCwd]);

  // ---------------------------------------------------------------------------
  // History query (TanStack Query with adaptive polling)
  // ---------------------------------------------------------------------------

  const historyQuery = useQuery({
    queryKey: ['messages', sessionId, selectedCwd],
    queryFn: () => transport.getMessages(sessionId!, selectedCwd ?? undefined),
    staleTime: QUERY_TIMING.MESSAGE_STALE_TIME_MS,
    refetchOnWindowFocus: false,
    enabled: sessionId !== null,
    refetchInterval: () => {
      if (isStreaming) return false;
      if (!enableMessagePolling) return false;
      return isTabVisible
        ? QUERY_TIMING.ACTIVE_TAB_REFETCH_MS
        : QUERY_TIMING.BACKGROUND_TAB_REFETCH_MS;
    },
  });

  // ---------------------------------------------------------------------------
  // Effects
  // ---------------------------------------------------------------------------

  // Reset history seed flag when session or cwd changes.
  // Preserves state during streaming (create-on-first-message).
  useEffect(() => {
    const store = useSessionChatStore.getState();
    if (sid) store.updateSession(sid, { historySeeded: false });
    // Read status directly from the store to avoid stale-closure risk.
    if (store.getSession(sessionId ?? '').status !== 'streaming') {
      setMessages([]);
    }
  }, [sessionId, selectedCwd, sid, setMessages]);

  // Seed messages from history (initial load + post-stream replace).
  useEffect(() => {
    if (!historyQuery.data) return;

    const history = historyQuery.data.messages;
    const historySeeded = useSessionChatStore.getState().getSession(sid).historySeeded;

    if (!historySeeded && history.length > 0) {
      // Defer seeding until streaming completes — server history is incomplete
      // and would overwrite optimistic messages.
      if (isStreaming) return;
      if (sid) useSessionChatStore.getState().updateSession(sid, { historySeeded: true });
      setMessages(history.map(mapHistoryMessage));
      return;
    }

    if (historySeeded && !isStreaming) {
      reconcileTaggedMessages(
        useSessionChatStore.getState().getSession(sid).messages,
        history,
        setMessages
      );
    }
  }, [historyQuery.data, isStreaming, sid, setMessages]);

  // ---------------------------------------------------------------------------
  // Pending interaction recovery (Path A — pull on mount)
  // ---------------------------------------------------------------------------

  // Runs after initSession() has reset currentParts (this hook is invoked from
  // useChatSession after that reset). Keyed on sessionId, so it re-pulls on every
  // switch, cold navigation, and refresh — the three DOR-73 mount cases. Live
  // pending-interaction recovery now flows through the durable `/events` snapshot
  // (StreamManager); this pull remains as the resilient cold-mount source.
  usePendingInteractions({
    sessionId,
    transport,
    selectedCwd,
    isStreaming,
    setMessages,
  });

  return { historyQuery };
}
