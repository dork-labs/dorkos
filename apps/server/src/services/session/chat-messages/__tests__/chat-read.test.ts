/**
 * `chat_read` (spec `spin-off-chats` §1): every option, over a real store so
 * the per-reader cursor `since: 'last-read'` rests on is the real one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { HistoryMessage } from '@dorkos/shared/types';
import type { SessionStatus } from '@dorkos/shared/session-stream';
import { ChatMessageStore } from '../chat-message-store.js';
import { ChatMessageError } from '../chat-message-service.js';
import { chatStateOf, readChat, type ChatReadDeps } from '../chat-read.js';

const CALLER = { sessionId: 'reader', agentPath: '/agents/ana' };
const TARGET = 'target';

let store: ChatMessageStore;
let history: HistoryMessage[];
let deps: ChatReadDeps;
let mayRead: boolean;

/** A history message with a stated timestamp, one minute apart by index. */
function msg(
  n: number,
  role: 'user' | 'assistant' = n % 2 === 1 ? 'user' : 'assistant',
  content = `message ${n}`,
  extra: Partial<HistoryMessage> = {}
): HistoryMessage {
  const minute = String(n).padStart(2, '0');
  return { id: `m${n}`, role, content, timestamp: `2026-10-09T10:${minute}:00.000Z`, ...extra };
}

beforeEach(() => {
  store = new ChatMessageStore(createTestDb());
  history = [];
  mayRead = true;
  deps = {
    store,
    mayRead: vi.fn(async () => mayRead),
    history: vi.fn(async () => history),
    status: vi.fn(() => null),
    describe: vi.fn(async () => ({ title: 'Build', agent: 'Bo' })),
    search: vi.fn(async () => []),
  };
});

describe('readChat — access', () => {
  it('refuses a chat the caller may not read, without reading its history', async () => {
    mayRead = false;
    history = [msg(1)];
    const err = await readChat(deps, CALLER, { chat: TARGET }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChatMessageError);
    expect((err as ChatMessageError).code).toBe('NOT_READABLE');
    expect(deps.history).not.toHaveBeenCalled();
    expect(deps.mayRead).toHaveBeenCalledWith(CALLER, TARGET);
  });
});

