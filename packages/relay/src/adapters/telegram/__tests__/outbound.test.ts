import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { deliverMessage, handleTypingSignal, clearAllTypingIntervals, BUFFER_TTL_MS, callbackIdMap } from '../outbound.js';
import type { ResponseBuffer } from '../outbound.js';
import type { Bot } from 'grammy';
import type { AdapterOutboundCallbacks } from '../../../types.js';

// Mock inbound.js for extractChatId and constants
vi.mock('../inbound.js', () => ({
  SUBJECT_PREFIX: 'relay.human.telegram',
  MAX_MESSAGE_LENGTH: 4096,
  extractChatId: (subject: string) => {
    const parts = subject.split('.');
    const chatIdStr = parts[parts.length - 1];
    if (!chatIdStr) return null;
    const num = Number(chatIdStr);
    return Number.isNaN(num) ? null : num;
  },
}));

// Mock payload-utils.js — mirrors actual implementations without SILENT_EVENT_TYPES
vi.mock('../../../lib/payload-utils.js', () => ({
  extractPayloadContent: (payload: unknown) => {
    if (typeof payload === 'string') return payload;
    if (payload !== null && typeof payload === 'object') {
      const obj = payload as Record<string, unknown>;
      if (typeof obj.content === 'string') return obj.content;
      if (typeof obj.text === 'string') return obj.text;
    }
    try {
      return JSON.stringify(payload);
    } catch {
      return '[unserializable payload]';
    }
  },
  detectStreamEventType: (payload: unknown) => {
    if (payload === null || typeof payload !== 'object') return null;
    const obj = payload as Record<string, unknown>;
    if (typeof obj.type !== 'string' || !('data' in obj)) return null;
    return obj.type;
  },
  extractTextDelta: (payload: unknown) => {
    if (payload === null || typeof payload !== 'object') return null;
    const obj = payload as Record<string, unknown>;
    if (obj.type !== 'text_delta') return null;
    const data = obj.data as Record<string, unknown> | undefined;
    if (!data || typeof data.text !== 'string') return null;
    return data.text;
  },
  extractErrorMessage: (payload: unknown) => {
    if (payload === null || typeof payload !== 'object') return null;
    const obj = payload as Record<string, unknown>;
    if (obj.type !== 'error') return null;
    const data = obj.data as Record<string, unknown> | undefined;
    return typeof data?.message === 'string' ? data.message : null;
  },
  extractApprovalData: (payload: unknown) => {
    if (payload === null || typeof payload !== 'object') return null;
    const obj = payload as Record<string, unknown>;
    if (obj.type !== 'approval_required') return null;
    const data = obj.data as Record<string, unknown> | undefined;
    if (!data?.toolCallId || !data?.toolName) return null;
    return {
      toolCallId: data.toolCallId as string,
      toolName: data.toolName as string,
      input: (data.input as string) ?? '',
      timeoutMs: (data.timeoutMs as number) ?? 600_000,
    };
  },
  formatToolDescription: (toolName: string, input: string) => {
    try {
      const parsed = JSON.parse(input) as Record<string, unknown>;
      if (toolName === 'Write' && typeof parsed.path === 'string') {
        return `wants to write to \`${parsed.path}\``;
      }
      if (toolName === 'Edit' && typeof parsed.file_path === 'string') {
        return `wants to edit \`${parsed.file_path}\``;
      }
      if (toolName === 'Bash' && typeof parsed.command === 'string') {
        const cmd = parsed.command as string;
        const preview = cmd.length > 60 ? `${cmd.slice(0, 57)}...` : cmd;
        return `wants to run \`${preview}\``;
      }
    } catch {
      // not JSON
    }
    return `wants to use tool \`${toolName}\``;
  },
  truncateText: (text: string, maxLen: number) => {
    if (text.length <= maxLen) return text;
    return `${text.slice(0, maxLen - 3)}...`;
  },
}));

const mockSendChatAction = vi.fn().mockResolvedValue(true);
const mockSendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
const mockSendMessageDraft = vi.fn().mockResolvedValue(true);

