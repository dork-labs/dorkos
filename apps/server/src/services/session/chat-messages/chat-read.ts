/**
 * `chat_read` (spec `spin-off-chats` §1): one chat reading another's state and
 * messages, so no agent ever reads a transcript file.
 *
 * Pure over its dependencies: the history comes in already stamped (a message
 * another chat sent reads as `{ from, kind, text }`, never as the raw fence),
 * the access rule and the search are injected, and the only write is the
 * per-reader cursor `since: 'last-read'` reads.
 *
 * @module services/session/chat-messages/chat-read
 */
import type { ChatMessageKind, ChatMessageSender } from '@dorkos/shared/chat-messages';
import type { HistoryMessage } from '@dorkos/shared/types';
import type { SessionStatus } from '@dorkos/shared/session-stream';
import type { ChatCaller } from './chat-message-service.js';
import { ChatMessageError } from './chat-message-service.js';
import type { ChatMessageStore } from './chat-message-store.js';

/** The default number of messages a read returns. */
export const CHAT_READ_DEFAULT_LAST = 10;
/** The most messages one read returns. */
export const CHAT_READ_MAX_LAST = 100;
/** The default size budget of one read, in characters. */
export const CHAT_READ_DEFAULT_MAX_CHARS = 8_000;
/** The smallest budget a caller may ask for. */
export const CHAT_READ_MIN_MAX_CHARS = 500;
/** The largest budget a caller may ask for. */
export const CHAT_READ_MAX_MAX_CHARS = 100_000;

/** Where a chat is, in the words a reader needs. */
export type ChatState =
  'running' | 'needs-you' | 'done' | 'failed' | 'stopped' | 'paused-at-limit' | 'idle';

/** What `chat_read` takes. */
export interface ChatReadInput {
  /** The chat to read. */
  chat: string;
  /** `'last-read'` (default), a message id, or an ISO time. */
  since?: string;
  /** The newest n messages (default 10, max 100). */
  last?: number;
  /** What to include. */
  include?: 'text' | 'tools' | 'status';
  /** A size budget, in characters. */
  maxChars?: number;
  /** Only messages matching these words. */
  query?: string;
  /** Continue a trimmed read: `<messageId>:<offset>`. */
  cursor?: string;
}

/** One message as a reader sees it. */
export interface ChatReadMessage {
  /** The message's id in the chat. */
  id: string;
  /** Who said it: the person, the chat's own agent, or another chat. */
  from: 'person' | 'agent' | 'chat';
  /** When the message carries words another chat sent: who sent them. */
  sender?: ChatMessageSender;
  /** When another chat sent it: what kind. */
  kind?: ChatMessageKind;
  /** When it was said (ISO 8601), when the chat recorded it. */
  at?: string;
  /** The words. */
  text: string;
  /** With `include: 'tools'`: one line per tool call. */
  tools?: string[];
  /** True when the words were cut at the size budget; `cursor` continues them. */
  trimmed?: true;
}

/** What `chat_read` answers. */
export interface ChatReadResult {
  /** The chat. */
  chat: {
    id: string;
    title: string | null;
    agent: string | null;
    state: ChatState;
  };
  /** The messages, oldest first. */
  messages: ChatReadMessage[];
  /** True when more messages were left out by `last` or the size budget. */
  more: boolean;
  /** Where to continue a read the size budget cut. */
  cursor?: string;
}

/** What `chat_read` needs. */
export interface ChatReadDeps {
  /** The store, for read cursors. */
  store: ChatMessageStore;
  /** Whether the calling chat may read the target. */
  mayRead: (caller: ChatCaller, target: string) => Promise<boolean>;
  /** The chat's history, stamped. */
  history: (sessionId: string) => Promise<HistoryMessage[]>;
  /** The chat's status, when a live projector holds one. */
  status: (sessionId: string) => { status: SessionStatus; needsYou: boolean } | null;
  /** The chat's title and agent name. */
  describe: (sessionId: string) => Promise<{ title: string | null; agent: string | null }>;
  /** Message ids in the chat matching the words, best first. */
  search: (sessionId: string, query: string, limit: number) => Promise<string[]>;
}

/**
 * Read where a chat is, in the words a reader needs.
 *
 * @param live - The chat's live status, or null when no live projector holds it.
 */
export function chatStateOf(live: { status: SessionStatus; needsYou: boolean } | null): ChatState {
  if (!live) return 'idle';
  if (live.needsYou) return 'needs-you';
  const { lifecycle, limit } = live.status;
  if (lifecycle === 'streaming') return 'running';
  // A usage limit holds it: the turn stopped at the limit and waits for a
  // reset or a carry-over.
  if (limit) return 'paused-at-limit';
  if (lifecycle === 'blocked') return 'needs-you';
  if (lifecycle === 'error') return 'failed';
  if (lifecycle === 'interrupted') return 'stopped';
  return 'done';
}

/** One tool call, in one short line. */
function toolLine(call: NonNullable<HistoryMessage['toolCalls']>[number]): string {
  const input = typeof call.input === 'string' ? call.input : JSON.stringify(call.input ?? '');
  const short = input.length > 120 ? `${input.slice(0, 117)}…` : input;
  return `${call.toolName}(${short})`;
}

