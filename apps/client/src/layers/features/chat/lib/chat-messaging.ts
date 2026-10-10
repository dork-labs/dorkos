/**
 * Reading the chat-messaging tool calls a chat makes (`chat_send`,
 * `session_start`, `chat_stop`) and the messages other chats sent it, for the
 * Sent card, the received message and the "Stopped by" line (spec
 * `spin-off-chats` §6).
 *
 * Pure. The card's live state comes from the server (`GET
 * /api/sessions/:id/chat-messages`); this only reads what the tool call itself
 * already says, so a card has something true to draw before that read lands.
 *
 * @module features/chat/lib/chat-messaging
 */
import {
  messagingToolOf,
  type ChatMessageStamp,
  type ChatStopNotice,
  type SentChatMessage,
} from '@dorkos/shared/chat-messages';
import type { HistoryMessage } from '@dorkos/shared/types';
import type { ChatMessage } from '@/layers/shared/model';

/** A messaging tool call, as far as its own input and result tell. */
export interface MessagingCall {
  /** Which tool. */
  tool: 'chat_send' | 'session_start' | 'chat_stop';
  /** The chat it is addressed to, when the input names one. */
  to?: string;
  /** The words sent, or the first message of a spin-off. */
  message?: string;
  /** The label the agent wrote for the card. */
  summary?: string;
  /** How it was asked to arrive. */
  delivery?: 'queue' | 'steer' | 'interrupt';
  /** Why a chat was stopped, or why a spin-off was started. */
  reason?: string;
  /** The chat message id the server answered with. */
  messageId?: string;
  /** The chat it went to (or the spin-off that started). */
  chatId?: string;
  /** The server's refusal, in its own words. */
  error?: string;
  /** The call is held for a person to approve, and has not run. */
  waiting?: boolean;
  /** A `chat_stop` that found nothing running: nothing was stopped. */
  notRunning?: boolean;
  /** A plain note the server added to its receipt. */
  note?: string;
}

