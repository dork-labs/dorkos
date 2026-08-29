import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TelegramAdapter, TELEGRAM_MANIFEST } from '../index.js';
import type { RelayPublisher, RelayLogger, Unsubscribe } from '../../../types.js';
import type { z } from 'zod';
import { TelegramAdapterConfigSchema } from '@dorkos/shared/relay-schemas';
import type { TelegramAdapterConfig } from '../../../types.js';

// --- node:http mock ---
// Replaces the real HTTP server to avoid port-binding in tests and to expose
// server.on / server.once / server.closeAllConnections for assertion.

const mockServerListen = vi.fn();
const mockServerClose = vi.fn();
const mockServerOn = vi.fn();
const mockServerOnce = vi.fn();
const mockServerCloseAllConnections = vi.fn();

/** The last MockServer instance created by createServer() — used in tests. */
let lastMockServer: MockServer | null = null;

class MockServer {
  headersTimeout = 0;
  requestTimeout = 0;
  maxHeadersCount = 0;
  keepAliveTimeout = 0;

  listen(_port: number, cb?: () => void) {
    mockServerListen(_port, cb);
    // Immediately invoke the callback so the listen promise resolves
    cb?.();
    return this;
  }

  close(cb?: (err?: Error) => void) {
    mockServerClose(cb);
    // Immediately invoke the callback with no error so the close promise resolves
    cb?.();
    return this;
  }

  on(event: string, handler: (...args: unknown[]) => void) {
    mockServerOn(event, handler);
    return this;
  }

  once(event: string, handler: (...args: unknown[]) => void) {
    mockServerOnce(event, handler);
    return this;
  }

  closeAllConnections() {
    mockServerCloseAllConnections();
  }
}

vi.mock('node:http', () => ({
  createServer: vi.fn((_handler: unknown) => {
    lastMockServer = new MockServer();
    return lastMockServer;
  }),
}));

// --- grammy mock ---
// We mock the grammy module to avoid real Telegram API calls in tests.

const mockSendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
const mockSendChatAction = vi.fn().mockResolvedValue(true);
const mockSetWebhook = vi.fn().mockResolvedValue(true);
const mockDeleteWebhook = vi.fn().mockResolvedValue(true);
const mockLeaveChat = vi.fn().mockResolvedValue(true);
const mockGetMe = vi.fn().mockResolvedValue({
  id: 777,
  is_bot: true,
  username: 'test_bot',
  can_read_all_group_messages: true,
});
const mockBotInit = vi.fn().mockResolvedValue(undefined);
const mockBotStart = vi.fn().mockResolvedValue(undefined);
const mockBotStop = vi.fn().mockResolvedValue(undefined);
const mockBotCatch = vi.fn();

/** Captured message handler registered via bot.on('message', handler) */
let capturedMessageHandler: ((ctx: unknown) => Promise<void>) | null = null;
/** Captured callback query handler registered via bot.on('callback_query:data', handler) */
let capturedCallbackQueryHandler: ((ctx: unknown) => Promise<void>) | null = null;
/** Captured chat-member handler registered via bot.on('my_chat_member', handler) — DOR-883. */
let capturedChatMemberHandler: ((ctx: unknown) => Promise<void>) | null = null;
/** Captured error handler registered via bot.catch(handler) */
let _capturedErrorHandler: ((err: unknown) => void) | null = null;
/** Captured onStart callback from bot.start({ onStart }) */
let _capturedOnStart: (() => void) | null = null;

vi.mock('grammy', () => {
  class MockBot {
    api = {
      config: {
        use: vi.fn(),
      },
      sendMessage: mockSendMessage,
      sendChatAction: mockSendChatAction,
      setWebhook: mockSetWebhook,
      deleteWebhook: mockDeleteWebhook,
      getMe: mockGetMe,
      leaveChat: mockLeaveChat,
    };

    botInfo = { username: 'test_bot' };

    on(event: string, handler: (ctx: unknown) => Promise<void>) {
      if (event === 'callback_query:data') {
        capturedCallbackQueryHandler = handler;
      } else if (event === 'my_chat_member') {
        capturedChatMemberHandler = handler;
      } else if (event === 'message') {
        capturedMessageHandler = handler;
      }
    }

    catch(handler: (err: unknown) => void) {
      _capturedErrorHandler = handler;
      mockBotCatch(handler);
    }

    async init() {
      return mockBotInit();
    }

    async start(opts?: { drop_pending_updates?: boolean; onStart?: () => void }) {
      _capturedOnStart = opts?.onStart ?? null;
      // Simulate onStart being called immediately for polling mode
      if (opts?.onStart) opts.onStart();
      return mockBotStart(opts);
    }

    async stop() {
      return mockBotStop();
    }
  }

  // webhookCallback returns a simple no-op request handler for tests
  const webhookCallback = vi.fn().mockReturnValue(vi.fn().mockResolvedValue(undefined));

  return { Bot: MockBot, webhookCallback };
});

vi.mock('@grammyjs/auto-retry', () => ({
  autoRetry: vi.fn().mockReturnValue(vi.fn()),
}));

/**
 * A Telegram adapter config with schema defaults filled in.
 *
 * Built through `TelegramAdapterConfigSchema` rather than as an object literal
 * so the fixture inherits every default the real config path applies. When the
 * schema gains a field (as it did with `streaming`), these call sites keep
 * compiling and keep matching production instead of drifting.
 */
function tgConfig(overrides: z.input<typeof TelegramAdapterConfigSchema>): TelegramAdapterConfig {
  return TelegramAdapterConfigSchema.parse(overrides);
}

// --- Relay mock helpers ---

function createMockRelay(): RelayPublisher {
  const signalHandlers: Array<{
    pattern: string;
    handler: (subject: string, signal: { type: string; state: string }) => void;
  }> = [];

  const relay: RelayPublisher = {
    publish: vi.fn().mockResolvedValue({ messageId: 'msg-1', deliveredTo: 1 }),
    subscribe: vi.fn().mockReturnValue(() => {}),
    onSignal: vi
      .fn()
      .mockImplementation(
        (
          pattern: string,
          handler: (subject: string, signal: { type: string; state: string }) => void
        ): Unsubscribe => {
          signalHandlers.push({ pattern, handler });
          return () => {
            const idx = signalHandlers.findIndex((s) => s.handler === handler);
            if (idx >= 0) signalHandlers.splice(idx, 1);
          };
        }
      ),
  };

  // Expose a way to trigger signals from tests
  (
    relay as RelayPublisher & {
      _emitSignal: (subject: string, signal: { type: string; state: string }) => void;
    }
  )._emitSignal = (subject: string, signal: { type: string; state: string }) => {
    for (const { handler } of signalHandlers) {
      handler(subject, signal);
    }
  };

  return relay;
}

/** The bot's own Telegram identity, as grammy exposes it on `ctx.me`. */
const BOT_IDENTITY = { id: 777, is_bot: true, first_name: 'DorkBot', username: 'dorkbot' };