function buildMockBot(): Bot {
  return {
    api: {
      sendChatAction: mockSendChatAction,
      sendMessage: mockSendMessage,
      sendMessageDraft: mockSendMessageDraft,
    },
  } as unknown as Bot;
}

function createCallbacks(): AdapterOutboundCallbacks {
  return {
    trackOutbound: vi.fn(),
    recordError: vi.fn(),
  };
}

function createEnvelope(subject: string, payload: unknown, from = 'relay.agent.backend') {
  return {
    id: 'env-01',
    subject,
    from,
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

describe('typing indicator -- interval refresh', () => {
  let bot: Bot;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    bot = buildMockBot();
  });

  afterEach(() => {
    clearAllTypingIntervals();
    vi.useRealTimers();
  });

  it('calls sendChatAction immediately on active signal', async () => {
    await handleTypingSignal(bot, 'relay.human.telegram.12345', 'active');
    expect(mockSendChatAction).toHaveBeenCalledTimes(1);
    expect(mockSendChatAction).toHaveBeenCalledWith(12345, 'typing');
  });

  it('refreshes sendChatAction every 4 seconds', async () => {
    await handleTypingSignal(bot, 'relay.human.telegram.12345', 'active');
    expect(mockSendChatAction).toHaveBeenCalledTimes(1);

    // Advance 4 seconds -- first interval tick
    await vi.advanceTimersByTimeAsync(4_000);
    expect(mockSendChatAction).toHaveBeenCalledTimes(2);

    // Advance another 4 seconds -- second interval tick
    await vi.advanceTimersByTimeAsync(4_000);
    expect(mockSendChatAction).toHaveBeenCalledTimes(3);
  });

  it('clears interval on non-active signal', async () => {
    await handleTypingSignal(bot, 'relay.human.telegram.12345', 'active');
    expect(mockSendChatAction).toHaveBeenCalledTimes(1);

    // Stop typing
    await handleTypingSignal(bot, 'relay.human.telegram.12345', 'stopped');

    // Advance time -- should NOT trigger additional calls
    await vi.advanceTimersByTimeAsync(8_000);
    expect(mockSendChatAction).toHaveBeenCalledTimes(1);
  });

  it('clears interval when sendChatAction fails', async () => {
    await handleTypingSignal(bot, 'relay.human.telegram.12345', 'active');

    // Make the interval tick fail
    mockSendChatAction.mockRejectedValueOnce(new Error('chat not found'));
    await vi.advanceTimersByTimeAsync(4_000);

    // Should not call again after failure
    await vi.advanceTimersByTimeAsync(4_000);
    // 3 total: 1 immediate + 1 failed interval + 0 after clear
    expect(mockSendChatAction).toHaveBeenCalledTimes(2);
  });

  it('replaces existing interval on repeated active signals', async () => {
    await handleTypingSignal(bot, 'relay.human.telegram.12345', 'active');
    await handleTypingSignal(bot, 'relay.human.telegram.12345', 'active');

    // Should have called immediately twice (once per active signal)
    expect(mockSendChatAction).toHaveBeenCalledTimes(2);

    // Only one interval should be running
    await vi.advanceTimersByTimeAsync(4_000);
    expect(mockSendChatAction).toHaveBeenCalledTimes(3);
  });

  it('does nothing when bot is null', async () => {
    await handleTypingSignal(null, 'relay.human.telegram.12345', 'active');
    expect(mockSendChatAction).not.toHaveBeenCalled();
  });

  it('clearAllTypingIntervals clears all active intervals', async () => {
    await handleTypingSignal(bot, 'relay.human.telegram.111', 'active');
    await handleTypingSignal(bot, 'relay.human.telegram.222', 'active');

    clearAllTypingIntervals();

    await vi.advanceTimersByTimeAsync(8_000);
    // Only the 2 immediate calls, no interval refreshes
    expect(mockSendChatAction).toHaveBeenCalledTimes(2);
  });
});

