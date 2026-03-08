import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SessionStatusEvent, MessagePart, HistoryMessage, TaskUpdateEvent } from '@dorkos/shared/types';
import { useTransport, useAppStore } from '@/layers/shared/model';
import { useRelayEnabled } from '@/layers/entities/relay';
import { QUERY_TIMING, TIMING } from '@/layers/shared/lib';
import type { ChatMessage, ChatSessionOptions } from './chat-types';
import { createStreamEventHandler, deriveFromParts } from './stream-event-handler';

/**
 * Poll a ref until it becomes true, with a best-effort timeout.
 * Resolves (never rejects) — caller should proceed after timeout.
 *
 * @param ref - Boolean ref to poll
 * @param timeoutMs - Max wait time in milliseconds
 */
function waitForStreamReady(
  ref: React.MutableRefObject<boolean>,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve) => {
    if (ref.current) return resolve();
    const start = Date.now();
    const interval = setInterval(() => {
      if (ref.current) {
        clearInterval(interval);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        resolve(); // Proceed anyway — pending buffer catches early events
      }
    }, 50);
  });
}

// Re-export types for backward compat
export type { ChatMessage, ToolCallState, GroupPosition, MessageGrouping, ChatStatus, ChatSessionOptions } from './chat-types';

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

export function useChatSession(sessionId: string, options: ChatSessionOptions = {}) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const selectedCwd = useAppStore((s) => s.selectedCwd);
  const relayEnabled = useRelayEnabled();
  const clientIdRef = useRef(crypto.randomUUID());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState<'idle' | 'streaming' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
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
  const sessionBusyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stalenessTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedCwdRef = useRef(selectedCwd);
  const [isTabVisible, setIsTabVisible] = useState(!document.hidden);
  const messagesRef = useRef<ChatMessage[]>(messages);

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
  const streamReadyRef = useRef<boolean>(false);
  // Keep status in a ref so the staleness timer async callback sees the current value
  const statusRef = useRef(status);
  useEffect(() => {
    statusRef.current = status;
  });

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

  // Create stream event handler at hook level so it can be shared between
  // handleSubmit (legacy SSE path) and EventSource relay_message listener
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
        setMessages,
        setError,
        setStatus,
        setSessionStatus,
        setEstimatedTokens,
        setStreamStartTime,
        setIsTextStreaming,
        sessionId,
        onTaskEventRef,
        onSessionIdChangeRef,
        onStreamingDoneRef,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Refs are stable; only sessionId drives recreation
    [sessionId]
  );

  // Load message history from SDK transcript via TanStack Query with adaptive polling
  const historyQuery = useQuery({
    queryKey: ['messages', sessionId, selectedCwd],
    queryFn: () => transport.getMessages(sessionId, selectedCwd ?? undefined),
    staleTime: QUERY_TIMING.MESSAGE_STALE_TIME_MS,
    refetchOnWindowFocus: false,
    refetchInterval: () => {
      if (isStreaming || relayEnabled) return false;
      return isTabVisible
        ? QUERY_TIMING.ACTIVE_TAB_REFETCH_MS
        : QUERY_TIMING.BACKGROUND_TAB_REFETCH_MS;
    },
  });

  // Reset history seed flag when session or cwd changes
  useEffect(() => {
    historySeededRef.current = false;
    setMessages([]);
  }, [sessionId, selectedCwd]);

  // Seed local messages state from history (initial load + polling updates)
  useEffect(() => {
    if (!historyQuery.data) return;

    const history = historyQuery.data.messages;

    if (!historySeededRef.current && history.length > 0) {
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

  // Client-side staleness detector (relay path only).
  // Resets on every relay SSE event; fires if stream goes silent for DONE_STALENESS_MS.
  // On expiry, polls transport.getSession() — a successful response means the backend
  // completed but the `done` event was lost. Transitions to idle and refreshes messages.
  // Uses statusRef to read current status without adding it as a dep (avoids timer churn).
  const resetStalenessTimer = useCallback(() => {
    if (!relayEnabled) return;
    if (stalenessTimerRef.current) clearTimeout(stalenessTimerRef.current);
    stalenessTimerRef.current = setTimeout(async () => {
      stalenessTimerRef.current = null;
      // Only act if still streaming — a `done` event may have arrived in the meantime
      if (statusRef.current !== 'streaming') return;
      try {
        await transport.getSession(sessionId, selectedCwdRef.current ?? undefined);
        // Successful response: backend session exists and is no longer actively streaming.
        // Transition to idle and refresh message history.
        setStatus('idle');
        queryClient.invalidateQueries({ queryKey: ['messages', sessionId, selectedCwdRef.current] });
      } catch {
        // Session not found or network error — leave streaming state unchanged
      }
    }, TIMING.DONE_STALENESS_MS);
  }, [relayEnabled, sessionId, transport, queryClient]);

  // Relay-path EventSource: stable, never torn down by isStreaming changes.
  // Only recreated when sessionId or relayEnabled changes.
  // Response chunks arrive as relay_message events on this SSE connection.
  useEffect(() => {
    if (!sessionId || !relayEnabled) return;

    const params = new URLSearchParams();
    params.set('clientId', clientIdRef.current);
    const url = `/api/sessions/${sessionId}/stream?${params}`;
    const eventSource = new EventSource(url);

    eventSource.addEventListener('stream_ready', () => {
      streamReadyRef.current = true;
    });

    eventSource.addEventListener('relay_message', (event: MessageEvent) => {
      try {
        const envelope = JSON.parse(event.data) as { payload: { type: string; data: unknown } };
        // Reset staleness timer on every relay event — stream is still active
        resetStalenessTimer();
        streamEventHandler(envelope.payload.type, envelope.payload.data, assistantIdRef.current);
      } catch {
        // Ignore parse errors
      }
    });

    eventSource.addEventListener('sync_update', () => {
      // Don't invalidate during streaming — a mid-stream refetch can overwrite
      // the optimistic assistant message with a stale history snapshot, causing
      // tool call status updates to become no-ops (spinner stuck on 'running').
      if (statusRef.current === 'streaming') return;
      queryClient.invalidateQueries({ queryKey: ['messages', sessionId, selectedCwdRef.current] });
      queryClient.invalidateQueries({ queryKey: ['tasks', sessionId, selectedCwdRef.current] });
    });

    eventSource.onerror = () => {
      // EventSource auto-reconnects; reset ready state so we re-handshake
      streamReadyRef.current = false;
    };

    return () => {
      eventSource.close();
      streamReadyRef.current = false;
      if (stalenessTimerRef.current) {
        clearTimeout(stalenessTimerRef.current);
        stalenessTimerRef.current = null;
      }
    };
  }, [sessionId, relayEnabled, streamEventHandler, queryClient, resetStalenessTimer]);

  // Legacy-path EventSource: closes during streaming since SSE is embedded in POST.
  // No-op when relay is enabled — the relay effect above handles sync updates.
  useEffect(() => {
    if (!sessionId || relayEnabled) return;
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
  }, [sessionId, isStreaming, queryClient, relayEnabled]);

  // Cleanup sessionBusy and staleness timers on unmount
  useEffect(() => {
    return () => {
      if (sessionBusyTimerRef.current) clearTimeout(sessionBusyTimerRef.current);
      if (stalenessTimerRef.current) clearTimeout(stalenessTimerRef.current);
    };
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!input.trim() || status === 'streaming') return;

    const userContent = input.trim();
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: userContent,
      parts: [{ type: 'text', text: userContent }],
      timestamp: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setStatus('streaming');
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
      const finalContent = options.transformContent
        ? await options.transformContent(userMessage.content)
        : userMessage.content;

      if (relayEnabled) {
        // Wait for SSE stream_ready handshake (5s timeout, best-effort).
        // This ensures the relay subscription is active before the POST triggers SDK events.
        if (!streamReadyRef.current) {
          await waitForStreamReady(streamReadyRef, 5000);
        }
        // Relay path: POST returns 202 receipt, response chunks arrive via EventSource
        await transport.sendMessageRelay(sessionId, finalContent, {
          clientId: clientIdRef.current,
        });
        // Start the staleness detector — if the `done` event is lost, this fires after
        // DONE_STALENESS_MS of silence and polls the backend to recover gracefully.
        resetStalenessTimer();
        // Status stays 'streaming' — done event will arrive via EventSource relay_message
      } else {
        // Legacy path: POST streams SSE inline
        await transport.sendMessage(
          sessionId,
          finalContent,
          (event) => streamEventHandler(event.type, event.data, assistantIdRef.current),
          abortController.signal,
          selectedCwd ?? undefined
        );
        setStatus('idle');
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        if ((err as { code?: string }).code === 'SESSION_LOCKED') {
          setSessionBusy(true);
          setInput(userMessage.content);
          if (sessionBusyTimerRef.current) clearTimeout(sessionBusyTimerRef.current);
          sessionBusyTimerRef.current = setTimeout(() => {
            setSessionBusy(false);
            sessionBusyTimerRef.current = null;
          }, TIMING.SESSION_BUSY_CLEAR_MS);
        } else {
          setError((err as Error).message);
        }
        setStatus('error');
      }
      if (textStreamingTimerRef.current) clearTimeout(textStreamingTimerRef.current);
      isTextStreamingRef.current = false;
      setIsTextStreaming(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Intentional: stable refs for transport/options/cwd
  }, [input, status, sessionId, relayEnabled, streamEventHandler]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    if (textStreamingTimerRef.current) clearTimeout(textStreamingTimerRef.current);
    isTextStreamingRef.current = false;
    setIsTextStreaming(false);
    setStatus('idle');
  }, []);

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
  };
}