describe('readChat — include status', () => {
  it('answers the state with no messages and leaves the cursor alone', async () => {
    history = [msg(1), msg(2)];
    vi.mocked(deps.status).mockReturnValue({
      status: { lifecycle: 'streaming', limit: null } as unknown as SessionStatus,
      needsYou: false,
    });

    const result = await readChat(deps, CALLER, { chat: TARGET, include: 'status' });

    expect(result).toEqual({
      chat: {
        id: TARGET,
        title: 'Build',
        link: `[Build](/session?session=${TARGET})`,
        agent: 'Bo',
        state: 'running',
      },
      messages: [],
      more: false,
    });
    expect(store.readCursor(CALLER.sessionId, TARGET)).toBeUndefined();
    // And the next default read still sees everything.
    const next = await readChat(deps, CALLER, { chat: TARGET });
    expect(next.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
  });
});

describe('readChat — since', () => {
  it('last-read (default) gives the newest 10, then only what is newer', async () => {
    history = Array.from({ length: 15 }, (_, i) => msg(i + 1));

    const first = await readChat(deps, CALLER, { chat: TARGET });
    expect(first.messages.map((m) => m.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `m${i + 6}`)
    );
    expect(first.more).toBe(true);
    expect(store.readCursor(CALLER.sessionId, TARGET)).toBe('m15');

    history = [...history, msg(16), msg(17)];
    const second = await readChat(deps, CALLER, { chat: TARGET });
    expect(second.messages.map((m) => m.id)).toEqual(['m16', 'm17']);
    expect(second.more).toBe(false);

    const third = await readChat(deps, CALLER, { chat: TARGET });
    expect(third.messages).toEqual([]);
  });

  it('keeps one cursor per reader', async () => {
    history = [msg(1), msg(2)];
    await readChat(deps, CALLER, { chat: TARGET });
    const other = await readChat(deps, { ...CALLER, sessionId: 'other-reader' }, { chat: TARGET });
    expect(other.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('last reads the newest n', async () => {
    history = Array.from({ length: 6 }, (_, i) => msg(i + 1));
    const result = await readChat(deps, CALLER, { chat: TARGET, last: 3 });
    expect(result.messages.map((m) => m.id)).toEqual(['m4', 'm5', 'm6']);
    expect(result.more).toBe(true);
  });

  it('since a message id reads what came after it; with last, the newest of those', async () => {
    history = Array.from({ length: 6 }, (_, i) => msg(i + 1));
    const after = await readChat(deps, CALLER, { chat: TARGET, since: 'm2' });
    expect(after.messages.map((m) => m.id)).toEqual(['m3', 'm4', 'm5', 'm6']);

    const newest = await readChat(deps, CALLER, { chat: TARGET, since: 'm2', last: 2 });
    expect(newest.messages.map((m) => m.id)).toEqual(['m5', 'm6']);
  });

  it('since an ISO time reads what was said after it', async () => {
    history = Array.from({ length: 6 }, (_, i) => msg(i + 1));
    const result = await readChat(deps, CALLER, {
      chat: TARGET,
      since: '2026-10-09T10:04:00.000Z',
    });
    expect(result.messages.map((m) => m.id)).toEqual(['m5', 'm6']);
  });

  it('refuses a since that is neither a message here nor a time', async () => {
    history = [msg(1)];
    const err = await readChat(deps, CALLER, { chat: TARGET, since: 'no-such-id' }).catch(
      (e: unknown) => e
    );
    expect((err as ChatMessageError).code).toBe('NOT_FOUND');
  });
});

describe('readChat — include tools', () => {
  it('adds one line per tool call, and only when asked', async () => {
    history = [
      msg(1),
      msg(2, 'assistant', 'Ran it.', {
        toolCalls: [
          { toolCallId: 't1', toolName: 'Bash', input: '{"command":"ls"}', status: 'complete' },
        ] as HistoryMessage['toolCalls'],
      }),
      msg(3, 'assistant', '', {
        toolCalls: [
          { toolCallId: 't2', toolName: 'Read', input: 'x'.repeat(200), status: 'complete' },
        ] as HistoryMessage['toolCalls'],
      }),
    ];

    const text = await readChat(deps, CALLER, { chat: TARGET, last: 10 });
    expect(text.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(text.messages.some((m) => m.tools)).toBe(false);

    const tools = await readChat(deps, CALLER, { chat: TARGET, since: 'm1', include: 'tools' });
    expect(tools.messages.map((m) => [m.id, m.tools])).toEqual([
      ['m2', ['Bash({"command":"ls"})']],
      ['m3', [`Read(${'x'.repeat(117)}…)`]],
    ]);
  });
});

describe('readChat — maxChars', () => {
  it('trims the last message at the budget and the cursor continues exactly there', async () => {
    const long2 = 'b'.repeat(300);
    const long3 = 'c'.repeat(150);
    history = [msg(1, 'user', 'a'.repeat(300)), msg(2, 'assistant', long2), msg(3, 'user', long3)];

    const first = await readChat(deps, CALLER, { chat: TARGET, maxChars: 500 });
    expect(first.messages.map((m) => [m.id, m.text.length, m.trimmed])).toEqual([
      ['m1', 300, undefined],
      ['m2', 200, true],
    ]);
    expect(first.more).toBe(true);
    expect(first.cursor).toBe('m2:0:200');
    // Only the whole message counts as read.
    expect(store.readCursor(CALLER.sessionId, TARGET)).toBe('m1');

    const rest = await readChat(deps, CALLER, {
      chat: TARGET,
      maxChars: 500,
      cursor: first.cursor!,
    });
    expect(rest.messages.map((m) => m.id)).toEqual(['m2', 'm3']);
    expect(first.messages[1]!.text + rest.messages[0]!.text).toBe(long2);
    expect(rest.messages[1]!.text).toBe(long3);
    expect(rest.cursor).toBeUndefined();
    expect(rest.more).toBe(false);
    expect(store.readCursor(CALLER.sessionId, TARGET)).toBe('m3');
  });

  it('continues a cut that is itself cut again, from the right offset', async () => {
    const huge = 'abcdefghij'.repeat(130); // 1300 characters
    history = [msg(1, 'user', huge)];

    const a = await readChat(deps, CALLER, { chat: TARGET, maxChars: 500 });
    expect(a.cursor).toBe('m1:0:500');
    const b = await readChat(deps, CALLER, { chat: TARGET, maxChars: 500, cursor: a.cursor! });
    expect(b.cursor).toBe('m1:0:1000');
    const c = await readChat(deps, CALLER, { chat: TARGET, maxChars: 500, cursor: b.cursor! });
    expect(c.cursor).toBeUndefined();
    expect(a.messages[0]!.text + b.messages[0]!.text + c.messages[0]!.text).toBe(huge);
  });
});

describe('readChat — maxChars over a batched message', () => {
  it('continues a cut inside the SECOND chat message of one user message from where it stopped', async () => {
    // Two agent messages that waited together ran as one turn, so one user
    // message carries two stamps and reads as two parts sharing its id.
    const sender = { chatId: 'chat-a', agentName: 'Ana' };
    const one = '1'.repeat(300);
    const two = '2'.repeat(300);
    const stamp = (id: string, text: string) => ({
      id,
      kind: 'message' as const,
      from: sender,
      text,
      delivery: 'queue' as const,
      status: 'working' as const,
      sentAt: '2026-10-09T10:00:00.000Z',
    });
    history = [msg(1, 'user', 'fenced', { chatMessages: [stamp('c1', one), stamp('c2', two)] })];

    const first = await readChat(deps, CALLER, { chat: TARGET, maxChars: 500 });
    expect(first.messages.map((m) => m.text.length)).toEqual([300, 200]);
    expect(first.messages[1]!.trimmed).toBe(true);

    const rest = await readChat(deps, CALLER, {
      chat: TARGET,
      maxChars: 500,
      cursor: first.cursor!,
    });
    // The reader must get the last 100 characters of the second message, and
    // nothing of the first again.
    expect(rest.messages.map((m) => m.text)).toEqual(['2'.repeat(100)]);
  });
});

describe('readChat — query', () => {
  it('reads only the messages search found, and leaves the cursor alone', async () => {
    history = Array.from({ length: 5 }, (_, i) => msg(i + 1));
    vi.mocked(deps.search).mockResolvedValue(['m4', 'm2']);

    const result = await readChat(deps, CALLER, { chat: TARGET, query: 'deploy' });

    expect(deps.search).toHaveBeenCalledWith(TARGET, 'deploy', 100);
    expect(result.messages.map((m) => m.id)).toEqual(['m2', 'm4']);
    expect(store.readCursor(CALLER.sessionId, TARGET)).toBeUndefined();
  });
});

describe('readChat — messages another chat sent', () => {
  it('reads a stamped message as from another chat, with its sender, never the fence', async () => {
    const sender = { chatId: 'chat-a', agentName: 'Ana', agentId: 'agent-ana' };
    history = [
      msg(
        1,
        'user',
        '--- BEGIN CHAT MESSAGE aaaaaaaa --- raw fence --- END CHAT MESSAGE aaaaaaaa ---',
        {
          chatMessages: [
            {
              id: 'c1',
              kind: 'message',
              from: sender,
              text: 'first words',
              delivery: 'queue',
              status: 'working',
              sentAt: '2026-10-09T10:00:00.000Z',
            },
            {
              id: 'c2',
              kind: 'report',
              from: sender,
              text: 'second words',
              delivery: 'queue',
              status: 'working',
              sentAt: '2026-10-09T10:00:01.000Z',
            },
          ],
        }
      ),
      msg(2, 'user', 'the person typed this'),
    ];

    const result = await readChat(deps, CALLER, { chat: TARGET });

    expect(result.messages).toEqual([
      expect.objectContaining({
        id: 'm1',
        from: 'chat',
        sender,
        kind: 'message',
        text: 'first words',
      }),
      expect.objectContaining({
        id: 'm1',
        from: 'chat',
        sender,
        kind: 'report',
        text: 'second words',
      }),
      expect.objectContaining({ id: 'm2', from: 'person', text: 'the person typed this' }),
    ]);
    expect(JSON.stringify(result)).not.toContain('BEGIN CHAT MESSAGE');
  });
});

describe('chatStateOf', () => {
  const live = (lifecycle: string, extra: { limit?: unknown; needsYou?: boolean } = {}) => ({
    status: { lifecycle, limit: extra.limit ?? null } as unknown as SessionStatus,
    needsYou: extra.needsYou ?? false,
  });

  it.each([
    ['no live projector', null, 'idle'],
    ['streaming', live('streaming'), 'running'],
    ['a pending ask while streaming', live('streaming', { needsYou: true }), 'needs-you'],
    ['blocked', live('blocked'), 'needs-you'],
    ['held at a usage limit', live('idle', { limit: { kind: 'hard' } }), 'paused-at-limit'],
    ['errored', live('error'), 'failed'],
    ['interrupted', live('interrupted'), 'stopped'],
    ['idle after a turn', live('idle'), 'done'],
  ] as const)('%s → %s', (_label, input, expected) => {
    expect(chatStateOf(input)).toBe(expected);
  });
});
