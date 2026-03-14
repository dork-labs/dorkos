import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WebClient } from '@slack/web-api';
import { deliverMessage } from '../outbound.js';
import type { ActiveStream } from '../outbound.js';
import type { AdapterOutboundCallbacks } from '../../../types.js';

// Mock the inbound module since it is developed in parallel.
// These constants match the values defined in inbound.ts.
vi.mock('../inbound.js', () => ({
  SUBJECT_PREFIX: 'relay.human.slack',
  MAX_MESSAGE_LENGTH: 4000,
  extractChannelId: (subject: string) => {
    const prefix = 'relay.human.slack';
    if (!subject.startsWith(prefix)) return null;
    const remainder = subject.slice(prefix.length + 1);
    if (!remainder) return null;
    if (remainder.startsWith('group.')) {
      const id = remainder.slice('group.'.length);
      return id || null;
    }
    return remainder;
  },
}));

// Mock payload-utils.js to avoid slackify-markdown dependency noise in tests.
// formatForPlatform is a passthrough so test assertions match raw text without
// mrkdwn conversion applied. All other utils are provided with real implementations.
vi.mock('../../../lib/payload-utils.js', () => {
  return {
    extractPayloadContent: (payload: unknown) => {
      if (typeof payload === 'string') return payload;
      if (payload !== null && typeof payload === 'object') {
        const obj = payload as Record<string, unknown>;
        if (typeof obj.content === 'string') return obj.content;
        if (typeof obj.text === 'string') return obj.text;
      }
      try { return JSON.stringify(payload); } catch { return '[unserializable payload]'; }
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
    truncateText: (text: string, maxLen: number) => {
      if (text.length <= maxLen) return text;
      return `${text.slice(0, maxLen - 3)}...`;
    },
    SILENT_EVENT_TYPES: new Set([
      'session_status',
      'tool_call_start',
      'tool_call_delta',
      'tool_call_end',
      'tool_result',
      'approval_required',
      'question_prompt',
      'task_update',
      'relay_receipt',
      'message_delivered',
      'relay_message',
    ]),
    // Passthrough — no mrkdwn conversion applied in tests
    formatForPlatform: (content: string, _platform: string) => content,
  };
});

const mockPostMessage = vi.fn().mockResolvedValue({ ts: 'msg-ts-1' });
const mockChatUpdate = vi.fn().mockResolvedValue({ ts: 'msg-ts-1' });

/**
 * Build a WebClient test double with only the chat.postMessage and chat.update
 * methods wired. The cast through `unknown` is intentional: the real WebClient
 * has dozens of API groups we don't need, and a partial stub is cleaner than
 * implementing the full interface.
 */
function buildMockClient(): WebClient {
  const stub = { chat: { postMessage: mockPostMessage, update: mockChatUpdate } };
  return stub as unknown as WebClient;
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

/** Helper to call deliverMessage with options object. */
function deliver(
  subject: string,
  envelope: ReturnType<typeof createEnvelope>,
  client: WebClient | null,
  streamState: Map<string, ActiveStream>,
  callbacks: AdapterOutboundCallbacks,
  botUserId = 'UBOTID',
) {
  return deliverMessage({
    adapterId: 'slack',
    subject,
    envelope,
    client,
    streamState,
    botUserId,
    callbacks,
  });
}

describe('deliverMessage', () => {
  let client: WebClient;
  let streamState: Map<string, ActiveStream>;
  let callbacks: AdapterOutboundCallbacks;

  beforeEach(() => {
    vi.clearAllMocks();
    client = buildMockClient();
    streamState = new Map();
    callbacks = createCallbacks();
  });

  describe('echo prevention', () => {
    it('skips envelopes from relay.human.slack.* (echo prevention)', async () => {
      const envelope = createEnvelope(
        'relay.human.slack.D123',
        { content: 'echo' },
        'relay.human.slack.bot',
      );
      const result = await deliver('relay.human.slack.D123', envelope, client, streamState, callbacks);
      expect(result.success).toBe(true);
      expect(mockPostMessage).not.toHaveBeenCalled();
    });
  });

  describe('guard conditions', () => {
    it('returns error when client is null', async () => {
      const envelope = createEnvelope('relay.human.slack.D123', { content: 'hi' });
      const result = await deliver('relay.human.slack.D123', envelope, null, streamState, callbacks);
      expect(result.success).toBe(false);
      expect(result.error).toContain('not started');
    });

    it('returns error when subject has no extractable channel ID', async () => {
      const envelope = createEnvelope('relay.human.telegram.D123', { content: 'hi' });
      const result = await deliver('relay.human.telegram.D123', envelope, client, streamState, callbacks);
      expect(result.success).toBe(false);
      expect(result.error).toContain('cannot extract channel ID');
    });
  });

  describe('standard payload delivery', () => {
    it('sends standard payload via chat.postMessage', async () => {
      const envelope = createEnvelope('relay.human.slack.D123', { content: 'Hello!' });
      const result = await deliver('relay.human.slack.D123', envelope, client, streamState, callbacks);
      expect(result.success).toBe(true);
      expect(mockPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'D123', text: 'Hello!' }),
      );
      expect(callbacks.trackOutbound).toHaveBeenCalled();
    });

    it('includes thread_ts when platformData.ts is present', async () => {
      const envelope = createEnvelope('relay.human.slack.D123', {
        content: 'Threaded reply',
        platformData: { ts: '1234567890.123456' },
      });
      await deliver('relay.human.slack.D123', envelope, client, streamState, callbacks);
      expect(mockPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({ thread_ts: '1234567890.123456' }),
      );
    });

    it('uses platformData.threadTs over platformData.ts for threading', async () => {
      const envelope = createEnvelope('relay.human.slack.D123', {
        content: 'Already threaded',
        platformData: { ts: '1234.0001', threadTs: '1234.0000' },
      });
      await deliver('relay.human.slack.D123', envelope, client, streamState, callbacks);
      expect(mockPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({ thread_ts: '1234.0000' }),
      );
    });

    it('truncates messages to MAX_MESSAGE_LENGTH (4000 chars)', async () => {
      const longContent = 'A'.repeat(5000);
      const envelope = createEnvelope('relay.human.slack.D123', { content: longContent });
      await deliver('relay.human.slack.D123', envelope, client, streamState, callbacks);
      const call = mockPostMessage.mock.calls[0][0] as { text: string };
      expect(call.text.length).toBeLessThanOrEqual(4000);
      expect(call.text.endsWith('...')).toBe(true);
    });

    it('records error and returns failure when postMessage throws', async () => {
      mockPostMessage.mockRejectedValueOnce(new Error('channel_not_found'));
      const envelope = createEnvelope('relay.human.slack.D123', { content: 'hi' });
      const result = await deliver('relay.human.slack.D123', envelope, client, streamState, callbacks);
      expect(result.success).toBe(false);
      expect(result.error).toBe('channel_not_found');
      expect(callbacks.recordError).toHaveBeenCalled();
    });
  });

  describe('streaming — text_delta', () => {
    it('starts stream on first text_delta via chat.postMessage', async () => {
      const delta = createEnvelope('relay.human.slack.D123', {
        type: 'text_delta', data: { text: 'Hello' },
      });
      await deliver('relay.human.slack.D123', delta, client, streamState, callbacks);
      expect(mockPostMessage).toHaveBeenCalledTimes(1);
      expect(streamState.has('D123')).toBe(true);
      expect(streamState.get('D123')?.accumulatedText).toBe('Hello');
      expect(streamState.get('D123')?.messageTs).toBe('msg-ts-1');
    });

    it('updates existing stream on subsequent text_delta via chat.update', async () => {
      const delta1 = createEnvelope('relay.human.slack.D123', {
        type: 'text_delta', data: { text: 'Hello' },
      });
      await deliver('relay.human.slack.D123', delta1, client, streamState, callbacks);

      const delta2 = createEnvelope('relay.human.slack.D123', {
        type: 'text_delta', data: { text: ' world' },
      });
      await deliver('relay.human.slack.D123', delta2, client, streamState, callbacks);

      expect(mockPostMessage).toHaveBeenCalledTimes(1);
      expect(mockChatUpdate).toHaveBeenCalledTimes(1);
      expect(streamState.get('D123')?.accumulatedText).toBe('Hello world');
    });

    it('uses chat.update with accumulated text on subsequent deltas', async () => {
      const delta1 = createEnvelope('relay.human.slack.D123', {
        type: 'text_delta', data: { text: 'Part 1' },
      });
      await deliver('relay.human.slack.D123', delta1, client, streamState, callbacks);

      const delta2 = createEnvelope('relay.human.slack.D123', {
        type: 'text_delta', data: { text: ' Part 2' },
      });
      await deliver('relay.human.slack.D123', delta2, client, streamState, callbacks);

      expect(mockChatUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'D123', ts: 'msg-ts-1', text: 'Part 1 Part 2' }),
      );
    });

    it('records error and returns failure when chat.update throws', async () => {
      const delta1 = createEnvelope('relay.human.slack.D123', {
        type: 'text_delta', data: { text: 'Hi' },
      });
      await deliver('relay.human.slack.D123', delta1, client, streamState, callbacks);

      mockChatUpdate.mockRejectedValueOnce(new Error('message_not_found'));
      const delta2 = createEnvelope('relay.human.slack.D123', {
        type: 'text_delta', data: { text: ' more' },
      });
      const result = await deliver('relay.human.slack.D123', delta2, client, streamState, callbacks);
      expect(result.success).toBe(false);
      expect(callbacks.recordError).toHaveBeenCalled();
    });
  });

  describe('streaming — done', () => {
    it('finalizes stream on done event and removes from streamState', async () => {
      const delta = createEnvelope('relay.human.slack.D123', {
        type: 'text_delta', data: { text: 'Hi' },
      });
      await deliver('relay.human.slack.D123', delta, client, streamState, callbacks);

      const done = createEnvelope('relay.human.slack.D123', { type: 'done', data: {} });
      const result = await deliver('relay.human.slack.D123', done, client, streamState, callbacks);

      expect(result.success).toBe(true);
      expect(streamState.has('D123')).toBe(false);
      expect(mockChatUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'D123', ts: 'msg-ts-1', text: 'Hi' }),
      );
      expect(callbacks.trackOutbound).toHaveBeenCalled();
    });

    it('done with no active stream does not send any message', async () => {
      const done = createEnvelope('relay.human.slack.D123', { type: 'done', data: {} });
      const result = await deliver('relay.human.slack.D123', done, client, streamState, callbacks);
      expect(result.success).toBe(true);
      expect(mockPostMessage).not.toHaveBeenCalled();
      expect(mockChatUpdate).not.toHaveBeenCalled();
      expect(callbacks.trackOutbound).not.toHaveBeenCalled();
    });
  });

  describe('streaming — error', () => {
    it('handles error event with buffered content via chat.update', async () => {
      const delta = createEnvelope('relay.human.slack.D123', {
        type: 'text_delta', data: { text: 'Partial response' },
      });
      await deliver('relay.human.slack.D123', delta, client, streamState, callbacks);

      const error = createEnvelope('relay.human.slack.D123', {
        type: 'error', data: { message: 'Context exceeded' },
      });
      await deliver('relay.human.slack.D123', error, client, streamState, callbacks);

      expect(mockChatUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('[Error: Context exceeded]'),
        }),
      );
      expect(streamState.has('D123')).toBe(false);
      expect(callbacks.trackOutbound).toHaveBeenCalled();
    });

    it('sends standalone error message when no stream is active', async () => {
      const error = createEnvelope('relay.human.slack.D123', {
        type: 'error', data: { message: 'Session failed' },
      });
      await deliver('relay.human.slack.D123', error, client, streamState, callbacks);
      expect(mockPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({ text: '[Error: Session failed]' }),
      );
      expect(callbacks.trackOutbound).toHaveBeenCalled();
    });

    it('clears stream state on error even when update fails', async () => {
      const delta = createEnvelope('relay.human.slack.D123', {
        type: 'text_delta', data: { text: 'Hi' },
      });
      await deliver('relay.human.slack.D123', delta, client, streamState, callbacks);

      mockChatUpdate.mockRejectedValueOnce(new Error('edit_window_closed'));
      const error = createEnvelope('relay.human.slack.D123', {
        type: 'error', data: { message: 'timeout' },
      });
      const result = await deliver('relay.human.slack.D123', error, client, streamState, callbacks);
      expect(result.success).toBe(false);
      // Stream state is cleared even on failure
      expect(streamState.has('D123')).toBe(false);
    });
  });

  describe('silent event types', () => {
    it('skips session_status events without sending', async () => {
      const envelope = createEnvelope('relay.human.slack.D123', {
        type: 'session_status', data: {},
      });
      const result = await deliver('relay.human.slack.D123', envelope, client, streamState, callbacks);
      expect(result.success).toBe(true);
      expect(mockPostMessage).not.toHaveBeenCalled();
    });

    it('skips tool_call_start events without sending', async () => {
      const envelope = createEnvelope('relay.human.slack.D123', {
        type: 'tool_call_start', data: { tool: 'bash' },
      });
      const result = await deliver('relay.human.slack.D123', envelope, client, streamState, callbacks);
      expect(result.success).toBe(true);
      expect(mockPostMessage).not.toHaveBeenCalled();
    });
  });

  describe('group channel delivery', () => {
    it('delivers to group channel via subject with group segment', async () => {
      const envelope = createEnvelope('relay.human.slack.group.C12345', {
        content: 'Team update',
      });
      const result = await deliver('relay.human.slack.group.C12345', envelope, client, streamState, callbacks);
      expect(result.success).toBe(true);
      expect(mockPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'C12345' }),
      );
    });
  });

  describe('durationMs', () => {
    it('includes durationMs in all result paths', async () => {
      const envelope = createEnvelope('relay.human.slack.D123', { content: 'hi' });
      const result = await deliver('relay.human.slack.D123', envelope, client, streamState, callbacks);
      expect(typeof result.durationMs).toBe('number');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });
});
