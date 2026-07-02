import { useEffect, useMemo, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAppStore } from '@/layers/shared/model';
import { useTransport } from '@/layers/shared/model';
import {
  useSessionChatStore,
  useSessionChatState,
  useSessionListStore,
  useSessionStreamConnection,
} from '@/layers/entities/session';
import { useSessionStoreActions } from './use-session-store-actions';
import { useSessionHistory } from './use-session-history';
import { useSessionSubmit } from './use-session-submit';
import { useNativeCommands } from './native-commands';
import { useSessionStream, useSessionRekeyRedirect } from './use-session-stream';
import { useStreamTiming } from './use-stream-timing';
import { useTodoEvents } from './use-todo-events';
import { useSystemStatusEvents } from './use-system-status-events';
import { useTurnEndReconcile } from './use-turn-end-reconcile';
import { selectRenderedMessages, selectRenderedStatus } from './stream/derive-rendered-state';
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
export { classifyTransportError } from './stream/classify-transport-error';

/** Orchestrates chat session state, message history, SSE streaming, and optimistic UI updates. */
export function useChatSession(sessionId: string | null, options: ChatSessionOptions = {}) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const selectedCwd = useAppStore((s) => s.selectedCwd);
  const enableMessagePolling = useAppStore((s) => s.enableMessagePolling);
  const sid = sessionId ?? '';

  // Single store subscription for all per-session fields.
  // useSessionChatState returns DEFAULT_SESSION_STATE (stable module-level constant)
  // when the session doesn't exist yet — avoiding the new-object-per-render trap that
  // per-field selectors with inline `?? []` / `?? {}` defaults would cause.
  const {
    messages: legacyMessages,
    input,
    status: legacyStatus,
    error,
    sessionBusy,
    sessionStatus,
    isRateLimited,
    rateLimitRetryAfter,
    systemStatus,
    promptSuggestions,
  } = useSessionChatState(sid);

  // Subscribe-first hydration: attach the durable `/events` stream + the global
  // status stream and read this session's server-derived projection from the
  // per-session store (spec chat-stream-reconnection). The render fields below
  // (messages/status/pendingInteractions) come from this projection once it
  // hydrates; until then the legacy chat store provides the instant first paint.
  const streamState = useSessionStream(sessionId, selectedCwd);

  // Late rekey follow-up: when the canonical id resolves only AFTER the trigger
  // 202 (the common Claude path), the server's retire announce rewrites the URL
  // here, the same in-place replace the 202 path performs when it knows the id.
  useSessionRekeyRedirect(sessionId, options.onSessionIdChangeReplace);

  // Connection indicator: sourced from the durable `/events` stream's
  // ConnectionState (StreamManager), replacing the retired sync-stream's
  // connection state. The badge degrades gracefully without a failed-attempt
  // count — the StreamManager owns reconnection/backoff internally.
  const syncConnectionState = useSessionStreamConnection(sid);

  // Server-derived render fields: the projected message list and coarse status
  // come from the hydrated stream store (falling back to the legacy store until
  // the session hydrates). Pending interactions are scanned from the projected
  // messages below, preserving the ToolCallState consumer contract.
  const messages = useMemo(
    () => selectRenderedMessages(streamState, legacyMessages),
    [streamState, legacyMessages]
  );
  const status = selectRenderedStatus(streamState, legacyStatus);

  // Status-strip metrics (elapsed clock, token estimate, typing flag) derived
  // from the projected turn — the legacy in-band writers are gone (CLI-B6).
  const { streamStartTime, estimatedTokens, isTextStreaming } = useStreamTiming(
    sessionId,
    streamState.inProgressTurn,
    status === 'streaming'
  );

  // Forward newly-streamed todo_update events to the task panel + celebrations
  // (the bubble projection correctly skips them — CLI-B4).
  useTodoEvents(
    sessionId,
    streamState.inProgressTurn,
    streamState.streamReadyCursor,
    options.onTaskEvent
  );

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

  const { setMessages, setInput, setError, setSessionBusy, setSystemStatus } =
    useSessionStoreActions(sid, isAliveRef, mountGenerationMapRef);

  // Drive the status strip's "Compacting context…" state from projected
  // system_status events — its legacy in-band producer was retired (DOR-118).
  useSystemStatusEvents(sessionId, streamState.inProgressTurn, setSystemStatus);

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

  // Acknowledge the unseen-activity flag when this session becomes active —
  // the operator is now looking at the background work that settled. The
  // subscription also clears a flag that lands AFTER the switch (a settle
  // frame racing the durable-stream attach can slip past the binding's
  // attached-session guard), so the active session can never hold one.
  useEffect(() => {
    if (!sessionId) return;
    useSessionListStore.getState().clearUnseen(sessionId);
    return useSessionListStore.subscribe((s) => {
      if (s.unseen[sessionId] !== undefined) {
        useSessionListStore.getState().clearUnseen(sessionId);
      }
    });
  }, [sessionId]);

  // ---------------------------------------------------------------------------
  // History, sync, and presence
  // ---------------------------------------------------------------------------

  const { historyQuery } = useSessionHistory({
    sessionId,
    sid,
    transport,
    selectedCwd,
    enableMessagePolling,
    isStreaming: status === 'streaming',
    setMessages,
  });

  // ---------------------------------------------------------------------------
  // Submission
  // ---------------------------------------------------------------------------

  // Native (client-side) chat commands (e.g. /rename) — intercepted in the send
  // funnel so they run locally and never reach the runtime/model.
  const native = useNativeCommands(selectedCwd, sessionId);

  const { handleSubmit, submitContent, stop, retryMessage, markToolCallResponded } =
    useSessionSubmit({
      sessionId,
      input,
      status,
      transport,
      queryClient,
      selectedCwd,
      onSessionIdChangeReplace: options.onSessionIdChangeReplace,
      transformContent: options.transformContent,
      launchRuntime: options.launchRuntime,
      setInput,
      setError,
      setSessionBusy,
      tryNativeCommand: native.tryRun,
    });

  // Turn-end reconciliation: when the active session settles, reload canonical
  // history into the stream store and clear the optimistic user message so the
  // completed turn persists as full-fidelity history (and fire onStreamingDone).
  useTurnEndReconcile({
    sessionId,
    transport,
    selectedCwd,
    streamState,
    queryClient,
    onStreamingDone: options.onStreamingDone,
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
    pendingInteractions,
    markToolCallResponded,
    isRateLimited,
    rateLimitRetryAfter,
    systemStatus,
    promptSuggestions,
    syncConnectionState,
    // Exposed so the queue path (useChatQueue) can intercept native commands at
    // the queue decision — they must run instantly, never sit in the queue.
    tryNativeCommand: native.tryRun,
  };
}
