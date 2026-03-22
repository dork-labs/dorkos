/**
 * Tests for the ChatSdkTelegramAdapter.
 *
 * Covers lifecycle management, echo prevention, inbound forwarding,
 * outbound delivery, streaming delivery, and testConnection validation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatSdkTelegramAdapter } from '../adapter.js';
import { extractChatIdFromThreadId } from '../inbound.js';
import { ChatSdkTelegramThreadIdCodec } from '../../../lib/thread-id.js';
import { createMockRelayPublisher } from '../../../testing/mock-relay-publisher.js';
import { createMockRelayEnvelope } from '../../../testing/mock-relay-envelope.js';
import { runAdapterComplianceSuite } from '../../../testing/compliance-suite.js';

// --- Module-level mock state ---
// Use vi.hoisted() so these are available inside vi.mock() factories, which are
// hoisted to the top of the file by Vitest's transform pass.

// vi.hoisted() runs before vi.mock() factories — the returned values can be
// safely referenced inside mock factories even though factories are hoisted.
const { mockPostMessage, mockChatInitialize, mockChatShutdown, messageHandlers } = vi.hoisted(
  () => {
    // Use a plain object for message handlers so we can mutate it in-place
    // (vi.hoisted() returns a const binding that can't be reassigned).
    const handlers: Record<string, (thread: unknown, message: unknown) => Promise<void>> = {};
    return {
      mockPostMessage: vi.fn().mockResolvedValue(undefined),
      mockChatInitialize: vi.fn().mockResolvedValue(undefined),
      mockChatShutdown: vi.fn().mockResolvedValue(undefined),
      messageHandlers: handlers,
    };
  }
);

// Use a stable constructor function so `new Chat(...)` works after vi.clearAllMocks().
// Arrow functions cannot be used as constructors; a regular function is required here.
vi.mock('chat', () => {
  return {
    Chat: vi.fn(function (this: Record<string, unknown>) {
      this.initialize = mockChatInitialize;
      this.shutdown = mockChatShutdown;
      this.onDirectMessage = (handler: (thread: unknown, message: unknown) => Promise<void>) => {
        messageHandlers['directMessage'] = handler;
      };
      this.onNewMention = (handler: (thread: unknown, message: unknown) => Promise<void>) => {
        messageHandlers['newMention'] = handler;
      };
      this.onSubscribedMessage = (
        handler: (thread: unknown, message: unknown) => Promise<void>
      ) => {
        messageHandlers['subscribedMessage'] = handler;
      };
    }),
  };
});

vi.mock('@chat-adapter/telegram', () => ({
  TelegramAdapter: vi.fn(),
  createTelegramAdapter: vi.fn().mockReturnValue({
    postMessage: mockPostMessage,
    userName: 'test_bot',
  }),
}));

// --- Test helpers ---

/** Build a minimal mock Thread that handleInboundMessage expects. */
function buildMockThread(overrides: Partial<{ id: string; isDM: boolean }> = {}) {
  return {
    id: '12345',
    isDM: true,
    ...overrides,
  };
}

/** Build a minimal mock Message that handleInboundMessage expects. */
function buildMockMessage(
  overrides: Partial<{
    id: string;
    text: string;
    author: { isMe: boolean; userId: string; userName: string; fullName: string };
  }> = {}
) {
  return {
    id: 'msg-001',
    text: 'Hello from Telegram',
    author: {
      isMe: false,
      userId: 'user-42',
      userName: 'testuser',
      fullName: 'Test User',
    },
    ...overrides,
  };
}

/** Create a fresh adapter instance for tests. */
function createAdapter() {
  return new ChatSdkTelegramAdapter('test-chatsdk', { token: 'test:token' });
}

// --- Unit tests ---

