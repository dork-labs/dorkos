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
        // The pending card in the input zone is built from THIS shape, not from
        // the part, so anything dropped here is invisible on the card a person
        // actually answers — the SDK's context and the countdown alike (DOR-810).
        approvalStartedAt: part.approvalStartedAt,
        approvalRemainingMs: part.approvalRemainingMs,
        approvalParked: part.approvalParked,
        approvalTitle: part.approvalTitle,
        approvalDisplayName: part.approvalDisplayName,
        approvalDescription: part.approvalDescription,
        approvalBlockedPath: part.approvalBlockedPath,
        approvalDecisionReason: part.approvalDecisionReason,
        approvalHasSuggestions: part.approvalHasSuggestions,
        approvalAlwaysAllowScope: part.approvalAlwaysAllowScope,
      });
    }
  }
  return { content: textSegments.join('\n'), toolCalls };
}
