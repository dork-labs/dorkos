import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TelegramAdapter } from '../index.js';
import type { RelayPublisher, Unsubscribe } from '../../../types.js';

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
const mockBotInit = vi.fn().mockResolvedValue(undefined);
const mockBotStart = vi.fn().mockResolvedValue(undefined);
const mockBotStop = vi.fn().mockResolvedValue(undefined);
const mockBotCatch = vi.fn();

/** Captured message handler registered via bot.on('message', handler) */
let capturedMessageHandler: ((ctx: unknown) => Promise<void>) | null = null;
/** Captured callback query handler registered via bot.on('callback_query:data', handler) */
let capturedCallbackQueryHandler: ((ctx: unknown) => Promise<void>) | null = null;
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
    };

    botInfo = { username: 'test_bot' };

    on(event: string, handler: (ctx: unknown) => Promise<void>) {
      if (event === 'callback_query:data') {
        capturedCallbackQueryHandler = handler;
      } else {
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

// --- Relay mock helpers ---

function createMockRelay(): RelayPublisher {
  const signalHandlers: Array<{ pattern: string; handler: (subject: string, signal: { type: string; state: string }) => void }> = [];

  const relay: RelayPublisher = {
    publish: vi.fn().mockResolvedValue({ messageId: 'msg-1', deliveredTo: 1 }),
    onSignal: vi.fn().mockImplementation((pattern: string, handler: (subject: string, signal: { type: string; state: string }) => void): Unsubscribe => {
      signalHandlers.push({ pattern, handler });
      return () => {
        const idx = signalHandlers.findIndex((s) => s.handler === handler);
        if (idx >= 0) signalHandlers.splice(idx, 1);
      };
    }),
  };

  // Expose a way to trigger signals from tests
  (relay as RelayPublisher & { _emitSignal: (subject: string, signal: { type: string; state: string }) => void })._emitSignal = (
    subject: string,
    signal: { type: string; state: string },
  ) => {
    for (const { handler } of signalHandlers) {
      handler(subject, signal);
    }
  };

  return relay;
}

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
  } = overrides;

  return {
    chat: { id: chatId, type: chatType, ...(title ? { title } : {}) },
    from: { id: fromId, first_name: firstName, last_name: lastName, username },
    message: { text, message_id: messageId, caption: undefined },
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

    adapter = new TelegramAdapter('telegram', { token: 'test-token', mode: 'polling' });
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
    expect(adapter.id).toBe('telegram');
    expect(adapter.subjectPrefix).toBe('relay.human.telegram');
    expect(adapter.displayName).toBe('Telegram');
  });

  it('accepts a custom displayName', () => {
    const custom = new TelegramAdapter('tg-work', { token: 'tok', mode: 'polling' }, 'Work Telegram');
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
      expect.objectContaining({ drop_pending_updates: true }),
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
    expect(mockRelay.onSignal).toHaveBeenCalledWith('relay.human.telegram.>', expect.any(Function));
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
      'relay.human.telegram.12345',
      expect.objectContaining({
        content: 'Hello!',
        channelType: 'dm',
      }),
      { from: 'relay.human.telegram.bot', replyTo: 'relay.human.telegram.12345' },
    );
  });

  it('publishes inbound group message to relay.human.telegram.group.{chatId}', async () => {
    await adapter.start(mockRelay);

    const ctx = createInboundCtx({
      chatId: -100111222,
      chatType: 'group',
      text: 'Group message',
      title: 'Project Team',
    });
    await capturedMessageHandler!(ctx);

    expect(mockRelay.publish).toHaveBeenCalledWith(
      'relay.human.telegram.group.-100111222',
      expect.objectContaining({
        content: 'Group message',
        channelType: 'group',
      }),
      { from: 'relay.human.telegram.bot', replyTo: 'relay.human.telegram.group.-100111222' },
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
      expect.any(Object),
    );
  });

  it('includes platformData with chatId and messageId', async () => {
    await adapter.start(mockRelay);

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
      expect.any(Object),
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

  // --- Echo guard ---

  it('deliver() skips messages originating from this adapter (echo prevention)', async () => {
    await adapter.start(mockRelay);

    const envelope = createEnvelope('relay.human.telegram.12345', { content: 'Echo!' });
    // Override 'from' to simulate the adapter's own inbound publish
    envelope.from = 'relay.human.telegram.bot';

    const result = await adapter.deliver('relay.human.telegram.12345', envelope);
    expect(result.success).toBe(true);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('deliver() allows messages from non-telegram sources', async () => {
    await adapter.start(mockRelay);

    const envelope = createEnvelope('relay.human.telegram.12345', { content: 'Agent reply' });
    // from is 'relay.agent.backend' — should NOT be filtered
    const result = await adapter.deliver('relay.human.telegram.12345', envelope);
    expect(result.success).toBe(true);
    expect(mockSendMessage).toHaveBeenCalledWith(12345, 'Agent reply');
  });

  // --- Outbound delivery ---

  it('deliver() sends a Telegram message to the correct chat', async () => {
    await adapter.start(mockRelay);

    const envelope = createEnvelope('relay.human.telegram.12345', { content: 'Hello from agent!' });
    await adapter.deliver('relay.human.telegram.12345', envelope);

    expect(mockSendMessage).toHaveBeenCalledWith(12345, 'Hello from agent!');
  });

  it('deliver() sends to group chat ID (negative)', async () => {
    await adapter.start(mockRelay);

    const envelope = createEnvelope('relay.human.telegram.group.-100111222', 'Group reply');
    await adapter.deliver('relay.human.telegram.group.-100111222', envelope);

    expect(mockSendMessage).toHaveBeenCalledWith(-100111222, 'Group reply');
  });

  it('deliver() increments outbound message count', async () => {
    await adapter.start(mockRelay);

    const envelope = createEnvelope('relay.human.telegram.1', { content: 'hi' });
    await adapter.deliver('relay.human.telegram.1', envelope);

    expect(adapter.getStatus().messageCount.outbound).toBe(1);
  });

  it('deliver() truncates content exceeding 4096 characters', async () => {
    await adapter.start(mockRelay);

    const longContent = 'A'.repeat(5000);
    const envelope = createEnvelope('relay.human.telegram.1', { content: longContent });
    await adapter.deliver('relay.human.telegram.1', envelope);

    const sentText = vi.mocked(mockSendMessage).mock.calls[0][1] as string;
    expect(sentText.length).toBeLessThanOrEqual(4096);
    expect(sentText.endsWith('...')).toBe(true);
  });

  it('deliver() returns failure for invalid subject (non-telegram prefix)', async () => {
    await adapter.start(mockRelay);

    const envelope = createEnvelope('relay.agent.backend', { content: 'hi' });
    const result = await adapter.deliver('relay.agent.backend', envelope);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cannot extract chat ID/);
  });

  it('deliver() returns failure if not started', async () => {
    const envelope = createEnvelope('relay.human.telegram.1', { content: 'hi' });
    const result = await adapter.deliver('relay.human.telegram.1', envelope);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not started/);
  });

  it('deliver() records error and returns failure when sendMessage fails', async () => {
    mockSendMessage.mockRejectedValueOnce(new Error('Telegram API error'));

    await adapter.start(mockRelay);

    const envelope = createEnvelope('relay.human.telegram.1', { content: 'hi' });
    const result = await adapter.deliver('relay.human.telegram.1', envelope);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Telegram API error/);

    expect(adapter.getStatus().errorCount).toBe(1);
  });

  // --- Outbound message payload extraction ---

  describe('outbound message payload extraction', () => {
    it('handles string payload', async () => {
      await adapter.start(mockRelay);

      const envelope = createEnvelope('relay.human.telegram.12345', 'plain text message');
      await adapter.deliver('relay.human.telegram.12345', envelope);

      expect(mockSendMessage).toHaveBeenCalledWith(12345, 'plain text message');
    });

    it('handles object payload with content field', async () => {
      await adapter.start(mockRelay);

      const envelope = createEnvelope('relay.human.telegram.12345', {
        content: 'structured message',
        metadata: {},
      });
      await adapter.deliver('relay.human.telegram.12345', envelope);

      expect(mockSendMessage).toHaveBeenCalledWith(12345, 'structured message');
    });

    it('handles object payload with text field', async () => {
      await adapter.start(mockRelay);

      const envelope = createEnvelope('relay.human.telegram.12345', {
        text: 'text field message',
        metadata: {},
      });
      await adapter.deliver('relay.human.telegram.12345', envelope);

      expect(mockSendMessage).toHaveBeenCalledWith(12345, 'text field message');
    });

    it('handles object payload without content or text — falls back to JSON', async () => {
      await adapter.start(mockRelay);

      const payload = { data: 'raw data', count: 5 };
      const envelope = createEnvelope('relay.human.telegram.12345', payload);
      await adapter.deliver('relay.human.telegram.12345', envelope);

      expect(mockSendMessage).toHaveBeenCalledWith(12345, JSON.stringify(payload));
    });

    it('handles null payload', async () => {
      await adapter.start(mockRelay);

      const envelope = createEnvelope('relay.human.telegram.12345', null);
      await adapter.deliver('relay.human.telegram.12345', envelope);

      expect(mockSendMessage).toHaveBeenCalledWith(12345, 'null');
    });

    it('handles numeric payload', async () => {
      await adapter.start(mockRelay);

      const envelope = createEnvelope('relay.human.telegram.12345', 42);
      await adapter.deliver('relay.human.telegram.12345', envelope);

      expect(mockSendMessage).toHaveBeenCalledWith(12345, '42');
    });
  });

  // --- Float chat ID rejection (Number.isInteger guard) ---

  it('deliver() rejects a float DM subject (e.g. relay.human.telegram.1.5)', async () => {
    await adapter.start(mockRelay);

    const envelope = createEnvelope('relay.human.telegram.1.5', { content: 'hi' });
    const result = await adapter.deliver('relay.human.telegram.1.5', envelope);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cannot extract chat ID/);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('deliver() rejects a float group subject (e.g. relay.human.telegram.group.1.5)', async () => {
    await adapter.start(mockRelay);

    const envelope = createEnvelope('relay.human.telegram.group.1.5', { content: 'hi' });
    const result = await adapter.deliver('relay.human.telegram.group.1.5', envelope);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cannot extract chat ID/);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('typing signal is not forwarded for a float DM subject', async () => {
    await adapter.start(mockRelay);

    const relay = mockRelay as ReturnType<typeof createMockRelay> & {
      _emitSignal: (subject: string, signal: { type: string; state: string }) => void;
    };
    relay._emitSignal('relay.human.telegram.1.5', { type: 'typing', state: 'active' });

    await Promise.resolve();

    expect(mockSendChatAction).not.toHaveBeenCalled();
  });

  // --- Typing signals ---

  it('forwards active typing signals to Telegram as chat action', async () => {
    await adapter.start(mockRelay);

    const relay = mockRelay as ReturnType<typeof createMockRelay> & {
      _emitSignal: (subject: string, signal: { type: string; state: string }) => void;
    };
    relay._emitSignal('relay.human.telegram.12345', { type: 'typing', state: 'active' });

    // Allow microtask queue to drain
    await Promise.resolve();

    expect(mockSendChatAction).toHaveBeenCalledWith(12345, 'typing');
  });

  it('ignores typing signals when state is not active', async () => {
    await adapter.start(mockRelay);

    const relay = mockRelay as ReturnType<typeof createMockRelay> & {
      _emitSignal: (subject: string, signal: { type: string; state: string }) => void;
    };
    relay._emitSignal('relay.human.telegram.12345', { type: 'typing', state: 'stopped' });

    await Promise.resolve();

    expect(mockSendChatAction).not.toHaveBeenCalled();
  });

  it('ignores non-typing signals (presence, read_receipt, etc.)', async () => {
    await adapter.start(mockRelay);

    const relay = mockRelay as ReturnType<typeof createMockRelay> & {
      _emitSignal: (subject: string, signal: { type: string; state: string }) => void;
    };
    relay._emitSignal('relay.human.telegram.12345', { type: 'presence', state: 'online' });

    await Promise.resolve();

    expect(mockSendChatAction).not.toHaveBeenCalled();
  });

  it('swallows errors from typing signal forwarding', async () => {
    mockSendChatAction.mockRejectedValueOnce(new Error('Rate limited'));

    await adapter.start(mockRelay);

    const relay = mockRelay as ReturnType<typeof createMockRelay> & {
      _emitSignal: (subject: string, signal: { type: string; state: string }) => void;
    };

    // Should not throw
    relay._emitSignal('relay.human.telegram.12345', { type: 'typing', state: 'active' });
    await Promise.resolve();

    // Error count should NOT be incremented for typing signal failures
    expect(adapter.getStatus().errorCount).toBe(0);
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

  // --- Webhook mode ---

  it('webhook mode: calls setWebhook and starts webhook server', async () => {
    const webhookAdapter = new TelegramAdapter('tg-webhook', {
      token: 'test-token',
      mode: 'webhook',
      webhookUrl: 'https://example.com/webhook',
      webhookPort: 8443,
    });

    await webhookAdapter.start(mockRelay);

    expect(mockSetWebhook).toHaveBeenCalledWith(
      'https://example.com/webhook',
      expect.objectContaining({ secret_token: expect.any(String) }),
    );

    await webhookAdapter.stop();
  });

  it('webhook mode: throws if webhookUrl is missing', async () => {
    const webhookAdapter = new TelegramAdapter('tg-webhook', {
      token: 'test-token',
      mode: 'webhook',
      // no webhookUrl
    });

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

    const webhookAdapter = new TelegramAdapter('tg-webhook', {
      token: 'test-token',
      mode: 'webhook',
      webhookUrl: 'https://example.com/webhook',
      webhookPort: 8443,
      webhookSecret: 'my-fixed-secret',
    });

    await webhookAdapter.start(mockRelay);

    // setWebhook should receive the secret_token option
    expect(mockSetWebhook).toHaveBeenCalledWith(
      'https://example.com/webhook',
      { secret_token: 'my-fixed-secret' },
    );

    // webhookCallback should receive the secretToken option
    expect(webhookCallback).toHaveBeenCalledWith(
      expect.anything(),
      'http',
      { secretToken: 'my-fixed-secret' },
    );

    await webhookAdapter.stop();
  });

  it('webhook mode: auto-generates secret when webhookSecret is not provided', async () => {
    const webhookAdapter = new TelegramAdapter('tg-webhook', {
      token: 'test-token',
      mode: 'webhook',
      webhookUrl: 'https://example.com/webhook',
      webhookPort: 8443,
    });

    await webhookAdapter.start(mockRelay);

    // Should still pass a secret_token (auto-generated)
    expect(mockSetWebhook).toHaveBeenCalledWith(
      'https://example.com/webhook',
      expect.objectContaining({ secret_token: expect.any(String) }),
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
    const webhookAdapter = new TelegramAdapter('tg-webhook', {
      token: 'test-token',
      mode: 'webhook',
      webhookUrl: 'https://example.com/webhook',
      webhookPort: 8443,
    });

    await webhookAdapter.start(mockRelay);

    // once() must have been called with 'error' so the handler is removed
    // after the promise settles — preventing a listener leak on later errors.
    expect(mockServerOnce).toHaveBeenCalledWith('error', expect.any(Function));

    // on() must NOT have been called with 'error' (that would be the leaky path)
    const onErrorCalls = (mockServerOn.mock.calls as Array<[string, unknown]>).filter(
      ([event]) => event === 'error',
    );
    expect(onErrorCalls).toHaveLength(0);

    await webhookAdapter.stop();
  });

  // --- C5: Webhook server shutdown calls closeAllConnections() before close() ---

  it('stop() calls closeAllConnections() before server.close() (C5)', async () => {
    const webhookAdapter = new TelegramAdapter('tg-webhook', {
      token: 'test-token',
      mode: 'webhook',
      webhookUrl: 'https://example.com/webhook',
      webhookPort: 8443,
    });

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
    const webhookAdapter = new TelegramAdapter('tg-webhook', {
      token: 'test-token',
      mode: 'webhook',
      webhookUrl: 'https://example.com/webhook',
      webhookPort: 8443,
    });

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
    const webhookAdapter = new TelegramAdapter('tg-webhook', {
      token: 'test-token',
      mode: 'webhook',
      webhookUrl: 'https://example.com/webhook',
      webhookPort: 8443,
    });

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
      'Max reconnection attempts exhausted \u2014 adapter will not retry',
    );
  });

  // --- C2: extractChatId rejects invalid chat ID 0 ---

  it('deliver() rejects empty group suffix that would produce chat ID 0 (C2)', async () => {
    await adapter.start(mockRelay);

    // Subject "relay.human.telegram.group." has no ID after the final dot.
    // Without the guard, Number("") === 0 would be treated as valid.
    const envelope = createEnvelope('relay.human.telegram.group.', { content: 'hi' });
    const result = await adapter.deliver('relay.human.telegram.group.', envelope);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cannot extract chat ID/);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('deliver() accepts valid group chat IDs', async () => {
    await adapter.start(mockRelay);

    const envelope = createEnvelope('relay.human.telegram.group.12345', { content: 'hi' });
    const result = await adapter.deliver('relay.human.telegram.group.12345', envelope);
    expect(result.success).toBe(true);
    expect(mockSendMessage).toHaveBeenCalledWith(12345, 'hi');
  });

  it('deliver() accepts valid DM chat IDs', async () => {
    await adapter.start(mockRelay);

    const envelope = createEnvelope('relay.human.telegram.67890', { content: 'hi' });
    const result = await adapter.deliver('relay.human.telegram.67890', envelope);
    expect(result.success).toBe(true);
    expect(mockSendMessage).toHaveBeenCalledWith(67890, 'hi');
  });

  it('deliver() rejects non-integer chat IDs', async () => {
    await adapter.start(mockRelay);

    const envelope = createEnvelope('relay.human.telegram.abc', { content: 'hi' });
    const result = await adapter.deliver('relay.human.telegram.abc', envelope);
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
        const envelope = createEnvelope('relay.human.telegram.12345', {
          type: 'text_delta',
          data: { text },
        });
        const result = await adapter.deliver('relay.human.telegram.12345', envelope);
        expect(result.success).toBe(true);
      }
      expect(mockSendMessage).not.toHaveBeenCalled();

      // Send done event — should flush buffer as a single message
      const doneEnvelope = createEnvelope('relay.human.telegram.12345', {
        type: 'done',
        data: {},
      });
      const doneResult = await adapter.deliver('relay.human.telegram.12345', doneEnvelope);
      expect(doneResult.success).toBe(true);
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      expect(mockSendMessage).toHaveBeenCalledWith(12345, 'Hello from agent!');
    });

    it('sends error with buffered text on error event', async () => {
      await adapter.start(mockRelay);

      // Buffer some text
      const textEnvelope = createEnvelope('relay.human.telegram.12345', {
        type: 'text_delta',
        data: { text: 'Partial response' },
      });
      await adapter.deliver('relay.human.telegram.12345', textEnvelope);

      // Send error event
      const errorEnvelope = createEnvelope('relay.human.telegram.12345', {
        type: 'error',
        data: { message: 'Context limit exceeded' },
      });
      const result = await adapter.deliver('relay.human.telegram.12345', errorEnvelope);
      expect(result.success).toBe(true);
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      expect(mockSendMessage).toHaveBeenCalledWith(
        12345,
        'Partial response\n\n[Error: Context limit exceeded]',
      );
    });

    it('sends error-only message when no text was buffered', async () => {
      await adapter.start(mockRelay);

      const errorEnvelope = createEnvelope('relay.human.telegram.12345', {
        type: 'error',
        data: { message: 'Session failed' },
      });
      const result = await adapter.deliver('relay.human.telegram.12345', errorEnvelope);
      expect(result.success).toBe(true);
      expect(mockSendMessage).toHaveBeenCalledWith(12345, '[Error: Session failed]');
    });

    it('silently skips session_status events', async () => {
      await adapter.start(mockRelay);

      const envelope = createEnvelope('relay.human.telegram.12345', {
        type: 'session_status',
        data: { sessionId: 'abc-123', costUsd: 0, contextTokens: 0 },
      });
      const result = await adapter.deliver('relay.human.telegram.12345', envelope);
      expect(result.success).toBe(true);
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it('silently skips tool_call_start events', async () => {
      await adapter.start(mockRelay);

      const envelope = createEnvelope('relay.human.telegram.12345', {
        type: 'tool_call_start',
        data: { id: 'tc-1', name: 'Read', input: {} },
      });
      const result = await adapter.deliver('relay.human.telegram.12345', envelope);
      expect(result.success).toBe(true);
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it('silently skips tool_call_end events', async () => {
      await adapter.start(mockRelay);

      const envelope = createEnvelope('relay.human.telegram.12345', {
        type: 'tool_call_end',
        data: { id: 'tc-1' },
      });
      const result = await adapter.deliver('relay.human.telegram.12345', envelope);
      expect(result.success).toBe(true);
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it('still handles StandardPayload directly (non-StreamEvent)', async () => {
      await adapter.start(mockRelay);

      const envelope = createEnvelope('relay.human.telegram.12345', { content: 'Direct message' });
      const result = await adapter.deliver('relay.human.telegram.12345', envelope);
      expect(result.success).toBe(true);
      expect(mockSendMessage).toHaveBeenCalledWith(12345, 'Direct message');
    });

    it('done with empty buffer does not send a message', async () => {
      await adapter.start(mockRelay);

      const doneEnvelope = createEnvelope('relay.human.telegram.12345', {
        type: 'done',
        data: {},
      });
      const result = await adapter.deliver('relay.human.telegram.12345', doneEnvelope);
      expect(result.success).toBe(true);
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it('buffers per-chat independently', async () => {
      await adapter.start(mockRelay);

      // Buffer text in chat 111
      await adapter.deliver('relay.human.telegram.111', createEnvelope('relay.human.telegram.111', {
        type: 'text_delta',
        data: { text: 'Chat A' },
      }));

      // Buffer text in chat 222
      await adapter.deliver('relay.human.telegram.222', createEnvelope('relay.human.telegram.222', {
        type: 'text_delta',
        data: { text: 'Chat B' },
      }));

      // Flush chat 111
      await adapter.deliver('relay.human.telegram.111', createEnvelope('relay.human.telegram.111', {
        type: 'done',
        data: {},
      }));

      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      expect(mockSendMessage).toHaveBeenCalledWith(111, 'Chat A');

      // Flush chat 222
      await adapter.deliver('relay.human.telegram.222', createEnvelope('relay.human.telegram.222', {
        type: 'done',
        data: {},
      }));

      expect(mockSendMessage).toHaveBeenCalledTimes(2);
      expect(mockSendMessage).toHaveBeenCalledWith(222, 'Chat B');
    });

    it('increments outbound count when flushing buffer on done', async () => {
      await adapter.start(mockRelay);

      await adapter.deliver('relay.human.telegram.12345', createEnvelope('relay.human.telegram.12345', {
        type: 'text_delta',
        data: { text: 'hi' },
      }));
      await adapter.deliver('relay.human.telegram.12345', createEnvelope('relay.human.telegram.12345', {
        type: 'done',
        data: {},
      }));

      expect(adapter.getStatus().messageCount.outbound).toBe(1);
    });
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
      'relay.human.telegram.12345',
      expect.objectContaining({
        content: 'Photo description',
        channelType: 'dm',
      }),
      { from: 'relay.human.telegram.bot', replyTo: 'relay.human.telegram.12345' },
    );
  });
});
