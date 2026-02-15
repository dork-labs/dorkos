import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { TextDelta, ToolCallEvent, ApprovalEvent, QuestionPromptEvent, ErrorEvent, SessionStatusEvent, QuestionItem, TaskUpdateEvent, MessagePart, HistoryMessage } from '@dorkos/shared/types';
import { useTransport, useAppStore } from '@/layers/shared/model';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: ToolCallState[];
  parts: MessagePart[];
  timestamp: string;
  messageType?: 'command' | 'compaction';
  commandName?: string;
  commandArgs?: string;
}

export type GroupPosition = 'only' | 'first' | 'middle' | 'last';

export interface MessageGrouping {
  position: GroupPosition;
  groupIndex: number;
}

export interface ToolCallState {
  toolCallId: string;
  toolName: string;
  input: string;
  result?: string;
  status: 'pending' | 'running' | 'complete' | 'error';
  /** Set when this tool call requires interactive UI (approval or question) */
  interactiveType?: 'approval' | 'question';
  /** Question data when interactiveType is 'question' */
  questions?: QuestionItem[];
  /** Submitted answers (present when restored from history) */
  answers?: Record<string, string>;
}

type ChatStatus = 'idle' | 'streaming' | 'error';

interface ChatSessionOptions {
  /** Transform message content before sending to server (e.g., prepend context) */
  transformContent?: (content: string) => string | Promise<string>;
  /** Called when a task_update event is received during streaming */
  onTaskEvent?: (event: TaskUpdateEvent) => void;
  /** Called when the SDK assigns a different session ID (e.g., first message in a new session) */
  onSessionIdChange?: (newSessionId: string) => void;
  /** Called when streaming completes after 3+ seconds (for notification sound) */
  onStreamingDone?: () => void;
}

/** Derive flat content and toolCalls from parts for backward compat */
function deriveFromParts(parts: MessagePart[]): { content: string; toolCalls: ToolCallState[] } {
  const textSegments: string[] = [];
  const toolCalls: ToolCallState[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      textSegments.push(part.text);
    } else {
      toolCalls.push({
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input || '',
        result: part.result,
        status: part.status,
        interactiveType: part.interactiveType,
        questions: part.questions,
        answers: part.answers,
      });
    }
  }
  return { content: textSegments.join('\n'), toolCalls };
}

