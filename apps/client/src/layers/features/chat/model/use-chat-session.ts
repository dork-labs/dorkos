import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SessionStatusEvent, MessagePart, HistoryMessage } from '@dorkos/shared/types';
import { useTransport, useAppStore } from '@/layers/shared/model';
import { QUERY_TIMING, TIMING } from '@/layers/shared/lib';
import { insertOptimisticSession } from '@/layers/entities/session';
import type { ChatMessage, ChatSessionOptions, TransportErrorInfo } from './chat-types';
import { createStreamEventHandler, deriveFromParts } from './stream-event-handler';

// Re-export types for backward compat
export type { ChatMessage, ToolCallState, GroupPosition, MessageGrouping, ChatStatus, ChatSessionOptions, TransportErrorInfo } from './chat-types';

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

/** Map HistoryMessage from server to internal ChatMessage format. */
function mapHistoryMessage(m: HistoryMessage): ChatMessage {
  const parts: MessagePart[] = m.parts ? [...m.parts] : [];
  if (parts.length === 0) {
    if (m.content) {
      parts.push({ type: 'text', text: m.content });
    }
    if (m.toolCalls) {
      for (const tc of m.toolCalls) {
        parts.push({
          type: 'tool_call',
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: tc.input,
          result: tc.result,
          status: tc.status,
          ...(tc.questions
            ? {
                interactiveType: 'question' as const,
                questions: tc.questions,
                answers: tc.answers,
              }
            : {}),
        });
      }
    }
  }

  const derived = deriveFromParts(parts);
  return {
    id: m.id,
    role: m.role,
    content: derived.content,
    toolCalls: derived.toolCalls.length > 0 ? derived.toolCalls : undefined,
    parts,
    timestamp: m.timestamp || '',
    messageType: m.messageType,
    commandName: m.commandName,
    commandArgs: m.commandArgs,
  };
}