function createInboundCtx(overrides: {
  chatId?: number;
  chatType?: 'private' | 'group' | 'supergroup' | 'channel';
  text?: string;
  firstName?: string;
  lastName?: string;
  username?: string;
  fromId?: number;
  messageId?: number;
  title?: string;
  /** Entities Telegram attached to the text (mentions, commands). */
  entities?: Array<Record<string, unknown>>;
}) {
  const {
    chatId = 12345,
    chatType = 'private',
    text = 'Hello agent!',
    firstName = 'Alice',
    lastName = undefined,
    username = 'alice',
    fromId = 99,
    messageId = 1,
    title,
    entities,
  } = overrides;

  return {
    chat: { id: chatId, type: chatType, ...(title ? { title } : {}) },
    from: { id: fromId, is_bot: false, first_name: firstName, last_name: lastName, username },
    me: BOT_IDENTITY,
    message: { text, message_id: messageId, caption: undefined, entities },
  };
}

function createEnvelope(subject: string, payload: unknown) {
  return {
    id: 'env-01',
    subject,
    from: 'relay.agent.backend',
    budget: {
      hopCount: 0,
      maxHops: 5,
      ancestorChain: [],
      ttl: Date.now() + 3_600_000,
      callBudgetRemaining: 10,
    },
    createdAt: new Date().toISOString(),
    payload,
  };
}

// --- Compliance Suite ---
// NOTE: Compliance suite not run for TelegramAdapter because start() connects
// to the Telegram Bot API via grammy. The compliance suite's createAdapter()
// factory cannot produce an adapter that passes start() without extensive
// mocking of grammy internals. All compliance behaviors (shape, lifecycle,
// idempotency, delivery, status) are covered by the dedicated tests below.

// --- Tests ---

describe('TELEGRAM_MANIFEST', () => {
  it('puts respondMode on a step, so the group setting leads the wizard', () => {
    // The changelog sends people here to restore the old behavior. Every
    // declared field now reaches the screen whether or not a step names it
    // (see `adapters/__tests__/wizard-field-coverage.test.ts`), but this one
    // belongs in the guided flow rather than under Advanced, so it is pinned
    // by name.
    const named = (TELEGRAM_MANIFEST.setupSteps ?? []).flatMap((step) => step.fields);

    expect(named).toContain('respondMode');
  });
});

