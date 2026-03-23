/**
 * Pure utilities and helper factory for stream event handling.
 *
 * @module features/chat/model/stream-event-helpers
 */
import type { MessagePart, HookPart } from '@dorkos/shared/types';
import type { ToolCallState } from './chat-types';
import type { StreamEventDeps, StreamHandlerHelpers } from './stream-event-types';

/** Derive flat content and toolCalls from parts for backward compat. */
export function deriveFromParts(parts: MessagePart[]): {
  content: string;
  toolCalls: ToolCallState[];
} {
  const textSegments: string[] = [];
  const toolCalls: ToolCallState[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      textSegments.push(part.text);
    } else if (part.type === 'tool_call') {
      toolCalls.push({
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input || '',
        result: part.result,
        progressOutput: part.progressOutput,
        status: part.status,
        interactiveType: part.interactiveType,
        questions: part.questions,
        answers: part.answers,
        timeoutMs: part.timeoutMs,
        hooks: part.hooks,
        startedAt: part.startedAt,
        completedAt: part.completedAt,
      });
    }
  }
  return { content: textSegments.join('\n'), toolCalls };
}

/** Create finder and message helper functions from deps. */
export function createStreamHelpers(deps: StreamEventDeps): StreamHandlerHelpers {
  const { currentPartsRef, orphanHooksRef, assistantCreatedRef, setMessages } = deps;

  function findToolCallPart(toolCallId: string) {
    for (let i = currentPartsRef.current.length - 1; i >= 0; i--) {
      const part = currentPartsRef.current[i];
      if (part.type === 'tool_call' && part.toolCallId === toolCallId) {
        return part;
      }
    }
    return undefined;
  }

  function findHookById(hookId: string): HookPart | undefined {
    for (let i = currentPartsRef.current.length - 1; i >= 0; i--) {
      const part = currentPartsRef.current[i];
      if (part.type === 'tool_call' && part.hooks) {
        const hook = part.hooks.find((h) => h.hookId === hookId);
        if (hook) return hook;
      }
    }
    return undefined;
  }

  function findSubagentPart(taskId: string) {
    for (let i = currentPartsRef.current.length - 1; i >= 0; i--) {
      const part = currentPartsRef.current[i];
      if (part.type === 'subagent' && part.taskId === taskId) {
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
          _streaming: true,
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

  return {
    findToolCallPart,
    findHookById,
    findSubagentPart,
    updateAssistantMessage,
    currentPartsRef,
    orphanHooksRef,
  };
}