describe('ChatSdkTelegramAdapter', () => {
  let adapter: ChatSdkTelegramAdapter;
  let relay: ReturnType<typeof createMockRelayPublisher>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Clear handler registrations in-place — can't reassign the const from vi.hoisted()
    for (const key of Object.keys(messageHandlers)) {
      delete messageHandlers[key];
    }
    adapter = createAdapter();
    relay = createMockRelayPublisher();
  });

  afterEach(async () => {
    try {
      await adapter.stop();
    } catch {
      // Swallow — adapter may already be stopped
    }
  });

  // --- Lifecycle ---

  it('starts and stops without errors', async () => {
    await adapter.start(relay);

    expect(mockChatInitialize).toHaveBeenCalledTimes(1);
    expect(adapter.getStatus().state).toBe('connected');

    await adapter.stop();

    expect(mockChatShutdown).toHaveBeenCalledTimes(1);
    expect(adapter.getStatus().state).toBe('disconnected');
  });

  it('registers all three message handlers on start', async () => {
    await adapter.start(relay);

    expect(messageHandlers['directMessage']).toBeDefined();
    expect(messageHandlers['newMention']).toBeDefined();
    expect(messageHandlers['subscribedMessage']).toBeDefined();
  });

  // --- Echo prevention ---

  it('returns success without posting when envelope.from starts with subject prefix', async () => {
    await adapter.start(relay);

    const envelope = createMockRelayEnvelope({
      from: 'relay.human.telegram-chatsdk.test-chatsdk.bot',
    });

    const result = await adapter.deliver(
      'relay.human.telegram-chatsdk.test-chatsdk.12345',
      envelope
    );

    expect(result.success).toBe(true);
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  // --- Text delivery ---

  it('calls postMessage when delivering a text payload', async () => {
    await adapter.start(relay);

    const envelope = createMockRelayEnvelope({
      from: 'relay.agents.some-agent',
      payload: { type: 'text', body: 'Hello from the agent' },
    });

    const result = await adapter.deliver(
      'relay.human.telegram-chatsdk.test-chatsdk.12345',
      envelope
    );

    expect(result.success).toBe(true);
    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    expect(mockPostMessage).toHaveBeenCalledWith(
      '12345',
      expect.objectContaining({ raw: expect.any(String) })
    );
  });

  it('calls postMessage with approval text when delivering approval_required payload', async () => {
    await adapter.start(relay);

    // extractApprovalData expects { type, data: { toolCallId, toolName, input } }
    const envelope = createMockRelayEnvelope({
      from: 'relay.agents.some-agent',
      payload: {
        type: 'approval_required',
        data: {
          toolCallId: 'call-001',
          toolName: 'bash',
          input: JSON.stringify({ command: 'ls -la' }),
          timeoutMs: 60_000,
        },
      },
    });

    const result = await adapter.deliver(
      'relay.human.telegram-chatsdk.test-chatsdk.12345',
      envelope
    );

    expect(result.success).toBe(true);
    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    const [threadId, { raw }] = mockPostMessage.mock.calls[0] as [string, { raw: string }];
    expect(threadId).toBe('12345');
    expect(raw).toContain('Tool Approval Required');
    expect(raw).toContain('bash');
  });

  // --- StreamEvent handling ---

  it('buffers text_delta events and flushes on done', async () => {
    await adapter.start(relay);

    const delta1 = createMockRelayEnvelope({
      from: 'relay.agents.some-agent',
      payload: { type: 'text_delta', data: { text: 'Hello ' } },
    });
    const delta2 = createMockRelayEnvelope({
      from: 'relay.agents.some-agent',
      payload: { type: 'text_delta', data: { text: 'world!' } },
    });
    const done = createMockRelayEnvelope({
      from: 'relay.agents.some-agent',
      payload: { type: 'done', data: {} },
    });

    const subject = 'relay.human.telegram-chatsdk.test-chatsdk.12345';

    await adapter.deliver(subject, delta1);
    await adapter.deliver(subject, delta2);
    // No message sent yet — still buffering
    expect(mockPostMessage).not.toHaveBeenCalled();

    await adapter.deliver(subject, done);
    // Now the buffer should have flushed
    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    const [threadId, { raw }] = mockPostMessage.mock.calls[0] as [string, { raw: string }];
    expect(threadId).toBe('12345');
    expect(raw).toContain('Hello');
    expect(raw).toContain('world');
  });

  it('silently drops session_status StreamEvents without sending', async () => {
    await adapter.start(relay);

    const statusEvent = createMockRelayEnvelope({
      from: 'relay.agents.some-agent',
      payload: { type: 'session_status', data: { status: 'active' } },
    });

    const result = await adapter.deliver(
      'relay.human.telegram-chatsdk.test-chatsdk.12345',
      statusEvent
    );

    expect(result.success).toBe(true);
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('flushes buffer with error message on error StreamEvent', async () => {
    await adapter.start(relay);

    const subject = 'relay.human.telegram-chatsdk.test-chatsdk.12345';

    const delta = createMockRelayEnvelope({
      from: 'relay.agents.some-agent',
      payload: { type: 'text_delta', data: { text: 'Partial response' } },
    });
    const error = createMockRelayEnvelope({
      from: 'relay.agents.some-agent',
      payload: { type: 'error', data: { message: 'Something went wrong' } },
    });

    await adapter.deliver(subject, delta);
    expect(mockPostMessage).not.toHaveBeenCalled();

    await adapter.deliver(subject, error);
    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    const [, { raw }] = mockPostMessage.mock.calls[0] as [string, { raw: string }];
    expect(raw).toContain('Partial response');
    expect(raw).toContain('Something went wrong');
  });

  it('flushes buffered text before approval_required event', async () => {
    await adapter.start(relay);

    const subject = 'relay.human.telegram-chatsdk.test-chatsdk.12345';

    const delta = createMockRelayEnvelope({
      from: 'relay.agents.some-agent',
      payload: { type: 'text_delta', data: { text: 'Before approval' } },
    });
    const approval = createMockRelayEnvelope({
      from: 'relay.agents.some-agent',
      payload: {
        type: 'approval_required',
        data: {
          toolCallId: 'call-002',
          toolName: 'Write',
          input: JSON.stringify({ path: '/tmp/test.txt' }),
          timeoutMs: 60_000,
        },
      },
    });

    await adapter.deliver(subject, delta);
    await adapter.deliver(subject, approval);

    // Two messages: flushed buffer + approval prompt
    expect(mockPostMessage).toHaveBeenCalledTimes(2);
    const [, first] = mockPostMessage.mock.calls[0] as [string, { raw: string }];
    const [, second] = mockPostMessage.mock.calls[1] as [string, { raw: string }];
    expect(first.raw).toContain('Before approval');
    expect(second.raw).toContain('Tool Approval Required');
  });

  it('done with empty buffer succeeds without posting', async () => {
    await adapter.start(relay);

    const done = createMockRelayEnvelope({
      from: 'relay.agents.some-agent',
      payload: { type: 'done', data: {} },
    });

    const result = await adapter.deliver('relay.human.telegram-chatsdk.test-chatsdk.12345', done);

    expect(result.success).toBe(true);
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  // --- deliverStream ---

  it('deliverStream returns error when not started', async () => {
    async function* singleChunk() {
      yield 'hello';
    }

    const result = await adapter.deliverStream(
      'relay.human.telegram-chatsdk.test-chatsdk.12345',
      '12345',
      singleChunk()
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not initialized/i);
  });

  it('deliverStream accumulates chunks and calls postMessage after start', async () => {
    await adapter.start(relay);

    async function* multiChunk() {
      yield 'Hello ';
      yield 'world';
      yield '!';
    }

    const result = await adapter.deliverStream(
      'relay.human.telegram-chatsdk.test-chatsdk.12345',
      '12345',
      multiChunk()
    );

    expect(result.success).toBe(true);
    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    const [threadId, { raw }] = mockPostMessage.mock.calls[0] as [string, { raw: string }];
    expect(threadId).toBe('12345');
    expect(raw).toContain('Hello');
    expect(raw).toContain('world');
  });

  // --- Inbound forwarding ---

  it('publishes to relay when a direct message handler fires', async () => {
    await adapter.start(relay);

    const thread = buildMockThread({ id: '99999', isDM: true });
    const message = buildMockMessage({ text: 'Hey agent!' });

    await messageHandlers['directMessage']!(thread, message);

    expect(relay.publish).toHaveBeenCalledWith(
      'relay.human.telegram-chatsdk.test-chatsdk.99999',
      expect.objectContaining({
        content: 'Hey agent!',
        senderName: 'Test User',
        channelType: 'dm',
      }),
      expect.objectContaining({ from: 'relay.human.telegram-chatsdk.test-chatsdk.bot' })
    );
  });

  it('does not forward message to relay when author.isMe is true', async () => {
    await adapter.start(relay);

    const thread = buildMockThread({ id: '99999', isDM: true });
    const message = buildMockMessage({
      author: { isMe: true, userId: 'bot', userName: 'bot', fullName: 'Bot' },
    });

    await messageHandlers['directMessage']!(thread, message);

    expect(relay.publish).not.toHaveBeenCalled();
  });

  it('publishes with channelType group when thread.isDM is false', async () => {
    await adapter.start(relay);

    const thread = buildMockThread({ id: 'grp-123', isDM: false });
    const message = buildMockMessage({ text: 'Group message' });

    await messageHandlers['newMention']!(thread, message);

    expect(relay.publish).toHaveBeenCalledWith(
      'relay.human.telegram-chatsdk.test-chatsdk.group.grp-123',
      expect.objectContaining({ channelType: 'group' }),
      expect.anything()
    );
  });

  // --- Chat SDK thread ID normalization ---

  it('normalizes Chat SDK thread ID format for DM messages', async () => {
    await adapter.start(relay);

    const thread = buildMockThread({ id: 'telegram:817732118', isDM: true });
    const message = buildMockMessage({ text: 'Hello' });

    await messageHandlers['directMessage']!(thread, message);

    expect(relay.publish).toHaveBeenCalledWith(
      'relay.human.telegram-chatsdk.test-chatsdk.817732118',
      expect.objectContaining({ content: 'Hello' }),
      expect.anything()
    );
  });

  it('normalizes Chat SDK thread ID format for group messages', async () => {
    await adapter.start(relay);

    const thread = buildMockThread({ id: 'telegram:-100123456789', isDM: false });
    const message = buildMockMessage({ text: 'Group msg' });

    await messageHandlers['newMention']!(thread, message);

    expect(relay.publish).toHaveBeenCalledWith(
      'relay.human.telegram-chatsdk.test-chatsdk.group.-100123456789',
      expect.objectContaining({ channelType: 'group' }),
      expect.anything()
    );
  });

  it('strips forum thread ID suffix from Chat SDK thread ID', async () => {
    await adapter.start(relay);

    const thread = buildMockThread({ id: 'telegram:817732118:42', isDM: true });
    const message = buildMockMessage({ text: 'Forum msg' });

    await messageHandlers['directMessage']!(thread, message);

    expect(relay.publish).toHaveBeenCalledWith(
      'relay.human.telegram-chatsdk.test-chatsdk.817732118',
      expect.objectContaining({ content: 'Forum msg' }),
      expect.anything()
    );
  });

  it('preserves original Chat SDK thread ID in platformData.threadId', async () => {
    await adapter.start(relay);

    const thread = buildMockThread({ id: 'telegram:817732118', isDM: true });
    const message = buildMockMessage({ text: 'Check platformData' });

    await messageHandlers['directMessage']!(thread, message);

    expect(relay.publish).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        platformData: expect.objectContaining({ threadId: 'telegram:817732118' }),
      }),
      expect.anything()
    );
  });

  // --- testConnection ---

  it('testConnection returns { ok: true } with a valid token', async () => {
    const result = await adapter.testConnection();

    expect(result.ok).toBe(true);
    expect(result.botUsername).toBe('test_bot');
    expect(mockChatInitialize).toHaveBeenCalled();
    expect(mockChatShutdown).toHaveBeenCalled();
  });

  it('testConnection returns { ok: false, error } when Chat throws', async () => {
    mockChatInitialize.mockRejectedValueOnce(new Error('Unauthorized'));

    const result = await adapter.testConnection();

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unauthorized/);
  });
});

