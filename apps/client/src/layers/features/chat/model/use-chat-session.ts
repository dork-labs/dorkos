import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  SessionStatusEvent,
  MessagePart,
  PresenceUpdateEvent,
  HookPart,
} from '@dorkos/shared/types';
import {
  useTransport,
  useAppStore,
  useTabVisibility,
  useSSEConnection,
} from '@/layers/shared/model';
import { QUERY_TIMING, TIMING, SSE_RESILIENCE } from '@/layers/shared/lib';
import { insertOptimisticSession } from '@/layers/entities/session';
import type { Session } from '@dorkos/shared/types';
import type { ChatMessage, ChatSessionOptions, TransportErrorInfo } from './chat-types';
import { createStreamEventHandler } from './stream-event-handler';
import { deriveFromParts } from './stream-event-helpers';
import { mapHistoryMessage, reconcileTaggedMessages } from './stream-history-helpers';

// Re-export types for backward compat
export type {
  ChatMessage,
  ToolCallState,
  HookState,
  GroupPosition,
  MessageGrouping,
  ChatStatus,
  ChatSessionOptions,
  TransportErrorInfo,
} from './chat-types';

/**
 * Classify a transport-level error for structured banner display.
 *
 * @internal Exported for testing only.
 */
export function classifyTransportError(err: unknown): TransportErrorInfo {
  const error = err instanceof Error ? err : new Error(String(err));
  const code = (err as { code?: string } | null | undefined)?.code;
  const status = (err as { status?: number } | null | undefined)?.status;

  // Session locked by another client
  if (code === 'SESSION_LOCKED') {
    return {
      heading: 'Session in use',
      message: 'Another client is sending a message. Try again in a few seconds.',
      retryable: false,
      autoDismissMs: TIMING.SESSION_BUSY_CLEAR_MS,
    };
  }

  // Network/fetch errors
  if (error instanceof TypeError || /fetch|network/i.test(error.message)) {
    return {
      heading: 'Connection failed',
      message: 'Could not reach the server. Check your connection and try again.',
      retryable: true,
    };
  }

  // HTTP 500-599 server errors
  if (status && status >= 500 && status <= 599) {
    return {
      heading: 'Server error',
      message: 'The server encountered an error. Try again.',
      retryable: true,
    };
  }

  // HTTP 408 or timeout
  if (status === 408 || /timeout/i.test(error.message)) {
    return {
      heading: 'Request timed out',
      message: 'The server took too long to respond. Try again.',
      retryable: true,
    };
  }

  // Default unknown
  return {
    heading: 'Error',
    message: error.message,
    retryable: false,
  };
}

