import { useState, useCallback, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { TextDelta, ToolCallEvent, ApprovalEvent, QuestionPromptEvent, ErrorEvent, SessionStatusEvent, QuestionItem, TaskUpdateEvent, MessagePart } from '@lifeos/shared/types';
import { useTransport } from '../contexts/TransportContext';
import { useAppStore } from '../stores/app-store';

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

export function useChatSession(sessionId: string, options: ChatSessionOptions = {}) {
  const transport = useTransport();
  const selectedCwd = useAppStore((s) => s.selectedCwd);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState<ChatStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const sessionStatusRef = useRef<SessionStatusEvent | null>(null);
  const [sessionStatus, setSessionStatus] = useState<SessionStatusEvent | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const currentPartsRef = useRef<MessagePart[]>([]);
  const historySeededRef = useRef(false);
  const streamStartTimeRef = useRef<number | null>(null);
  const estimatedTokensRef = useRef<number>(0);
  const [streamStartTime, setStreamStartTime] = useState<number | null>(null);
  const [estimatedTokens, setEstimatedTokens] = useState<number>(0);

  // Load message history from SDK transcript via TanStack Query
  const historyQuery = useQuery({
    queryKey: ['messages', sessionId],
    queryFn: () => transport.getMessages(sessionId, selectedCwd ?? undefined),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  // Seed local messages state from history (once per mount)
  useEffect(() => {
    if (historyQuery.data && !historySeededRef.current) {
      historySeededRef.current = true;
      const history = historyQuery.data.messages;
      if (history.length > 0) {
        setMessages(history.map(m => {
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
        }));
      }
    }
  }, [historyQuery.data]);

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

    const assistantId = crypto.randomUUID();
    setMessages(prev => [...prev, {
      id: assistantId,
      role: 'assistant',
      content: '',
      toolCalls: [],
      parts: [],
      timestamp: new Date().toISOString(),
    }]);

    const abortController = new AbortController();
    abortRef.current = abortController;

    try {
      const finalContent = options.transformContent
        ? await options.transformContent(userMessage.content)
        : userMessage.content;

      await transport.sendMessage(
        sessionId,
        finalContent,
        (event) => handleStreamEvent(event.type, event.data, assistantId),
        abortController.signal,
        selectedCwd ?? undefined,
      );

      setStatus('idle');
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError((err as Error).message);
        setStatus('error');
      }
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
        // Reset inference indicator state
        streamStartTimeRef.current = null;
        estimatedTokensRef.current = 0;
        setStreamStartTime(null);
        setEstimatedTokens(0);
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

  function updateAssistantMessage(assistantId: string) {
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
    setStatus('idle');
  }, []);

  const isLoadingHistory = historyQuery.isLoading;

  return { messages, input, setInput, handleSubmit, status, error, stop, isLoadingHistory, sessionStatus, streamStartTime, estimatedTokens };
}
