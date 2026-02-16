import type {
  TextDelta,
  ToolCallEvent,
  ApprovalEvent,
  QuestionPromptEvent,
  ErrorEvent,
  SessionStatusEvent,
  TaskUpdateEvent,
  MessagePart,
} from '@dorkos/shared/types';
import type { ChatMessage, ToolCallState, ChatSessionOptions } from './chat-types';

interface StreamEventDeps {
  currentPartsRef: React.MutableRefObject<MessagePart[]>;
  assistantCreatedRef: React.MutableRefObject<boolean>;
  sessionStatusRef: React.MutableRefObject<SessionStatusEvent | null>;
  streamStartTimeRef: React.MutableRefObject<number | null>;
  estimatedTokensRef: React.MutableRefObject<number>;
  textStreamingTimerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  isTextStreamingRef: React.MutableRefObject<boolean>;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setError: (error: string | null) => void;
  setStatus: (status: 'idle' | 'streaming' | 'error') => void;
  setSessionStatus: (status: SessionStatusEvent | null) => void;
  setEstimatedTokens: (tokens: number) => void;
  setStreamStartTime: (time: number | null) => void;
  setIsTextStreaming: (streaming: boolean) => void;
  sessionId: string;
  options: ChatSessionOptions;
}

/** Derive flat content and toolCalls from parts for backward compat. */
export function deriveFromParts(parts: MessagePart[]): { content: string; toolCalls: ToolCallState[] } {
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

/** Create a stream event handler that processes SSE events into chat messages. */
export function createStreamEventHandler(deps: StreamEventDeps) {
  const {
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
  } = deps;

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
      setMessages((prev) => [
        ...prev,
        {
          id: assistantId,
          role: 'assistant',
          content: '',
          toolCalls: [],
          parts: [],
          timestamp: new Date().toISOString(),
        },
      ]);
    }
  }

  function updateAssistantMessage(assistantId: string) {
    ensureAssistantMessage(assistantId);
    const parts = currentPartsRef.current.map((p) => ({ ...p }));
    const derived = deriveFromParts(parts);
    setMessages((prev) =>
      prev.map((m) =>
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

  return function handleStreamEvent(type: string, data: unknown, assistantId: string) {
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
        estimatedTokensRef.current += text.length / 4;
        setEstimatedTokens(estimatedTokensRef.current);
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
        const merged: SessionStatusEvent = {
          ...sessionStatusRef.current,
          ...incoming,
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
        if (streamStartTimeRef.current) {
          const elapsed = Date.now() - streamStartTimeRef.current;
          if (elapsed >= 3000) {
            options.onStreamingDone?.();
          }
        }
        streamStartTimeRef.current = null;
        estimatedTokensRef.current = 0;
        setStreamStartTime(null);
        setEstimatedTokens(0);
        if (textStreamingTimerRef.current) clearTimeout(textStreamingTimerRef.current);
        isTextStreamingRef.current = false;
        setIsTextStreaming(false);
        setStatus('idle');
        break;
      }
    }
  };
}