describe('deliverMessage', () => {
  let bot: Bot;
  let responseBuffers: Map<number, ResponseBuffer>;
  let callbacks: AdapterOutboundCallbacks;

  beforeEach(() => {
    vi.clearAllMocks();
    bot = buildMockBot();
    responseBuffers = new Map();
    callbacks = createCallbacks();
  });

  describe('echo prevention', () => {
    it('skips envelopes from relay.human.telegram.* (echo prevention)', async () => {
      const envelope = createEnvelope(
        'relay.human.telegram.12345',
        { content: 'echo' },
        'relay.human.telegram.bot',
      );
      const result = await deliverMessage({
        adapterId: 'telegram',
        subject: 'relay.human.telegram.12345',
        envelope,
        bot,
        responseBuffers,
        callbacks,
        streaming: false,
      });
      expect(result.success).toBe(true);
      expect(mockSendMessage).not.toHaveBeenCalled();
    });
  });

  describe('guard conditions', () => {
    it('returns error when bot is null', async () => {
      const envelope = createEnvelope('relay.human.telegram.12345', { content: 'hi' });
      const result = await deliverMessage({
        adapterId: 'telegram',
        subject: 'relay.human.telegram.12345',
        envelope,
        bot: null,
        responseBuffers,
        callbacks,
        streaming: false,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not started');
    });

    it('returns error when subject has no extractable chat ID', async () => {
      const envelope = createEnvelope('relay.human.slack.D123', { content: 'hi' });
      const result = await deliverMessage({
        adapterId: 'telegram',
        subject: 'relay.human.slack.D123',
        envelope,
        bot,
        responseBuffers,
        callbacks,
        streaming: false,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('cannot extract chat ID');
    });
  });

  describe('standard payload delivery', () => {
    it('sends standard payload via sendMessage', async () => {
      const envelope = createEnvelope('relay.human.telegram.12345', { content: 'Hello!' });
      const result = await deliverMessage({
        adapterId: 'telegram',
        subject: 'relay.human.telegram.12345',
        envelope,
        bot,
        responseBuffers,
        callbacks,
        streaming: false,
      });
      expect(result.success).toBe(true);
      expect(mockSendMessage).toHaveBeenCalledWith(12345, 'Hello!');
      expect(callbacks.trackOutbound).toHaveBeenCalled();
    });
  });

  describe('streaming — text_delta buffering', () => {
    it('buffers text_delta events without sending', async () => {
      const envelope = createEnvelope('relay.human.telegram.12345', {
        type: 'text_delta',
        data: { text: 'Hello' },
      });
      const result = await deliverMessage({
        adapterId: 'telegram',
        subject: 'relay.human.telegram.12345',
        envelope,
        bot,
        responseBuffers,
        callbacks,
        streaming: false,
      });
      expect(result.success).toBe(true);
      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(responseBuffers.get(12345)?.text).toBe('Hello');
    });

    it('accumulates multiple text_delta events', async () => {
      for (const text of ['Hello', ' world', '!']) {
        const envelope = createEnvelope('relay.human.telegram.12345', {
          type: 'text_delta',
          data: { text },
        });
        await deliverMessage({
          adapterId: 'telegram',
          subject: 'relay.human.telegram.12345',
          envelope,
          bot,
          responseBuffers,
          callbacks,
          streaming: false,
        });
      }
      expect(responseBuffers.get(12345)?.text).toBe('Hello world!');
      expect(mockSendMessage).not.toHaveBeenCalled();
    });
  });

  describe('streaming — done flush', () => {
    it('flushes buffered text on done event', async () => {
      responseBuffers.set(12345, { text: 'Accumulated text', startedAt: Date.now() });
      const envelope = createEnvelope('relay.human.telegram.12345', {
        type: 'done',
        data: {},
      });
      const result = await deliverMessage({
        adapterId: 'telegram',
        subject: 'relay.human.telegram.12345',
        envelope,
        bot,
        responseBuffers,
        callbacks,
        streaming: false,
      });
      expect(result.success).toBe(true);
      expect(mockSendMessage).toHaveBeenCalledWith(12345, 'Accumulated text');
      expect(responseBuffers.has(12345)).toBe(false);
      expect(callbacks.trackOutbound).toHaveBeenCalled();
    });

    it('done with no buffered text does not send', async () => {
      const envelope = createEnvelope('relay.human.telegram.12345', {
        type: 'done',
        data: {},
      });
      const result = await deliverMessage({
        adapterId: 'telegram',
        subject: 'relay.human.telegram.12345',
        envelope,
        bot,
        responseBuffers,
        callbacks,
        streaming: false,
      });
      expect(result.success).toBe(true);
      expect(mockSendMessage).not.toHaveBeenCalled();
    });
  });

  describe('streaming — error flush', () => {
    it('flushes buffer with error suffix on error event', async () => {
      responseBuffers.set(12345, { text: 'Partial response', startedAt: Date.now() });
      const envelope = createEnvelope('relay.human.telegram.12345', {
        type: 'error',
        data: { message: 'Context exceeded' },
      });
      const result = await deliverMessage({
        adapterId: 'telegram',
        subject: 'relay.human.telegram.12345',
        envelope,
        bot,
        responseBuffers,
        callbacks,
        streaming: false,
      });
      expect(result.success).toBe(true);
      expect(mockSendMessage).toHaveBeenCalledWith(
        12345,
        expect.stringContaining('[Error: Context exceeded]'),
      );
      expect(responseBuffers.has(12345)).toBe(false);
    });

    it('sends standalone error when no buffer exists', async () => {
      const envelope = createEnvelope('relay.human.telegram.12345', {
        type: 'error',
        data: { message: 'Session failed' },
      });
      await deliverMessage({
        adapterId: 'telegram',
        subject: 'relay.human.telegram.12345',
        envelope,
        bot,
        responseBuffers,
        callbacks,
        streaming: false,
      });
      expect(mockSendMessage).toHaveBeenCalledWith(12345, '[Error: Session failed]');
    });
  });

  describe('event whitelist — unknown events silently dropped', () => {
    it.each([
      'thinking_delta',
      'system_status',
      'tool_progress',
      'compact_boundary',
      'subagent_started',
      'subagent_progress',
      'subagent_done',
      'hook_started',
      'hook_progress',
      'hook_response',
      'prompt_suggestion',
      'presence_update',
      'rate_limit',
      'session_status',
      'tool_call_start',
      'tool_call_delta',
      'tool_call_end',
      'tool_result',
      'approval_required',
      'question_prompt',
      'some_future_event_xyz',
    ])('silently drops %s', async (eventType) => {
      const envelope = createEnvelope('relay.human.telegram.12345', {
        type: eventType,
        data: { text: 'internal data' },
      });
      const result = await deliverMessage({
        adapterId: 'telegram',
        subject: 'relay.human.telegram.12345',
        envelope,
        bot,
        responseBuffers,
        callbacks,
        streaming: false,
      });
      expect(result.success).toBe(true);
      expect(mockSendMessage).not.toHaveBeenCalled();
    });
  });

  describe('sendMessageDraft streaming', () => {
    beforeEach(() => {
      // clearAllTypingIntervals also resets the module-level lastDraftUpdate map
      clearAllTypingIntervals();
    });

    it('calls sendMessageDraft for DMs when streaming is true', async () => {
      const envelope = createEnvelope('relay.human.telegram.12345', {
        type: 'text_delta',
        data: { text: 'Hello' },
      });
      await deliverMessage({
        adapterId: 'telegram',
        subject: 'relay.human.telegram.12345',
        envelope,
        bot,
        responseBuffers,
        callbacks,
        streaming: true,
      });
      expect(mockSendMessageDraft).toHaveBeenCalledWith(12345, 'Hello');
    });

    it('does not call sendMessageDraft for groups (negative chatId)', async () => {
      const envelope = createEnvelope('relay.human.telegram.-100123', {
        type: 'text_delta',
        data: { text: 'Hello' },
      });
      await deliverMessage({
        adapterId: 'telegram',
        subject: 'relay.human.telegram.-100123',
        envelope,
        bot,
        responseBuffers,
        callbacks,
        streaming: true,
      });
      expect(mockSendMessageDraft).not.toHaveBeenCalled();
      // Still buffers the text
      expect(responseBuffers.get(-100123)?.text).toBe('Hello');
    });

    it('does not call sendMessageDraft when streaming is false', async () => {
      const envelope = createEnvelope('relay.human.telegram.12345', {
        type: 'text_delta',
        data: { text: 'Hello' },
      });
      await deliverMessage({
        adapterId: 'telegram',
        subject: 'relay.human.telegram.12345',
        envelope,
        bot,
        responseBuffers,
        callbacks,
        streaming: false,
      });
      expect(mockSendMessageDraft).not.toHaveBeenCalled();
    });

    it('throttles sendMessageDraft to DRAFT_UPDATE_INTERVAL_MS', async () => {
      vi.useFakeTimers();
      // Pin Date.now() so the first call goes through
      vi.setSystemTime(1_000_000);

      const envelope1 = createEnvelope('relay.human.telegram.12345', {
        type: 'text_delta',
        data: { text: 'Hello' },
      });
      await deliverMessage({
        adapterId: 'telegram',
        subject: 'relay.human.telegram.12345',
        envelope: envelope1,
        bot,
        responseBuffers,
        callbacks,
        streaming: true,
      });
      expect(mockSendMessageDraft).toHaveBeenCalledTimes(1);

      // Second call within throttle window (no time advance) — should be skipped
      const envelope2 = createEnvelope('relay.human.telegram.12345', {
        type: 'text_delta',
        data: { text: ' world' },
      });
      await deliverMessage({
        adapterId: 'telegram',
        subject: 'relay.human.telegram.12345',
        envelope: envelope2,
        bot,
        responseBuffers,
        callbacks,
        streaming: true,
      });
      expect(mockSendMessageDraft).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });

    it('silently swallows sendMessageDraft errors (graceful fallback)', async () => {
      mockSendMessageDraft.mockRejectedValueOnce(new Error('not available'));
      const envelope = createEnvelope('relay.human.telegram.12345', {
        type: 'text_delta',
        data: { text: 'Hello' },
      });
      const result = await deliverMessage({
        adapterId: 'telegram',
        subject: 'relay.human.telegram.12345',
        envelope,
        bot,
        responseBuffers,
        callbacks,
        streaming: true,
      });
      // Should succeed — draft is best-effort
      expect(result.success).toBe(true);
      // Text should still be buffered
      expect(responseBuffers.get(12345)?.text).toBe('Hello');
    });

    it('finalizes draft via sendMessage on done', async () => {
      responseBuffers.set(12345, { text: 'Full response', startedAt: Date.now() });
      const envelope = createEnvelope('relay.human.telegram.12345', {
        type: 'done',
        data: {},
      });
      await deliverMessage({
        adapterId: 'telegram',
        subject: 'relay.human.telegram.12345',
        envelope,
        bot,
        responseBuffers,
        callbacks,
        streaming: true,
      });
      expect(mockSendMessage).toHaveBeenCalledWith(12345, 'Full response');
    });
  });

  describe('TTL reaping', () => {
    it('reaps stale buffers older than BUFFER_TTL_MS on the next deliverMessage call', async () => {
      // Seed a buffer that is already past its TTL
      const staleStartedAt = Date.now() - BUFFER_TTL_MS - 1;
      responseBuffers.set(99999, { text: 'stale text', startedAt: staleStartedAt });

      // Deliver any message to trigger the reaping pass
      const envelope = createEnvelope('relay.human.telegram.12345', { content: 'ping' });
      await deliverMessage({
        adapterId: 'telegram',
        subject: 'relay.human.telegram.12345',
        envelope,
        bot,
        responseBuffers,
        callbacks,
        streaming: false,
      });

      expect(responseBuffers.has(99999)).toBe(false);
    });

    it('preserves buffers that are within the TTL window', async () => {
      // Seed a buffer that is well within the TTL
      const recentStartedAt = Date.now() - 1_000;
      responseBuffers.set(99999, { text: 'recent text', startedAt: recentStartedAt });

      const envelope = createEnvelope('relay.human.telegram.12345', { content: 'ping' });
      await deliverMessage({
        adapterId: 'telegram',
        subject: 'relay.human.telegram.12345',
        envelope,
        bot,
        responseBuffers,
        callbacks,
        streaming: false,
      });

      expect(responseBuffers.has(99999)).toBe(true);
      expect(responseBuffers.get(99999)?.text).toBe('recent text');
    });

    it('preserves the original startedAt when appending text_delta chunks', async () => {
      const originalStartedAt = Date.now() - 5_000;
      responseBuffers.set(12345, { text: 'first', startedAt: originalStartedAt });

      const envelope = createEnvelope('relay.human.telegram.12345', {
        type: 'text_delta',
        data: { text: ' second' },
      });
      await deliverMessage({
        adapterId: 'telegram',
        subject: 'relay.human.telegram.12345',
        envelope,
        bot,
        responseBuffers,
        callbacks,
        streaming: false,
      });

      const buf = responseBuffers.get(12345);
      expect(buf?.text).toBe('first second');
      expect(buf?.startedAt).toBe(originalStartedAt);
    });
  });

  describe('approval_required handling', () => {
    beforeEach(() => {
      // Clear the module-level callbackIdMap between tests
      callbackIdMap.clear();
    });

    it('renders inline keyboard with Approve and Deny buttons', async () => {
      const envelope = createEnvelope('relay.human.telegram.12345', {
        type: 'approval_required',
        data: {
          toolCallId: 'toolu_123',
          toolName: 'Write',
          input: '{"path":"src/index.ts","content":"hello"}',
          timeoutMs: 600_000,
          agentId: 'agent-1',
          ccaSessionKey: 'sess-abc',
        },
      });
      const result = await deliverMessage({
        adapterId: 'telegram',
        subject: 'relay.human.telegram.12345',
        envelope,
        bot,
        responseBuffers,
        callbacks,
        streaming: false,
      });
      expect(result.success).toBe(true);
      expect(mockSendMessage).toHaveBeenCalledWith(
        12345,
        expect.stringContaining('Tool Approval Required'),
        expect.objectContaining({
          reply_markup: expect.objectContaining({
            inline_keyboard: expect.arrayContaining([
              expect.arrayContaining([
                expect.objectContaining({ text: 'Approve' }),
                expect.objectContaining({ text: 'Deny' }),
              ]),
            ]),
          }),
        }),
      );
      expect(callbacks.trackOutbound).toHaveBeenCalled();
    });

    it('stores full IDs in callbackIdMap with a short key', async () => {
      const envelope = createEnvelope('relay.human.telegram.12345', {
        type: 'approval_required',
        data: {
          toolCallId: 'toolu_123',
          toolName: 'Write',
          input: '{"path":"src/index.ts"}',
          timeoutMs: 600_000,
          agentId: 'agent-1',
          ccaSessionKey: 'sess-abc',
        },
      });
      await deliverMessage({
        adapterId: 'telegram',
        subject: 'relay.human.telegram.12345',
        envelope,
        bot,
        responseBuffers,
        callbacks,
        streaming: false,
      });
      expect(callbackIdMap.size).toBe(1);
      const entry = [...callbackIdMap.values()][0];
      expect(entry).toEqual({
        toolCallId: 'toolu_123',
        sessionId: 'sess-abc',
        agentId: 'agent-1',
      });
      // Short key should be 12 hex characters (6 bytes)
      const key = [...callbackIdMap.keys()][0];
      expect(key).toHaveLength(12);
    });

    it('encodes callback_data under 64 bytes', async () => {
      const envelope = createEnvelope('relay.human.telegram.12345', {
        type: 'approval_required',
        data: {
          toolCallId: 'toolu_123',
          toolName: 'Write',
          input: '{"path":"src/index.ts"}',
          timeoutMs: 600_000,
          agentId: 'agent-1',
          ccaSessionKey: 'sess-abc',
        },
      });
      await deliverMessage({
        adapterId: 'telegram',
        subject: 'relay.human.telegram.12345',
        envelope,
        bot,
        responseBuffers,
        callbacks,
        streaming: false,
      });
      const call = mockSendMessage.mock.calls[0];
      const keyboard = (call[2] as { reply_markup: { inline_keyboard: { callback_data: string }[][] } })
        .reply_markup.inline_keyboard[0];
      expect(Buffer.byteLength(keyboard[0].callback_data)).toBeLessThanOrEqual(64);
      expect(Buffer.byteLength(keyboard[1].callback_data)).toBeLessThanOrEqual(64);
    });

    it('evicts callbackIdMap entry after CALLBACK_ID_TTL_MS', async () => {
      vi.useFakeTimers();
      const envelope = createEnvelope('relay.human.telegram.12345', {
        type: 'approval_required',
        data: {
          toolCallId: 'toolu_ttl',
          toolName: 'Bash',
          input: '{"command":"ls"}',
          timeoutMs: 600_000,
          agentId: 'agent-1',
          ccaSessionKey: 'sess-abc',
        },
      });
      await deliverMessage({
        adapterId: 'telegram',
        subject: 'relay.human.telegram.12345',
        envelope,
        bot,
        responseBuffers,
        callbacks,
        streaming: false,
      });
      expect(callbackIdMap.size).toBe(1);

      // Advance past the 15-minute TTL
      vi.advanceTimersByTime(15 * 60 * 1_000 + 1);
      expect(callbackIdMap.size).toBe(0);

      vi.useRealTimers();
    });

    it('falls through to whitelist drop when approval data is invalid', async () => {
      const envelope = createEnvelope('relay.human.telegram.12345', {
        type: 'approval_required',
        data: { toolName: 'Write' }, // missing toolCallId
      });
      const result = await deliverMessage({
        adapterId: 'telegram',
        subject: 'relay.human.telegram.12345',
        envelope,
        bot,
        responseBuffers,
        callbacks,
        streaming: false,
      });
      expect(result.success).toBe(true);
      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(callbackIdMap.size).toBe(0);
    });

    it('flushes buffered text before posting approval card', async () => {
      const responseBuffers = new Map<number, ResponseBuffer>();
      const bot = buildMockBot();
      const callbacks = createCallbacks();

      // Simulate text_delta buffering
      const deltaEnv = createEnvelope('relay.human.telegram.12345', {
        type: 'text_delta',
        data: { text: 'Let me search for projects' },
      }, 'agent:sess-1');
      await deliverMessage({
        adapterId: 'telegram',
        subject: 'relay.human.telegram.12345',
        envelope: deltaEnv,
        bot,
        responseBuffers,
        callbacks,
        streaming: false,
      });
      expect(mockSendMessage).not.toHaveBeenCalled(); // buffered only

      // Send approval_required — should flush text first
      const approvalEnv = createEnvelope('relay.human.telegram.12345', {
        type: 'approval_required',
        data: {
          toolCallId: 'toolu_flush',
          toolName: 'WebSearch',
          input: '{"query":"art blocks"}',
          timeoutMs: 600_000,
          agentId: 'agent-1',
          ccaSessionKey: 'sess-1',
        },
      }, 'agent:sess-1');
      await deliverMessage({
        adapterId: 'telegram',
        subject: 'relay.human.telegram.12345',
        envelope: approvalEnv,
        bot,
        responseBuffers,
        callbacks,
        streaming: false,
      });

      // First call: flushed buffer text; second call: approval card
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
      const flushCall = mockSendMessage.mock.calls[0];
      expect(flushCall[0]).toBe(12345);
      expect(flushCall[1]).toContain('Let me search for projects');
    });
  });
});
