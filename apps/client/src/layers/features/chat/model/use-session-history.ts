/**
 * Session history loading, seeding, and cross-client sync for a single chat session.
 *
 * Encapsulates: TanStack Query fetch for message history, history-seed effects,
 * session SSE sync connection, and presence bookkeeping.
 */
import { useEffect, useMemo, useRef } from 'react';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import type { PresenceUpdateEvent } from '@dorkos/shared/types';
import { useSSEConnection, useTabVisibility, useTransport } from '@/layers/shared/model';
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
  enableCrossClientSync: boolean;
  enableMessagePolling: boolean;
  isStreaming: boolean;
  /** Current presenceInfo from store — kept in sync via internal ref. */
  presenceInfo: PresenceUpdateEvent | null;
  setMessages: (update: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => void;
  setPresenceTasks: (tasks: boolean) => void;
  setPresenceInfo: (info: PresenceUpdateEvent | null) => void;
  queryClient: QueryClient;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Manages history fetching, SSE sync, and presence state for a chat session.
 *
 * @returns The TanStack Query result for history, plus the SSE sync connection state.
 */
export function useSessionHistory({
  sessionId,
  sid,
  transport,
  selectedCwd,
  enableCrossClientSync,
  enableMessagePolling,
  isStreaming,
  presenceInfo,
  setMessages,
  setPresenceTasks,
  setPresenceInfo,
  queryClient,
}: UseSessionHistoryParams) {
  const isTabVisible = useTabVisibility();

  // Refs for stable async access inside event handlers without stale closures
  const selectedCwdRef = useRef(selectedCwd);
  const presenceInfoRef = useRef(presenceInfo);
  const presenceTasksTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Bridges the Path B re-emit handler (returned by `usePendingInteractions`
  // below) back into `syncEventHandlers`, which is memoized BEFORE that hook
  // runs. The ref avoids the memo-ordering deadlock and any stale closure.
  const replayInteractionEventRef = useRef<((type: string, data: unknown) => void) | null>(null);

  useEffect(() => {
    selectedCwdRef.current = selectedCwd;
  }, [selectedCwd]);

  useEffect(() => {
    presenceInfoRef.current = presenceInfo;
  }, [presenceInfo]);

  // Cleanup presence tasks timer on unmount
  useEffect(() => {
    return () => {
      if (presenceTasksTimerRef.current) clearTimeout(presenceTasksTimerRef.current);
    };
  }, []);

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
  // Preserves state during streaming (create-on-first-message) and remap.
  useEffect(() => {
    const store = useSessionChatStore.getState();
    if (sid && store.getSession(sid).isRemapping) {
      // Clear the flag and force incremental dedup path (Branch 2) — messages are
      // preserved and tagged-dedup will reconcile IDs when history loads.
      store.updateSession(sid, { isRemapping: false, historySeeded: true });
      return;
    }
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
  // Cross-client SSE sync
  // ---------------------------------------------------------------------------

  const syncUrl = useMemo(() => {
    if (!sessionId || isStreaming || !enableCrossClientSync) return null;
    const clientIdParam = transport.clientId
      ? `?clientId=${encodeURIComponent(transport.clientId)}`
      : '';
    return `/api/sessions/${sessionId}/stream${clientIdParam}`;
  }, [sessionId, isStreaming, enableCrossClientSync, transport.clientId]);

  const syncEventHandlers = useMemo(
    () => ({
      sync_update: () => {
        queryClient.invalidateQueries({
          queryKey: ['messages', sessionId, selectedCwdRef.current],
        });
        queryClient.invalidateQueries({
          queryKey: ['tasks', sessionId, selectedCwdRef.current],
        });

        // Tasks the presence badge when another client's change arrives
        if (presenceInfoRef.current && presenceInfoRef.current.clientCount > 1) {
          setPresenceTasks(true);
          if (presenceTasksTimerRef.current) clearTimeout(presenceTasksTimerRef.current);
          presenceTasksTimerRef.current = setTimeout(() => {
            setPresenceTasks(false);
            presenceTasksTimerRef.current = null;
          }, 1000);
        }
      },
      presence_update: (data: unknown) => {
        try {
          setPresenceInfo(data as PresenceUpdateEvent);
        } catch {
          /* ignore malformed */
        }
      },
      // Path B recovery — pending interactions re-emitted on every (re)connect of
      // the sync stream. Routed through the SAME idempotent renderer the Path A
      // pull uses, so a prompt already painted by the in-band turn or the pull is
      // upserted in place (dedup by interaction id), never stacked as a duplicate.
      approval_required: (data: unknown) =>
        replayInteractionEventRef.current?.('approval_required', data),
      question_prompt: (data: unknown) =>
        replayInteractionEventRef.current?.('question_prompt', data),
      elicitation_prompt: (data: unknown) =>
        replayInteractionEventRef.current?.('elicitation_prompt', data),
    }),
    [sessionId, queryClient, setPresenceTasks, setPresenceInfo]
  );

  const { connectionState: syncConnectionState, failedAttempts: syncFailedAttempts } =
    useSSEConnection(syncUrl, { eventHandlers: syncEventHandlers });

  // ---------------------------------------------------------------------------
  // Pending interaction recovery (Path A — pull on mount)
  // ---------------------------------------------------------------------------

  // Runs after initSession() has reset currentParts (this hook is invoked from
  // useChatSession after that reset). Keyed on sessionId, so it re-pulls on every
  // switch, cold navigation, and refresh — the three DOR-73 mount cases. The pull
  // is established after the sync subscription above so a live re-emit and the pull
  // dedup by interaction id rather than racing; ordering only affects which paints
  // first, never correctness.
  //
  // The hook also returns `replayInteractionEvent` — the shared routing entrypoint
  // Path B (re-emit on the sync stream) feeds live re-emitted interaction events
  // through so they upsert the SAME card this pull hydrated.
  const { replayInteractionEvent } = usePendingInteractions({
    sessionId,
    transport,
    selectedCwd,
    isStreaming,
    setMessages,
  });

  // Publish the stable Path B entrypoint to the ref the (earlier-memoized)
  // `syncEventHandlers` reads. `replayInteractionEvent` is stable across renders
  // (memoized in usePendingInteractions), so this effect runs only when the
  // session changes. The ref is dereferenced only inside an SSE event callback —
  // always after commit — so an effect-time assignment is sound.
  useEffect(() => {
    replayInteractionEventRef.current = replayInteractionEvent;
  }, [replayInteractionEvent]);

  return { historyQuery, syncConnectionState, syncFailedAttempts };
}
