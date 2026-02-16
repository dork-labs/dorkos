import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SessionStatusEvent, MessagePart, HistoryMessage } from '@dorkos/shared/types';
import { useTransport, useAppStore } from '@/layers/shared/model';
import type { ChatMessage, ChatSessionOptions } from './chat-types';
import { createStreamEventHandler, deriveFromParts } from './stream-event-handler';

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

  // Load message history from SDK transcript via TanStack Query with adaptive polling
  const historyQuery = useQuery({
    queryKey: ['messages', sessionId, selectedCwd],
    queryFn: () => transport.getMessages(sessionId, selectedCwd ?? undefined),
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchInterval: () => {
      if (isStreaming) return false;
      return isTabVisible ? 3000 : 10000;
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
      const currentMessages = messagesRef.current;
      const newMessages = history.slice(currentMessages.length);

      if (newMessages.length > 0) {
        setMessages((prev) => [...prev, ...newMessages.map(mapHistoryMessage)]);
      }
    }
  }, [historyQuery.data, isStreaming]);

  // EventSource subscription for real-time sync updates
  useEffect(() => {
    if (!sessionId || isStreaming) return;

    const url = `/api/sessions/${sessionId}/stream`;
    const eventSource = new EventSource(url);

    eventSource.addEventListener('sync_update', () => {
      queryClient.invalidateQueries({ queryKey: ['messages', sessionId, selectedCwdRef.current] });
      queryClient.invalidateQueries({ queryKey: ['tasks', sessionId, selectedCwdRef.current] });
    });

    eventSource.addEventListener('sync_connected', () => {
      // Optional: track connection status
    });

    return () => {
      eventSource.close();
    };
  }, [sessionId, isStreaming, queryClient]);

  // Cleanup sessionBusy timer on unmount
  useEffect(() => {
    return () => {
      if (sessionBusyTimerRef.current) clearTimeout(sessionBusyTimerRef.current);
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

    const handleStreamEvent = createStreamEventHandler({
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
      options,
    });

    try {
      const finalContent = options.transformContent
        ? await options.transformContent(userMessage.content)
        : userMessage.content;

      await transport.sendMessage(
        sessionId,
        finalContent,
        (event) => handleStreamEvent(event.type, event.data, assistantIdRef.current),
        abortController.signal,
        selectedCwd ?? undefined
      );

      setStatus('idle');
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        if ((err as { code?: string }).code === 'SESSION_LOCKED') {
          setSessionBusy(true);
          setInput(userMessage.content);
          if (sessionBusyTimerRef.current) clearTimeout(sessionBusyTimerRef.current);
          sessionBusyTimerRef.current = setTimeout(() => {
            setSessionBusy(false);
            sessionBusyTimerRef.current = null;
          }, 5000);
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
  }, [input, status, sessionId]);

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