/** Orchestrates chat session state, message history, SSE streaming, and optimistic UI updates. */
export function useChatSession(sessionId: string | null, options: ChatSessionOptions = {}) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const selectedCwd = useAppStore((s) => s.selectedCwd);
  const enableCrossClientSync = useAppStore((s) => s.enableCrossClientSync);
  const enableMessagePolling = useAppStore((s) => s.enableMessagePolling);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState<'idle' | 'streaming' | 'error'>('idle');
  const [error, setError] = useState<TransportErrorInfo | null>(null);
  const [sessionBusy, setSessionBusy] = useState(false);
  const sessionStatusRef = useRef<SessionStatusEvent | null>(null);
  const [sessionStatus, setSessionStatus] = useState<SessionStatusEvent | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const currentPartsRef = useRef<MessagePart[]>([]);
  // Buffer for hook events that arrive before their owning tool_call_start
  const orphanHooksRef = useRef<Map<string, HookPart[]>>(new Map());
  const assistantIdRef = useRef<string>('');
  const assistantCreatedRef = useRef(false);
  const historySeededRef = useRef(false);
  const streamStartTimeRef = useRef<number | null>(null);
  const estimatedTokensRef = useRef<number>(0);
  const [streamStartTime, setStreamStartTime] = useState<number | null>(null);
  const [estimatedTokens, setEstimatedTokens] = useState<number>(0);
  const textStreamingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTextStreamingRef = useRef(false);
  const [isTextStreaming, setIsTextStreaming] = useState(false);
  const thinkingStartRef = useRef<number | null>(null);
  const [rateLimitRetryAfter, setRateLimitRetryAfter] = useState<number | null>(null);
  const [isRateLimited, setIsRateLimited] = useState(false);
  const rateLimitClearRef = useRef<(() => void) | null>(null);
  const [systemStatus, setSystemStatus] = useState<string | null>(null);
  const [promptSuggestions, setPromptSuggestions] = useState<string[]>([]);
  const systemStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionBusyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [presenceInfo, setPresenceInfo] = useState<PresenceUpdateEvent | null>(null);
  const [presencePulse, setPresencePulse] = useState(false);
  const presenceInfoRef = useRef<PresenceUpdateEvent | null>(null);
  const presencePulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedCwdRef = useRef(selectedCwd);
  const isTabVisible = useTabVisibility();
  const messagesRef = useRef<ChatMessage[]>(messages);
  // Tracks the optimistic user message ID so it can be removed on error
  const pendingUserIdRef = useRef<string | null>(null);
  // Tracks auto-retry attempts for transient POST stream failures
  const retryCountRef = useRef<number>(0);

  // Signals that a sessionId change is a server remap (not user navigation).
  // Set synchronously in the done handler BEFORE onSessionIdChange fires,
  // so the session change effect can skip clearing messages.
  const isRemappingRef = useRef(false);

  // Keep refs in sync with state
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    selectedCwdRef.current = selectedCwd;
  }, [selectedCwd]);
  useEffect(() => {
    presenceInfoRef.current = presenceInfo;
  }, [presenceInfo]);

  const isStreaming = status === 'streaming';
  // Keep status in a ref so the sync_update handler sees current status without a stale closure
  const statusRef = useRef(status);
  useEffect(() => {
    statusRef.current = status;
  });

  // Keep rateLimitClearRef in sync — avoids stale closures in the stream handler
  // eslint-disable-next-line react-hooks/refs -- Intentional render-time ref sync to avoid stale closures
  rateLimitClearRef.current = () => {
    setIsRateLimited(false);
    setRateLimitRetryAfter(null);
  };

  const setSystemStatusWithClear = useCallback((message: string | null) => {
    if (systemStatusTimerRef.current) {
      clearTimeout(systemStatusTimerRef.current);
      systemStatusTimerRef.current = null;
    }
    setSystemStatus(message);
    if (message) {
      systemStatusTimerRef.current = setTimeout(() => {
        setSystemStatus(null);
        systemStatusTimerRef.current = null;
      }, TIMING.SYSTEM_STATUS_DISMISS_MS);
    }
  }, []);

  // Ref-stabilize callbacks to prevent streamEventHandler identity churn.
  // Synced on every render (refs are synchronous — no useEffect needed).
  const onTaskEventRef = useRef(options.onTaskEvent);
  const onSessionIdChangeRef = useRef(options.onSessionIdChange);
  const onStreamingDoneRef = useRef(options.onStreamingDone);
  const transformContentRef = useRef(options.transformContent);
  /* eslint-disable react-hooks/refs -- Intentional render-time ref sync to avoid stale closures in stream callbacks */
  onTaskEventRef.current = options.onTaskEvent;
  onSessionIdChangeRef.current = options.onSessionIdChange;
  onStreamingDoneRef.current = options.onStreamingDone;
  transformContentRef.current = options.transformContent;
  /* eslint-enable react-hooks/refs */

  // Create stream event handler at hook level for the SSE streaming path
  const streamEventHandler = useMemo(
    () =>
      // eslint-disable-next-line react-hooks/refs -- refs are captured by the factory and read inside callbacks, not during construction
      createStreamEventHandler({
        currentPartsRef,
        orphanHooksRef,
        assistantCreatedRef,
        sessionStatusRef,
        streamStartTimeRef,
        estimatedTokensRef,
        textStreamingTimerRef,
        isTextStreamingRef,
        thinkingStartRef,
        setMessages,
        setError,
        setStatus,
        setSessionStatus,
        setEstimatedTokens,
        setStreamStartTime,
        setIsTextStreaming,
        setRateLimitRetryAfter,
        setIsRateLimited,
        setSystemStatus: setSystemStatusWithClear,
        setPromptSuggestions,
        rateLimitClearRef,
        sessionId: sessionId ?? '',
        onTaskEventRef,
        onSessionIdChangeRef,
        onStreamingDoneRef,
        isRemappingRef,
      }),

    [sessionId, setSystemStatusWithClear]
  );

  // Load message history from SDK transcript via TanStack Query with adaptive polling
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

  // Reset history seed flag when session or cwd changes.
  // Don't clear messages during streaming — preserves state during
  // create-on-first-message (null → clientId).
  // Don't clear messages during remap — the done handler sets isRemappingRef
  // before changing sessionId (clientId → sdkId); we keep messages and force
  // Branch 2 (incremental dedup) so tagged-dedup reconciles IDs correctly.
  useEffect(() => {
    if (isRemappingRef.current) {
      isRemappingRef.current = false;
      // Force incremental dedup path (Branch 2) — messages are preserved,
      // and the tagged-dedup logic will reconcile IDs when history loads.
      historySeededRef.current = true;
      return;
    }
    historySeededRef.current = false;
    if (statusRef.current !== 'streaming') {
      setMessages([]);
    }
  }, [sessionId, selectedCwd]);

  // Clear presence state when the active session changes
  useEffect(() => {
    setPresenceInfo(null);
    setPresencePulse(false);
  }, [sessionId]);

  // Seed local messages state from history (initial load + post-stream replace)
  useEffect(() => {
    if (!historyQuery.data) return;

    const history = historyQuery.data.messages;

    if (!historySeededRef.current && history.length > 0) {
      // Don't seed during streaming — server history is incomplete and would
      // overwrite optimistic messages (e.g. create-on-first-message sessionId change).
      // Seeding defers until streaming completes and this effect re-runs.
      if (isStreaming) return;
      historySeededRef.current = true;
      setMessages(history.map(mapHistoryMessage));
      return;
    }

    if (historySeededRef.current && !isStreaming) {
      reconcileTaggedMessages(messagesRef.current, history, setMessages);
    }
  }, [historyQuery.data, isStreaming]);

  // Build sync URL (null when streaming or sync disabled)
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

        // Pulse the presence badge when another client's change arrives
        if (presenceInfoRef.current && presenceInfoRef.current.clientCount > 1) {
          setPresencePulse(true);
          if (presencePulseTimerRef.current) clearTimeout(presencePulseTimerRef.current);
          presencePulseTimerRef.current = setTimeout(() => {
            setPresencePulse(false);
            presencePulseTimerRef.current = null;
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
    }),
    [sessionId, queryClient]
  );

  const { connectionState: syncConnectionState, failedAttempts: syncFailedAttempts } =
    useSSEConnection(syncUrl, { eventHandlers: syncEventHandlers });

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (sessionBusyTimerRef.current) clearTimeout(sessionBusyTimerRef.current);
      if (systemStatusTimerRef.current) clearTimeout(systemStatusTimerRef.current);
      if (presencePulseTimerRef.current) clearTimeout(presencePulseTimerRef.current);
    };
  }, []);

  /** Reset text-streaming and rate-limit state after a stream ends or fails. */
  const resetStreamingState = useCallback(() => {
    if (textStreamingTimerRef.current) clearTimeout(textStreamingTimerRef.current);
    isTextStreamingRef.current = false;
    setIsTextStreaming(false);
    setIsRateLimited(false);
    setRateLimitRetryAfter(null);
  }, []);

  /**
   * Core submission logic shared by `handleSubmit` and `submitContent`.
   *
   * @param content - The trimmed message text to send.
   * @param clearInput - When true, clears the `input` state after enqueueing (used by handleSubmit). When false, the textarea draft is preserved (used by submitContent/queue flush).
   * @param restoreContentOnLock - Content to restore to `input` if the session is locked. Only meaningful when clearInput is true.
   */
  const executeSubmission = useCallback(
    async (content: string, clearInput: boolean, restoreContentOnLock: string) => {
      // sessionId is always a speculative UUID (guaranteed by router loader).
      // If this UUID doesn't exist in the sessions cache yet, optimistically
      // insert a placeholder so the sidebar shows it immediately.
      const targetSessionId = sessionId!;
      const sessions =
        queryClient.getQueryData<Session[]>(['sessions', selectedCwdRef.current]) ?? [];
      if (!sessions.some((s) => s.id === targetSessionId)) {
        const now = new Date().toISOString();
        insertOptimisticSession(queryClient, selectedCwdRef.current, {
          id: targetSessionId,
          title: `Session ${targetSessionId.slice(0, 8)}`,
          createdAt: now,
          updatedAt: now,
          permissionMode: 'default',
        });
      }

      // Add optimistic user message directly to the messages array so it appears
      // in the virtualizer BEFORE the streaming assistant message. This fixes the
      // ordering bug where the assistant appeared above the user message (the old
      // pendingUserContent bubble was rendered outside the virtualizer).
      const pendingUserId = `pending-user-${crypto.randomUUID()}`;
      pendingUserIdRef.current = pendingUserId;
      setMessages((prev) => [
        ...prev,
        {
          id: pendingUserId,
          role: 'user' as const,
          content,
          parts: [{ type: 'text', text: content }],
          timestamp: new Date().toISOString(),
          _streaming: true,
        },
      ]);
      if (clearInput) setInput('');
      setPromptSuggestions([]);
      setStatus('streaming');
      statusRef.current = 'streaming'; // Sync ref immediately — closes the timing window where sync_update could invalidate stale history
      setError(null);
      retryCountRef.current = 0; // Reset auto-retry counter for each new submission
      currentPartsRef.current = [];
      const streamStart = Date.now();
      streamStartTimeRef.current = streamStart;
      estimatedTokensRef.current = 0;
      setStreamStartTime(streamStart);
      setEstimatedTokens(0);

      assistantIdRef.current = crypto.randomUUID();
      assistantCreatedRef.current = false;

      const abortController = new AbortController();
      abortRef.current = abortController;

      try {
        const finalContent = transformContentRef.current
          ? await transformContentRef.current(content)
          : content;

        await transport.sendMessage(
          targetSessionId,
          finalContent,
          (event) => streamEventHandler(event.type, event.data, assistantIdRef.current),
          abortController.signal,
          selectedCwdRef.current ?? undefined,
          { clientMessageId: pendingUserId }
        );
        pendingUserIdRef.current = null;
        setStatus('idle');
      } catch (err) {
        // Abort is not an error — user cancelled intentionally
        if ((err as Error).name === 'AbortError') {
          resetStreamingState();
          return;
        }

        const errorInfo = classifyTransportError(err);

        // Session locked — restore input and show auto-dismissing banner
        if ((err as { code?: string }).code === 'SESSION_LOCKED') {
          // Remove optimistic user message — delivery was rejected
          if (pendingUserIdRef.current) {
            const failedId = pendingUserIdRef.current;
            setMessages((prev) => prev.filter((m) => m.id !== failedId));
            pendingUserIdRef.current = null;
          }
          setSessionBusy(true);
          setError(errorInfo);
          if (clearInput) setInput(restoreContentOnLock);
          if (sessionBusyTimerRef.current) clearTimeout(sessionBusyTimerRef.current);
          sessionBusyTimerRef.current = setTimeout(() => {
            setSessionBusy(false);
            setError(null);
            sessionBusyTimerRef.current = null;
          }, TIMING.SESSION_BUSY_CLEAR_MS);
          setStatus('error');
          resetStreamingState();
          return;
        }

        // Retryable transient error — auto-retry once before surfacing to user.
        // Only auto-retry if no events were received yet (connection failed before
        // streaming started). If events already arrived, the server-side session
        // state has been modified — retrying would send a duplicate message. In that
        // case, preserve the partial response and let the user decide via the Retry button.
        const hasPartialResponse = assistantCreatedRef.current;
        if (
          errorInfo.retryable &&
          !hasPartialResponse &&
          retryCountRef.current < SSE_RESILIENCE.POST_MAX_RETRIES
        ) {
          retryCountRef.current += 1;
          // Show transient "retrying" banner — keep any partial assistant response visible
          setError({
            heading: 'Connection interrupted',
            message: 'Retrying…',
            retryable: false,
          });

          // Wait before retry attempt
          await new Promise((resolve) => setTimeout(resolve, SSE_RESILIENCE.POST_RETRY_DELAY_MS));

          try {
            // Re-attempt with same args — reuse the existing abort controller
            const retryContent = transformContentRef.current
              ? await transformContentRef.current(content)
              : content;

            await transport.sendMessage(
              targetSessionId,
              retryContent,
              (event) => streamEventHandler(event.type, event.data, assistantIdRef.current),
              abortController.signal,
              selectedCwdRef.current ?? undefined,
              { clientMessageId: pendingUserIdRef.current ?? pendingUserId }
            );

            // Retry succeeded — clear error, reset counter, go idle
            pendingUserIdRef.current = null;
            retryCountRef.current = 0;
            setError(null);
            setStatus('idle');
            resetStreamingState();
            return;
          } catch (retryErr) {
            // Retry also failed — fall through to show error with retry button
            if ((retryErr as Error).name === 'AbortError') {
              resetStreamingState();
              return;
            }
            // Remove optimistic user message only if it was never delivered
            if (pendingUserIdRef.current) {
              const failedId = pendingUserIdRef.current;
              setMessages((prev) => prev.filter((m) => m.id !== failedId));
              pendingUserIdRef.current = null;
            }
            setError(classifyTransportError(retryErr));
            setStatus('error');
            resetStreamingState();
            return;
          }
        }

        // Non-retryable error, retries exhausted, or mid-stream failure — show error banner.
        // Remove optimistic user message only if it was never delivered
        if (pendingUserIdRef.current) {
          const failedId = pendingUserIdRef.current;
          setMessages((prev) => prev.filter((m) => m.id !== failedId));
          pendingUserIdRef.current = null;
        }

        // Mid-stream interruption: override the error message to explain that the
        // partial response is preserved and the user can retry manually.
        const displayError =
          hasPartialResponse && errorInfo.retryable
            ? {
                heading: 'Response interrupted',
                message:
                  'The connection was lost mid-response. The partial response is preserved above.',
                retryable: true,
              }
            : errorInfo;

        setError(displayError);
        setStatus('error');
        resetStreamingState();
      }
    },
    [sessionId, transport, streamEventHandler, queryClient, resetStreamingState]
  );

  const handleSubmit = useCallback(async () => {
    if (!input.trim() || status === 'streaming') return;
    const userContent = input.trim();
    await executeSubmission(userContent, true, userContent);
  }, [input, status, executeSubmission]);

  /**
   * Submit a message by content string directly, without clearing the `input` state.
   * Used by the auto-flush mechanism to send queued messages while preserving the
   * user's current draft in the textarea.
   */
  const submitContent = useCallback(
    async (content: string) => {
      if (!content.trim() || status === 'streaming') return;
      await executeSubmission(content.trim(), false, '');
    },
    [status, executeSubmission]
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    resetStreamingState();
    setStatus('idle');
  }, [resetStreamingState]);

  /** Retry a failed message submission, resetting the retry counter. */
  const retryMessage = useCallback(
    async (content: string) => {
      setError(null);
      retryCountRef.current = 0;
      await executeSubmission(content, false, '');
    },
    [executeSubmission]
  );

  /** Optimistically mark a tool call as responded (approved/denied/answered). */
  const markToolCallResponded = useCallback(
    (toolCallId: string) => {
      const part = currentPartsRef.current.find(
        (p) => p.type === 'tool_call' && p.toolCallId === toolCallId
      );
      if (part && part.type === 'tool_call') {
        part.status = 'running';
        const parts = currentPartsRef.current.map((p) => ({ ...p }));
        const derived = deriveFromParts(parts);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantIdRef.current
              ? {
                  ...m,
                  content: derived.content,
                  toolCalls: derived.toolCalls.length > 0 ? derived.toolCalls : [],
                  parts,
                }
              : m
          )
        );
      }
    },
    [] // Refs are stable
  );

  // Only show loading when we have no local messages to display.
  // During session ID remap (clientId → sdkId), messages are preserved in
  // local state but the query key changes — causing isLoading to briefly
  // become true. Without this guard, ChatPanel swaps in a loading spinner
  // and the messages "flash" despite being available in local state.
  const isLoadingHistory = historyQuery.isLoading && messages.length === 0;

  const pendingInteractions = useMemo(() => {
    return messages
      .flatMap((m) => m.toolCalls || [])
      .filter((tc) => tc.interactiveType && tc.status === 'pending');
  }, [messages]);

  const activeInteraction = pendingInteractions[0] || null;
  const isWaitingForUser = activeInteraction !== null;
  const waitingType = activeInteraction?.interactiveType || null;

  return {
    messages,
    input,
    setInput,
    handleSubmit,
    submitContent,
    status,
    error,
    sessionBusy,
    stop,
    retryMessage,
    isLoadingHistory,
    sessionStatus,
    streamStartTime,
    estimatedTokens,
    isTextStreaming,
    isWaitingForUser,
    waitingType,
    activeInteraction,
    markToolCallResponded,
    isRateLimited,
    rateLimitRetryAfter,
    systemStatus,
    promptSuggestions,
    presenceInfo,
    presencePulse,
    syncConnectionState,
    syncFailedAttempts,
  };
}
