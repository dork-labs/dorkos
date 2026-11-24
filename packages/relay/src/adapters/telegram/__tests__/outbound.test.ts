import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deliverMessage, createTelegramOutboundState, BUFFER_TTL_MS } from '../outbound.js';
import type { ResponseBuffer, TelegramOutboundState } from '../outbound.js';
import type { Bot } from 'grammy';
import type { AdapterOutboundCallbacks } from '../../../types.js';
import {
  buildMockBot,
  createCallbacks,
  createEnvelope,
  mockSendMessage,
  testCodec,
} from './outbound.fixtures.js';

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
      // `skipped`, not a plain success: the publish pipeline counts a skip as
      // neither delivered nor failed, which is what stopped an inbound message
      // in an unbound chat from tracing as `delivered` (DOR-789).
      expect(result).toMatchObject({ success: true, skipped: true });
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
      responseBuffers.set(12345, {
        text: 'Accumulated text',
        startedAt: Date.now(),
        lastEventAt: Date.now(),
      });
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

    // A turn that ends having sent nothing at all leaves the person looking at
    // their own question with no sign anything happened (DOR-789).
    it('done with nothing sent says the agent finished without a reply', async () => {
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
      expect(mockSendMessage).toHaveBeenCalledWith(
        12345,
        expect.stringContaining('finished without sending anything back'),
        { parse_mode: 'HTML' }
      );
    });

    // The runtime publishes error THEN done. The done used to find "nothing
    // spoken" and append "the agent finished without sending anything back"
    // under the error line — on every crashed turn (DOR-789).
    it('done after an error adds nothing — the error was the answer', async () => {
      const turn = { from: 'agent:session-crash' };
      await deliverMessage({
        adapterId: 'telegram',
        subject: 'relay.human.telegram.12345',
        envelope: createEnvelope(
          'relay.human.telegram.12345',
          { type: 'error', data: { message: 'SDK session crashed' } },
          turn.from
        ),
        bot,
        responseBuffers,
        state,
        callbacks,
        streaming: false,
        codec: testCodec,
      });
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      expect(mockSendMessage.mock.calls[0][1]).toContain('SDK session crashed');

      await deliverMessage({
        adapterId: 'telegram',
        subject: 'relay.human.telegram.12345',
        envelope: createEnvelope(
          'relay.human.telegram.12345',
          { type: 'done', data: {} },
          turn.from
        ),
        bot,
        responseBuffers,
        state,
        callbacks,
        streaming: false,
        codec: testCodec,
      });

      // Exactly the error line, and nothing after it.
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
    });

    it('two turns interleaved in one chat do not cancel each other out', async () => {
      // Turn A streams text; turn B finishes first. The response buffer is
      // keyed by CHAT (an inherited conflation, documented on the buffer), so
      // B's terminal is what flushes A's text — but the "has this turn spoken"
      // mark is keyed per TURN, so A stays marked and its own terminal adds
      // nothing. Keyed per chat, B's done consumed A's mark and A's done then
      // appended "the agent finished without sending anything back" under the
      // answer it had just given (DOR-789).
      await deliverMessage({
        adapterId: 'telegram',
        subject: 'relay.human.telegram.12345',
        envelope: createEnvelope(
          'relay.human.telegram.12345',
          { type: 'text_delta', data: { text: 'A is working' } },
          'agent:session-A'
        ),
        bot,
        responseBuffers,
        state,
        callbacks,
        streaming: false,
        codec: testCodec,
      });
      mockSendMessage.mockClear();

      await deliverMessage({
        adapterId: 'telegram',
        subject: 'relay.human.telegram.12345',
        envelope: createEnvelope(
          'relay.human.telegram.12345',
          { type: 'done', data: {} },
          'agent:session-B'
        ),
        bot,
        responseBuffers,
        state,
        callbacks,
        streaming: false,
        codec: testCodec,
      });
      // The chat's buffered text goes out. Not an empty response: something was
      // said in this chat.
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      expect(mockSendMessage.mock.calls[0][1]).toBe('A is working');
      mockSendMessage.mockClear();

      await deliverMessage({
        adapterId: 'telegram',
        subject: 'relay.human.telegram.12345',
        envelope: createEnvelope(
          'relay.human.telegram.12345',
          { type: 'done', data: {} },
          'agent:session-A'
        ),
        bot,
        responseBuffers,
        state,
        callbacks,
        streaming: false,
        codec: testCodec,
      });
      // A spoke, so A's terminal contradicts nothing.
      expect(mockSendMessage).not.toHaveBeenCalled();
    });
  });

  describe('streaming — error flush', () => {
    it('flushes buffer with error suffix on error event', async () => {
      responseBuffers.set(12345, {
        text: 'Partial response',
        startedAt: Date.now(),
        lastEventAt: Date.now(),
      });
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

  describe('TTL reaping', () => {
    it('reaps stale buffers older than BUFFER_TTL_MS on the next deliverMessage call', async () => {
      // Seed a buffer that is already past its TTL
      const staleStartedAt = Date.now() - BUFFER_TTL_MS - 1;
      responseBuffers.set(99999, {
        text: 'stale text',
        startedAt: staleStartedAt,
        lastEventAt: staleStartedAt,
      });

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
      responseBuffers.set(99999, {
        text: 'recent text',
        startedAt: recentStartedAt,
        lastEventAt: recentStartedAt,
      });

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

    // Reaping used to run off `startedAt`, which nothing refreshed, so a long
    // answer had its own text deleted mid-stream and `done` flushed only the
    // tail (DOR-789).
    it('keeps a stream alive past the TTL as long as text keeps arriving', async () => {
      const startedLongAgo = Date.now() - BUFFER_TTL_MS * 2;
      responseBuffers.set(12345, {
        text: 'the beginning of a long answer',
        startedAt: startedLongAgo,
        lastEventAt: Date.now() - 1_000,
      });

      await deliverMessage({
        adapterId: 'telegram',
        subject: 'relay.human.telegram.12345',
        envelope: createEnvelope('relay.human.telegram.12345', {
          type: 'text_delta',
          data: { text: ' and its end' },
        }),
        bot,
        responseBuffers,
        state,
        callbacks,
        streaming: false,
        codec: testCodec,
      });

      // Then the turn finishes: the whole answer goes out, not just the tail.
      await deliverMessage({
        adapterId: 'telegram',
        subject: 'relay.human.telegram.12345',
        envelope: createEnvelope('relay.human.telegram.12345', { type: 'done', data: {} }),
        bot,
        responseBuffers,
        state,
        callbacks,
        streaming: false,
        codec: testCodec,
      });

      expect(mockSendMessage).toHaveBeenCalledWith(
        12345,
        'the beginning of a long answer and its end',
        { parse_mode: 'HTML' }
      );
    });

    it('still reaps a stream that has genuinely gone silent', async () => {
      responseBuffers.set(99999, {
        text: 'abandoned',
        startedAt: Date.now() - 1_000,
        lastEventAt: Date.now() - BUFFER_TTL_MS - 1,
      });

      await deliverMessage({
        adapterId: 'telegram',
        subject: 'relay.human.telegram.12345',
        envelope: createEnvelope('relay.human.telegram.12345', { content: 'ping' }),
        bot,
        responseBuffers,
        state,
        callbacks,
        streaming: false,
        codec: testCodec,
      });

      expect(responseBuffers.has(99999)).toBe(false);
    });
  });
});
