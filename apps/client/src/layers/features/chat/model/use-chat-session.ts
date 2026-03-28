import { useCallback, useRef, useEffect, useMemo } from 'react';
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
  useTheme,
} from '@/layers/shared/model';
import { QUERY_TIMING, TIMING } from '@/layers/shared/lib';
import {
  insertOptimisticSession,
  useSessionChatStore,
  useSessionChatState,
} from '@/layers/entities/session';
import type { Session } from '@dorkos/shared/types';
import type { ChatMessage, ChatSessionOptions, ChatStatus, TransportErrorInfo } from './chat-types';
import { createStreamEventHandler } from './stream-event-handler';
import { deriveFromParts } from './stream-event-helpers';
import { mapHistoryMessage, reconcileTaggedMessages } from './stream-history-helpers';
import { streamManager } from './stream-manager';

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

// Re-export for consumers
export { classifyTransportError } from './classify-transport-error';

/** Orchestrates chat session state, message history, SSE streaming, and optimistic UI updates. */
export function useChatSession(sessionId: string | null, options: ChatSessionOptions = {}) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const selectedCwd = useAppStore((s) => s.selectedCwd);
  const enableCrossClientSync = useAppStore((s) => s.enableCrossClientSync);
  const enableMessagePolling = useAppStore((s) => s.enableMessagePolling);
  // --- Store-backed fields: all per-session transient state ---
  // Keyed per-session in the Zustand store so they survive session switches,
  // can be read by concurrent streams without stale-closure issues, and
  // preserve drafts/metadata when the user navigates away and returns.
  const sid = sessionId ?? '';

  // Single store subscription for all per-session fields.
  // useSessionChatState returns DEFAULT_SESSION_STATE (a stable module-level constant)
  // when the session doesn't exist yet — avoiding the new-object-per-render trap that
  // per-field selectors with inline `?? []` / `?? {}` defaults would cause.
  const {
    messages,
    input,
    status,
    error,
    sessionBusy,
    sessionStatus,
    streamStartTime,
    estimatedTokens,
    isTextStreaming,
    isRateLimited,
    rateLimitRetryAfter,
    systemStatus,
    promptSuggestions,
    presenceInfo,
    presencePulse,
  } = useSessionChatState(sid);

  /**
   * Write messages for the active session to the store.
   *
   * Accepts either a direct array or a function updater — mirrors the
   * `React.Dispatch<React.SetStateAction<T>>` contract so all existing call
   * sites remain unchanged after migration from local useState.
   */
  const setMessages = useCallback(
    (update: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => {
      if (!sid || !isAliveRef.current) return;
      const store = useSessionChatStore.getState();
      // Guard against stale closures from a previous component instance that
      // mounted for the same session ID. initSession increments mountGeneration
      // each time a fresh session entry is created, so a callback captured before
      // that reset will see a mismatched generation and drop the write.
      const currentGen = store.getSession(sid).mountGeneration;
      if (mountGenerationRef.current !== -1 && currentGen !== mountGenerationRef.current) return;
      const next = typeof update === 'function' ? update(store.getSession(sid).messages) : update;
      store.updateSession(sid, { messages: next });
    },
    [sid]
  );

  /** Write input draft for the active session to the store. */
  const setInput = useCallback(
    (value: string) => {
      if (!sid) return;
      useSessionChatStore.getState().updateSession(sid, { input: value });
    },
    [sid]
  );

  /** Write status for the active session to the store. */
  const setStatus = useCallback(
    (nextStatus: ChatStatus) => {
      if (!sid) return;
      useSessionChatStore.getState().updateSession(sid, { status: nextStatus });
    },
    [sid]
  );

  /** Write error for the active session to the store. */
  const setError = useCallback(
    (nextError: TransportErrorInfo | null) => {
      if (!sid) return;
      useSessionChatStore.getState().updateSession(sid, { error: nextError });
    },
    [sid]
  );

  /** Write sessionBusy for the active session to the store. */
  const setSessionBusy = useCallback(
    (busy: boolean) => {
      if (!sid) return;
      useSessionChatStore.getState().updateSession(sid, { sessionBusy: busy });
    },
    [sid]
  );

  /** Write sessionStatus for the active session to the store. */
  const setSessionStatus = useCallback(
    (s: SessionStatusEvent | null) => {
      if (!sid) return;
      useSessionChatStore.getState().updateSession(sid, { sessionStatus: s });
    },
    [sid]
  );

  /** Write estimatedTokens for the active session to the store. */
  const setEstimatedTokens = useCallback(
    (tokens: number) => {
      if (!sid) return;
      useSessionChatStore.getState().updateSession(sid, { estimatedTokens: tokens });
    },
    [sid]
  );

  /** Write streamStartTime for the active session to the store. */
  const setStreamStartTime = useCallback(
    (time: number | null) => {
      if (!sid) return;
      useSessionChatStore.getState().updateSession(sid, { streamStartTime: time });
    },
    [sid]
  );

  /** Write isTextStreaming for the active session to the store. */
  const setIsTextStreaming = useCallback(
    (streaming: boolean) => {
      if (!sid) return;
      useSessionChatStore.getState().updateSession(sid, { isTextStreaming: streaming });
    },
    [sid]
  );

  /** Write isRateLimited + rateLimitRetryAfter for the active session to the store. */
  const setRateLimitRetryAfter = useCallback(
    (retryAfter: number | null) => {
      if (!sid) return;
      useSessionChatStore.getState().updateSession(sid, { rateLimitRetryAfter: retryAfter });
    },
    [sid]
  );

  /** Write isRateLimited for the active session to the store. */
  const setIsRateLimited = useCallback(
    (limited: boolean) => {
      if (!sid) return;
      useSessionChatStore.getState().updateSession(sid, { isRateLimited: limited });
    },
    [sid]
  );

  /** Write systemStatus for the active session to the store. */
  const setSystemStatus = useCallback(
    (message: string | null) => {
      if (!sid) return;
      useSessionChatStore.getState().updateSession(sid, { systemStatus: message });
    },
    [sid]
  );

  /** Write promptSuggestions for the active session to the store. */
  const setPromptSuggestions = useCallback(
    (suggestions: string[]) => {
      if (!sid) return;
      useSessionChatStore.getState().updateSession(sid, { promptSuggestions: suggestions });
    },
    [sid]
  );

  /** Write presenceInfo for the active session to the store. */
  const setPresenceInfo = useCallback(
    (info: PresenceUpdateEvent | null) => {
      if (!sid) return;
      useSessionChatStore.getState().updateSession(sid, { presenceInfo: info });
    },
    [sid]
  );

  /** Write presencePulse for the active session to the store. */
  const setPresencePulse = useCallback(
    (pulse: boolean) => {
      if (!sid) return;
      useSessionChatStore.getState().updateSession(sid, { presencePulse: pulse });
    },
    [sid]
  );

  // Initialize the store entry synchronously on first render so mountGeneration
  // is available before any effects run. initSession is idempotent — it only
  // creates a new entry (and claims a new mountGeneration) when one doesn't exist.
  // Calling it during render is safe because it's a pure Zustand store mutation
  // with no observable side effects on the component tree.
  if (sid) useSessionChatStore.getState().initSession(sid);

  // mountGenerationRef captures the mountGeneration counter at the time THIS
  // component instance first rendered. Every initSession call for a new (or
  // re-initialized) session claims the next global integer, so any setMessages
  // closure from a previous component instance for the same session ID will hold
  // a stale generation value and will be dropped — matching React's own setState
  // no-op behavior for unmounted components, but without relying on the async
  // effect-cleanup flush order (which can be delayed into a sibling component's
  // act() block in tests).
  const mountGenerationRef = useRef<number>(
    sid ? useSessionChatStore.getState().getSession(sid).mountGeneration : -1
  );

  // isAliveRef provides a secondary unmount guard for in-flight callbacks that
  // resolve after this component instance cleanly unmounts (e.g. network requests
  // that finish just after navigation).
  const isAliveRef = useRef(true);
  useEffect(() => {
    isAliveRef.current = true;
    return () => {
      isAliveRef.current = false;
    };
  }, []);

  // Ref for session_status merging — session_status events are cumulative and
  // must be merged with the previous value. The ref avoids stale-closure issues
  // in the stream event handler.
  const sessionStatusRef = useRef<SessionStatusEvent | null>(null);
  // Per-stream scratch buffers — kept as refs because they are mutated synchronously
  // on every stream event within a single streaming session.  They don't need to
  // survive session switches (a new stream always resets them in executeSubmission).
  const currentPartsRef = useRef<MessagePart[]>([]);
  // Buffer for hook events that arrive before their owning tool_call_start
  const orphanHooksRef = useRef<Map<string, HookPart[]>>(new Map());
  const assistantIdRef = useRef<string>('');
  const assistantCreatedRef = useRef(false);
  const streamStartTimeRef = useRef<number | null>(null);
  const estimatedTokensRef = useRef<number>(0);
  const textStreamingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTextStreamingRef = useRef(false);
  const thinkingStartRef = useRef<number | null>(null);
  // Tracks the clear-rate-limit callback — updated on every render to avoid stale closures
  const rateLimitClearRef = useRef<(() => void) | null>(null);
  const systemStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionBusyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const presenceInfoRef = useRef<PresenceUpdateEvent | null>(null);
  const presencePulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedCwdRef = useRef(selectedCwd);
  const isTabVisible = useTabVisibility();

  // Called synchronously in the done handler when the server remaps the session.
  // Lets StreamManager move its ActiveStream + timer entries to the new key
  // before React re-renders with the new session ID.
  const onRemapRef = useRef<((oldId: string, newId: string) => void) | undefined>(undefined);

  // Refs for ui_command dispatch — kept stable so the stream handler never stales.
  const themeRef = useRef<(theme: 'light' | 'dark') => void>(() => {});
  const scrollToMessageRef = useRef<((messageId?: string) => void) | undefined>(undefined);
  const switchAgentRef = useRef<((cwd: string) => void) | undefined>(undefined);

  // Keep refs in sync with state
  useEffect(() => {
    selectedCwdRef.current = selectedCwd;
  }, [selectedCwd]);
  useEffect(() => {
    presenceInfoRef.current = presenceInfo;
  }, [presenceInfo]);

  const isStreaming = status === 'streaming';

  // Keep rateLimitClearRef in sync — avoids stale closures in the stream handler
  rateLimitClearRef.current = () => {
    setIsRateLimited(false);
    setRateLimitRetryAfter(null);
  };

  const setSystemStatusWithClear = useCallback(
    (message: string | null) => {
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
    },
    [setSystemStatus]
  );

  // Wire theme setter into ref so ui_command/set_theme can call it without a React context.
  const { setTheme } = useTheme();
  themeRef.current = setTheme;

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
        onRemapRef,
        themeRef,
        scrollToMessageRef,
        switchAgentRef,
      }),

    [
      sessionId,
      setMessages,
      setError,
      setStatus,
      setSessionStatus,
      setEstimatedTokens,
      setStreamStartTime,
      setIsTextStreaming,
      setRateLimitRetryAfter,
      setIsRateLimited,
      setSystemStatusWithClear,
      setPromptSuggestions,
    ]
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
  // Don't clear messages during remap — the done handler calls renameSession and
  // sets isRemapping: true before firing onSessionIdChange (clientId → sdkId);
  // we keep messages and force Branch 2 (incremental dedup) so tagged-dedup
  // reconciles IDs correctly.
  useEffect(() => {
    const store = useSessionChatStore.getState();
    if (sid && store.getSession(sid).isRemapping) {
      // Clear the flag and force incremental dedup path (Branch 2) — messages are
      // preserved and tagged-dedup will reconcile IDs when history loads.
      store.updateSession(sid, { isRemapping: false, historySeeded: true });
      return;
    }
    if (sid) store.updateSession(sid, { historySeeded: false });
    // Read status directly from the store — no stale-closure risk since this
    // effect runs after the previous session's store state is already settled.
    if (store.getSession(sessionId ?? '').status !== 'streaming') {
      setMessages([]);
    }
  }, [sessionId, selectedCwd, sid, setMessages]);

  // Initialize session in the store when the active session changes.
  // This ensures the store entry exists before StreamManager writes to it.
  // Also capture the mountGeneration from the freshly-initialized entry so
  // setMessages can detect stale closures from previous component instances.
  useEffect(() => {
    if (sessionId) {
      useSessionChatStore.getState().initSession(sessionId);
      mountGenerationRef.current = useSessionChatStore
        .getState()
        .getSession(sessionId).mountGeneration;
    }
  }, [sessionId]);

  // Presence state is per-session in the store — no clearing needed on switch.

  // Clear background activity indicator when this session becomes active.
  // StreamManager sets hasUnseenActivity on all completed streams; this effect
  // ensures the indicator disappears as soon as the user navigates to the session.
  useEffect(() => {
    if (sessionId) {
      useSessionChatStore.getState().updateSession(sessionId, { hasUnseenActivity: false });
    }
  }, [sessionId]);

  // Per-session state (input, error, status, etc.) is now keyed by session ID
  // in the Zustand store. Switching sessions changes `sid`, which selects a
  // different store slot — no manual clearing needed. The old useEffect that
  // cleared these fields was removed because it destroys per-session drafts.

  // Seed messages from history (initial load + post-stream replace).
  // historySeeded is stored in the Zustand store so it survives session switches
  // and is visible to the remap effect without stale-closure risk.
  useEffect(() => {
    if (!historyQuery.data) return;

    const history = historyQuery.data.messages;
    const historySeeded = useSessionChatStore.getState().getSession(sid).historySeeded;

    if (!historySeeded && history.length > 0) {
      // Don't seed during streaming — server history is incomplete and would
      // overwrite optimistic messages (e.g. create-on-first-message sessionId change).
      // Seeding defers until streaming completes and this effect re-runs.
      if (isStreaming) return;
      if (sid) useSessionChatStore.getState().updateSession(sid, { historySeeded: true });
      setMessages(history.map(mapHistoryMessage));
      return;
    }

    if (historySeeded && !isStreaming) {
      // Pass current messages directly — no stale ref needed.
      reconcileTaggedMessages(
        useSessionChatStore.getState().getSession(sid).messages,
        history,
        setMessages
      );
    }
  }, [historyQuery.data, isStreaming, sid, setMessages]);

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
    [sessionId, queryClient, setPresencePulse, setPresenceInfo]
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
  }, [setIsTextStreaming, setIsRateLimited, setRateLimitRetryAfter]);

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

      // StreamManager.start() owns the optimistic user message — it writes it to the
      // store before calling transport.sendMessage, so we must not also add it here.
      // Prepare UI state and per-stream scratch buffers, then hand off to StreamManager.
      if (clearInput) setInput('');
      setPromptSuggestions([]);
      setError(null);
      currentPartsRef.current = [];
      const streamStart = Date.now();
      streamStartTimeRef.current = streamStart;
      estimatedTokensRef.current = 0;

      assistantIdRef.current = crypto.randomUUID();
      assistantCreatedRef.current = false;

      try {
        // Delegate transport call, optimistic message, and AbortController lifecycle
        // to StreamManager. It writes directly to the session-chat-store and re-throws
        // errors so this catch block can update UI-only state (input restore, busy timer).
        // Phase 1 shim: onEvent forwards each stream event to this hook's local
        // streamEventHandler for messages/status updates. Removed in Phase 2.
        await streamManager.start({
          transport,
          sessionId: targetSessionId,
          content,
          cwd: selectedCwdRef.current,
          transformContent: transformContentRef.current ?? undefined,
          onEvent: (type, data) => streamEventHandler(type, data, assistantIdRef.current),
          onSessionIdChange: onSessionIdChangeRef.current,
          onStreamingDone: onStreamingDoneRef.current,
        });
        resetStreamingState();
      } catch (err) {
        // Abort is not an error — user cancelled intentionally
        if ((err as Error).name === 'AbortError') {
          resetStreamingState();
          return;
        }

        // Session locked — StreamManager has already removed the optimistic message
        // and set error/status in the store. Hook-layer extras: restore input text
        // and start the auto-dismiss timer for the session-busy banner.
        if ((err as { code?: string }).code === 'SESSION_LOCKED') {
          if (clearInput) setInput(restoreContentOnLock);
          if (sessionBusyTimerRef.current) clearTimeout(sessionBusyTimerRef.current);
          sessionBusyTimerRef.current = setTimeout(() => {
            setSessionBusy(false);
            setError(null);
            sessionBusyTimerRef.current = null;
          }, TIMING.SESSION_BUSY_CLEAR_MS);
          resetStreamingState();
          return;
        }

        // For all other errors StreamManager has already written error/status/messages
        // to the store. Only reset transient streaming indicators here.
        resetStreamingState();
      }
    },
    [
      sessionId,
      transport,
      queryClient,
      resetStreamingState,
      setInput,
      setPromptSuggestions,
      setError,
      setSessionBusy,
      streamEventHandler,
    ]
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
    if (sessionId) streamManager.abort(sessionId);
    resetStreamingState();
    setStatus('idle');
  }, [sessionId, resetStreamingState, setStatus]);

  /** Retry a failed message submission, resetting the retry counter. */
  const retryMessage = useCallback(
    async (content: string) => {
      setError(null);
      await executeSubmission(content, false, '');
    },
    [executeSubmission, setError]
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
    [setMessages] // Refs are stable, setMessages from useCallback
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
