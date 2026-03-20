/**
 * Pure helpers for mapping history messages and reconciling tagged (streaming)
 * messages with server-confirmed history.
 *
 * Extracted from `use-chat-session.ts` to keep the hook under the file-size
 * threshold and to allow unit testing without React context.
 *
 * @module features/chat/model/stream-history-helpers
 */
import type { HistoryMessage, MessagePart } from '@dorkos/shared/types';
import type { ChatMessage } from './chat-types';
import { deriveFromParts } from './stream-event-helpers';

/** Map a server `HistoryMessage` to the client `ChatMessage` format. */
export function mapHistoryMessage(m: HistoryMessage): ChatMessage {
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

/**
 * Reconcile tagged (optimistic) messages with server history.
 *
 * Tagged messages are client-side placeholders created during streaming
 * (`_streaming: true`). When server history arrives, this function:
 *
 * 1. Matches the tagged user message by exact content.
 * 2. Matches the tagged assistant message by position (immediately after the
 *    matched user), carrying over client-only subagent parts.
 * 3. Appends any remaining new server messages.
 *
 * Each match emits a `setMessages` updater; the caller collects and applies
 * them in order.
 */
export function reconcileTaggedMessages(
  currentMessages: ChatMessage[],
  history: HistoryMessage[],
  setMessages: (fn: (prev: ChatMessage[]) => ChatMessage[]) => void
): void {
  const currentIds = new Set(currentMessages.map((m) => m.id));
  const taggedMessages = currentMessages.filter((m) => m._streaming);

  const taggedUser = taggedMessages.find((m) => m.role === 'user');
  const taggedAssistant = taggedMessages.find((m) => m.role === 'assistant');

  const newMessages: HistoryMessage[] = [];
  let matchedUserIdx = -1;

  for (let i = 0; i < history.length; i++) {
    const serverMsg = history[i];
    if (currentIds.has(serverMsg.id)) continue;

    // Try to match tagged user message by exact content
    if (taggedUser && serverMsg.role === 'user' && serverMsg.content === taggedUser.content) {
      matchedUserIdx = i;
      // Replace tagged user with server version, clear tag
      setMessages((prev) =>
        prev.map((m) =>
          m.id === taggedUser.id ? { ...mapHistoryMessage(serverMsg), _streaming: false } : m
        )
      );
      continue;
    }

    // Match tagged assistant by position (immediately after matched user)
    if (
      taggedAssistant &&
      matchedUserIdx >= 0 &&
      i === matchedUserIdx + 1 &&
      serverMsg.role === 'assistant'
    ) {
      // Carry over subagent parts not already in the server response (the
      // transcript parser may or may not extract them depending on SDK version).
      const serverMapped = mapHistoryMessage(serverMsg);
      const serverSubagentIds = new Set(
        serverMapped.parts.filter((p) => p.type === 'subagent').map((p) => p.taskId)
      );
      const clientOnlyParts = taggedAssistant.parts.filter(
        (p) => p.type === 'subagent' && !serverSubagentIds.has(p.taskId)
      );
      const mergedParts =
        clientOnlyParts.length > 0
          ? [...serverMapped.parts, ...clientOnlyParts]
          : serverMapped.parts;

      setMessages((prev) =>
        prev.map((m) =>
          m.id === taggedAssistant.id
            ? { ...serverMapped, parts: mergedParts, _streaming: false }
            : m
        )
      );
      continue;
    }

    // No match — append as new message (existing behavior)
    newMessages.push(serverMsg);
  }

  if (newMessages.length > 0) {
    setMessages((prev) => [...prev, ...newMessages.map(mapHistoryMessage)]);
  }
}
