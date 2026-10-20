/**
 * A session's work, turn by turn (DOR-3075): what the Work tab lists, and when
 * each turn began, which the line under a DM's reply reads its time from.
 *
 * @module widgets/session/lib/work-turns
 */
import type { ChatMessage } from '@/layers/shared/model';
import { formatDuration } from '@/layers/shared/lib';
import { hasWork } from '@/layers/features/chat';

/** One turn of a session: the words that opened it and the replies to them. */
export interface WorkTurn {
  /** Stable within the transcript: the first reply's id. */
  key: string;
  /** The words that opened the turn, or `null` for a turn nobody typed. */
  prompt: string | null;
  /** When the turn opened (ISO 8601), or `null` when no record says. */
  startedAt: string | null;
  /** Its replies that did any work, oldest first. */
  replies: ChatMessage[];
  /** Whether the turn is running now. */
  live: boolean;
}

/**
 * Whether a message is words a person (or another chat) sent, opening a turn.
 * A staged note, a compaction, a local command's output and the client's own
 * stop lines and notes are not.
 */
function opensTurn(message: ChatMessage): boolean {
  return (
    message.role === 'user' &&
    !message._stagedContext &&
    !message._chatStop &&
    !message._directNote &&
    message.messageType !== 'compaction' &&
    message.messageType !== 'local_command_output'
  );
}

/**
 * Group a transcript into turns, keeping only the turns that did work.
 *
 * @param messages - The transcript, oldest first.
 */
export function buildWorkTurns(messages: readonly ChatMessage[]): WorkTurn[] {
  const turns: WorkTurn[] = [];
  let prompt: string | null = null;
  let startedAt: string | null = null;
  let current: WorkTurn | null = null;
  for (const message of messages) {
    if (opensTurn(message)) {
      prompt = message.content.trim() || null;
      startedAt = message.timestamp || null;
      current = null;
      continue;
    }
    if (message.role !== 'assistant' || !hasWork(message.parts ?? [])) continue;
    if (current === null) {
      current = { key: message.id, prompt, startedAt, replies: [], live: false };
      turns.push(current);
    }
    current.replies.push(message);
    if (message._streaming) current.live = true;
  }
  return turns;
}

/**
 * When each reply's turn opened, by reply id: the time of the words it
 * answers. A reply with no such record is left out.
 *
 * @param messages - The transcript, oldest first.
 */
export function turnStartsByReply(messages: readonly ChatMessage[]): Map<string, string> {
  const starts = new Map<string, string>();
  let startedAt: string | null = null;
  for (const message of messages) {
    if (opensTurn(message)) startedAt = message.timestamp || null;
    else if (message.role === 'assistant' && startedAt) starts.set(message.id, startedAt);
  }
  return starts;
}

/**
 * How long a turn took, worded for the line under a reply: from the words
 * that opened it to the reply's own time, which is when its turn was saved.
 * `null` when either time is missing or they do not make sense together,
 * rather than a number that is not true.
 *
 * @param startedAt - When the turn opened (ISO 8601).
 * @param repliedAt - The reply's time (ISO 8601).
 */
export function turnDuration(
  startedAt: string | undefined,
  repliedAt: string | undefined
): string | null {
  if (!startedAt || !repliedAt) return null;
  const ms = Date.parse(repliedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return formatDuration(ms);
}

/**
 * The reply still being written, by id, or `null` when no turn is running.
 *
 * The newest in-progress reply, as long as everything after it is in progress
 * too: right after a steer, before the new segment has said anything, the
 * steer is the only thing after it and the turn is still running, so the reply
 * before it is still the live one. Once the new segment arrives it takes over.
 *
 * @param messages - The transcript, oldest first.
 */
export function liveReplyId(messages: readonly ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (!message._streaming) return null;
    if (message.role === 'assistant') return message.id;
  }
  return null;
}