/** Parse JSON, or undefined. */
function parseObject(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** A string field, or undefined. */
function str(obj: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = obj?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The result of a tool call as JSON: MCP results arrive as the JSON text
 * itself, or wrapped in a content array of text blocks.
 */
function resultObject(result: string | undefined): Record<string, unknown> | undefined {
  const direct = parseObject(result);
  if (!direct) return undefined;
  if (Array.isArray(direct.content)) {
    for (const block of direct.content as Array<Record<string, unknown>>) {
      const inner = typeof block?.text === 'string' ? parseObject(block.text) : undefined;
      if (inner) return inner;
    }
  }
  return direct;
}

/**
 * Read a messaging tool call, or null when the call is not one.
 *
 * @param part - The tool call's name, raw input and raw result.
 */
export function readMessagingCall(part: {
  toolName: string;
  input?: string;
  result?: string;
  status?: string;
}): MessagingCall | null {
  const tool = messagingToolOf(part.toolName);
  if (tool !== 'chat_send' && tool !== 'session_start' && tool !== 'chat_stop') return null;
  const input = parseObject(part.input);
  const result = resultObject(part.result);
  const error = refusalOf(part, result);
  const waiting = error === undefined && result?.status === 'approval_required';
  const delivery = str(input, 'delivery');
  return {
    tool,
    ...(str(input, tool === 'chat_stop' ? 'chat' : 'to') !== undefined
      ? { to: str(input, tool === 'chat_stop' ? 'chat' : 'to') }
      : {}),
    ...(str(input, tool === 'session_start' ? 'prompt' : 'message') !== undefined
      ? { message: str(input, tool === 'session_start' ? 'prompt' : 'message') }
      : {}),
    ...(str(input, 'summary') !== undefined ? { summary: str(input, 'summary') } : {}),
    ...(delivery === 'queue' || delivery === 'steer' || delivery === 'interrupt'
      ? { delivery }
      : {}),
    ...(str(input, 'reason') !== undefined ? { reason: str(input, 'reason') } : {}),
    ...(str(result, 'messageId') !== undefined ? { messageId: str(result, 'messageId') } : {}),
    ...((str(result, 'chatId') ?? str(result, 'sessionId')) !== undefined
      ? { chatId: str(result, 'chatId') ?? str(result, 'sessionId') }
      : {}),
    ...(error !== undefined ? { error } : {}),
    ...(waiting ? { waiting } : {}),
    ...(tool === 'chat_stop' && error === undefined && result?.stopped === false
      ? { notRunning: true }
      : {}),
    ...(str(result, 'note') !== undefined ? { note: str(result, 'note') } : {}),
  };
}

/** What a call that did not happen says when it gives no reason of its own. */
const UNSENT_REASON = 'It could not be sent.';

/**
 * Why a call did not happen, or undefined when it did (or has not finished):
 * the server's refusal (`ok: false`), a capability gate's denial
 * (`status: 'denied'`), or a call the runtime marked as an error, whose result
 * is then the reason in plain text.
 */
function refusalOf(
  part: { result?: string; status?: string },
  result: Record<string, unknown> | undefined
): string | undefined {
  if (result?.status === 'denied') return str(result, 'message') ?? UNSENT_REASON;
  if (result?.ok === false || typeof result?.error === 'string') {
    return str(result, 'error') ?? str(result, 'message') ?? UNSENT_REASON;
  }
  if (part.status === 'error') {
    if (result) return str(result, 'error') ?? str(result, 'message') ?? UNSENT_REASON;
    return part.result?.trim() || UNSENT_REASON;
  }
  return undefined;
}

/**
 * A reason short enough for the closed card's one line: its first sentence,
 * cut at a word near `max` characters.
 *
 * @param reason - The reason, in the server's words.
 * @param max - The longest it may be.
 */
export function shortReason(reason: string, max = 60): string {
  const first = reason.trim().split(/(?<=[.!?])\s/)[0] ?? '';
  if (first.length <= max) return first;
  const cut = first.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, '')}…`;
}

/**
 * What the server knows of a chat this one messaged: its title and agent, from
 * the newest record of anything sent to it. For a card whose own record the
 * server cannot name (a `chat_stop` returns no receipt id).
 *
 * @param chatId - The chat.
 * @param sent - What this chat sent, as the server reported it.
 */
export function chatFactsFor(
  chatId: string | undefined,
  sent: readonly SentChatMessage[]
): SentChatMessage['to'] | undefined {
  if (!chatId) return undefined;
  for (let i = sent.length - 1; i >= 0; i--) {
    if (sent[i]!.to.chatId === chatId) return sent[i]!.to;
  }
  return undefined;
}

/**
 * The server's record of a call's message, when it has one: by receipt id for
 * `chat_send`, by the spin-off it started for `session_start`.
 *
 * @param call - The call.
 * @param sent - What the chat sent, as the server reported it.
 */
export function sentRecordFor(
  call: MessagingCall,
  sent: readonly SentChatMessage[]
): SentChatMessage | undefined {
  if (call.messageId) return sent.find((s) => s.id === call.messageId);
  if (call.tool === 'session_start' && call.chatId) {
    return sent.find((s) => s.kind === 'start' && s.to.chatId === call.chatId);
  }
  return undefined;
}

/** The one line a Sent card shows for what a message is about: the label, else its first line. */
export function sentSummary(summary: string | undefined, text: string | undefined): string {
  if (summary && summary.trim()) return summary.trim();
  const first = (text ?? '').split('\n').find((line) => line.trim() !== '') ?? '';
  const clean = first.replace(/^#+\s*/, '').trim();
  return clean.length > 72 ? `${clean.slice(0, 71)}…` : clean;
}

/** The words a Sent card says about where a message is. */
export function deliveryLabel(
  record: Pick<SentChatMessage, 'status' | 'delivery' | 'position' | 'failureReason'> | undefined,
  call: Pick<MessagingCall, 'error' | 'waiting'> & { pending?: boolean }
): { label: string; tone: 'muted' | 'active' | 'done' | 'error' } {
  if (call.error) return { label: 'Failed', tone: 'error' };
  if (call.waiting) return { label: 'Waiting for approval', tone: 'muted' };
  if (!record) return { label: call.pending ? 'Sending' : 'Sent', tone: 'muted' };
  switch (record.status) {
    case 'queued':
      return {
        label: record.position ? `Queued · #${record.position}` : 'Queued',
        tone: 'muted',
      };
    case 'steered':
      return { label: 'Steered in', tone: 'done' };
    case 'working':
      return {
        label: record.delivery === 'interrupt' ? 'Interrupted, working' : 'Working',
        tone: 'active',
      };
    case 'delivered':
      return {
        label: record.delivery === 'interrupt' ? 'Interrupted, then delivered' : 'Delivered',
        tone: 'done',
      };
    case 'replied':
      return { label: 'Replied', tone: 'done' };
    case 'failed':
      return { label: 'Failed', tone: 'error' };
    default:
      return { label: 'Sent', tone: 'muted' };
  }
}