// --- extractChatIdFromThreadId ---

describe('extractChatIdFromThreadId', () => {
  it('extracts chatId from telegram:chatId format', () => {
    expect(extractChatIdFromThreadId('telegram:817732118')).toBe('817732118');
  });

  it('extracts chatId from negative group ID', () => {
    expect(extractChatIdFromThreadId('telegram:-100123456789')).toBe('-100123456789');
  });

  it('strips messageThreadId from forum topic format', () => {
    expect(extractChatIdFromThreadId('telegram:817732118:42')).toBe('817732118');
  });

  it('passes through IDs without colons', () => {
    expect(extractChatIdFromThreadId('817732118')).toBe('817732118');
  });

  it('handles empty string', () => {
    expect(extractChatIdFromThreadId('')).toBe('');
  });

  it('handles slack format for future adapters', () => {
    expect(extractChatIdFromThreadId('slack:C01234567')).toBe('C01234567');
  });
});

// --- Adapter compliance suite ---

runAdapterComplianceSuite({
  name: 'ChatSdkTelegramAdapter',
  createAdapter: () => new ChatSdkTelegramAdapter('test-chatsdk', { token: 'test:token' }),
  deliverSubject: 'relay.human.telegram-chatsdk.test-chatsdk.12345',
  codec: new ChatSdkTelegramThreadIdCodec('test-chatsdk'),
  samplePlatformId: '12345',
});
