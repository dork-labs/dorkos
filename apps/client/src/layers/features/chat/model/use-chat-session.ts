import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAppStore } from '@/layers/shared/model';
import { useTransport } from '@/layers/shared/model';
import {
  useSessionChatStore,
  useSessionChatState,
  useSessionListStore,
  useSessionStreamConnection,
  selectRenderedStatus,
} from '@/layers/entities/session';
import { useSessionStoreActions } from './use-session-store-actions';
import { useSessionHistory } from './use-session-history';
import { useSessionSubmit } from './use-session-submit';
import { useAutoKickoff } from './kickoff/use-auto-kickoff';
import { useNativeCommands } from './native-commands';
import { useSessionStream, useSessionRekeyRedirect } from './use-session-stream';
import { useStreamTiming } from './use-stream-timing';
import { useTodoEvents } from './use-todo-events';
import { useSystemStatusEvents } from './use-system-status-events';
import { useTurnEndReconcile } from './use-turn-end-reconcile';
import { selectRenderedMessages } from './stream/derive-rendered-state';
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

/** Orchestrates chat session state, message history, SSE streaming, and optimistic UI updates. */
export function useChatSession(sessionId: string | null, options: ChatSessionOptions = {}) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const selectedCwd = useAppStore((s) => s.selectedCwd);
  const enableMessagePolling = useAppStore((s) => s.enableMessagePolling);
  // The status bar's pre-launch billing pick, read from the shared store rather
  // than passed down like `launchRuntime`: the runtime hint rides the URL, and
  // this one deliberately does not (a shareable link must not decide whose
  // subscription a turn spends), so the store is the only channel it has.
  //
  // It is spent only by the session it was made in — see the `sessionId` match
  // where it is handed on. The store outlives the menu that took the choice, so
  // sending whatever happens to be in it would let a pick made on an abandoned
  // draft bill the next conversation.
  const pendingAccount = useAppStore((s) => s.pendingAccount);
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
    sessionStatus,
    systemStatus,
    operationProgress,
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

  // Seed the generation for this session. A layout effect rather than render,
  // because render may not touch refs — and the first one this hook declares, so
  // it lands ahead of every effect this component owns and every passive effect
  // anywhere. It is NOT ahead of a descendant's layout effect, which React runs
  // child-first; the guard fails open there, since `setMessages` skips the
  // generation check entirely when the map has no entry for the session yet.
  useLayoutEffect(() => {
    if (!sid) return;
    if (mountGenerationMapRef.current.has(sid)) return;
    mountGenerationMapRef.current.set(
      sid,
      useSessionChatStore.getState().getSession(sid).mountGeneration
    );
  }, [sid]);

  // ---------------------------------------------------------------------------
  // Store write actions
  // ---------------------------------------------------------------------------

  const { setMessages, setInput, setError, setSystemStatus, setOperationProgress } =
    useSessionStoreActions(sid, isAliveRef, mountGenerationMapRef);

  // Drive the status strip's operation-progress (compaction) and hook-flash
  // states from the projected turn — the legacy in-band producers were retired
  // (DOR-110 operation_progress, DOR-118/DOR-125).
  useSystemStatusEvents(
    sessionId,
    streamState.inProgressTurn,
    setOperationProgress,
    setSystemStatus
  );

  // ---------------------------------------------------------------------------
  // Session initialisation
  // ---------------------------------------------------------------------------

  // Eagerly call initSession during render — it's a no-op (no set()) when the
  // session already exists. For brand-new sessions this is still safe because
  // the store is external to the React tree (Zustand), so the setState doesn't
  // trigger re-render of a *different* component.
  if (sid) useSessionChatStore.getState().initSession(sid);

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

  // Client-side command intents (DOR-109) — the single recognition point for
  // /rename, /clear, /context (run locally, never reach the runtime) and the
  // runtime-fulfilled /compact (dispatched via the transport). /clear's
  // navigation and /compact's runtime support are injected by the host (ChatPanel
  // owns the router + the session's runtime) so this orchestrator stays
  // router-free.
  const native = useNativeCommands(selectedCwd, sessionId, {
    startFreshSession: options.startFreshSession,
    compact: options.compactIntent,
  });

  const {
    handleSubmit,
    submitContent,
    enqueueContent,
    steerContent,
    addContextContent,
    stop,
    retryMessage,
    submitKickoff,
    markToolCallResponded,
  } = useSessionSubmit({
    sessionId,
    input,
    status,
    transport,
    queryClient,
    selectedCwd,
    onSessionIdChangeReplace: options.onSessionIdChangeReplace,
    transformContent: options.transformContent,
    launchRuntime: options.launchRuntime,
    launchAccount: pendingAccount?.sessionId === sid ? pendingAccount.id : null,
    takeSeedContext: options.takeSeedContext,
    setInput,
    setError,
    tryNativeCommand: native.tryRun,
  });

  // Whether the durable stream snapshot has landed for this session. Gates the
  // kickoff mid-stream failure flip AND the first-light waking state (both must
  // wait until an empty session is confirmed real, not merely un-rehydrated).
  const hydrated = streamState.streamReadyCursor !== null;

  // The agent speaks first (M4): a freshly created agent's session opens with an
  // auto-triggered greeting. No-op for every session without a pending birth.
  // `cwd` lets a fresh session claim a birth recorded by a create that never
  // navigated (onboarding) — the hello lands on the agent's real first session.
  // Adapt the kickoff's `(content, cwd)` shape to submitContent's opts, so a
  // `first-message` birth also runs its first turn in the agent's directory.
  // Memoized so it keeps a stable identity — it sits in useAutoKickoff's effect
  // deps, and a fresh function each render would re-run that effect on every
  // mid-stream token update (harmless given the fire-once guards, but it makes
  // the dependency list meaningless).
  const submitFirstMessage = useCallback(
    (content: string, cwd?: string) => submitContent(content, cwd ? { cwd } : undefined),
    [submitContent]
  );

  useAutoKickoff({
    sessionId,
    cwd: selectedCwd,
    status,
    messages,
    hydrated,
    submitKickoff,
    submitContent: submitFirstMessage,
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
    enqueueContent,
    steerContent,
    addContextContent,
    status,
    error,
    stop,
    retryMessage,
    isLoadingHistory,
    hydrated,
    sessionStatus,
    streamStartTime,
    estimatedTokens,
    isTextStreaming,
    isWaitingForUser,
    waitingType,
    activeInteraction,
    pendingInteractions,
    markToolCallResponded,
    systemStatus,
    operationProgress,
    promptSuggestions,
    syncConnectionState,
    // Exposed so the queue path (useChatQueue) can intercept native commands at
    // the queue decision — they must run instantly, never sit in the queue.
    tryNativeCommand: native.tryRun,
    // True while a dispatched command is still settling. The composer keeps its
    // text across that window on purpose, so both submit paths must close or a
    // second Enter turns one intent into two triggers.
    commandPending: native.commandPending,
  };
}
