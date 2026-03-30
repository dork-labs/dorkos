import { useEffect, useMemo, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAppStore } from '@/layers/shared/model';
import { useTransport } from '@/layers/shared/model';
import { useSessionChatStore, useSessionChatState } from '@/layers/entities/session';
import { useSessionStoreActions } from './use-session-store-actions';
import { useSessionHistory } from './use-session-history';
import { useSessionSubmit } from './use-session-submit';
import type { ChatSessionOptions } from './chat-types';

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
  const sid = sessionId ?? '';

  // Single store subscription for all per-session fields.
  // useSessionChatState returns DEFAULT_SESSION_STATE (stable module-level constant)
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
    presenceTasks,
  } = useSessionChatState(sid);

  // ---------------------------------------------------------------------------
  // Lifecycle refs — declared early so they can be passed to useSessionStoreActions
  // ---------------------------------------------------------------------------

  // isAliveRef: secondary unmount guard for in-flight callbacks that resolve
  // after this component instance cleanly unmounts.
  const isAliveRef = useRef(true);
  useEffect(() => {
    isAliveRef.current = true;
    return () => {
      isAliveRef.current = false;
    };
  }, []);

  // Per-session mount generation Map. Each entry records the mountGeneration at
  // the time initSession was called for that session ID. Lets setMessages detect
  // stale closures from a destroyed-and-recreated session.
  const mountGenerationMapRef = useRef<Map<string, number>>(new Map());

  // ---------------------------------------------------------------------------
  // Store write actions
  // ---------------------------------------------------------------------------

  const {
    setMessages,
    setInput,
    setStatus,
    setError,
    setSessionBusy,
    setSessionStatus,
    setEstimatedTokens,
    setStreamStartTime,
    setIsTextStreaming,
    setRateLimitRetryAfter,
    setIsRateLimited,
    setSystemStatusWithClear,
    setPromptSuggestions,
    setPresenceInfo,
    setPresenceTasks,
  } = useSessionStoreActions(sid, isAliveRef, mountGenerationMapRef);

  // ---------------------------------------------------------------------------
  // Session initialisation
  // ---------------------------------------------------------------------------

  // Eagerly call initSession during render — it's a no-op (no set()) when the
  // session already exists. For brand-new sessions this is still safe because
  // the store is external to the React tree (Zustand), so the setState doesn't
  // trigger re-render of a *different* component.
  if (sid) useSessionChatStore.getState().initSession(sid);
  if (sid) {
    const gen = useSessionChatStore.getState().getSession(sid).mountGeneration;
    if (!mountGenerationMapRef.current.has(sid)) {
      mountGenerationMapRef.current.set(sid, gen);
    }
  }

  // Re-init, capture mountGeneration, and touch access order when the active
  // session changes. initSession is idempotent; touchSession updates LRU order.
  useEffect(() => {
    if (sessionId) {
      useSessionChatStore.getState().initSession(sessionId);
      useSessionChatStore.getState().touchSession(sessionId);
      mountGenerationMapRef.current.set(
        sessionId,
        useSessionChatStore.getState().getSession(sessionId).mountGeneration
      );
    }
  }, [sessionId]);

  // Clear background activity indicator when this session becomes active.
  useEffect(() => {
    if (sessionId) {
      useSessionChatStore.getState().updateSession(sessionId, { hasUnseenActivity: false });
    }
  }, [sessionId]);

  // ---------------------------------------------------------------------------
  // History, sync, and presence
  // ---------------------------------------------------------------------------

  const { historyQuery, syncConnectionState, syncFailedAttempts } = useSessionHistory({
    sessionId,
    sid,
    transport,
    selectedCwd,
    enableCrossClientSync,
    enableMessagePolling,
    isStreaming: status === 'streaming',
    presenceInfo,
    setMessages,
    setPresenceTasks,
    setPresenceInfo,
    queryClient,
  });

  // ---------------------------------------------------------------------------
  // Submission
  // ---------------------------------------------------------------------------

  const { handleSubmit, submitContent, stop, retryMessage, markToolCallResponded } =
    useSessionSubmit({
      sessionId,
      input,
      status,
      transport,
      queryClient,
      selectedCwd,
      onTaskEvent: options.onTaskEvent,
      onSessionIdChange: options.onSessionIdChange,
      onStreamingDone: options.onStreamingDone,
      transformContent: options.transformContent,
      setMessages,
      setInput,
      setError,
      setStatus,
      setSessionBusy,
      setSessionStatus,
      setEstimatedTokens,
      setStreamStartTime,
      setIsTextStreaming,
      setRateLimitRetryAfter,
      setIsRateLimited,
      setSystemStatus: setSystemStatusWithClear,
      setPromptSuggestions,
    });

  // ---------------------------------------------------------------------------
  // Derived values
  // ---------------------------------------------------------------------------

  // Only show loading when there are no local messages to display.
  // During session ID remap (clientId → sdkId) messages are preserved in local
  // state but the query key changes, causing isLoading to briefly be true.
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
    presenceTasks,
    syncConnectionState,
    syncFailedAttempts,
  };
}
