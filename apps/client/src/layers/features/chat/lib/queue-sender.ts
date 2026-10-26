/**
 * Who sent a queued message that came from another chat, and the words the
 * queue says about it (DOR-3060; designer copy). Pure, so every rule is a
 * table test.
 *
 * A queued row from another agent must never read as the person's own words,
 * so the row names the agent and the chat it came from, and the header counts
 * who sent what.
 *
 * @module features/chat/lib/queue-sender
 */
import type { QueuedMessage } from '@dorkos/shared/schemas';

/** The agent and chat a queued message came from. */
export interface QueueSender {
  /** The sending agent's name. */
  agentName: string;
  /** Its Mesh id, for its face, when Mesh knew it. */
  agentId?: string;
  /** The chat it was sent from: what the title links to. */
  chatId: string;
  /** That chat's title. Absent when it could not be read: the row says "can't open". */
  chatTitle?: string;
}

/** The name an unknown sender is shown under. */
export const UNKNOWN_SENDER = 'Another chat';

/**
 * The sender of a queued message from another chat, or `null` when it cannot
 * be named (a row written before senders were recorded).
 *
 * @param fromChats - The message's `fromChats`, when the server sent any.
 */
export function queueSenderOf(fromChats: QueuedMessage['fromChats']): QueueSender | null {
  const first = fromChats?.[0];
  if (!first || first.legacy) return null;
  const { agentName, agentId, chatId, chatTitle } = first.from;
  return {
    agentName,
    chatId,
    ...(agentId ? { agentId } : {}),
    ...(chatTitle ? { chatTitle } : {}),
  };
}

/** What the header counts: who sent each queued message. */
export interface QueueHeaderRow {
  /** True when another chat sent it. */
  fromChat: boolean;
  /** Its sender, or `null` for an unknown one. */
  sender?: QueueSender | null;
}

/**
 * The queue header's count. Only the person's own: "Queued (2)". Only agents:
 * "1 from Security", or "3 from Security and 2 others" across three or more
 * senders. Mixed: "2 queued · 1 yours, 1 from Security".
 *
 * @param rows - The queued messages, in order.
 */
export function queueHeaderCount(rows: readonly QueueHeaderRow[]): string {
  const agentRows = rows.filter((row) => row.fromChat);
  if (agentRows.length === 0) return `Queued (${rows.length})`;
  const bySender = new Map<string, number>();
  for (const row of agentRows) {
    const name = row.sender?.agentName ?? UNKNOWN_SENDER;
    bySender.set(name, (bySender.get(name) ?? 0) + 1);
  }
  const [top, topCount] = [...bySender].sort((a, b) => b[1] - a[1])[0]!;
  const others = bySender.size - 1;
  const agents = `${topCount} from ${top}${others > 0 ? ` and ${others} other${others === 1 ? '' : 's'}` : ''}`;
  const yours = rows.length - agentRows.length;
  return yours === 0 ? agents : `${rows.length} queued · ${yours} yours, ${agents}`;
}
