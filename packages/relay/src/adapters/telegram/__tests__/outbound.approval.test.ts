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

    it('encodes callback_data under 64 bytes, and forgets the full ids after their TTL', async () => {
      vi.useFakeTimers();
      const envelope = createEnvelope('relay.human.telegram.12345', {
        type: 'approval_required',
        data: {
          toolCallId: 'toolu_123',
          toolName: 'Write',
          input: '{"path":"src/index.ts"}',
          // Longer than the 15-minute id TTL, so only the TTL can evict it.
          timeoutMs: 3_600_000,
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

      // The short key maps back to the full ids for 15 minutes, then is evicted.
      expect(state.callbackIdMap.size).toBe(1);
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
