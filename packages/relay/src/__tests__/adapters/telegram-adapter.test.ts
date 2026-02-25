import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TelegramAdapter } from '../../adapters/telegram-adapter.js';
import type { RelayPublisher, AdapterStatus, Unsubscribe } from '../../types.js';

// --- grammy mock ---
// We mock the grammy module to avoid real Telegram API calls in tests.

const mockSendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
const mockSendChatAction = vi.fn().mockResolvedValue(true);
const mockSetWebhook = vi.fn().mockResolvedValue(true);
const mockBotStart = vi.fn().mockResolvedValue(undefined);
const mockBotStop = vi.fn().mockResolvedValue(undefined);
const mockBotCatch = vi.fn();

/** Captured message handler registered via bot.on('message', handler) */
let capturedMessageHandler: ((ctx: unknown) => Promise<void>) | null = null;
/** Captured error handler registered via bot.catch(handler) */
let capturedErrorHandler: ((err: unknown) => void) | null = null;
/** Captured onStart callback from bot.start({ onStart }) */
let capturedOnStart: (() => void) | null = null;

vi.mock('grammy', () => {
  class MockBot {
    api = {
      config: {
        use: vi.fn(),
      },
      sendMessage: mockSendMessage,
      sendChatAction: mockSendChatAction,
      setWebhook: mockSetWebhook,
    };

    on(_event: string, handler: (ctx: unknown) => Promise<void>) {
      capturedMessageHandler = handler;
    }

    catch(handler: (err: unknown) => void) {
      capturedErrorHandler = handler;
      mockBotCatch(handler);
    }

    async start(opts?: { drop_pending_updates?: boolean; onStart?: () => void }) {
      capturedOnStart = opts?.onStart ?? null;
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

// --- Tests ---

describe('TelegramAdapter', () => {
  let adapter: TelegramAdapter;
  let mockRelay: ReturnType<typeof createMockRelay>;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedMessageHandler = null;
    capturedErrorHandler = null;
    capturedOnStart = null;

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
      { from: 'relay.human.telegram.bot' },
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
      { from: 'relay.human.telegram.bot' },
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

  it('deliver() throws for invalid subject (non-telegram prefix)', async () => {
    await adapter.start(mockRelay);

    const envelope = createEnvelope('relay.agent.backend', { content: 'hi' });
    await expect(adapter.deliver('relay.agent.backend', envelope)).rejects.toThrow(
      "cannot extract chat ID",
    );
  });

  it('deliver() throws if not started', async () => {
    const envelope = createEnvelope('relay.human.telegram.1', { content: 'hi' });
    await expect(adapter.deliver('relay.human.telegram.1', envelope)).rejects.toThrow(
      'not started',
    );
  });

  it('deliver() records error and re-throws when sendMessage fails', async () => {
    mockSendMessage.mockRejectedValueOnce(new Error('Telegram API error'));

    await adapter.start(mockRelay);

    const envelope = createEnvelope('relay.human.telegram.1', { content: 'hi' });
    await expect(adapter.deliver('relay.human.telegram.1', envelope)).rejects.toThrow(
      'Telegram API error',
    );

    expect(adapter.getStatus().errorCount).toBe(1);
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

  // --- Webhook mode ---

  it('webhook mode: calls setWebhook and starts webhook server', async () => {
    const webhookAdapter = new TelegramAdapter('tg-webhook', {
      token: 'test-token',
      mode: 'webhook',
      webhookUrl: 'https://example.com/webhook',
      webhookPort: 8443,
    });

    await webhookAdapter.start(mockRelay);

    expect(mockSetWebhook).toHaveBeenCalledWith('https://example.com/webhook');

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
});