describe('TelegramAdapter', () => {
  let adapter: TelegramAdapter;
  let mockRelay: ReturnType<typeof createMockRelay>;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedMessageHandler = null;
    capturedCallbackQueryHandler = null;
    _capturedErrorHandler = null;
    _capturedOnStart = null;
    lastMockServer = null;

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

  it('has correct id, subjectPrefix, and displayName', () => {
    expect(adapter.id).toBe('tg1');
    expect(adapter.subjectPrefix).toBe('relay.human.telegram.tg1');
    expect(adapter.displayName).toBe('Telegram');
  });

  it('accepts a custom displayName', () => {
    const custom = new TelegramAdapter(
      'tg-work',
      tgConfig({ token: 'tok', mode: 'polling' }),
      'Work Telegram'
    );
    expect(custom.displayName).toBe('Work Telegram');
  });

  // --- Initial status ---

  it('reports disconnected before start', () => {
    const status = adapter.getStatus();
    expect(status.state).toBe('disconnected');
    expect(status.messageCount.inbound).toBe(0);
    expect(status.messageCount.outbound).toBe(0);
    expect(status.errorCount).toBe(0);
  });

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

  it('start() transitions state to connected', async () => {
    await adapter.start(mockRelay);
    expect(adapter.getStatus().state).toBe('connected');
  });

  it('start() records startedAt timestamp', async () => {
    const before = new Date().toISOString();
    await adapter.start(mockRelay);
    const after = new Date().toISOString();

    const { startedAt } = adapter.getStatus();
    expect(startedAt).toBeDefined();
    expect(startedAt! >= before).toBe(true);
    expect(startedAt! <= after).toBe(true);
  });

  it('start() subscribes to relay signals', async () => {
    await adapter.start(mockRelay);
    expect(mockRelay.onSignal).toHaveBeenCalledWith(
      'relay.human.telegram.tg1.>',
      expect.any(Function)
    );
  });

  it('start() is idempotent — second call is a no-op', async () => {
    await adapter.start(mockRelay);
    await adapter.start(mockRelay); // second call

    // bot.start should only be called once
    expect(mockBotStart).toHaveBeenCalledTimes(1);
  });

  // --- stop() ---

  it('stop() calls bot.stop() and transitions to disconnected', async () => {
    await adapter.start(mockRelay);
    await adapter.stop();

    expect(mockBotStop).toHaveBeenCalled();
    expect(adapter.getStatus().state).toBe('disconnected');
  });

  it('stop() is idempotent — second call is a no-op', async () => {
    await adapter.start(mockRelay);
    await adapter.stop();
    await adapter.stop();

    expect(mockBotStop).toHaveBeenCalledTimes(1);
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

  // --- Inbound messages ---

  it('publishes inbound DM to relay.human.telegram.{chatId}', async () => {
    await adapter.start(mockRelay);

    const ctx = createInboundCtx({ chatId: 12345, chatType: 'private', text: 'Hello!' });
    await capturedMessageHandler!(ctx);

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
    await capturedMessageHandler!(ctx);

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
    await capturedMessageHandler!(ctx);

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

  it('includes platformData with chatId and messageId', async () => {
    await adapter.start(mockRelay);

    // fromId 55 rather than the fixture's 99, so this also proves the id the
    // payload reports is the AUTHOR's and not the chat's.
    const ctx = createInboundCtx({ chatId: 99, messageId: 7, fromId: 55 });
    await capturedMessageHandler!(ctx);

    expect(mockRelay.publish).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        platformData: expect.objectContaining({
          chatId: 99,
          messageId: 7,
          fromId: 55,
        }),
      }),
      expect.any(Object)
    );
  });

  it('skips messages with no text and no caption', async () => {
    await adapter.start(mockRelay);

    const ctx = {
      chat: { id: 1, type: 'private' },
      from: { id: 1, first_name: 'A', username: 'a' },
      message: { text: '', caption: undefined, message_id: 1 },
    };
    await capturedMessageHandler!(ctx);

    expect(mockRelay.publish).not.toHaveBeenCalled();
  });

  it('increments inbound message count after successful publish', async () => {
    await adapter.start(mockRelay);

    const ctx = createInboundCtx({ text: 'Hi' });
    await capturedMessageHandler!(ctx);

    expect(adapter.getStatus().messageCount.inbound).toBe(1);
  });

  it('records error when publish fails but does not throw', async () => {
    vi.mocked(mockRelay.publish).mockRejectedValueOnce(new Error('Relay unavailable'));

    await adapter.start(mockRelay);

    const ctx = createInboundCtx({ text: 'Hi' });
    await expect(capturedMessageHandler!(ctx)).resolves.toBeUndefined();

    expect(adapter.getStatus().errorCount).toBe(1);
    expect(adapter.getStatus().lastError).toContain('Relay unavailable');
  });

  // --- chat-member updates (DOR-883: the group-add claim flow's entry point) ---

  it("wires 'my_chat_member' and publishes when the bot is added to a group", async () => {
    await adapter.start(mockRelay);
    expect(capturedChatMemberHandler).not.toBeNull();

    await capturedChatMemberHandler!({
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

  it("does not publish for a 'my_chat_member' update that is not an add (e.g. a promotion)", async () => {
    await adapter.start(mockRelay);

    await capturedChatMemberHandler!({
      myChatMember: {
        chat: { id: -100999, type: 'supergroup', title: 'Ops' },
        from: { id: 42, is_bot: false, first_name: 'Ana', username: 'ana' },
        date: 0,
        old_chat_member: { status: 'member', user: BOT_IDENTITY },
        new_chat_member: { status: 'administrator', user: BOT_IDENTITY },
      },
    });

    expect(mockRelay.publish).not.toHaveBeenCalled();
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

  it('deliver() allows messages from non-telegram sources', async () => {
    await adapter.start(mockRelay);

    const envelope = createEnvelope('relay.human.telegram.tg1.12345', { content: 'Agent reply' });
    // from is 'relay.agent.backend' — should NOT be filtered
    const result = await adapter.deliver('relay.human.telegram.tg1.12345', envelope);
    expect(result.success).toBe(true);
    expect(mockSendMessage).toHaveBeenCalledWith(12345, 'Agent reply', { parse_mode: 'HTML' });
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

  it('deliver() sends to group chat ID (negative)', async () => {
    await adapter.start(mockRelay);

    const envelope = createEnvelope('relay.human.telegram.tg1.group.-100111222', 'Group reply');
    await adapter.deliver('relay.human.telegram.tg1.group.-100111222', envelope);

    expect(mockSendMessage).toHaveBeenCalledWith(-100111222, 'Group reply', { parse_mode: 'HTML' });
  });

  it('deliver() increments outbound message count', async () => {
    await adapter.start(mockRelay);

    const envelope = createEnvelope('relay.human.telegram.tg1.1', { content: 'hi' });
    await adapter.deliver('relay.human.telegram.tg1.1', envelope);

    expect(adapter.getStatus().messageCount.outbound).toBe(1);
  });

  it('deliver() splits content exceeding 4096 characters into multiple messages', async () => {
    await adapter.start(mockRelay);

    const longContent = 'A'.repeat(5000);
    const envelope = createEnvelope('relay.human.telegram.tg1.1', { content: longContent });
    await adapter.deliver('relay.human.telegram.tg1.1', envelope);

    // Should send 2 messages: first chunk (4096 chars) + remainder
    expect(vi.mocked(mockSendMessage)).toHaveBeenCalledTimes(2);
    const firstChunk = vi.mocked(mockSendMessage).mock.calls[0][1] as string;
    const secondChunk = vi.mocked(mockSendMessage).mock.calls[1][1] as string;
    expect(firstChunk.length).toBeLessThanOrEqual(4096);
    expect(firstChunk.length + secondChunk.length).toBe(5000);
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

  it('deliver() returns failure for invalid subject (non-telegram prefix)', async () => {
    await adapter.start(mockRelay);

    const envelope = createEnvelope('relay.agent.backend', { content: 'hi' });
    const result = await adapter.deliver('relay.agent.backend', envelope);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cannot extract chat ID/);
  });

  it('deliver() returns failure if not started', async () => {
    const envelope = createEnvelope('relay.human.telegram.tg1.1', { content: 'hi' });
    const result = await adapter.deliver('relay.human.telegram.tg1.1', envelope);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not started/);
  });

  it('deliver() records error and returns failure when sendMessage fails', async () => {
    mockSendMessage.mockRejectedValueOnce(new Error('Telegram API error'));

    await adapter.start(mockRelay);

    const envelope = createEnvelope('relay.human.telegram.tg1.1', { content: 'hi' });
    const result = await adapter.deliver('relay.human.telegram.tg1.1', envelope);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Telegram API error/);

    expect(adapter.getStatus().errorCount).toBe(1);
  });

  // --- Outbound message payload extraction ---

  describe('outbound message payload extraction', () => {
    it('handles string payload', async () => {
      await adapter.start(mockRelay);

      const envelope = createEnvelope('relay.human.telegram.tg1.12345', 'plain text message');
      await adapter.deliver('relay.human.telegram.tg1.12345', envelope);

      expect(mockSendMessage).toHaveBeenCalledWith(12345, 'plain text message', {
        parse_mode: 'HTML',
      });
    });

    it('handles object payload with content field', async () => {
      await adapter.start(mockRelay);

      const envelope = createEnvelope('relay.human.telegram.tg1.12345', {
        content: 'structured message',
        metadata: {},
      });
      await adapter.deliver('relay.human.telegram.tg1.12345', envelope);

      expect(mockSendMessage).toHaveBeenCalledWith(12345, 'structured message', {
        parse_mode: 'HTML',
      });
    });

    it('handles object payload with text field', async () => {
      await adapter.start(mockRelay);

      const envelope = createEnvelope('relay.human.telegram.tg1.12345', {
        text: 'text field message',
        metadata: {},
      });
      await adapter.deliver('relay.human.telegram.tg1.12345', envelope);

      expect(mockSendMessage).toHaveBeenCalledWith(12345, 'text field message', {
        parse_mode: 'HTML',
      });
    });

    it('handles object payload without content or text — falls back to JSON', async () => {
      await adapter.start(mockRelay);

      const payload = { data: 'raw data', count: 5 };
      const envelope = createEnvelope('relay.human.telegram.tg1.12345', payload);
      await adapter.deliver('relay.human.telegram.tg1.12345', envelope);

      expect(mockSendMessage).toHaveBeenCalledWith(12345, JSON.stringify(payload), {
        parse_mode: 'HTML',
      });
    });

    it('handles null payload', async () => {
      await adapter.start(mockRelay);

      const envelope = createEnvelope('relay.human.telegram.tg1.12345', null);
      await adapter.deliver('relay.human.telegram.tg1.12345', envelope);

      expect(mockSendMessage).toHaveBeenCalledWith(12345, 'null', { parse_mode: 'HTML' });
    });

    it('handles numeric payload', async () => {
      await adapter.start(mockRelay);

      const envelope = createEnvelope('relay.human.telegram.tg1.12345', 42);
      await adapter.deliver('relay.human.telegram.tg1.12345', envelope);

      expect(mockSendMessage).toHaveBeenCalledWith(12345, '42', { parse_mode: 'HTML' });
    });
  });

  // --- Float chat ID rejection (Number.isInteger guard) ---

  it('deliver() rejects a float DM subject (e.g. relay.human.telegram.tg1.1.5)', async () => {
    await adapter.start(mockRelay);

    const envelope = createEnvelope('relay.human.telegram.tg1.1.5', { content: 'hi' });
    const result = await adapter.deliver('relay.human.telegram.tg1.1.5', envelope);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cannot extract chat ID/);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('deliver() rejects a float group subject (e.g. relay.human.telegram.tg1.group.1.5)', async () => {
    await adapter.start(mockRelay);

    const envelope = createEnvelope('relay.human.telegram.tg1.group.1.5', { content: 'hi' });
    const result = await adapter.deliver('relay.human.telegram.tg1.group.1.5', envelope);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cannot extract chat ID/);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('typing signal is not forwarded for a float DM subject', async () => {
    await adapter.start(mockRelay);

    const relay = mockRelay as ReturnType<typeof createMockRelay> & {
      _emitSignal: (subject: string, signal: { type: string; state: string }) => void;
    };
    relay._emitSignal('relay.human.telegram.tg1.1.5', { type: 'typing', state: 'active' });

    await Promise.resolve();

    expect(mockSendChatAction).not.toHaveBeenCalled();
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

  it('ignores typing signals when state is not active', async () => {
    await adapter.start(mockRelay);

    const relay = mockRelay as ReturnType<typeof createMockRelay> & {
      _emitSignal: (subject: string, signal: { type: string; state: string }) => void;
    };
    relay._emitSignal('relay.human.telegram.tg1.12345', { type: 'typing', state: 'stopped' });

    await Promise.resolve();

    expect(mockSendChatAction).not.toHaveBeenCalled();
  });

  it('ignores non-typing signals (presence, read_receipt, etc.)', async () => {
    await adapter.start(mockRelay);

    const relay = mockRelay as ReturnType<typeof createMockRelay> & {
      _emitSignal: (subject: string, signal: { type: string; state: string }) => void;
    };
    relay._emitSignal('relay.human.telegram.tg1.12345', { type: 'presence', state: 'online' });

    await Promise.resolve();

    expect(mockSendChatAction).not.toHaveBeenCalled();
  });

  // --- 'progress' signal (spec §6.8: the bridge's presence forwarder) ---

  it('forwards an active progress signal to Telegram as chat action, same as typing', async () => {
    // publishPresence deliberately emits 'progress', not 'typing' — agents
    // work, they do not type. This must land on the same indicator through
    // the same handler, not a second one.
    await adapter.start(mockRelay);

    const relay = mockRelay as ReturnType<typeof createMockRelay> & {
      _emitSignal: (subject: string, signal: { type: string; state: string }) => void;
    };
    relay._emitSignal('relay.human.telegram.tg1.12345', { type: 'progress', state: 'active' });

    await Promise.resolve();

    expect(mockSendChatAction).toHaveBeenCalledWith(12345, 'typing');
  });

  it('clears the indicator when a progress signal reports non-active', async () => {
    // A released claim must clear the indicator — same honesty property the
    // 'typing' branch already has (the indicator lives exactly as long as
    // the turn claim).
    await adapter.start(mockRelay);

    const relay = mockRelay as ReturnType<typeof createMockRelay> & {
      _emitSignal: (subject: string, signal: { type: string; state: string }) => void;
    };
    relay._emitSignal('relay.human.telegram.tg1.12345', { type: 'progress', state: 'active' });
    await Promise.resolve();
    expect(mockSendChatAction).toHaveBeenCalledWith(12345, 'typing');

    mockSendChatAction.mockClear();
    relay._emitSignal('relay.human.telegram.tg1.12345', { type: 'progress', state: 'stopped' });
    await Promise.resolve();

    // 'stopped' does not itself send a chat action (matches the 'typing'
    // branch's own behavior); the negative control is that a second 'active'
    // still works, proving the branch is live rather than a no-op that
    // happens to pass because nothing asserts a call.
    relay._emitSignal('relay.human.telegram.tg1.12345', { type: 'progress', state: 'active' });
    await Promise.resolve();
    expect(mockSendChatAction).toHaveBeenCalledWith(12345, 'typing');
  });

  it('swallows errors from typing signal forwarding', async () => {
    mockSendChatAction.mockRejectedValueOnce(new Error('Rate limited'));

    await adapter.start(mockRelay);

    const relay = mockRelay as ReturnType<typeof createMockRelay> & {
      _emitSignal: (subject: string, signal: { type: string; state: string }) => void;
    };

    // Should not throw
    relay._emitSignal('relay.human.telegram.tg1.12345', { type: 'typing', state: 'active' });
    await Promise.resolve();

    // Error count should NOT be incremented for typing signal failures
    expect(adapter.getStatus().errorCount).toBe(0);
  });

  // --- Typing is driven by the turn, not by the message arriving ---

  it('shows no typing for a message that starts no turn', async () => {
    await adapter.start(mockRelay);

    const ctx = createInboundCtx({ chatId: 12345, text: 'Hello agent!' });
    await capturedMessageHandler!(ctx);

    // Publishing is not working. Nothing downstream has claimed this message,
    // and it may never be answered — so the chat is told nothing (E16/E16a).
    expect(mockSendChatAction).not.toHaveBeenCalled();
  });

  it('starts typing when the turn starts, not when the message arrives', async () => {
    await adapter.start(mockRelay);

    const ctx = createInboundCtx({ chatId: 12345, text: 'Hello!' });
    await capturedMessageHandler!(ctx);
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

    await capturedMessageHandler!(createInboundCtx({ chatId: 12345, text: 'Hello!' }));
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

  it('testConnection() returns ok with botUsername when init succeeds', async () => {
    const result = await adapter.testConnection();
    expect(result).toEqual({ ok: true, botUsername: 'test_bot' });
  });

  it('testConnection() returns error when init fails', async () => {
    mockBotInit.mockRejectedValueOnce(new Error('Unauthorized: invalid token'));
    const result = await adapter.testConnection();
    expect(result).toEqual({ ok: false, error: 'Unauthorized: invalid token' });
  });

  it('testConnection() does NOT start the polling loop', async () => {
    await adapter.testConnection();
    expect(mockBotStart).not.toHaveBeenCalled();
  });

  it('testConnection() does not alter adapter state', async () => {
    await adapter.testConnection();
    expect(adapter.getStatus().state).toBe('disconnected');
  });

  // --- getMe() (spec §8, §11.2: the platform is the source of truth for
  // group visibility, never config) ---

  it('getMe() returns null before the adapter has connected', async () => {
    // No live bot to ask yet — this must not spin one up the way
    // testConnection() does.
    const result = await adapter.getMe();
    expect(result).toBeNull();
    expect(mockGetMe).not.toHaveBeenCalled();
  });

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

  it('getMe() reports privacy mode ON (the Telegram default) honestly', async () => {
    // The negative control: a bot that has NOT had privacy mode turned off
    // must report false, not default to the permissive value.
    mockGetMe.mockResolvedValueOnce({
      id: 777,
      is_bot: true,
      username: 'dorkbot',
      can_read_all_group_messages: false,
    });
    await adapter.start(mockRelay);

    const result = await adapter.getMe();

    expect(result).toEqual({ username: 'dorkbot', canReadAllGroupMessages: false });
  });

  it('getMe() makes a live API call every time — not a cached read of botInfo', async () => {
    await adapter.start(mockRelay);
    mockGetMe.mockClear();

    await adapter.getMe();
    await adapter.getMe();

    expect(mockGetMe).toHaveBeenCalledTimes(2);
  });

  it('getMe() throws rather than swallowing a failed API call into null', async () => {
    await adapter.start(mockRelay);
    mockGetMe.mockRejectedValueOnce(new Error('Unauthorized: revoked token'));

    await expect(adapter.getMe()).rejects.toThrow('Unauthorized: revoked token');
  });

  // --- leaveChat() (DOR-883: the group-add claim flow's "Leave" action) ---

  it('leaveChat() throws when the adapter has not connected — no live bot to ask', async () => {
    await expect(adapter.leaveChat('555')).rejects.toThrow(/not connected/i);
    expect(mockLeaveChat).not.toHaveBeenCalled();
  });

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

  // --- Webhook mode ---

  it('webhook mode: calls setWebhook and starts webhook server', async () => {
    const webhookAdapter = new TelegramAdapter(
      'tg-webhook',
      tgConfig({
        token: 'test-token',
        mode: 'webhook',
        webhookUrl: 'https://example.com/webhook',
        webhookPort: 8443,
      })
    );

    await webhookAdapter.start(mockRelay);

    expect(mockSetWebhook).toHaveBeenCalledWith(
      'https://example.com/webhook',
      expect.objectContaining({ secret_token: expect.any(String) })
    );

    await webhookAdapter.stop();
  });

  it('webhook mode: throws if webhookUrl is missing', async () => {
    const webhookAdapter = new TelegramAdapter(
      'tg-webhook',
      tgConfig({
        token: 'test-token',
        mode: 'webhook',
        // no webhookUrl
      })
    );

    await expect(webhookAdapter.start(mockRelay)).rejects.toThrow('webhookUrl is required');
  });

  // --- getStatus() defensiveness ---

  it('getStatus() returns a copy — mutations do not affect internal state', async () => {
    await adapter.start(mockRelay);

    const status = adapter.getStatus();
    status.errorCount = 999;

    expect(adapter.getStatus().errorCount).toBe(0);
  });

  // --- C3: Webhook secret token ---

  it('webhook mode: passes secret_token to setWebhook and webhookCallback', async () => {
    const { webhookCallback } = await import('grammy');

    const webhookAdapter = new TelegramAdapter(
      'tg-webhook',
      tgConfig({
        token: 'test-token',
        mode: 'webhook',
        webhookUrl: 'https://example.com/webhook',
        webhookPort: 8443,
        webhookSecret: 'my-fixed-secret',
      })
    );

    await webhookAdapter.start(mockRelay);

    // setWebhook should receive the secret_token option
    expect(mockSetWebhook).toHaveBeenCalledWith('https://example.com/webhook', {
      secret_token: 'my-fixed-secret',
    });

    // webhookCallback should receive the secretToken option
    expect(webhookCallback).toHaveBeenCalledWith(expect.anything(), 'http', {
      secretToken: 'my-fixed-secret',
    });

    await webhookAdapter.stop();
  });

  it('webhook mode: auto-generates secret when webhookSecret is not provided', async () => {
    const webhookAdapter = new TelegramAdapter(
      'tg-webhook',
      tgConfig({
        token: 'test-token',
        mode: 'webhook',
        webhookUrl: 'https://example.com/webhook',
        webhookPort: 8443,
      })
    );

    await webhookAdapter.start(mockRelay);

    // Should still pass a secret_token (auto-generated)
    expect(mockSetWebhook).toHaveBeenCalledWith(
      'https://example.com/webhook',
      expect.objectContaining({ secret_token: expect.any(String) })
    );

    // The auto-generated secret should be non-empty
    const calledSecret = mockSetWebhook.mock.calls[0][1].secret_token as string;
    expect(calledSecret.length).toBeGreaterThan(0);

    await webhookAdapter.stop();
  });

  // --- I7: Polling reconnection with exponential backoff ---

  it('reconnects with backoff when polling fails', async () => {
    vi.useFakeTimers();

    // First bot.start() rejects to simulate a polling failure
    let startCallCount = 0;
    mockBotStart.mockImplementation(async (opts?: { onStart?: () => void }) => {
      startCallCount++;
      if (startCallCount === 1) {
        // First call: succeeds initially then "crashes" — simulate with rejection
        if (opts?.onStart) opts.onStart();
        // After the polling loop "starts", simulate a late rejection
        throw new Error('Polling connection lost');
      }
      // Subsequent reconnect calls succeed
      if (opts?.onStart) opts.onStart();
    });

    await adapter.start(mockRelay);

    // Allow the .catch() handler on bot.start() to execute
    await vi.advanceTimersByTimeAsync(0);

    // Error should have been recorded
    expect(adapter.getStatus().errorCount).toBe(1);

    // Advance past first reconnect delay (5000ms)
    await vi.advanceTimersByTimeAsync(5_000);

    // The adapter should attempt to reconnect (new bot created and init called)
    // Initial init(1) + reconnect init(2)
    expect(mockBotInit).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  // --- D3: startedAt cleared on stop ---

  it('stop() clears startedAt from status', async () => {
    await adapter.start(mockRelay);
    expect(adapter.getStatus().startedAt).toBeDefined();

    await adapter.stop();
    expect(adapter.getStatus().startedAt).toBeUndefined();
  });

  // --- D4: Inbound content capped at 32KB ---

  it('caps inbound message content at MAX_CONTENT_LENGTH (32KB)', async () => {
    await adapter.start(mockRelay);

    const longText = 'X'.repeat(40_000);
    const ctx = createInboundCtx({ text: longText });
    await capturedMessageHandler!(ctx);

    const publishedPayload = vi.mocked(mockRelay.publish).mock.calls[0][1] as { content: string };
    expect(publishedPayload.content.length).toBe(32_768);
  });

  it('does not truncate inbound content under 32KB', async () => {
    await adapter.start(mockRelay);

    const normalText = 'Hello world';
    const ctx = createInboundCtx({ text: normalText });
    await capturedMessageHandler!(ctx);

    const publishedPayload = vi.mocked(mockRelay.publish).mock.calls[0][1] as { content: string };
    expect(publishedPayload.content).toBe('Hello world');
  });

  // --- C1: Reconnection stops old bot before creating a new one ---

  it('reconnection stops old bot before creating a new one (C1)', async () => {
    vi.useFakeTimers();

    // First bot.start() rejects immediately to trigger handlePollingError
    mockBotStart.mockImplementationOnce(async (opts?: { onStart?: () => void }) => {
      if (opts?.onStart) opts.onStart();
      throw new Error('Polling connection lost');
    });

    await adapter.start(mockRelay);

    // Allow the .catch() on bot.start() to execute
    await vi.advanceTimersByTimeAsync(0);

    // Clear the call count from startup
    mockBotStop.mockClear();

    // Advance past first reconnect delay (5000ms) — timer fires, old bot.stop() is called
    await vi.advanceTimersByTimeAsync(5_000);

    // The old bot's stop() should have been called before the new bot was created
    expect(mockBotStop).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  // --- H4: Reconnect re-registers ALL handlers, not just message ---

  it('reconnect re-registers the callback_query handler so approval buttons keep working (H4)', async () => {
    vi.useFakeTimers();

    mockBotStart.mockImplementationOnce(async (opts?: { onStart?: () => void }) => {
      if (opts?.onStart) opts.onStart();
      throw new Error('Polling connection lost');
    });

    await adapter.start(mockRelay);
    await vi.advanceTimersByTimeAsync(0);

    // The reconnect path builds a fresh Bot — reset captures so we can assert
    // the new bot got the full handler set, not just the message handler.
    capturedMessageHandler = null;
    capturedCallbackQueryHandler = null;

    await vi.advanceTimersByTimeAsync(5_000);

    expect(capturedMessageHandler).not.toBeNull();
    expect(capturedCallbackQueryHandler).not.toBeNull();

    vi.useRealTimers();
  });

  it('approval buttons work end-to-end after a polling reconnect (H4)', async () => {
    vi.useFakeTimers();

    mockBotStart.mockImplementationOnce(async (opts?: { onStart?: () => void }) => {
      if (opts?.onStart) opts.onStart();
      throw new Error('Polling connection lost');
    });

    await adapter.start(mockRelay);
    await vi.advanceTimersByTimeAsync(0);
    capturedCallbackQueryHandler = null;
    await vi.advanceTimersByTimeAsync(5_000);
    vi.useRealTimers();

    // Deliver an approval card, then press Approve via the RE-REGISTERED handler
    const approvalEnvelope = createEnvelope('relay.human.telegram.tg1.12345', {
      type: 'approval_required',
      data: {
        toolCallId: 'toolu_reconnect',
        toolName: 'Write',
        input: '{"path":"src/index.ts"}',
        timeoutMs: 0,
        agentId: 'agent-1',
        ccaSessionKey: 'sess-abc',
      },
    });
    const deliverResult = await adapter.deliver('relay.human.telegram.tg1.12345', approvalEnvelope);
    expect(deliverResult.success).toBe(true);

    // Extract the callback_data Telegram would echo back on button press
    const sendCall = mockSendMessage.mock.calls.at(-1)!;
    const keyboard = (
      sendCall[2] as { reply_markup: { inline_keyboard: { callback_data: string }[][] } }
    ).reply_markup.inline_keyboard[0];
    const approveData = keyboard[0].callback_data;

    const ctx = {
      callbackQuery: { data: approveData },
      from: { id: 42 },
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
      editMessageText: vi.fn().mockResolvedValue(true),
    };
    await capturedCallbackQueryHandler!(ctx);

    expect(mockRelay.publish).toHaveBeenCalledWith(
      'relay.system.approval.agent-1',
      expect.objectContaining({
        type: 'approval_response',
        toolCallId: 'toolu_reconnect',
        sessionId: 'sess-abc',
        approved: true,
        respondedBy: '42',
        platform: 'telegram',
      }),
      { from: 'telegram:42' }
    );
    // Decision edit uses HTML parse mode (legacy Markdown hard-fails)
    expect(ctx.editMessageText).toHaveBeenCalledWith('✅ <b>Tool Approved</b>', {
      parse_mode: 'HTML',
    });
  });

  /**
   * DOR-609. The approval card lands in the same chat that asked for the turn,
   * so without this check the person who sent the message could approve their
   * own tool call with one tap. `respondedBy` recorded who acted; nothing
   * decided who may.
   */
  describe('approval authorization', () => {
    /** Deliver a card and press Approve as `userId`. */
    async function pressApproveAs(userId: number) {
      await adapter.start(mockRelay);
      const envelope = createEnvelope('relay.human.telegram.tg1.12345', {
        type: 'approval_required',
        data: {
          toolCallId: 'toolu_auth',
          toolName: 'Bash',
          input: '{"command":"rm -rf ~"}',
          timeoutMs: 0,
          agentId: 'agent-1',
          ccaSessionKey: 'sess-abc',
        },
      });
      await adapter.deliver('relay.human.telegram.tg1.12345', envelope);

      const sendCall = mockSendMessage.mock.calls.at(-1)!;
      const approveData = (
        sendCall[2] as { reply_markup: { inline_keyboard: { callback_data: string }[][] } }
      ).reply_markup.inline_keyboard[0][0].callback_data;

      const ctx = {
        callbackQuery: { data: approveData },
        from: { id: userId },
        answerCallbackQuery: vi.fn().mockResolvedValue(true),
        editMessageText: vi.fn().mockResolvedValue(true),
      };
      vi.mocked(mockRelay.publish).mockClear();
      await capturedCallbackQueryHandler!(ctx);
      return ctx;
    }

    it('refuses a user who is not on the approver list', async () => {
      const ctx = await pressApproveAs(9999);

      expect(mockRelay.publish).not.toHaveBeenCalled();
      expect(ctx.editMessageText).not.toHaveBeenCalled();
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
        expect.objectContaining({ show_alert: true })
      );
    });

    it('allows the named approver', async () => {
      await pressApproveAs(42);

      expect(mockRelay.publish).toHaveBeenCalledWith(
        'relay.system.approval.agent-1',
        expect.objectContaining({ approved: true, respondedBy: '42' }),
        { from: 'telegram:42' }
      );
    });

    it('refuses everyone when no approver list is configured', async () => {
      adapter = new TelegramAdapter('tg1', tgConfig({ token: 'test-token', mode: 'polling' }));
      const ctx = await pressApproveAs(42);

      expect(mockRelay.publish).not.toHaveBeenCalled();
      expect(ctx.editMessageText).not.toHaveBeenCalled();
    });
  });

  /**
   * DOR-1509. grammY builds its request URL as
   * `https://api.telegram.org/bot<TOKEN>/<method>` — the bot token lives in
   * the URL path, not a header. On Node, grammY fetches through `node-fetch`,
   * whose `FetchError` bakes that URL directly into its own top-level
   * `.message` for every network-level failure (timeout, connection refused,
   * DNS failure, a bad redirect — confirmed against `node-fetch@2.7.0`'s
   * `lib/index.js`, e.g. `` `request to ${request.url} failed, reason: ...` ``).
   * grammY wraps that in its own `HttpError`, whose *own* `.message` stays
   * safe by default (`sensitiveLogs` defaults to `false`, never overridden in
   * this repo) — but the raw, token-bearing `FetchError` still sits one
   * property access away, on `HttpError.error`. This reproduces exactly that
   * shape and asserts the nested property is never touched.
   */
  describe('error logging never leaks the bot token (DOR-1509)', () => {
    const LEAKED_TOKEN = 'should-never-appear-in-logs';

    /**
     * Reproduces node-fetch@2.7.0's real `FetchError` shape (the class
     * grammY throws on every network-level failure on Node), not just a
     * plain `Error`. node-fetch predates ES6 classes: its `FetchError`
     * constructor calls `Error.call(this, message)` and then explicitly does
     * `this.message = message` — which, unlike a `class X extends Error`
     * subclass's `super()` (confirmed empirically: a bare `new Error(...)`
     * has NO own enumerable keys), makes `.message` an OWN ENUMERABLE
     * property. That is what lets the token-bearing URL survive
     * `JSON.stringify` and an object spread (`{...err}`) with no `toJSON()`
     * involved at all — exactly what DorkOS's own NDJSON file reporter does
     * with an object-shaped second logger argument
     * (`apps/server/src/lib/logger.ts`'s `createFileReporter`: an object
     * second arg becomes `context`, spread as `{ ...context }` and
     * `JSON.stringify`d).
     */
    function fakeNodeFetchError(message: string): Error {
      const err = new Error(message);
      Object.defineProperty(err, 'message', { value: message, enumerable: true });
      return err;
    }

    class FakeGrammyHttpError extends Error {
      readonly error: unknown;
      constructor(safeMessage: string, rawFetchError: unknown) {
        super(safeMessage);
        this.name = 'HttpError';
        this.error = rawFetchError;
      }
    }

    it('keeps the bot token out of every logger call when a Telegram send fails at the network level', async () => {
      const logger: RelayLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      adapter.setLogger(logger);
      await adapter.start(mockRelay);

      const leakedUrl = `https://api.telegram.org/bot${LEAKED_TOKEN}/sendMessage`;
      const rawFetchError = fakeNodeFetchError(
        `request to ${leakedUrl} failed, reason: getaddrinfo ENOTFOUND api.telegram.org`
      );
      const safeMessage = "Network request for 'sendMessage' failed!";

      const envelope = createEnvelope('relay.human.telegram.tg1.12345', {
        type: 'approval_required',
        data: {
          toolCallId: 'toolu_leak',
          toolName: 'Bash',
          input: '{"command":"echo hi"}',
          timeoutMs: 0,
          agentId: 'agent-1',
          ccaSessionKey: 'sess-leak',
        },
      });
      await adapter.deliver('relay.human.telegram.tg1.12345', envelope);

      const sendCall = mockSendMessage.mock.calls.at(-1)!;
      const approveData = (
        sendCall[2] as { reply_markup: { inline_keyboard: { callback_data: string }[][] } }
      ).reply_markup.inline_keyboard[0][0].callback_data;

      vi.mocked(mockRelay.publish).mockRejectedValueOnce(
        new FakeGrammyHttpError(safeMessage, rawFetchError)
      );

      const ctx = {
        callbackQuery: { data: approveData },
        from: { id: 42 },
        answerCallbackQuery: vi.fn().mockResolvedValue(true),
        editMessageText: vi.fn().mockResolvedValue(true),
      };
      await capturedCallbackQueryHandler!(ctx);

      expect(logger.error).toHaveBeenCalledWith(
        '[Telegram] callback query handler error:',
        expect.objectContaining({ message: safeMessage })
      );

      // Load-bearing: scans every argument ever handed to every logger method,
      // stringified, the same way a regression back to
      // `logger.error('...', err)` would actually surface the leak (reading
      // `err.error.message` directly, or spreading `err`, would put the URL —
      // and the token in it — into this string).
      const everyLoggedArg = [
        ...vi.mocked(logger.debug).mock.calls,
        ...vi.mocked(logger.info).mock.calls,
        ...vi.mocked(logger.warn).mock.calls,
        ...vi.mocked(logger.error).mock.calls,
      ];
      const serialized = JSON.stringify(everyLoggedArg);
      expect(serialized).not.toContain(LEAKED_TOKEN);
      expect(serialized).not.toContain(leakedUrl);
    });
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

  // --- C2: stop() clears pending reconnect timer ---

  it('stop() clears pending reconnect timer so it does not fire after stop (C2)', async () => {
    vi.useFakeTimers();

    // First bot.start() rejects immediately to trigger handlePollingError
    mockBotStart.mockImplementationOnce(async (opts?: { onStart?: () => void }) => {
      if (opts?.onStart) opts.onStart();
      throw new Error('Polling connection lost');
    });

    await adapter.start(mockRelay);

    // Allow the .catch() on bot.start() to execute — error is recorded
    await vi.advanceTimersByTimeAsync(0);

    // Stop the adapter while the reconnect timer is still pending
    await adapter.stop();

    // Clear call counts so we can detect any spurious calls
    mockBotInit.mockClear();
    mockBotStart.mockClear();

    // Advance past the reconnect delay — the timer should NOT fire
    await vi.advanceTimersByTimeAsync(10_000);

    // No new polling loop should have been started
    expect(mockBotInit).not.toHaveBeenCalled();
    expect(mockBotStart).not.toHaveBeenCalled();
    expect(adapter.getStatus().state).toBe('disconnected');

    vi.useRealTimers();
  });

  it('reconnect timer does not fire when adapter is in stopping state (C2)', async () => {
    vi.useFakeTimers();

    // First bot.start() rejects immediately to trigger handlePollingError
    mockBotStart.mockImplementationOnce(async (opts?: { onStart?: () => void }) => {
      if (opts?.onStart) opts.onStart();
      throw new Error('Polling connection lost');
    });

    await adapter.start(mockRelay);

    // Allow the .catch() on bot.start() to execute
    await vi.advanceTimersByTimeAsync(0);

    // Manually set status to 'stopping' to simulate mid-stop state check
    // (tests the guard inside the timer callback)
    const statusBefore = adapter.getStatus();
    expect(statusBefore.errorCount).toBe(1);

    // Stop clears the timer, so reconnect guard check on 'stopping' is
    // exercised only if stop() didn't already cancel the timer. To test
    // the guard independently, we verify stop() transitions through stopping.
    const stopPromise = adapter.stop();

    // During stop, state transitions to 'stopping' — timer should already
    // be cleared by the time stop() returns
    await stopPromise;

    mockBotInit.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(mockBotInit).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  // --- C4: Webhook server startup uses server.once for error handler ---

  it('webhook startup registers the error handler with once() not on() (C4)', async () => {
    const webhookAdapter = new TelegramAdapter(
      'tg-webhook',
      tgConfig({
        token: 'test-token',
        mode: 'webhook',
        webhookUrl: 'https://example.com/webhook',
        webhookPort: 8443,
      })
    );

    await webhookAdapter.start(mockRelay);

    // once() must have been called with 'error' so the handler is removed
    // after the promise settles — preventing a listener leak on later errors.
    expect(mockServerOnce).toHaveBeenCalledWith('error', expect.any(Function));

    // on() must NOT have been called with 'error' (that would be the leaky path)
    const onErrorCalls = (mockServerOn.mock.calls as Array<[string, unknown]>).filter(
      ([event]) => event === 'error'
    );
    expect(onErrorCalls).toHaveLength(0);

    await webhookAdapter.stop();
  });

  // --- C5: Webhook server shutdown calls closeAllConnections() before close() ---

  it('stop() calls closeAllConnections() before server.close() (C5)', async () => {
    const webhookAdapter = new TelegramAdapter(
      'tg-webhook',
      tgConfig({
        token: 'test-token',
        mode: 'webhook',
        webhookUrl: 'https://example.com/webhook',
        webhookPort: 8443,
      })
    );

    await webhookAdapter.start(mockRelay);

    // Capture call order by recording the sequence of calls
    const callOrder: string[] = [];
    mockServerCloseAllConnections.mockImplementation(() => callOrder.push('closeAllConnections'));
    mockServerClose.mockImplementation((cb?: (err?: Error) => void) => {
      callOrder.push('close');
      cb?.();
    });

    await webhookAdapter.stop();

    expect(callOrder).toEqual(['closeAllConnections', 'close']);
  });

  // --- M8: Webhook cleanup on stop ---

  it('stop() calls deleteWebhook() in webhook mode (M8)', async () => {
    const webhookAdapter = new TelegramAdapter(
      'tg-webhook',
      tgConfig({
        token: 'test-token',
        mode: 'webhook',
        webhookUrl: 'https://example.com/webhook',
        webhookPort: 8443,
      })
    );

    await webhookAdapter.start(mockRelay);
    await webhookAdapter.stop();

    expect(mockDeleteWebhook).toHaveBeenCalledOnce();
  });

  it('stop() does not call deleteWebhook() in polling mode', async () => {
    await adapter.start(mockRelay);
    await adapter.stop();

    expect(mockDeleteWebhook).not.toHaveBeenCalled();
  });

  it('stop() succeeds even when deleteWebhook() throws', async () => {
    const webhookAdapter = new TelegramAdapter(
      'tg-webhook',
      tgConfig({
        token: 'test-token',
        mode: 'webhook',
        webhookUrl: 'https://example.com/webhook',
        webhookPort: 8443,
      })
    );

    await webhookAdapter.start(mockRelay);
    mockDeleteWebhook.mockRejectedValueOnce(new Error('Network error'));

    await expect(webhookAdapter.stop()).resolves.toBeUndefined();
  });

  // --- M15: Max reconnect exhaustion message ---

  it('sets lastError when max reconnect attempts exhausted (M15)', async () => {
    await adapter.start(mockRelay);

    // Directly invoke the private handlePollingError method to simulate
    // repeated polling failures without needing timer orchestration.
    const adapterInternal = adapter as unknown as { handlePollingError: (err: Error) => void };

    // Call handlePollingError 5 times to exhaust RECONNECT_DELAYS (length=5)
    for (let i = 0; i < 5; i++) {
      adapterInternal.handlePollingError(new Error(`poll error ${i}`));
    }
    // 6th call: reconnectAttempts is now 5, which >= RECONNECT_DELAYS.length
    adapterInternal.handlePollingError(new Error('final error'));

    const status = adapter.getStatus();
    expect(status.lastError).toBe(
      'Max reconnection attempts exhausted \u2014 adapter will not retry'
    );
  });

  // --- C2: extractChatId rejects invalid chat ID 0 ---

  it('deliver() rejects empty group suffix that would produce chat ID 0 (C2)', async () => {
    await adapter.start(mockRelay);

    // Subject "relay.human.telegram.tg1.group." has no ID after the final dot.
    // Without the guard, Number("") === 0 would be treated as valid.
    const envelope = createEnvelope('relay.human.telegram.tg1.group.', { content: 'hi' });
    const result = await adapter.deliver('relay.human.telegram.tg1.group.', envelope);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cannot extract chat ID/);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('deliver() accepts valid group chat IDs', async () => {
    await adapter.start(mockRelay);

    const envelope = createEnvelope('relay.human.telegram.tg1.group.12345', { content: 'hi' });
    const result = await adapter.deliver('relay.human.telegram.tg1.group.12345', envelope);
    expect(result.success).toBe(true);
    expect(mockSendMessage).toHaveBeenCalledWith(12345, 'hi', { parse_mode: 'HTML' });
  });

  it('deliver() accepts valid DM chat IDs', async () => {
    await adapter.start(mockRelay);

    const envelope = createEnvelope('relay.human.telegram.tg1.67890', { content: 'hi' });
    const result = await adapter.deliver('relay.human.telegram.tg1.67890', envelope);
    expect(result.success).toBe(true);
    expect(mockSendMessage).toHaveBeenCalledWith(67890, 'hi', { parse_mode: 'HTML' });
  });

  it('deliver() rejects non-integer chat IDs', async () => {
    await adapter.start(mockRelay);

    const envelope = createEnvelope('relay.human.telegram.tg1.abc', { content: 'hi' });
    const result = await adapter.deliver('relay.human.telegram.tg1.abc', envelope);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cannot extract chat ID/);
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

    it('sends error-only message when no text was buffered', async () => {
      await adapter.start(mockRelay);

      const errorEnvelope = createEnvelope('relay.human.telegram.tg1.12345', {
        type: 'error',
        data: { message: 'Session failed' },
      });
      const result = await adapter.deliver('relay.human.telegram.tg1.12345', errorEnvelope);
      expect(result.success).toBe(true);
      expect(mockSendMessage).toHaveBeenCalledWith(12345, '[Error: Session failed]', {
        parse_mode: 'HTML',
      });
    });

    it('silently skips session_status events', async () => {
      await adapter.start(mockRelay);

      const envelope = createEnvelope('relay.human.telegram.tg1.12345', {
        type: 'session_status',
        data: { sessionId: 'abc-123', costUsd: 0, contextTokens: 0 },
      });
      const result = await adapter.deliver('relay.human.telegram.tg1.12345', envelope);
      expect(result.success).toBe(true);
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it('silently skips tool_call_start events', async () => {
      await adapter.start(mockRelay);

      const envelope = createEnvelope('relay.human.telegram.tg1.12345', {
        type: 'tool_call_start',
        data: { id: 'tc-1', name: 'Read', input: {} },
      });
      const result = await adapter.deliver('relay.human.telegram.tg1.12345', envelope);
      expect(result.success).toBe(true);
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it('silently skips tool_call_end events', async () => {
      await adapter.start(mockRelay);

      const envelope = createEnvelope('relay.human.telegram.tg1.12345', {
        type: 'tool_call_end',
        data: { id: 'tc-1' },
      });
      const result = await adapter.deliver('relay.human.telegram.tg1.12345', envelope);
      expect(result.success).toBe(true);
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it('still handles StandardPayload directly (non-StreamEvent)', async () => {
      await adapter.start(mockRelay);

      const envelope = createEnvelope('relay.human.telegram.tg1.12345', {
        content: 'Direct message',
      });
      const result = await adapter.deliver('relay.human.telegram.tg1.12345', envelope);
      expect(result.success).toBe(true);
      expect(mockSendMessage).toHaveBeenCalledWith(12345, 'Direct message', { parse_mode: 'HTML' });
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

    it('increments outbound count when flushing buffer on done', async () => {
      await adapter.start(mockRelay);

      await adapter.deliver(
        'relay.human.telegram.tg1.12345',
        createEnvelope('relay.human.telegram.tg1.12345', {
          type: 'text_delta',
          data: { text: 'hi' },
        })
      );
      await adapter.deliver(
        'relay.human.telegram.tg1.12345',
        createEnvelope('relay.human.telegram.tg1.12345', {
          type: 'done',
          data: {},
        })
      );

      expect(adapter.getStatus().messageCount.outbound).toBe(1);
    });
  });

  // --- Timeout on bot.init() ---

  it('start() rejects when bot.init() hangs beyond INIT_TIMEOUT_MS', async () => {
    vi.useFakeTimers();

    // Suppress the expected unhandled rejection from the timeout race under fake timers
    const suppress = () => {};
    process.on('unhandledRejection', suppress);

    mockBotInit.mockReturnValue(new Promise(() => {})); // never resolves

    const startPromise = adapter.start(mockRelay);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(startPromise).rejects.toThrow('timed out');

    mockBotInit.mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(0);
    process.removeListener('unhandledRejection', suppress);
    vi.useRealTimers();
  });

  it('testConnection() rejects when bot.init() hangs beyond INIT_TIMEOUT_MS', async () => {
    vi.useFakeTimers();

    const suppress = () => {};
    process.on('unhandledRejection', suppress);

    mockBotInit.mockReturnValue(new Promise(() => {})); // never resolves

    const resultPromise = adapter.testConnection();
    await vi.advanceTimersByTimeAsync(15_000);

    const result = await resultPromise;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('timed out');

    mockBotInit.mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(0);
    process.removeListener('unhandledRejection', suppress);
    vi.useRealTimers();
  });

  // --- M20: Caption-only message ---

  it('publishes caption-only messages when text is undefined (M20)', async () => {
    await adapter.start(mockRelay);

    const ctx = createInboundCtx({ chatId: 12345, chatType: 'private' });
    // Override message to have caption but no text
    (ctx.message as Record<string, unknown>).text = undefined;
    (ctx.message as Record<string, unknown>).caption = 'Photo description';

    await capturedMessageHandler!(ctx);

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