/** The messages one history message reads as. */
function readMessages(message: HistoryMessage, include: 'text' | 'tools'): ChatReadMessage[] {
  const at = message.timestamp ? { at: message.timestamp } : {};
  if (message.role === 'user') {
    if (message.chatMessages && message.chatMessages.length > 0) {
      return message.chatMessages.map((stamp) => ({
        id: message.id,
        from: 'chat' as const,
        sender: stamp.from,
        kind: stamp.kind,
        ...at,
        text: stamp.text,
      }));
    }
    return [{ id: message.id, from: 'person', ...at, text: message.content }];
  }
  const tools =
    include === 'tools' && message.toolCalls && message.toolCalls.length > 0
      ? { tools: message.toolCalls.map(toolLine) }
      : {};
  if (message.content.trim() === '' && !('tools' in tools)) return [];
  return [{ id: message.id, from: 'agent', ...at, text: message.content, ...tools }];
}

/** The size a message costs against the budget. */
function costOf(message: ChatReadMessage): number {
  return message.text.length + (message.tools?.reduce((n, t) => n + t.length + 1, 0) ?? 0);
}

/**
 * Read a chat for another chat.
 *
 * @param deps - What it needs.
 * @param caller - The calling chat.
 * @param input - What to read.
 * @throws ChatMessageError when the caller may not read it.
 */
export async function readChat(
  deps: ChatReadDeps,
  caller: ChatCaller,
  input: ChatReadInput
): Promise<ChatReadResult> {
  if (!(await deps.mayRead(caller, input.chat))) {
    throw new ChatMessageError(
      'NOT_READABLE',
      'You can read your own chat, the chat that started you, chats you started, and chats you ' +
        'have messaged or that messaged you. Ask that chat with chat_send instead.'
    );
  }
  const described = await deps.describe(input.chat);
  const chat = {
    id: input.chat,
    title: described.title,
    agent: described.agent,
    state: chatStateOf(deps.status(input.chat)),
  };
  const include = input.include ?? 'text';
  if (include === 'status') return { chat, messages: [], more: false };

  const history = await deps.history(input.chat);
  let selected = history;
  const moveCursor = input.query === undefined;

  if (input.query !== undefined) {
    const ids = new Set(await deps.search(input.chat, input.query, CHAT_READ_MAX_LAST));
    selected = history.filter((m) => ids.has(m.id));
  } else if (input.cursor !== undefined) {
    const id = input.cursor.slice(0, input.cursor.lastIndexOf(':'));
    const index = history.findIndex((m) => m.id === id);
    selected = index >= 0 ? history.slice(index) : history;
  } else {
    const since = input.since ?? 'last-read';
    const afterId =
      since === 'last-read' ? deps.store.readCursor(caller.sessionId, input.chat) : since;
    const byTime =
      since !== 'last-read' &&
      !Number.isNaN(Date.parse(since)) &&
      !history.some((m) => m.id === since);
    if (byTime) {
      const t = Date.parse(since);
      selected = history.filter((m) => m.timestamp !== undefined && Date.parse(m.timestamp) > t);
    } else if (afterId !== undefined) {
      const index = history.findIndex((m) => m.id === afterId);
      if (index >= 0) selected = history.slice(index + 1);
      else if (since !== 'last-read') {
        throw new ChatMessageError(
          'NOT_FOUND',
          'since must be "last-read", a message id from this chat, or an ISO time.'
        );
      }
    }
  }

  const last = Math.min(Math.max(1, input.last ?? CHAT_READ_DEFAULT_LAST), CHAT_READ_MAX_LAST);
  let more = false;
  // `last` reads the newest n; with nothing else narrowing it the read is the
  // newest n of everything after the cursor.
  if (input.cursor === undefined && selected.length > last) {
    selected = selected.slice(-last);
    more = true;
  }

  const budget = Math.min(
    Math.max(input.maxChars ?? CHAT_READ_DEFAULT_MAX_CHARS, CHAT_READ_MIN_MAX_CHARS),
    CHAT_READ_MAX_MAX_CHARS
  );
  const startOffset =
    input.cursor !== undefined
      ? Number(input.cursor.slice(input.cursor.lastIndexOf(':') + 1)) || 0
      : 0;
  const messages: ChatReadMessage[] = [];
  let used = 0;
  let cursor: string | undefined;
  let lastWholeId: string | undefined;
  outer: for (const [i, history] of selected.entries()) {
    const parts = readMessages(history, include);
    let offset = i === 0 ? startOffset : 0;
    for (const part of parts) {
      const piece = offset > 0 ? { ...part, text: part.text.slice(offset) } : part;
      offset = 0;
      const cost = costOf(piece);
      if (used + cost <= budget) {
        messages.push(piece);
        used += cost;
        continue;
      }
      const room = budget - used;
      if (room > 0 && piece.text.length > 0) {
        const taken = Math.min(room, piece.text.length);
        messages.push({ ...piece, text: piece.text.slice(0, taken), trimmed: true });
        cursor = `${history.id}:${(i === 0 ? startOffset : 0) + taken}`;
      } else {
        cursor = `${history.id}:${i === 0 ? startOffset : 0}`;
      }
      more = true;
      break outer;
    }
    lastWholeId = history.id;
  }

  if (moveCursor && lastWholeId !== undefined) {
    deps.store.setReadCursor(caller.sessionId, input.chat, lastWholeId);
  }
  return { chat, messages, more, ...(cursor ? { cursor } : {}) };
}
