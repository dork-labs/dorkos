import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  deliverMessage,
  handleTypingSignal,
  clearAllTypingIntervals,
  createTelegramOutboundState,
  BUFFER_TTL_MS,
  TYPING_INACTIVITY_MS,
  TYPING_REFRESH_MS,
} from '../outbound.js';
import type { ResponseBuffer, TelegramOutboundState } from '../outbound.js';
import type { Bot } from 'grammy';
import type { AdapterOutboundCallbacks } from '../../../types.js';
import { TelegramThreadIdCodec } from '../../../lib/thread-id.js';

// Mock inbound.js for extractChatId and constants
vi.mock('../inbound.js', () => ({
  SUBJECT_PREFIX: 'relay.human.telegram',
  MAX_MESSAGE_LENGTH: 4096,
  extractChatId: (
    codec: { decode: (s: string) => { platformId: string } | null },
    subject: string
  ) => {
    const decoded = codec.decode(subject);
    if (!decoded) return null;
    const id = Number(decoded.platformId);
    return Number.isInteger(id) ? id : null;
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
  escapeHtml: (text: string) =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  formatToolDescriptionHtml: (toolName: string, input: string) => {
    const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    try {
      const parsed = JSON.parse(input) as Record<string, unknown>;
      if (toolName === 'Write' && typeof parsed.path === 'string') {
        return `wants to write to <code>${esc(parsed.path)}</code>`;
      }
      if (toolName === 'Edit' && typeof parsed.file_path === 'string') {
        return `wants to edit <code>${esc(parsed.file_path)}</code>`;
      }
      if (toolName === 'Bash' && typeof parsed.command === 'string') {
        const cmd = parsed.command as string;
        const preview = cmd.length > 60 ? `${cmd.slice(0, 57)}...` : cmd;
        return `wants to run <code>${esc(preview)}</code>`;
      }
    } catch {
      // not JSON
    }
    return `wants to use tool <code>${esc(toolName)}</code>`;
  },
  truncateText: (text: string, maxLen: number) => {
    if (text.length <= maxLen) return text;
    return `${text.slice(0, maxLen - 3)}...`;
  },
  extractAgentIdFromEnvelope: (envelope: { payload?: unknown }) => {
    const payload = envelope.payload;
    if (payload && typeof payload === 'object' && 'data' in payload) {
      const data = (payload as Record<string, unknown>).data;
      if (data && typeof data === 'object' && 'agentId' in data) {
        return (data as Record<string, unknown>).agentId as string | undefined;
      }
    }
    return undefined;
  },
  extractSessionIdFromEnvelope: (envelope: { payload?: unknown }) => {
    const payload = envelope.payload;
    if (payload && typeof payload === 'object' && 'data' in payload) {
      const data = (payload as Record<string, unknown>).data;
      if (data && typeof data === 'object' && 'ccaSessionKey' in data) {
        return (data as Record<string, unknown>).ccaSessionKey as string | undefined;
      }
    }
    return undefined;
  },
  // Pass-through split: outbound tests do not test Markdown→HTML conversion
  // or chunking — real behavior is covered in lib/__tests__/payload-utils.test.ts.
  splitTelegramHtml: (text: string) => [text],
  TELEGRAM_MAX_LENGTH: 4000,
  TELEGRAM_HARD_LIMIT: 4096,
  SLACK_MAX_LENGTH: 3500,
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

/** Shared codec for tests — no instance ID so prefix is `relay.human.telegram`. */
const testCodec = new TelegramThreadIdCodec();

describe('typing indicator -- interval refresh', () => {
  let bot: Bot;
  let state: TelegramOutboundState;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    bot = buildMockBot();
    state = createTelegramOutboundState();
  });

  afterEach(() => {
    clearAllTypingIntervals(state);
    vi.useRealTimers();
  });

  it('calls sendChatAction immediately on active signal', async () => {
    await handleTypingSignal(bot, 'relay.human.telegram.12345', state, 'active', testCodec);
    expect(mockSendChatAction).toHaveBeenCalledTimes(1);
    expect(mockSendChatAction).toHaveBeenCalledWith(12345, 'typing');
  });

  it('refreshes sendChatAction every 4 seconds', async () => {
    await handleTypingSignal(bot, 'relay.human.telegram.12345', state, 'active', testCodec);
    expect(mockSendChatAction).toHaveBeenCalledTimes(1);

    // Advance 4 seconds -- first interval tick
    await vi.advanceTimersByTimeAsync(4_000);
    expect(mockSendChatAction).toHaveBeenCalledTimes(2);

    // Advance another 4 seconds -- second interval tick
    await vi.advanceTimersByTimeAsync(4_000);
    expect(mockSendChatAction).toHaveBeenCalledTimes(3);
  });

  it('clears interval on non-active signal', async () => {
    await handleTypingSignal(bot, 'relay.human.telegram.12345', state, 'active', testCodec);
    expect(mockSendChatAction).toHaveBeenCalledTimes(1);

    // Stop typing
    await handleTypingSignal(bot, 'relay.human.telegram.12345', state, 'stopped', testCodec);

    // Advance time -- should NOT trigger additional calls
    await vi.advanceTimersByTimeAsync(8_000);
    expect(mockSendChatAction).toHaveBeenCalledTimes(1);
  });

  it('clears interval when sendChatAction fails', async () => {
    await handleTypingSignal(bot, 'relay.human.telegram.12345', state, 'active', testCodec);

    // Make the interval tick fail
    mockSendChatAction.mockRejectedValueOnce(new Error('chat not found'));
    await vi.advanceTimersByTimeAsync(4_000);

    // Should not call again after failure
    await vi.advanceTimersByTimeAsync(4_000);
    // 3 total: 1 immediate + 1 failed interval + 0 after clear
    expect(mockSendChatAction).toHaveBeenCalledTimes(2);
  });

  it('keeps one loop running across repeated active signals', async () => {
    await handleTypingSignal(bot, 'relay.human.telegram.12345', state, 'active', testCodec);
    await handleTypingSignal(bot, 'relay.human.telegram.12345', state, 'active', testCodec);

    // One loop for one working span — a repeat signal neither re-fires the
    // chat action nor restarts the 4s cadence.
    expect(mockSendChatAction).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(mockSendChatAction).toHaveBeenCalledTimes(2);
  });

  it('does nothing when bot is null', async () => {
    await handleTypingSignal(null, 'relay.human.telegram.12345', state, 'active', testCodec);
    expect(mockSendChatAction).not.toHaveBeenCalled();
  });

  it('clearAllTypingIntervals clears all active intervals', async () => {
    await handleTypingSignal(bot, 'relay.human.telegram.111', state, 'active', testCodec);
    await handleTypingSignal(bot, 'relay.human.telegram.222', state, 'active', testCodec);

    clearAllTypingIntervals(state);

    await vi.advanceTimersByTimeAsync(8_000);
    // Only the 2 immediate calls, no interval refreshes
    expect(mockSendChatAction).toHaveBeenCalledTimes(2);
  });
});

describe('typing follows the turn, not the receipt', () => {
  const SUBJECT = 'relay.human.telegram.12345';

  let bot: Bot;
  let responseBuffers: Map<number, ResponseBuffer>;
  let callbacks: AdapterOutboundCallbacks;
  let state: TelegramOutboundState;

  /** Deliver one runtime event for the chat under test. */
  function deliverEvent(payload: unknown) {
    return deliverMessage({
      adapterId: 'telegram',
      subject: SUBJECT,
      envelope: createEnvelope(SUBJECT, payload),
      bot,
      responseBuffers,
      state,
      callbacks,
      streaming: false,
      codec: testCodec,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    bot = buildMockBot();
    responseBuffers = new Map();
    callbacks = createCallbacks();
    state = createTelegramOutboundState();
  });

  afterEach(() => {
    clearAllTypingIntervals(state);
    vi.useRealTimers();
  });

  it('starts on the first event of the turn', async () => {
    await deliverEvent({ type: 'text_delta', data: { text: 'Hel' } });

    expect(mockSendChatAction).toHaveBeenCalledTimes(1);
    expect(mockSendChatAction).toHaveBeenCalledWith(12345, 'typing');
    expect(state.typingIntervals.has(12345)).toBe(true);
  });

  it('refreshes every 4 seconds while the turn runs', async () => {
    await deliverEvent({ type: 'text_delta', data: { text: 'Hel' } });
    expect(mockSendChatAction).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(mockSendChatAction).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(mockSendChatAction).toHaveBeenCalledTimes(3);

    // Not one tick early: the cadence is 4s, not "under 4s".
    await vi.advanceTimersByTimeAsync(3_999);
    expect(mockSendChatAction).toHaveBeenCalledTimes(3);
  });

  it('keeps typing well past the old 60s cap while the turn keeps speaking', async () => {
    await deliverEvent({ type: 'text_delta', data: { text: 'thinking' } });

    // 90s of real work, restated by the stream throughout. The old blind cap
    // stopped at 60s and lied about a turn that was still running.
    for (let elapsed = 0; elapsed < 90_000; elapsed += 10_000) {
      await vi.advanceTimersByTimeAsync(10_000);
      await deliverEvent({ type: 'text_delta', data: { text: 'more' } });
    }

    expect(state.typingIntervals.has(12345)).toBe(true);
    // 1 immediate + 22 refreshes (90_000 / 4_000, floored). The nine further
    // deliveries add none: one loop per chat, kept rather than restarted.
    expect(mockSendChatAction).toHaveBeenCalledTimes(23);
  });

  it('never cuts a turn that keeps speaking, however long it runs', async () => {
    await deliverEvent({ type: 'text_delta', data: { text: 'start' } });

    // 30 simulated minutes of a turn that reports in every 20s. The bound is
    // keyed to observation, not to a work budget, so this is never cut.
    for (let minute = 0; minute < 30; minute++) {
      for (let tick = 0; tick < 3; tick++) {
        await vi.advanceTimersByTimeAsync(20_000);
        await deliverEvent({ type: 'tool_result', data: { content: 'ok' } });
      }
    }

    expect(state.typingIntervals.has(12345)).toBe(true);
  });

  it('stops a stream that goes dark without a terminal', async () => {
    // The reviewer's probe: one delta, then silence forever. `done` is
    // best-effort upstream and a stalled stream may never reach its finally,
    // so a lost terminal must not leave the chat typing for the rest of time.
    await deliverEvent({ type: 'text_delta', data: { text: 'Hel' } });
    expect(state.typingIntervals.has(12345)).toBe(true);

    await vi.advanceTimersByTimeAsync(TYPING_INACTIVITY_MS + TYPING_REFRESH_MS);
    expect(state.typingIntervals.has(12345)).toBe(false);

    const callsAtStop = mockSendChatAction.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(mockSendChatAction).toHaveBeenCalledTimes(callsAtStop);
  });

  it('holds the indicator through a silence shorter than the bound', async () => {
    await deliverEvent({ type: 'text_delta', data: { text: 'Hel' } });

    await vi.advanceTimersByTimeAsync(TYPING_INACTIVITY_MS - TYPING_REFRESH_MS);

    expect(state.typingIntervals.has(12345)).toBe(true);
  });

  it('does not re-fire a chat action for every streamed chunk', async () => {
    await deliverEvent({ type: 'text_delta', data: { text: 'a' } });
    await deliverEvent({ type: 'text_delta', data: { text: 'b' } });
    await deliverEvent({ type: 'text_delta', data: { text: 'c' } });

    // One loop for one turn — the refresh cadence is not reset by each chunk.
    expect(mockSendChatAction).toHaveBeenCalledTimes(1);
  });

  it('stops at the terminal when the reply is sent', async () => {
    await deliverEvent({ type: 'text_delta', data: { text: 'Hello' } });
    expect(state.typingIntervals.has(12345)).toBe(true);

    await deliverEvent({ type: 'done', data: {} });

    expect(state.typingIntervals.has(12345)).toBe(false);
    expect(mockSendMessage).toHaveBeenCalledTimes(1);

    mockSendChatAction.mockClear();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(mockSendChatAction).not.toHaveBeenCalled();
  });

  it('stops at the terminal when the turn errors', async () => {
    await deliverEvent({ type: 'text_delta', data: { text: 'Hello' } });
    expect(state.typingIntervals.has(12345)).toBe(true);

    await deliverEvent({ type: 'error', data: { message: 'Session failed' } });

    expect(state.typingIntervals.has(12345)).toBe(false);

    mockSendChatAction.mockClear();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(mockSendChatAction).not.toHaveBeenCalled();
  });

  it('stops while a tool approval waits on a person', async () => {
    await deliverEvent({ type: 'text_delta', data: { text: 'Hello' } });
    expect(state.typingIntervals.has(12345)).toBe(true);

    await deliverEvent({
      type: 'approval_required',
      data: {
        toolCallId: 'call-1',
        toolName: 'Bash',
        input: '{"command":"ls"}',
      },
    });

    // Waiting on a human is not working. Nothing about the agent is in flight.
    expect(state.typingIntervals.has(12345)).toBe(false);
  });

  // The other two interactions the session projector folds into `blocked`
  // alongside `approval_required`. Telegram's own whitelist drops all three
  // from delivery, so typing here would show a question nobody can see.
  it('stops while a question waits on a person', async () => {
    await deliverEvent({ type: 'text_delta', data: { text: 'Hello' } });
    expect(state.typingIntervals.has(12345)).toBe(true);

    await deliverEvent({ type: 'question_prompt', data: { id: 'q-1', questions: [] } });

    expect(state.typingIntervals.has(12345)).toBe(false);
  });

  it('stops while an elicitation waits on a person', async () => {
    await deliverEvent({ type: 'text_delta', data: { text: 'Hello' } });
    expect(state.typingIntervals.has(12345)).toBe(true);

    await deliverEvent({
      type: 'elicitation_prompt',
      data: { id: 'e-1', serverName: 'mcp', message: 'Which account?' },
    });

    expect(state.typingIntervals.has(12345)).toBe(false);
  });

  it('stops on an error terminal that carries no message', async () => {
    await deliverEvent({ type: 'text_delta', data: { text: 'Hello' } });
    expect(state.typingIntervals.has(12345)).toBe(true);

    // A malformed error is still a terminal. Classifying on the event type,
    // not on whether a message could be extracted, is what makes it one.
    await deliverEvent({ type: 'error', data: {} });

    expect(state.typingIntervals.has(12345)).toBe(false);
  });

  it('stops when a standard (non-streamed) reply arrives', async () => {
    await deliverEvent({ type: 'text_delta', data: { text: 'Hello' } });
    expect(state.typingIntervals.has(12345)).toBe(true);

    await deliverEvent({ content: 'Direct reply' });

    expect(state.typingIntervals.has(12345)).toBe(false);
  });

  it('clears the loop when a refresh fails', async () => {
    await deliverEvent({ type: 'text_delta', data: { text: 'Hello' } });

    mockSendChatAction.mockRejectedValueOnce(new Error('chat not found'));
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.advanceTimersByTimeAsync(4_000);

    // 1 immediate + 1 failed refresh, then nothing.
    expect(mockSendChatAction).toHaveBeenCalledTimes(2);
    expect(state.typingIntervals.has(12345)).toBe(false);
  });
});

describe('deliverMessage', () => {
  let bot: Bot;
  let responseBuffers: Map<number, ResponseBuffer>;
  let callbacks: AdapterOutboundCallbacks;
  let state: TelegramOutboundState;

  beforeEach(() => {
    vi.clearAllMocks();
    bot = buildMockBot();
    responseBuffers = new Map();
    callbacks = createCallbacks();
    state = createTelegramOutboundState();
  });

  describe('echo prevention', () => {
    it('skips envelopes from relay.human.telegram.* (echo prevention)', async () => {
      const envelope = createEnvelope(
        'relay.human.telegram.12345',
        { content: 'echo' },
        'relay.human.telegram.bot'
      );
      const result = await deliverMessage({
        adapterId: 'telegram',
        subject: 'relay.human.telegram.12345',
        envelope,
        bot,
        responseBuffers,
        state,
        callbacks,
        streaming: false,
        codec: testCodec,
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
        state,
        callbacks,
        streaming: false,
        codec: testCodec,
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
        state,
        callbacks,
        streaming: false,
        codec: testCodec,
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
        state,
        callbacks,
        streaming: false,
        codec: testCodec,
      });
      expect(result.success).toBe(true);
      expect(mockSendMessage).toHaveBeenCalledWith(12345, 'Hello!', { parse_mode: 'HTML' });
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
        state,
        callbacks,
        streaming: false,
        codec: testCodec,
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
          state,
          callbacks,
          streaming: false,
          codec: testCodec,
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
        state,
        callbacks,
        streaming: false,
        codec: testCodec,
      });
      expect(result.success).toBe(true);
      expect(mockSendMessage).toHaveBeenCalledWith(12345, 'Accumulated text', {
        parse_mode: 'HTML',
      });
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
        state,
        callbacks,
        streaming: false,
        codec: testCodec,
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
        state,
        callbacks,
        streaming: false,
        codec: testCodec,
      });
      expect(result.success).toBe(true);
      expect(mockSendMessage).toHaveBeenCalledWith(
        12345,
        expect.stringContaining('[Error: Context exceeded]'),
        { parse_mode: 'HTML' }
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
        state,
        callbacks,
        streaming: false,
        codec: testCodec,
      });
      expect(mockSendMessage).toHaveBeenCalledWith(12345, '[Error: Session failed]', {
        parse_mode: 'HTML',
      });
    });
  });

  describe('event whitelist — unknown events silently dropped', () => {
    it.each([
      'thinking_delta',
      'system_status',
      'tool_progress',
      'compact_boundary',
      'background_task_started',
      'background_task_progress',
      'background_task_done',
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
        state,
        callbacks,
        streaming: false,
        codec: testCodec,
      });
      expect(result.success).toBe(true);
      expect(mockSendMessage).not.toHaveBeenCalled();
    });
  });

  describe('sendMessageDraft streaming', () => {
    beforeEach(() => {
      // Reset lastDraftUpdate on fresh state (already fresh from outer beforeEach)
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
        state,
        callbacks,
        streaming: true,
        codec: testCodec,
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
        state,
        callbacks,
        streaming: true,
        codec: testCodec,
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
        state,
        callbacks,
        streaming: false,
        codec: testCodec,
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
        state,
        callbacks,
        streaming: true,
        codec: testCodec,
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
        state,
        callbacks,
        streaming: true,
        codec: testCodec,
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
        state,
        callbacks,
        streaming: true,
        codec: testCodec,
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
        state,
        callbacks,
        streaming: true,
        codec: testCodec,
      });
      expect(mockSendMessage).toHaveBeenCalledWith(12345, 'Full response', { parse_mode: 'HTML' });
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
        state,
        callbacks,
        streaming: false,
        codec: testCodec,
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
        state,
        callbacks,
        streaming: false,
        codec: testCodec,
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
        state,
        callbacks,
        streaming: false,
        codec: testCodec,
      });

      const buf = responseBuffers.get(12345);
      expect(buf?.text).toBe('first second');
      expect(buf?.startedAt).toBe(originalStartedAt);
    });
  });

  describe('approval_required handling', () => {
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
        state,
        callbacks,
        streaming: false,
        codec: testCodec,
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
        })
      );
      expect(callbacks.trackOutbound).toHaveBeenCalled();
    });

    it('stores full IDs in state.callbackIdMap with a short key', async () => {
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
        state,
        callbacks,
        streaming: false,
        codec: testCodec,
      });
      expect(state.callbackIdMap.size).toBe(1);
      const entry = [...state.callbackIdMap.values()][0];
      expect(entry).toEqual({
        toolCallId: 'toolu_123',
        sessionId: 'sess-abc',
        agentId: 'agent-1',
      });
      // Short key should be 12 hex characters (6 bytes)
      const key = [...state.callbackIdMap.keys()][0];
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
        state,
        callbacks,
        streaming: false,
        codec: testCodec,
      });
      const call = mockSendMessage.mock.calls[0];
      const keyboard = (
        call[2] as { reply_markup: { inline_keyboard: { callback_data: string }[][] } }
      ).reply_markup.inline_keyboard[0];
      expect(Buffer.byteLength(keyboard[0].callback_data)).toBeLessThanOrEqual(64);
      expect(Buffer.byteLength(keyboard[1].callback_data)).toBeLessThanOrEqual(64);
    });

    it('evicts state.callbackIdMap entry after CALLBACK_ID_TTL_MS', async () => {
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
        state,
        callbacks,
        streaming: false,
        codec: testCodec,
      });
      expect(state.callbackIdMap.size).toBe(1);

      // Advance past the 15-minute TTL
      vi.advanceTimersByTime(15 * 60 * 1_000 + 1);
      expect(state.callbackIdMap.size).toBe(0);

      vi.useRealTimers();
    });

    it('renders the approval card in HTML parse mode (legacy Markdown hard-fails on tool input)', async () => {
      const envelope = createEnvelope('relay.human.telegram.12345', {
        type: 'approval_required',
        data: {
          toolCallId: 'toolu_html',
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
        state,
        callbacks,
        streaming: false,
        codec: testCodec,
      });
      const opts = mockSendMessage.mock.calls[0][2] as { parse_mode: string };
      expect(opts.parse_mode).toBe('HTML');
    });

    it('escapes adversarial tool input (backticks, underscores, HTML chars) in the card', async () => {
      const envelope = createEnvelope('relay.human.telegram.12345', {
        type: 'approval_required',
        data: {
          toolCallId: 'toolu_adv',
          toolName: 'Bash',
          input: '{"command":"echo `_hi_` && cat <file> & sleep"}',
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
        state,
        callbacks,
        streaming: false,
        codec: testCodec,
      });
      expect(result.success).toBe(true);
      const text = mockSendMessage.mock.calls[0][1] as string;
      // HTML-sensitive characters from the input must arrive escaped
      expect(text).toContain('&lt;file&gt;');
      expect(text).toContain('&amp;&amp;');
      expect(text).not.toContain('<file>');
      // Raw backticks/underscores are fine in HTML mode — they stay literal
      expect(text).toContain('`_hi_`');
    });

    it('logs loudly and records the error when the approval card cannot be sent', async () => {
      mockSendMessage.mockRejectedValueOnce(new Error("can't parse entities"));
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const envelope = createEnvelope('relay.human.telegram.12345', {
        type: 'approval_required',
        data: {
          toolCallId: 'toolu_fail',
          toolName: 'Write',
          input: '{"path":"src/index.ts"}',
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
        state,
        callbacks,
        streaming: false,
        codec: testCodec,
        logger,
      });
      expect(result.success).toBe(false);
      expect(callbacks.recordError).toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('failed to deliver approval card')
      );
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
        state,
        callbacks,
        streaming: false,
        codec: testCodec,
      });
      expect(result.success).toBe(true);
      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(state.callbackIdMap.size).toBe(0);
    });

    it('flushes buffered text before posting approval card', async () => {
      // Simulate text_delta buffering
      const deltaEnv = createEnvelope(
        'relay.human.telegram.12345',
        {
          type: 'text_delta',
          data: { text: 'Let me search for projects' },
        },
        'agent:sess-1'
      );
      await deliverMessage({
        adapterId: 'telegram',
        subject: 'relay.human.telegram.12345',
        envelope: deltaEnv,
        bot,
        responseBuffers,
        state,
        callbacks,
        streaming: false,
        codec: testCodec,
      });
      expect(mockSendMessage).not.toHaveBeenCalled(); // buffered only

      // Send approval_required — should flush text first
      const approvalEnv = createEnvelope(
        'relay.human.telegram.12345',
        {
          type: 'approval_required',
          data: {
            toolCallId: 'toolu_flush',
            toolName: 'WebSearch',
            input: '{"query":"art blocks"}',
            timeoutMs: 600_000,
            agentId: 'agent-1',
            ccaSessionKey: 'sess-1',
          },
        },
        'agent:sess-1'
      );
      await deliverMessage({
        adapterId: 'telegram',
        subject: 'relay.human.telegram.12345',
        envelope: approvalEnv,
        bot,
        responseBuffers,
        state,
        callbacks,
        streaming: false,
        codec: testCodec,
      });

      // First call: flushed buffer text; second call: approval card
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
      const flushCall = mockSendMessage.mock.calls[0];
      expect(flushCall[0]).toBe(12345);
      expect(flushCall[1]).toContain('Let me search for projects');
    });
  });
});
