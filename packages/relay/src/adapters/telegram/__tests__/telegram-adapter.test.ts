import { sendPrivateTelegramNotification } from '../private-notification.js';
vi.mock('../private-notification.js', () => ({ sendPrivateTelegramNotification: vi.fn() }));
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TelegramAdapter } from '../index.js';
import {
  BOT_IDENTITY,
  captured,
  createEnvelope,
  createInboundCtx,
  createMockRelay,
  mockBotStart,
  mockBotStop,
  mockGetMe,
  mockLeaveChat,
  mockSendChatAction,
  mockSendMessage,
  resetCaptured,
  tgConfig,
} from './telegram-adapter.fixtures.js';

vi.mock('node:http', async () => (await import('./telegram-adapter.fixtures.js')).httpModule());
vi.mock('grammy', async () => (await import('./telegram-adapter.fixtures.js')).grammyModule());
vi.mock('@grammyjs/auto-retry', async () =>
  (await import('./telegram-adapter.fixtures.js')).autoRetryModule()
);

describe('TelegramAdapter', () => {
  let adapter: TelegramAdapter;
  let mockRelay: ReturnType<typeof createMockRelay>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetCaptured();

    // User 42 is the approver these tests press buttons as. Without a named
    // approver every approval is refused, which is the point of DOR-609 — the
    // refusal path has its own tests below.
    //
    // User 99 is `createInboundCtx`'s default author, and private chats now
    // need an allowlist (DOR-788), so it is named here. These tests are about
    // subjects and payload shapes; the allowlist has its own tests in
    // `inbound.test.ts`.
    adapter = new TelegramAdapter(
      'tg1',
      tgConfig({
        token: 'test-token',
        mode: 'polling',
        approverAllowlist: ['42'],
        dmAllowlist: ['99', '55'],
      })
    );
    mockRelay = createMockRelay();
  });

  afterEach(async () => {
    // Clean up adapter if started
    if (adapter.getStatus().state !== 'disconnected' && adapter.getStatus().state !== 'error') {
      try {
        await adapter.stop();
      } catch {
        // ignore cleanup errors
      }
    }
  });

  // --- Identity ---

  it.each(['stop', 'restart'] as const)(
    'fences a private notification when the native client changes via %s',
    async (action) => {
      await adapter.start(mockRelay);
      const source = vi.fn(() => true);
      vi.mocked(sendPrivateTelegramNotification).mockImplementationOnce(async (input) => {
        await adapter.stop();
        if (action === 'restart') await adapter.start(mockRelay);
        return input.authorizeDispatch()
          ? { state: 'delivered', receiptId: 'unexpected' }
          : { state: 'refused' };
      });
      expect(
        await adapter.deliverPrivateNotification(
          'relay.human.telegram.tg1.-100123',
          'private',
          source
        )
      ).toEqual({ state: 'refused' });
      expect(source).not.toHaveBeenCalled();
    }
  );

  // --- start() ---

  it('start() creates a bot with autoRetry and begins polling', async () => {
    await adapter.start(mockRelay);

    const { autoRetry } = await import('@grammyjs/auto-retry');
    expect(autoRetry).toHaveBeenCalled();
    expect(mockBotStart).toHaveBeenCalledWith(
      expect.objectContaining({ drop_pending_updates: true })
    );
  });

  it('bounds autoRetry so a failing call eventually surfaces', async () => {
    // The library's own defaults are `maxRetryAttempts: Infinity` and
    // `maxDelaySeconds: Infinity`, and it wraps `getUpdates` too. Left
    // unbounded, a revoked token or a dead network retried in silence forever
    // while the adapter still reported `connected` — no error, no reconnect,
    // no message. The cap also bounds shutdown: the library's retry sleep is a
    // timer it never unrefs, so it holds the process open for the whole delay.
    await adapter.start(mockRelay);

    const { autoRetry } = await import('@grammyjs/auto-retry');
    expect(autoRetry).toHaveBeenCalledWith(
      expect.objectContaining({ maxRetryAttempts: 3, maxDelaySeconds: 60 })
    );
  });

  it('stop() unsubscribes from relay signals', async () => {
    await adapter.start(mockRelay);

    // Simulate a signal subscription being active
    const signalCount = (mockRelay.onSignal as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(signalCount).toBe(1);

    await adapter.stop();

    // After stop, typing signals should no longer be forwarded
    expect(mockSendChatAction).not.toHaveBeenCalled();
  });

  it('stop() calls bot.stop() and transitions to disconnected', async () => {
    await adapter.start(mockRelay);
    await adapter.stop();

    expect(mockBotStop).toHaveBeenCalled();
    expect(adapter.getStatus().state).toBe('disconnected');
  });

  // --- Inbound messages ---

  it('publishes inbound DM to relay.human.telegram.{chatId}', async () => {
    await adapter.start(mockRelay);

    const ctx = createInboundCtx({ chatId: 12345, chatType: 'private', text: 'Hello!' });
    await captured.message!(ctx);

    expect(mockRelay.publish).toHaveBeenCalledWith(
      'relay.human.telegram.tg1.12345',
      expect.objectContaining({
        content: 'Hello!',
        channelType: 'dm',
      }),
      { from: 'relay.human.telegram.tg1.bot', replyTo: 'relay.human.telegram.tg1.12345' }
    );
  });

  it('publishes inbound group message to relay.human.telegram.tg1.group.{chatId}', async () => {
    await adapter.start(mockRelay);

    // Addressed to the bot, because a group message that names nobody is
    // filtered before it reaches the relay (DOR-619). Gating has its own tests
    // in `inbound.test.ts`; this one is about subject and payload shape.
    const ctx = createInboundCtx({
      chatId: -100111222,
      chatType: 'group',
      text: '@dorkbot Group message',
      title: 'Project Team',
      entities: [{ type: 'mention', offset: 0, length: 8 }],
    });
    await captured.message!(ctx);

    expect(mockRelay.publish).toHaveBeenCalledWith(
      'relay.human.telegram.tg1.group.-100111222',
      expect.objectContaining({
        content: '@dorkbot Group message',
        channelType: 'group',
      }),
      { from: 'relay.human.telegram.tg1.bot', replyTo: 'relay.human.telegram.tg1.group.-100111222' }
    );
  });

  it('normalises StandardPayload with senderName and responseContext', async () => {
    await adapter.start(mockRelay);

    const ctx = createInboundCtx({
      chatId: 42,
      firstName: 'Bob',
      lastName: 'Smith',
      text: 'Hi there',
    });
    await captured.message!(ctx);

    expect(mockRelay.publish).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        senderName: 'Bob Smith',
        responseContext: expect.objectContaining({
          platform: 'telegram',
          maxLength: 4096,
        }),
      }),
      expect.any(Object)
    );
  });

  // --- chat-member updates (DOR-883: the group-add claim flow's entry point) ---

  it("wires 'my_chat_member' and publishes when the bot is added to a group", async () => {
    await adapter.start(mockRelay);
    expect(captured.chatMember).not.toBeNull();

    await captured.chatMember!({
      myChatMember: {
        chat: { id: -100999, type: 'supergroup', title: 'Ops' },
        from: { id: 42, is_bot: false, first_name: 'Ana', username: 'ana' },
        date: 0,
        old_chat_member: { status: 'left', user: BOT_IDENTITY },
        new_chat_member: { status: 'member', user: BOT_IDENTITY },
      },
    });

    expect(mockRelay.publish).toHaveBeenCalledWith(
      'relay.human.telegram.tg1.group.-100999',
      expect.objectContaining({
        content: '',
        senderName: 'Ana',
        channelName: 'Ops',
        channelType: 'group',
      }),
      expect.objectContaining({ from: 'relay.human.telegram.tg1.bot' })
    );
  });

  // --- Echo guard ---

  it('deliver() skips messages originating from this adapter (echo prevention)', async () => {
    await adapter.start(mockRelay);

    const envelope = createEnvelope('relay.human.telegram.tg1.12345', { content: 'Echo!' });
    // Override 'from' to simulate the adapter's own inbound publish
    envelope.from = 'relay.human.telegram.tg1.bot';

    const result = await adapter.deliver('relay.human.telegram.tg1.12345', envelope);
    expect(result.success).toBe(true);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  // --- Outbound delivery ---

  it('deliver() sends a Telegram message to the correct chat', async () => {
    await adapter.start(mockRelay);

    const envelope = createEnvelope('relay.human.telegram.tg1.12345', {
      content: 'Hello from agent!',
    });
    await adapter.deliver('relay.human.telegram.tg1.12345', envelope);

    expect(mockSendMessage).toHaveBeenCalledWith(12345, 'Hello from agent!', {
      parse_mode: 'HTML',
    });
  });

  it('deliver() sends a markdown table without throwing, escaped but otherwise literal (§15 backstop, §13)', async () => {
    // The chats-as-channels spec's §15 backstop: the outbound adapter has to
    // survive a model that ignores room_context's formatting guidance and
    // sends a Markdown table anyway. `markdownToTelegramHtml` has no table
    // handling at all — pipes and dashes carry no special meaning to it — so
    // this pins the REAL, unmocked conversion (this file mocks grammy and
    // node:http, never `payload-utils.js`) surviving a table end to end: no
    // throw, one send, and the one HTML-significant character in a cell
    // escaped so Telegram's parser does not reject the whole message.
    await adapter.start(mockRelay);

    const table = ['| Service | Status |', '| --- | --- |', '| api | up |', '| db | <down> |'].join(
      '\n'
    );
    const envelope = createEnvelope('relay.human.telegram.tg1.12345', { content: table });

    const result = await adapter.deliver('relay.human.telegram.tg1.12345', envelope);

    expect(result.success).toBe(true);
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(mockSendMessage).mock.calls[0][1] as string;
    // Mangled — the table's own syntax rides through as literal text — but
    // not broken: no throw above, and the one thing that WOULD have broken
    // Telegram's parser (an unescaped angle bracket) did not survive.
    expect(sent).toContain('| Service | Status |');
    expect(sent).toContain('| --- | --- |');
    expect(sent).toContain('&lt;down&gt;');
    expect(sent).not.toContain('<down>');
  });

  // --- Typing signals ---

  it('forwards active typing signals to Telegram as chat action', async () => {
    await adapter.start(mockRelay);

    const relay = mockRelay as ReturnType<typeof createMockRelay> & {
      _emitSignal: (subject: string, signal: { type: string; state: string }) => void;
    };
    relay._emitSignal('relay.human.telegram.tg1.12345', { type: 'typing', state: 'active' });

    // Allow microtask queue to drain
    await Promise.resolve();

    expect(mockSendChatAction).toHaveBeenCalledWith(12345, 'typing');
  });

  // --- 'progress' signal (spec §6.8: the bridge's presence forwarder) ---

  // --- Typing is driven by the turn, not by the message arriving ---

  it('shows no typing for a message that starts no turn', async () => {
    await adapter.start(mockRelay);

    const ctx = createInboundCtx({ chatId: 12345, text: 'Hello agent!' });
    await captured.message!(ctx);

    // Publishing is not working. Nothing downstream has claimed this message,
    // and it may never be answered — so the chat is told nothing (E16/E16a).
    expect(mockSendChatAction).not.toHaveBeenCalled();
  });

  it('starts typing when the turn starts, not when the message arrives', async () => {
    await adapter.start(mockRelay);

    const ctx = createInboundCtx({ chatId: 12345, text: 'Hello!' });
    await captured.message!(ctx);
    expect(mockSendChatAction).not.toHaveBeenCalled();

    // First event of the turn — the earliest honest evidence an agent is working.
    await adapter.deliver(
      'relay.human.telegram.tg1.12345',
      createEnvelope('relay.human.telegram.tg1.12345', {
        type: 'text_delta',
        data: { text: 'Hello' },
      })
    );

    expect(mockSendChatAction).toHaveBeenCalledWith(12345, 'typing');
  });

  it('stops typing when the reply is sent', async () => {
    await adapter.start(mockRelay);

    await captured.message!(createInboundCtx({ chatId: 12345, text: 'Hello!' }));
    await adapter.deliver(
      'relay.human.telegram.tg1.12345',
      createEnvelope('relay.human.telegram.tg1.12345', {
        type: 'text_delta',
        data: { text: 'Hello' },
      })
    );
    expect(mockSendChatAction).toHaveBeenCalledWith(12345, 'typing');

    await adapter.deliver(
      'relay.human.telegram.tg1.12345',
      createEnvelope('relay.human.telegram.tg1.12345', { type: 'done', data: {} })
    );

    mockSendChatAction.mockClear();
    await new Promise((r) => setTimeout(r, 50));
    expect(mockSendChatAction).not.toHaveBeenCalled();
  });

  // --- testConnection() ---

  // --- getMe() (spec §8, §11.2: the platform is the source of truth for
  // group visibility, never config) ---

  it('getMe() exposes canReadAllGroupMessages and username sourced from the platform', async () => {
    mockGetMe.mockResolvedValueOnce({
      id: 777,
      is_bot: true,
      username: 'dorkbot',
      can_read_all_group_messages: true,
    });
    await adapter.start(mockRelay);

    const result = await adapter.getMe();

    expect(result).toEqual({ username: 'dorkbot', canReadAllGroupMessages: true });
  });

  // --- leaveChat() (DOR-883: the group-add claim flow's "Leave" action) ---

  it("leaveChat() calls the platform's own leave with the chat id, unchanged", async () => {
    await adapter.start(mockRelay);

    await adapter.leaveChat('-100555');

    expect(mockLeaveChat).toHaveBeenCalledWith('-100555');
    expect(mockLeaveChat).toHaveBeenCalledTimes(1);
  });

  it('leaveChat() propagates a platform refusal rather than swallowing it', async () => {
    await adapter.start(mockRelay);
    mockLeaveChat.mockRejectedValueOnce(new Error('Bad Request: chat not found'));

    await expect(adapter.leaveChat('555')).rejects.toThrow('Bad Request: chat not found');
  });

  // --- D4: Inbound content capped at 32KB ---

  it('caps inbound message content at MAX_CONTENT_LENGTH (32KB)', async () => {
    await adapter.start(mockRelay);

    const longText = 'X'.repeat(40_000);
    const ctx = createInboundCtx({ text: longText });
    await captured.message!(ctx);

    const publishedPayload = vi.mocked(mockRelay.publish).mock.calls[0][1] as { content: string };
    expect(publishedPayload.content.length).toBe(32_768);
  });

  // --- H2: formatted long messages split into valid HTML chunks ---

  it('deliver() splits >4096-char formatted content into valid HTML chunks each within the limit (H2)', async () => {
    await adapter.start(mockRelay);

    const paragraph =
      '**Section title**\n\nProse with `inline code` and *emphasis*.\n\n' +
      '```ts\n' +
      'const value = 1;\n'.repeat(8) +
      '```\n\n';
    const content = paragraph.repeat(40);
    expect(content.length).toBeGreaterThan(4096);

    const envelope = createEnvelope('relay.human.telegram.tg1.1', { content });
    const result = await adapter.deliver('relay.human.telegram.tg1.1', envelope);
    expect(result.success).toBe(true);
    expect(mockSendMessage.mock.calls.length).toBeGreaterThan(1);

    for (const call of mockSendMessage.mock.calls) {
      const chunk = call[1] as string;
      expect(chunk.length).toBeLessThanOrEqual(4096);
      expect(call[2]).toEqual({ parse_mode: 'HTML' });
      // Every chunk must be parseable on its own: balanced Telegram HTML tags
      for (const tag of ['b', 'i', 's', 'code', 'pre']) {
        const opens = chunk.match(new RegExp(`<${tag}(?: [^>]*)?>`, 'g'))?.length ?? 0;
        const closes = chunk.match(new RegExp(`</${tag}>`, 'g'))?.length ?? 0;
        expect(opens, `unbalanced <${tag}> in chunk`).toBe(closes);
      }
    }
  });

  // --- C2: extractChatId rejects invalid chat ID 0 ---

  // An empty group suffix ("group." has no ID; Number("") === 0 would pass
  // without the guard) and a float id (Number.isInteger guard).
  it.each([
    ['an empty group suffix that would produce chat ID 0 (C2)', 'relay.human.telegram.tg1.group.'],
    ['a float DM id', 'relay.human.telegram.tg1.1.5'],
  ])('deliver() rejects %s', async (_label, subject) => {
    await adapter.start(mockRelay);

    const envelope = createEnvelope(subject, { content: 'hi' });
    const result = await adapter.deliver(subject, envelope);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cannot extract chat ID/);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  // --- StreamEvent-aware delivery ---

  describe('StreamEvent delivery', () => {
    it('accumulates text_delta chunks and flushes on done', async () => {
      await adapter.start(mockRelay);

      // Send 3 text_delta events — sendMessage should NOT be called yet
      const deltas = ['Hello', ' from', ' agent!'];
      for (const text of deltas) {
        const envelope = createEnvelope('relay.human.telegram.tg1.12345', {
          type: 'text_delta',
          data: { text },
        });
        const result = await adapter.deliver('relay.human.telegram.tg1.12345', envelope);
        expect(result.success).toBe(true);
      }
      expect(mockSendMessage).not.toHaveBeenCalled();

      // Send done event — should flush buffer as a single message
      const doneEnvelope = createEnvelope('relay.human.telegram.tg1.12345', {
        type: 'done',
        data: {},
      });
      const doneResult = await adapter.deliver('relay.human.telegram.tg1.12345', doneEnvelope);
      expect(doneResult.success).toBe(true);
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      expect(mockSendMessage).toHaveBeenCalledWith(12345, 'Hello from agent!', {
        parse_mode: 'HTML',
      });
    });

    it('sends error with buffered text on error event', async () => {
      await adapter.start(mockRelay);

      // Buffer some text
      const textEnvelope = createEnvelope('relay.human.telegram.tg1.12345', {
        type: 'text_delta',
        data: { text: 'Partial response' },
      });
      await adapter.deliver('relay.human.telegram.tg1.12345', textEnvelope);

      // Send error event
      const errorEnvelope = createEnvelope('relay.human.telegram.tg1.12345', {
        type: 'error',
        data: { message: 'Context limit exceeded' },
      });
      const result = await adapter.deliver('relay.human.telegram.tg1.12345', errorEnvelope);
      expect(result.success).toBe(true);
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      expect(mockSendMessage).toHaveBeenCalledWith(
        12345,
        'Partial response\n\n[Error: Context limit exceeded]',
        { parse_mode: 'HTML' }
      );
    });

    it('done with an empty buffer tells the chat the agent said nothing', async () => {
      await adapter.start(mockRelay);

      const doneEnvelope = createEnvelope('relay.human.telegram.tg1.12345', {
        type: 'done',
        data: {},
      });
      const result = await adapter.deliver('relay.human.telegram.tg1.12345', doneEnvelope);
      expect(result.success).toBe(true);
      // Silence here is indistinguishable from an agent still thinking (DOR-789).
      expect(mockSendMessage).toHaveBeenCalledWith(
        12345,
        expect.stringContaining('finished without sending anything back'),
        expect.anything()
      );
    });

    it('buffers per-chat independently', async () => {
      await adapter.start(mockRelay);

      // Buffer text in chat 111
      await adapter.deliver(
        'relay.human.telegram.tg1.111',
        createEnvelope('relay.human.telegram.tg1.111', {
          type: 'text_delta',
          data: { text: 'Chat A' },
        })
      );

      // Buffer text in chat 222
      await adapter.deliver(
        'relay.human.telegram.tg1.222',
        createEnvelope('relay.human.telegram.tg1.222', {
          type: 'text_delta',
          data: { text: 'Chat B' },
        })
      );

      // Flush chat 111
      await adapter.deliver(
        'relay.human.telegram.tg1.111',
        createEnvelope('relay.human.telegram.tg1.111', {
          type: 'done',
          data: {},
        })
      );

      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      expect(mockSendMessage).toHaveBeenCalledWith(111, 'Chat A', { parse_mode: 'HTML' });

      // Flush chat 222
      await adapter.deliver(
        'relay.human.telegram.tg1.222',
        createEnvelope('relay.human.telegram.tg1.222', {
          type: 'done',
          data: {},
        })
      );

      expect(mockSendMessage).toHaveBeenCalledTimes(2);
      expect(mockSendMessage).toHaveBeenCalledWith(222, 'Chat B', { parse_mode: 'HTML' });
    });
  });

  // --- M20: Caption-only message ---

  it('publishes caption-only messages when text is undefined (M20)', async () => {
    await adapter.start(mockRelay);

    const ctx = createInboundCtx({ chatId: 12345, chatType: 'private' });
    // Override message to have caption but no text
    (ctx.message as Record<string, unknown>).text = undefined;
    (ctx.message as Record<string, unknown>).caption = 'Photo description';

    await captured.message!(ctx);

    expect(mockRelay.publish).toHaveBeenCalledWith(
      'relay.human.telegram.tg1.12345',
      expect.objectContaining({
        content: 'Photo description',
        channelType: 'dm',
      }),
      { from: 'relay.human.telegram.tg1.bot', replyTo: 'relay.human.telegram.tg1.12345' }
    );
  });
});
