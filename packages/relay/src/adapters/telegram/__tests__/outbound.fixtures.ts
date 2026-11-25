/**
 * Shared bot doubles and builders for the Telegram outbound test files.
 * Payload parsing and chat-id decoding run for real.
 */
import { vi, type Mock } from 'vitest';
import type { Bot } from 'grammy';
import type { AdapterOutboundCallbacks } from '../../../types.js';
import { TelegramThreadIdCodec } from '../../../lib/thread-id.js';

export const mockSendChatAction: Mock = vi.fn().mockResolvedValue(true);
export const mockSendMessage: Mock = vi.fn().mockResolvedValue({ message_id: 1 });
export const mockSendMessageDraft: Mock = vi.fn().mockResolvedValue(true);

export function buildMockBot(): Bot {
  return {
    api: {
      sendChatAction: mockSendChatAction,
      sendMessage: mockSendMessage,
      sendMessageDraft: mockSendMessageDraft,
    },
  } as unknown as Bot;
}

export function createCallbacks(): AdapterOutboundCallbacks {
  return {
    trackOutbound: vi.fn(),
    recordError: vi.fn(),
  };
}

export function createEnvelope(subject: string, payload: unknown, from = 'relay.agent.backend') {
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
export const testCodec = new TelegramThreadIdCodec();