/** Map HistoryMessage from server to internal ChatMessage format */
function mapHistoryMessage(m: HistoryMessage): ChatMessage {
  // Build parts from history: use server-provided parts if available, else synthesize
  const parts: MessagePart[] = m.parts ? [...m.parts] : [];
  if (parts.length === 0) {
    // Synthesize parts from flat content + toolCalls (backward compat)
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
          ...(tc.questions ? {
            interactiveType: 'question' as const,
            questions: tc.questions,
            answers: tc.answers,
          } : {}),
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
  const [status, setStatus] = useState<ChatStatus>('idle');
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
  // Track whether text deltas are actively flowing (for cursor visibility)
  const textStreamingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTextStreamingRef = useRef(false);
  const [isTextStreaming, setIsTextStreaming] = useState(false);
  // Timer ref for sessionBusy auto-clear (cleanup on unmount)
  const sessionBusyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Ref for selectedCwd to avoid stale closures in EventSource handler
  const selectedCwdRef = useRef(selectedCwd);
  // Track tab visibility for adaptive polling
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

  // Determine if we're actively streaming
  const isStreaming = status === 'streaming';

  // Load message history from SDK transcript via TanStack Query with adaptive polling
  const historyQuery = useQuery({
    queryKey: ['messages', sessionId, selectedCwd],
    queryFn: () => transport.getMessages(sessionId, selectedCwd ?? undefined),
    staleTime: 0, // Always check for updates (ETag handles efficiency)
    refetchOnWindowFocus: false,
    // Adaptive polling: 3s when visible, 10s when hidden, disabled while streaming
    refetchInterval: () => {
      if (isStreaming) return false; // No polling during active stream
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

    // Initial seed: replace messages state
    if (!historySeededRef.current && history.length > 0) {
      historySeededRef.current = true;
      setMessages(history.map(mapHistoryMessage));
      return;
    }

    // Subsequent polls: merge new messages (append-only)
    if (historySeededRef.current && !isStreaming) {
      const currentMessages = messagesRef.current;
      const newMessages = history.slice(currentMessages.length);

      if (newMessages.length > 0) {
        setMessages(prev => [...prev, ...newMessages.map(mapHistoryMessage)]);
      }
    }
  }, [historyQuery.data, isStreaming]);

  // EventSource subscription for real-time sync updates
  useEffect(() => {
    if (!sessionId || isStreaming) return;

    // Construct EventSource URL for persistent SSE stream
    const url = `/api/sessions/${sessionId}/stream`;
    const eventSource = new EventSource(url);

    eventSource.addEventListener('sync_update', () => {
      // Use ref to avoid stale closure when selectedCwd changes
      queryClient.invalidateQueries({ queryKey: ['messages', sessionId, selectedCwdRef.current] });
      queryClient.invalidateQueries({ queryKey: ['tasks', sessionId, selectedCwdRef.current] });
    });

    eventSource.addEventListener('sync_connected', () => {
      // Optional: track connection status (currently no-op)
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

    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setStatus('streaming');
    setError(null);
    currentPartsRef.current = [];
    // Start inference timer immediately so it counts during tool calls too
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

      await transport.sendMessage(
        sessionId,
        finalContent,
        (event) => handleStreamEvent(event.type, event.data, assistantIdRef.current),
        abortController.signal,
        selectedCwd ?? undefined,
      );

      setStatus('idle');
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        // Check for SESSION_LOCKED error (409 conflict)
        if ((err as { code?: string }).code === 'SESSION_LOCKED') {
          setSessionBusy(true);
          setInput(userMessage.content); // Restore user's input so they can retry
          // Auto-clear busy state after 5 seconds (with cleanup)
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
      // Clean up text streaming state on any exit
      if (textStreamingTimerRef.current) clearTimeout(textStreamingTimerRef.current);
      isTextStreamingRef.current = false;
      setIsTextStreaming(false);
    }
  }, [input, status, sessionId]);

  function handleStreamEvent(type: string, data: unknown, assistantId: string) {
    switch (type) {
      case 'text_delta': {
        const { text } = data as TextDelta;
        const parts = currentPartsRef.current;
        const lastPart = parts[parts.length - 1];
        if (lastPart && lastPart.type === 'text') {
          lastPart.text += text;
        } else {
          parts.push({ type: 'text', text });
        }
        // Inference indicator: accumulate token estimate from text deltas
        estimatedTokensRef.current += text.length / 4;
        setEstimatedTokens(estimatedTokensRef.current);
        // Track active text generation for cursor visibility
        if (!isTextStreamingRef.current) {
          isTextStreamingRef.current = true;
          setIsTextStreaming(true);
        }
        if (textStreamingTimerRef.current) clearTimeout(textStreamingTimerRef.current);
        textStreamingTimerRef.current = setTimeout(() => {
          isTextStreamingRef.current = false;
          setIsTextStreaming(false);
        }, 500);
        updateAssistantMessage(assistantId);
        break;
      }
      case 'tool_call_start': {
        const tc = data as ToolCallEvent;
        currentPartsRef.current.push({
          type: 'tool_call',
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: '',
          status: 'running',
        });
        updateAssistantMessage(assistantId);
        break;
      }
      case 'tool_call_delta': {
        const tc = data as ToolCallEvent;
        const existing = findToolCallPart(tc.toolCallId);
        if (existing && tc.input) {
          existing.input = (existing.input || '') + tc.input;
        }
        updateAssistantMessage(assistantId);
        break;
      }
      case 'tool_call_end': {
        const tc = data as ToolCallEvent;
        const existing = findToolCallPart(tc.toolCallId);
        if (existing) {
          existing.status = 'complete';
        }
        updateAssistantMessage(assistantId);
        break;
      }
      case 'tool_result': {
        const tc = data as ToolCallEvent;
        const existing = findToolCallPart(tc.toolCallId);
        if (existing) {
          existing.result = tc.result;
          existing.status = 'complete';
          // Mark AskUserQuestion as answered so QuestionPrompt shows collapsed on remount
          if (existing.interactiveType === 'question' && !existing.answers) {
            existing.answers = {};
          }
        }
        updateAssistantMessage(assistantId);
        break;
      }
      case 'approval_required': {
        const approval = data as ApprovalEvent;
        // Update existing part (created by tool_call_start) instead of duplicating
        const existingA = findToolCallPart(approval.toolCallId);
        if (existingA) {
          existingA.interactiveType = 'approval';
          existingA.input = approval.input;
          existingA.status = 'pending';
        } else {
          currentPartsRef.current.push({
            type: 'tool_call',
            toolCallId: approval.toolCallId,
            toolName: approval.toolName,
            input: approval.input,
            status: 'pending',
            interactiveType: 'approval',
          });
        }
        updateAssistantMessage(assistantId);
        break;
      }
      case 'question_prompt': {
        const question = data as QuestionPromptEvent;
        // Update existing part (created by tool_call_start) instead of duplicating
        const existingQ = findToolCallPart(question.toolCallId);
        if (existingQ) {
          existingQ.interactiveType = 'question';
          existingQ.questions = question.questions;
          existingQ.status = 'pending';
        } else {
          currentPartsRef.current.push({
            type: 'tool_call',
            toolCallId: question.toolCallId,
            toolName: 'AskUserQuestion',
            input: '',
            status: 'pending',
            interactiveType: 'question',
            questions: question.questions,
          });
        }
        updateAssistantMessage(assistantId);
        break;
      }
      case 'error': {
        const { message } = data as ErrorEvent;
        setError(message);
        setStatus('error');
        break;
      }
      case 'session_status': {
        const incoming = data as SessionStatusEvent;
        // Merge into accumulated status so values persist across events
        const merged: SessionStatusEvent = {
          ...sessionStatusRef.current,
          ...incoming,
          // Only overwrite fields that are actually present in the incoming event
          model: incoming.model ?? sessionStatusRef.current?.model,
          costUsd: incoming.costUsd ?? sessionStatusRef.current?.costUsd,
          contextTokens: incoming.contextTokens ?? sessionStatusRef.current?.contextTokens,
          contextMaxTokens: incoming.contextMaxTokens ?? sessionStatusRef.current?.contextMaxTokens,
        };
        sessionStatusRef.current = merged;
        setSessionStatus(merged);
        break;
      }
      case 'task_update': {
        const taskEvent = data as TaskUpdateEvent;
        options.onTaskEvent?.(taskEvent);
        break;
      }
      case 'done': {
        const doneData = data as { sessionId?: string };
        if (doneData.sessionId && doneData.sessionId !== sessionId) {
          options.onSessionIdChange?.(doneData.sessionId);
        }
        // Play notification sound if response took 3+ seconds
        if (streamStartTimeRef.current) {
          const elapsed = Date.now() - streamStartTimeRef.current;
          if (elapsed >= 3000) {
            options.onStreamingDone?.();
          }
        }
        // Reset inference indicator state
        streamStartTimeRef.current = null;
        estimatedTokensRef.current = 0;
        setStreamStartTime(null);
        setEstimatedTokens(0);
        // Reset text streaming cursor state
        if (textStreamingTimerRef.current) clearTimeout(textStreamingTimerRef.current);
        isTextStreamingRef.current = false;
        setIsTextStreaming(false);
        setStatus('idle');
        break;
      }
    }
  }

  function findToolCallPart(toolCallId: string) {
    for (let i = currentPartsRef.current.length - 1; i >= 0; i--) {
      const part = currentPartsRef.current[i];
      if (part.type === 'tool_call' && part.toolCallId === toolCallId) {
        return part;
      }
    }
    return undefined;
  }

  function ensureAssistantMessage(assistantId: string) {
    if (!assistantCreatedRef.current) {
      assistantCreatedRef.current = true;
      setMessages(prev => [...prev, {
        id: assistantId,
        role: 'assistant',
        content: '',
        toolCalls: [],
        parts: [],
        timestamp: new Date().toISOString(),
      }]);
    }
  }

  function updateAssistantMessage(assistantId: string) {
    ensureAssistantMessage(assistantId);
    const parts = currentPartsRef.current.map(p => ({ ...p }));
    const derived = deriveFromParts(parts);
    setMessages(prev =>
      prev.map(m =>
        m.id === assistantId
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
      .flatMap(m => m.toolCalls || [])
      .filter(tc => tc.interactiveType && tc.status === 'pending');
  }, [messages]);

  const activeInteraction = pendingInteractions[0] || null;
  const isWaitingForUser = activeInteraction !== null;
  const waitingType = activeInteraction?.interactiveType || null;

  return { messages, input, setInput, handleSubmit, status, error, sessionBusy, stop, isLoadingHistory, sessionStatus, streamStartTime, estimatedTokens, isTextStreaming, isWaitingForUser, waitingType, activeInteraction };
}
