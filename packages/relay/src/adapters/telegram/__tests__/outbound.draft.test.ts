import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deliverMessage, createTelegramOutboundState } from '../outbound.js';
import type { ResponseBuffer, TelegramOutboundState } from '../outbound.js';
import type { Bot } from 'grammy';
import type { AdapterOutboundCallbacks } from '../../../types.js';
import {
  buildMockBot,
  createCallbacks,
  createEnvelope,
  mockSendMessage,
  mockSendMessageDraft,
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

    it('finalizes draft via sendMessage on done', async () => {
      responseBuffers.set(12345, {
        text: 'Full response',
        startedAt: Date.now(),
        lastEventAt: Date.now(),
      });
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
});