/** The small tags a received message carries. */
export function stampTags(stamp: Pick<ChatMessageStamp, 'kind' | 'delivery'>): string[] {
  const tags: string[] = [];
  if (stamp.kind === 'report') tags.push('Report');
  if (stamp.kind === 'start') tags.push('Started this chat');
  if (stamp.delivery === 'steer') tags.push('Steered in');
  if (stamp.delivery === 'interrupt') tags.push('Interrupted');
  return tags;
}

/**
 * The transcript message a chat-message id lives in: the received message
 * carrying its stamp, or the assistant message whose tool call sent it. Lets a
 * link name the chat message and land on the row (DOR-1579's `?message=`).
 *
 * @param messages - The chat's history.
 * @param chatMessageId - The chat message's id.
 */
export function transcriptIdForChatMessage(
  messages: readonly Pick<HistoryMessage, 'id' | 'chatMessages' | 'toolCalls' | 'parts'>[],
  chatMessageId: string
): string | undefined {
  for (const message of messages) {
    if (message.chatMessages?.some((stamp) => stamp.id === chatMessageId)) return message.id;
    const calls = [
      ...(message.toolCalls ?? []),
      ...(message.parts ?? []).filter(
        (p): p is Extract<NonNullable<HistoryMessage['parts']>[number], { type: 'tool_call' }> =>
          p.type === 'tool_call'
      ),
    ];
    for (const call of calls) {
      if (readMessagingCall(call)?.messageId === chatMessageId) return message.id;
    }
  }
  return undefined;
}

/**
 * The transcript with a "Stopped by" line for each time another chat stopped
 * it, placed after the last message sent at or before the stop.
 *
 * A row with no timestamp is a live one — the turn in flight, a steer into
 * it — and is newer than any stop the server has recorded, so every stop
 * still waiting is placed before the first such row. A stop never lands below
 * the live turn, where it would take the "newest message" place the
 * streaming announcer, Retry and the streaming flag all read.
 *
 * @param messages - The rendered transcript, oldest first.
 * @param stops - The stops, oldest first.
 */
export function interleaveStopNotices(
  messages: readonly ChatMessage[],
  stops: readonly ChatStopNotice[]
): ChatMessage[] {
  if (stops.length === 0) return messages as ChatMessage[];
  const out: ChatMessage[] = [];
  let next = 0;
  const notice = (stop: ChatStopNotice): ChatMessage => ({
    id: `chat-stop-${stop.id}`,
    role: 'user',
    content: '',
    parts: [],
    timestamp: stop.at,
    _chatStop: stop,
  });
  for (const message of messages) {
    const live = message.timestamp === '';
    const at = live ? Number.NaN : Date.parse(message.timestamp);
    const before = (stop: ChatStopNotice) =>
      live || (!Number.isNaN(at) && Date.parse(stop.at) < at);
    while (next < stops.length && before(stops[next]!)) {
      out.push(notice(stops[next]!));
      next += 1;
    }
    out.push(message);
  }
  while (next < stops.length) {
    out.push(notice(stops[next]!));
    next += 1;
  }
  return out;
}
