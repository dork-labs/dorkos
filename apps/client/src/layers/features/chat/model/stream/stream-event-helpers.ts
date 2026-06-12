/**
 * Pure utilities shared by the stream projection and history reconstruction.
 *
 * @module features/chat/model/stream-event-helpers
 */
import type { MessagePart } from '@dorkos/shared/types';
import type { ToolCallState } from '../chat-types';

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
