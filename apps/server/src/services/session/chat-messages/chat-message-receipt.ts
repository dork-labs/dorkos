import type { ChatMessageStatus } from '@dorkos/shared/chat-messages';
import { agentPause } from '../../mesh/pause/agent-pause.js';
import type { ChatSendReceipt } from './chat-message-service.js';

/**
 * Say that an accepted queued message waits for the target's pause to lift.
 *
 * @param options - The accepted message's destination and delivery status
 */
export function pausedChatMessageNote(options: {
  status: ChatMessageStatus;
  chatId: string;
  cwd?: string;
  agentPath?: string;
}): string | undefined {
  if (options.status !== 'queued') return undefined;
  const paused = agentPause()?.pausedAgentOfSession(
    options.chatId,
    () => options.cwd,
    options.agentPath ? { forAgent: options.agentPath } : undefined
  );
  return paused
    ? `${paused.name} is paused. Your message is held and runs once it's resumed.`
    : undefined;
}

/**
 * Add the scheduled-reply redirect without losing the delivery's waiting note.
 *
 * @param receipt - The message's delivery receipt
 * @param asker - The agent whose direct chat now holds the answer
 */
export function redirectedChatReceipt(receipt: ChatSendReceipt, asker: string): ChatSendReceipt {
  const redirect =
    `That chat was a scheduled run, so your answer went to ${asker}'s direct chat ` +
    'with you, where it will see it.';
  return { ...receipt, note: [receipt.note, redirect].filter(Boolean).join(' ') };
}