/** Orchestrates chat session state, message history, SSE streaming, and optimistic UI updates. */
export function useChatSession(sessionId: string | null, options: ChatSessionOptions = {}) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const selectedCwd = useAppStore((s) => s.selectedCwd);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState<'idle' | 'streaming' | 'error'>('idle');
  const [error, setError] = useState<TransportErrorInfo | null>(null);
  const [sessionBusy, setSessionBusy] = useState(false);
  const sessionStatusRef = useRef<SessionStatusEvent | null>(null);
  const [sessionStatus, setSessionStatus] = useState<SessionStatusEvent | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const currentPartsRef = useRef<MessagePart[]>([]);
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
  const selectedCwdRef = useRef(selectedCwd);
  const [isTabVisible, setIsTabVisible] = useState(!document.hidden);
  const messagesRef = useRef<ChatMessage[]>(messages);
  // Tracks the optimistic user message ID so it can be removed on error
  const pendingUserIdRef = useRef<string | null>(null);

  // Keep refs in sync with state
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    selectedCwdRef.current = selectedCwd;
  }, [selectedCwd]);

  // Track tab visibility for adaptive polling interval
  useEffect(() => {
    const handleVisibilityChange = () => {
      setIsTabVisible(!document.hidden);
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  const isStreaming = status === 'streaming';
  // Keep status in a ref so the sync_update handler sees current status without a stale closure
  const statusRef = useRef(status);
  useEffect(() => {
    statusRef.current = status;
  });

  // Keep rateLimitClearRef in sync — avoids stale closures in the stream handler
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
  onTaskEventRef.current = options.onTaskEvent;
  onSessionIdChangeRef.current = options.onSessionIdChange;
  onStreamingDoneRef.current = options.onStreamingDone;
  transformContentRef.current = options.transformContent;

  // Create stream event handler at hook level for the SSE streaming path
  const streamEventHandler = useMemo(
    () =>
      createStreamEventHandler({
        currentPartsRef,
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
      return isTabVisible
        ? QUERY_TIMING.ACTIVE_TAB_REFETCH_MS
        : QUERY_TIMING.BACKGROUND_TAB_REFETCH_MS;
    },
  });

  // Reset history seed flag when session or cwd changes.
  // Don't clear messages during streaming — preserves state during
  // create-on-first-message (null → clientId) and done redirect (clientId → sdkId).
  useEffect(() => {
    historySeededRef.current = false;
    if (statusRef.current !== 'streaming') {
      setMessages([]);
    }
  }, [sessionId, selectedCwd]);

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
      const currentIds = new Set(messagesRef.current.map((m) => m.id));
      const newMessages = history.filter((m) => !currentIds.has(m.id));

      if (newMessages.length > 0) {
        setMessages((prev) => [...prev, ...newMessages.map(mapHistoryMessage)]);
      }
    }
  }, [historyQuery.data, isStreaming]);

  // Persistent SSE connection for session sync updates.
  // Closes during streaming since SSE events arrive inline on the POST response.
  useEffect(() => {
    if (!sessionId) return;
    if (isStreaming) return;

    const url = `/api/sessions/${sessionId}/stream`;
    const eventSource = new EventSource(url);

    eventSource.addEventListener('sync_update', () => {
      queryClient.invalidateQueries({ queryKey: ['messages', sessionId, selectedCwdRef.current] });
      queryClient.invalidateQueries({ queryKey: ['tasks', sessionId, selectedCwdRef.current] });
    });

    return () => {
      eventSource.close();
    };
  }, [sessionId, isStreaming, queryClient]);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (sessionBusyTimerRef.current) clearTimeout(sessionBusyTimerRef.current);
      if (systemStatusTimerRef.current) clearTimeout(systemStatusTimerRef.current);
    };
  }, []);

  /**
   * Core submission logic shared by `handleSubmit` and `submitContent`.
   *
   * @param content - The trimmed message text to send.
   * @param clearInput - When true, clears the `input` state after enqueueing (used by handleSubmit). When false, the textarea draft is preserved (used by submitContent/queue flush).
   * @param restoreContentOnLock - Content to restore to `input` if the session is locked. Only meaningful when clearInput is true.
   */
  const executeSubmission = useCallback(async (
    content: string,
    clearInput: boolean,
    restoreContentOnLock: string,
  ) => {
    // Create session on first message if no active session
    let targetSessionId = sessionId;
    if (!targetSessionId) {
      targetSessionId = crypto.randomUUID();
      const now = new Date().toISOString();
      insertOptimisticSession(queryClient, selectedCwdRef.current, {
        id: targetSessionId,
        title: `Session ${targetSessionId.slice(0, 8)}`,
        createdAt: now,
        updatedAt: now,
        permissionMode: 'default',
      });
      onSessionIdChangeRef.current?.(targetSessionId);
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
      },
    ]);
    if (clearInput) setInput('');
    setPromptSuggestions([]);
    setStatus('streaming');
    statusRef.current = 'streaming'; // Sync ref immediately — closes the timing window where sync_update could invalidate stale history
    setError(null);
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
        selectedCwd ?? undefined,
      );
      // Reset seed flag so the next history fetch does a full replace instead of
      // an incremental append. This prevents ID-mismatch duplicates: the streaming
      // assistant has a client-generated UUID while history has an SDK-assigned UUID.
      historySeededRef.current = false;
      pendingUserIdRef.current = null;
      // Invalidate broadly to cover session ID remaps (client UUID → SDK UUID).
      // The old targetSessionId may differ from the SDK-assigned ID returned in
      // the done event, so a narrow key would miss the active query.
      queryClient.invalidateQueries({ queryKey: ['messages'] });
      setStatus('idle');
    } catch (err) {
      // Remove optimistic user message on error — must not linger if delivery fails
      if (pendingUserIdRef.current) {
        const failedId = pendingUserIdRef.current;
        setMessages((prev) => prev.filter((m) => m.id !== failedId));
        pendingUserIdRef.current = null;
      }
      if ((err as Error).name !== 'AbortError') {
        if ((err as { code?: string }).code === 'SESSION_LOCKED') {
          setSessionBusy(true);
          setError(classifyTransportError(err));
          if (clearInput) setInput(restoreContentOnLock);
          if (sessionBusyTimerRef.current) clearTimeout(sessionBusyTimerRef.current);
          sessionBusyTimerRef.current = setTimeout(() => {
            setSessionBusy(false);
            setError(null);
            sessionBusyTimerRef.current = null;
          }, TIMING.SESSION_BUSY_CLEAR_MS);
        } else {
          setError(classifyTransportError(err));
        }
        setStatus('error');
      }
      if (textStreamingTimerRef.current) clearTimeout(textStreamingTimerRef.current);
      isTextStreamingRef.current = false;
      setIsTextStreaming(false);
      setIsRateLimited(false);
      setRateLimitRetryAfter(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Intentional: stable refs for transport/options/cwd
  }, [sessionId, streamEventHandler, queryClient]);

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
  const submitContent = useCallback(async (content: string) => {
    if (!content.trim() || status === 'streaming') return;
    await executeSubmission(content.trim(), false, '');
     
  }, [status, executeSubmission]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    if (textStreamingTimerRef.current) clearTimeout(textStreamingTimerRef.current);
    isTextStreamingRef.current = false;
    setIsTextStreaming(false);
    setIsRateLimited(false);
    setRateLimitRetryAfter(null);
    setStatus('idle');
  }, []);

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

  const isLoadingHistory = historyQuery.isLoading;

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
  };
}
