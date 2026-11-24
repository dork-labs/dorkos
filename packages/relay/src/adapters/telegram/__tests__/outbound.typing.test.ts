import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  deliverMessage,
  handleTypingSignal,
  clearAllTypingIntervals,
  createTelegramOutboundState,
  TYPING_INACTIVITY_MS,
  TYPING_REFRESH_MS,
} from '../outbound.js';
import type { ResponseBuffer, TelegramOutboundState } from '../outbound.js';
import type { Bot } from 'grammy';
import type { AdapterOutboundCallbacks } from '../../../types.js';
import {
  buildMockBot,
  createCallbacks,
  createEnvelope,
  mockSendChatAction,
  mockSendMessage,
  testCodec,
} from './outbound.fixtures.js';

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

  // Every other terminal: an error (even a malformed one with no message), a
  // plain non-streamed reply, and the two other interactions that block on a
  // person, which Telegram's whitelist drops, so typing through them would show
  // a question nobody can see.
  it.each([
    ['an error', { type: 'error', data: { message: 'Session failed' } }],
    ['an error with no message', { type: 'error', data: {} }],
    ['a standard reply', { content: 'Direct reply' }],
    ['a question', { type: 'question_prompt', data: { id: 'q-1', questions: [] } }],
    [
      'an elicitation',
      { type: 'elicitation_prompt', data: { id: 'e-1', serverName: 'mcp', message: 'Which?' } },
    ],
  ])('stops at %s', async (_label, payload) => {
    await deliverEvent({ type: 'text_delta', data: { text: 'Hello' } });
    expect(state.typingIntervals.has(12345)).toBe(true);

    await deliverEvent(payload);

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
