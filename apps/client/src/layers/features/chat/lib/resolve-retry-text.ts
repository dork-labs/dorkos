/**
 * Resolve the text to resend when a transport-level POST failure is retried.
 *
 * @module features/chat/lib/resolve-retry-text
 */
import type { AgentBirthRecord, ChatMessage } from '@/layers/shared/model';

/**
 * The message text to resend on Retry after a failed send.
 *
 * Normally this is the last user message in the transcript. But the onboarding
 * dissolve's first message lives only in a `first-message` birth record — the
 * optimistic user bubble is dropped when the trigger POST fails, so the
 * transcript is empty. Falling back to the record's message keeps Retry from
 * silently losing the sentence the user typed (which would otherwise leave a
 * dead Retry button).
 *
 * @param messages - The rendered transcript.
 * @param birthRecord - The active session's birth record, or null.
 */
export function resolveTransportRetryText(
  messages: ChatMessage[],
  birthRecord: AgentBirthRecord | null
): string | undefined {
  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
  if (lastUserMsg?.content) return lastUserMsg.content;
  if (birthRecord?.kind === 'first-message' && birthRecord.kickoffMessage) {
    return birthRecord.kickoffMessage;
  }
  return undefined;
}
