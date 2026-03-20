import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WebClient } from '@slack/web-api';
import { deliverMessage, createSlackOutboundState } from '../outbound.js';
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
    // Passthrough — no mrkdwn conversion applied in tests
    formatForPlatform: (content: string, _platform: string) => content,
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
  };
});

const mockPostMessage = vi.fn().mockResolvedValue({ ts: 'msg-ts-1' });
const mockChatUpdate = vi.fn().mockResolvedValue({ ts: 'msg-ts-1' });
const mockStartStream = vi.fn().mockResolvedValue({ stream_id: 'stream-123' });
const mockAppendStream = vi.fn().mockResolvedValue({ ok: true });
const mockStopStream = vi.fn().mockResolvedValue({ ok: true });
const mockReactionsAdd = vi.fn().mockResolvedValue({ ok: true });
const mockReactionsRemove = vi.fn().mockResolvedValue({ ok: true });

/**
 * Build a WebClient test double with chat and reactions methods wired.
 * The cast through `unknown` is intentional: the real WebClient has dozens
 * of API groups we don't need, and a partial stub is cleaner than
 * implementing the full interface.
 */
function buildMockClient(): WebClient {
  const stub = {
    chat: {
      postMessage: mockPostMessage,
      update: mockChatUpdate,
      startStream: mockStartStream,
      appendStream: mockAppendStream,
      stopStream: mockStopStream,
    },
    reactions: { add: mockReactionsAdd, remove: mockReactionsRemove },
  };
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
  streaming = true,
  typingIndicator: 'none' | 'reaction' = 'none',
  nativeStreaming = false,
  pendingReactions: Map<string, string[]> = new Map()
) {
  return deliverMessage({
    adapterId: 'slack',
    subject,
    envelope,
    client,
    streamState,
    pendingReactions,
    botUserId,
    callbacks,
    streaming,
    nativeStreaming,
    typingIndicator,
    approvalState: createSlackOutboundState(),
  });
}

describe('deliverMessage', () => {
  let client: WebClient;
  let streamState: Map<string, ActiveStream>;
  let callbacks: AdapterOutboundCallbacks;
  let nowMs: number;

  beforeEach(() => {
    vi.clearAllMocks();
    client = buildMockClient();
    streamState = new Map();
    callbacks = createCallbacks();
    // Pin Date.now for throttle-aware tests
    nowMs = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
  });

  describe('echo prevention', () => {
    it('skips envelopes from relay.human.slack.* (echo prevention)', async () => {
      const envelope = createEnvelope(
        'relay.human.slack.D123',
        { content: 'echo' },
        'relay.human.slack.bot'
      );
      const result = await deliver(
        'relay.human.slack.D123',
        envelope,
        client,
        streamState,
        callbacks
      );
      expect(result.success).toBe(true);
      expect(mockPostMessage).not.toHaveBeenCalled();
    });
  });

  describe('guard conditions', () => {
    it('returns error when client is null', async () => {
      const envelope = createEnvelope('relay.human.slack.D123', { content: 'hi' });
      const result = await deliver(
        'relay.human.slack.D123',
        envelope,
        null,
        streamState,
        callbacks
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('not started');
    });

    it('returns error when subject has no extractable channel ID', async () => {
      const envelope = createEnvelope('relay.human.telegram.D123', { content: 'hi' });
      const result = await deliver(
        'relay.human.telegram.D123',
        envelope,
        client,
        streamState,
        callbacks
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('cannot extract channel ID');
    });
  });

  describe('standard payload delivery', () => {
    it('sends standard payload via chat.postMessage', async () => {
      const envelope = createEnvelope('relay.human.slack.D123', { content: 'Hello!' });
      const result = await deliver(
        'relay.human.slack.D123',
        envelope,
        client,
        streamState,
        callbacks
      );
      expect(result.success).toBe(true);
      expect(mockPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'D123', text: 'Hello!' })
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
        expect.objectContaining({ thread_ts: '1234567890.123456' })
      );
    });

    it('uses platformData.threadTs over platformData.ts for threading', async () => {
      const envelope = createEnvelope('relay.human.slack.D123', {
        content: 'Already threaded',
        platformData: { ts: '1234.0001', threadTs: '1234.0000' },
      });
      await deliver('relay.human.slack.D123', envelope, client, streamState, callbacks);
      expect(mockPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({ thread_ts: '1234.0000' })
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
      const result = await deliver(
        'relay.human.slack.D123',
        envelope,
        client,
        streamState,
        callbacks
      );
      expect(result.success).toBe(false);
      expect(result.error).toBe('channel_not_found');
      expect(callbacks.recordError).toHaveBeenCalled();
    });
  });

  describe('streaming — text_delta', () => {
    it('starts stream on first text_delta via chat.postMessage', async () => {
      const delta = createEnvelope('relay.human.slack.D123', {
        type: 'text_delta',
        data: { text: 'Hello' },
      });
      await deliver('relay.human.slack.D123', delta, client, streamState, callbacks);
      expect(mockPostMessage).toHaveBeenCalledTimes(1);
      // Stream key includes envelope.id for collision prevention
      expect(streamState.has('D123:relay.agent.backend')).toBe(true);
      expect(streamState.get('D123:relay.agent.backend')?.accumulatedText).toBe('Hello');
      expect(streamState.get('D123:relay.agent.backend')?.messageTs).toBe('msg-ts-1');
    });

    it('updates existing stream on subsequent text_delta via chat.update after throttle window', async () => {
      const delta1 = createEnvelope('relay.human.slack.D123', {
        type: 'text_delta',
        data: { text: 'Hello' },
      });
      await deliver('relay.human.slack.D123', delta1, client, streamState, callbacks);

      // Advance past throttle window (1000ms)
      nowMs += 1_001;

      const delta2 = createEnvelope('relay.human.slack.D123', {
        type: 'text_delta',
        data: { text: ' world' },
      });
      await deliver('relay.human.slack.D123', delta2, client, streamState, callbacks);

      expect(mockPostMessage).toHaveBeenCalledTimes(1);
      expect(mockChatUpdate).toHaveBeenCalledTimes(1);
      expect(streamState.get('D123:relay.agent.backend')?.accumulatedText).toBe('Hello world');
    });

    it('throttles chat.update when called within throttle window', async () => {
      const delta1 = createEnvelope('relay.human.slack.D123', {
        type: 'text_delta',
        data: { text: 'Hello' },
      });
      await deliver('relay.human.slack.D123', delta1, client, streamState, callbacks);

      // Do NOT advance time — within throttle window
      const delta2 = createEnvelope('relay.human.slack.D123', {
        type: 'text_delta',
        data: { text: ' world' },
      });
      const result = await deliver(
        'relay.human.slack.D123',
        delta2,
        client,
        streamState,
        callbacks
      );

      expect(result.success).toBe(true);
      expect(mockChatUpdate).not.toHaveBeenCalled();
      // Text is still accumulated even though update was throttled
      expect(streamState.get('D123:relay.agent.backend')?.accumulatedText).toBe('Hello world');
    });

    it('uses chat.update with accumulated text on subsequent deltas', async () => {
      const delta1 = createEnvelope('relay.human.slack.D123', {
        type: 'text_delta',
        data: { text: 'Part 1' },
      });
      await deliver('relay.human.slack.D123', delta1, client, streamState, callbacks);

      nowMs += 1_001;

      const delta2 = createEnvelope('relay.human.slack.D123', {
        type: 'text_delta',
        data: { text: ' Part 2' },
      });
      await deliver('relay.human.slack.D123', delta2, client, streamState, callbacks);

      expect(mockChatUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'D123', ts: 'msg-ts-1', text: 'Part 1 Part 2' })
      );
    });

    it('collapses consecutive newlines on intermediate updates', async () => {
      const delta1 = createEnvelope('relay.human.slack.D123', {
        type: 'text_delta',
        data: { text: 'Line 1\n\nLine 2' },
      });
      await deliver('relay.human.slack.D123', delta1, client, streamState, callbacks);

      nowMs += 1_001;

      const delta2 = createEnvelope('relay.human.slack.D123', {
        type: 'text_delta',
        data: { text: '\n\nLine 3' },
      });
      await deliver('relay.human.slack.D123', delta2, client, streamState, callbacks);

      // Intermediate update should collapse \n\n to \n
      const updateCall = mockChatUpdate.mock.calls[0][0] as { text: string };
      expect(updateCall.text).toBe('Line 1\nLine 2\nLine 3');
    });

    it('records error and returns failure when chat.update throws', async () => {
      const delta1 = createEnvelope('relay.human.slack.D123', {
        type: 'text_delta',
        data: { text: 'Hi' },
      });
      await deliver('relay.human.slack.D123', delta1, client, streamState, callbacks);

      nowMs += 1_001;

      mockChatUpdate.mockRejectedValueOnce(new Error('message_not_found'));
      const delta2 = createEnvelope('relay.human.slack.D123', {
        type: 'text_delta',
        data: { text: ' more' },
      });
      const result = await deliver(
        'relay.human.slack.D123',
        delta2,
        client,
        streamState,
        callbacks
      );
      expect(result.success).toBe(false);
      expect(callbacks.recordError).toHaveBeenCalled();
    });
  });

  describe('streaming — done', () => {
    it('finalizes stream on done event and removes from streamState', async () => {
      const delta = createEnvelope('relay.human.slack.D123', {
        type: 'text_delta',
        data: { text: 'Hi' },
      });
      await deliver('relay.human.slack.D123', delta, client, streamState, callbacks);

      const done = createEnvelope('relay.human.slack.D123', { type: 'done', data: {} });
      const result = await deliver('relay.human.slack.D123', done, client, streamState, callbacks);

      expect(result.success).toBe(true);
      expect(streamState.has('D123:relay.agent.backend')).toBe(false);
      expect(mockChatUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'D123', ts: 'msg-ts-1', text: 'Hi' })
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
        type: 'text_delta',
        data: { text: 'Partial response' },
      });
      await deliver('relay.human.slack.D123', delta, client, streamState, callbacks);

      const error = createEnvelope('relay.human.slack.D123', {
        type: 'error',
        data: { message: 'Context exceeded' },
      });
      await deliver('relay.human.slack.D123', error, client, streamState, callbacks);

      expect(mockChatUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('[Error: Context exceeded]'),
        })
      );
      expect(streamState.has('D123:relay.agent.backend')).toBe(false);
      expect(callbacks.trackOutbound).toHaveBeenCalled();
    });

    it('sends standalone error message when no stream is active', async () => {
      const error = createEnvelope('relay.human.slack.D123', {
        type: 'error',
        data: { message: 'Session failed' },
      });
      await deliver('relay.human.slack.D123', error, client, streamState, callbacks);
      expect(mockPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({ text: '[Error: Session failed]' })
      );
      expect(callbacks.trackOutbound).toHaveBeenCalled();
    });

    it('clears stream state on error even when update fails', async () => {
      const delta = createEnvelope('relay.human.slack.D123', {
        type: 'text_delta',
        data: { text: 'Hi' },
      });
      await deliver('relay.human.slack.D123', delta, client, streamState, callbacks);

      mockChatUpdate.mockRejectedValueOnce(new Error('edit_window_closed'));
      const error = createEnvelope('relay.human.slack.D123', {
        type: 'error',
        data: { message: 'timeout' },
      });
      const result = await deliver('relay.human.slack.D123', error, client, streamState, callbacks);
      expect(result.success).toBe(false);
      // Stream state is cleared even on failure
      expect(streamState.has('D123:relay.agent.backend')).toBe(false);
    });
  });

  describe('silent event types', () => {
    it('skips session_status events without sending', async () => {
      const envelope = createEnvelope('relay.human.slack.D123', {
        type: 'session_status',
        data: {},
      });
      const result = await deliver(
        'relay.human.slack.D123',
        envelope,
        client,
        streamState,
        callbacks
      );
      expect(result.success).toBe(true);
      expect(mockPostMessage).not.toHaveBeenCalled();
    });

    it('skips tool_call_start events without sending', async () => {
      const envelope = createEnvelope('relay.human.slack.D123', {
        type: 'tool_call_start',
        data: { tool: 'bash' },
      });
      const result = await deliver(
        'relay.human.slack.D123',
        envelope,
        client,
        streamState,
        callbacks
      );
      expect(result.success).toBe(true);
      expect(mockPostMessage).not.toHaveBeenCalled();
    });
  });

  describe('group channel delivery', () => {
    it('delivers to group channel via subject with group segment', async () => {
      const envelope = createEnvelope('relay.human.slack.group.C12345', {
        content: 'Team update',
      });
      const result = await deliver(
        'relay.human.slack.group.C12345',
        envelope,
        client,
        streamState,
        callbacks
      );
      expect(result.success).toBe(true);
      expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C12345' }));
    });
  });

  describe('stale stream reaping', () => {
    it('removes stream entries older than 5 minutes on delivery', async () => {
      // Seed a stale stream entry
      streamState.set('D999', {
        channelId: 'D999',
        threadTs: '',
        messageTs: 'old-ts',
        accumulatedText: 'stale',
        lastUpdateAt: nowMs - 6 * 60 * 1_000,
        startedAt: nowMs - 6 * 60 * 1_000,
        streamId: 'stale-stream',
      });

      const envelope = createEnvelope('relay.human.slack.D123', { content: 'hi' });
      await deliver('relay.human.slack.D123', envelope, client, streamState, callbacks);

      expect(streamState.has('D999')).toBe(false);
    });

    it('preserves recent stream entries', async () => {
      streamState.set('D999', {
        channelId: 'D999',
        threadTs: '',
        messageTs: 'recent-ts',
        accumulatedText: 'recent',
        lastUpdateAt: nowMs - 1_000,
        startedAt: nowMs - 1_000,
        streamId: 'recent-stream',
      });

      const envelope = createEnvelope('relay.human.slack.D123', { content: 'hi' });
      await deliver('relay.human.slack.D123', envelope, client, streamState, callbacks);

      expect(streamState.has('D999')).toBe(true);
    });
  });

  describe('concurrent stream isolation', () => {
    it('concurrent responses from different agents get independent stream state', async () => {
      // Two agents respond to the same channel simultaneously
      const deltaA = createEnvelope('relay.human.slack.D123', {
        type: 'text_delta',
        data: { text: 'From A' },
      });
      // Override from to simulate different agent sessions
      (deltaA as Record<string, unknown>).from = 'agent:session-1';

      const deltaB = createEnvelope('relay.human.slack.D123', {
        type: 'text_delta',
        data: { text: 'From B' },
      });
      (deltaB as Record<string, unknown>).from = 'agent:session-2';

      await deliver('relay.human.slack.D123', deltaA, client, streamState, callbacks);
      await deliver('relay.human.slack.D123', deltaB, client, streamState, callbacks);

      // Two separate stream entries should exist
      expect(streamState.size).toBe(2);
      expect(mockPostMessage).toHaveBeenCalledTimes(2);

      // Each stream has its own accumulated text
      const entries = Array.from(streamState.values());
      const texts = entries.map((e) => e.accumulatedText).sort();
      expect(texts).toEqual(['From A', 'From B']);
    });
  });

  describe('durationMs', () => {
    it('includes durationMs in all result paths', async () => {
      const envelope = createEnvelope('relay.human.slack.D123', { content: 'hi' });
      const result = await deliver(
        'relay.human.slack.D123',
        envelope,
        client,
        streamState,
        callbacks
      );
      expect(typeof result.durationMs).toBe('number');
    });
  });

  describe('typing indicator — emoji reaction', () => {
    it('adds reaction on stream start when typingIndicator is reaction', async () => {
      const delta = createEnvelope('relay.human.slack.D123', {
        type: 'text_delta',
        data: { text: 'Hello' },
        platformData: { ts: '1234.0001' },
      });
      await deliver(
        'relay.human.slack.D123',
        delta,
        client,
        streamState,
        callbacks,
        'UBOTID',
        true,
        'reaction'
      );

      expect(mockReactionsAdd).toHaveBeenCalledWith({
        channel: 'D123',
        name: 'hourglass_flowing_sand',
        timestamp: '1234.0001',
      });
    });

    it('removes reaction on done', async () => {
      const delta = createEnvelope('relay.human.slack.D123', {
        type: 'text_delta',
        data: { text: 'Hello' },
        platformData: { ts: '1234.0001' },
      });
      await deliver(
        'relay.human.slack.D123',
        delta,
        client,
        streamState,
        callbacks,
        'UBOTID',
        true,
        'reaction'
      );

      const done = createEnvelope('relay.human.slack.D123', {
        type: 'done',
        data: {},
        platformData: { ts: '1234.0001' },
      });
      await deliver(
        'relay.human.slack.D123',
        done,
        client,
        streamState,
        callbacks,
        'UBOTID',
        true,
        'reaction'
      );

      expect(mockReactionsRemove).toHaveBeenCalledWith({
        channel: 'D123',
        name: 'hourglass_flowing_sand',
        timestamp: '1234.0001',
      });
    });

    it('removes reaction on error', async () => {
      const delta = createEnvelope('relay.human.slack.D123', {
        type: 'text_delta',
        data: { text: 'Partial' },
        platformData: { ts: '1234.0001' },
      });
      await deliver(
        'relay.human.slack.D123',
        delta,
        client,
        streamState,
        callbacks,
        'UBOTID',
        true,
        'reaction'
      );

      const error = createEnvelope('relay.human.slack.D123', {
        type: 'error',
        data: { message: 'failed' },
        platformData: { ts: '1234.0001' },
      });
      await deliver(
        'relay.human.slack.D123',
        error,
        client,
        streamState,
        callbacks,
        'UBOTID',
        true,
        'reaction'
      );

      expect(mockReactionsRemove).toHaveBeenCalledWith({
        channel: 'D123',
        name: 'hourglass_flowing_sand',
        timestamp: '1234.0001',
      });
    });

    it('does not add reaction when typingIndicator is none', async () => {
      const delta = createEnvelope('relay.human.slack.D123', {
        type: 'text_delta',
        data: { text: 'Hello' },
        platformData: { ts: '1234.0001' },
      });
      await deliver(
        'relay.human.slack.D123',
        delta,
        client,
        streamState,
        callbacks,
        'UBOTID',
        true,
        'none'
      );

      expect(mockReactionsAdd).not.toHaveBeenCalled();
    });

    it('swallows reaction errors silently', async () => {
      mockReactionsAdd.mockRejectedValueOnce(new Error('no_permission'));

      const delta = createEnvelope('relay.human.slack.D123', {
        type: 'text_delta',
        data: { text: 'Hello' },
        platformData: { ts: '1234.0001' },
      });
      const result = await deliver(
        'relay.human.slack.D123',
        delta,
        client,
        streamState,
        callbacks,
        'UBOTID',
        true,
        'reaction'
      );

      // Delivery should still succeed even if reaction fails
      expect(result.success).toBe(true);
    });

    it('does not add reaction when no threadTs available', async () => {
      const delta = createEnvelope('relay.human.slack.D123', {
        type: 'text_delta',
        data: { text: 'Hello' },
        // No platformData — no threadTs
      });
      await deliver(
        'relay.human.slack.D123',
        delta,
        client,
        streamState,
        callbacks,
        'UBOTID',
        true,
        'reaction'
      );

      // Reactions require a real message ts — should not be called without threadTs
      expect(mockReactionsAdd).not.toHaveBeenCalled();
    });

    it('adds reaction on buffered mode stream start', async () => {
      const delta = createEnvelope('relay.human.slack.D123', {
        type: 'text_delta',
        data: { text: 'Hello' },
        platformData: { ts: '1234.0001' },
      });
      await deliver(
        'relay.human.slack.D123',
        delta,
        client,
        streamState,
        callbacks,
        'UBOTID',
        false,
        'reaction'
      );

      expect(mockReactionsAdd).toHaveBeenCalledWith({
        channel: 'D123',
        name: 'hourglass_flowing_sand',
        timestamp: '1234.0001',
      });
      // Should not post message (buffered mode)
      expect(mockPostMessage).not.toHaveBeenCalled();
    });

    it('removes pending reaction on done even without platformData in response', async () => {
      // Simulate inbound adding a pending reaction
      const pendingReactions = new Map<string, string[]>();
      pendingReactions.set('D123', ['1234.0001']);

      // CCA response envelope has NO platformData (realistic scenario)
      const done = createEnvelope('relay.human.slack.D123', {
        type: 'done',
        data: {},
      });
      await deliver(
        'relay.human.slack.D123',
        done,
        client,
        streamState,
        callbacks,
        'UBOTID',
        true,
        'reaction',
        false,
        pendingReactions
      );

      expect(mockReactionsRemove).toHaveBeenCalledWith({
        channel: 'D123',
        name: 'hourglass_flowing_sand',
        timestamp: '1234.0001',
      });
      // Queue should be drained
      expect(pendingReactions.has('D123')).toBe(false);
    });

    it('removes pending reaction on error even without platformData in response', async () => {
      const pendingReactions = new Map<string, string[]>();
      pendingReactions.set('D123', ['1234.0001']);

      const error = createEnvelope('relay.human.slack.D123', {
        type: 'error',
        data: { message: 'failed' },
      });
      await deliver(
        'relay.human.slack.D123',
        error,
        client,
        streamState,
        callbacks,
        'UBOTID',
        true,
        'reaction',
        false,
        pendingReactions
      );

      expect(mockReactionsRemove).toHaveBeenCalledWith({
        channel: 'D123',
        name: 'hourglass_flowing_sand',
        timestamp: '1234.0001',
      });
    });

    it('handles FIFO ordering with multiple queued messages', async () => {
      const pendingReactions = new Map<string, string[]>();
      pendingReactions.set('D123', ['1234.0001', '1234.0002']);

      // First done removes first reaction
      const done1 = createEnvelope('relay.human.slack.D123', { type: 'done', data: {} });
      await deliver(
        'relay.human.slack.D123',
        done1,
        client,
        streamState,
        callbacks,
        'UBOTID',
        true,
        'reaction',
        false,
        pendingReactions
      );

      expect(mockReactionsRemove).toHaveBeenCalledWith({
        channel: 'D123',
        name: 'hourglass_flowing_sand',
        timestamp: '1234.0001',
      });

      // Second done removes second reaction
      mockReactionsRemove.mockClear();
      const done2 = createEnvelope('relay.human.slack.D123', { type: 'done', data: {} });
      await deliver(
        'relay.human.slack.D123',
        done2,
        client,
        streamState,
        callbacks,
        'UBOTID',
        true,
        'reaction',
        false,
        pendingReactions
      );

      expect(mockReactionsRemove).toHaveBeenCalledWith({
        channel: 'D123',
        name: 'hourglass_flowing_sand',
        timestamp: '1234.0002',
      });
      expect(pendingReactions.has('D123')).toBe(false);
    });

    it('does not crash when pending reactions queue is empty', async () => {
      const pendingReactions = new Map<string, string[]>();

      const done = createEnvelope('relay.human.slack.D123', { type: 'done', data: {} });
      const result = await deliver(
        'relay.human.slack.D123',
        done,
        client,
        streamState,
        callbacks,
        'UBOTID',
        true,
        'reaction',
        false,
        pendingReactions
      );

      expect(result.success).toBe(true);
      // No reactions should be removed when queue is empty
      expect(mockReactionsRemove).not.toHaveBeenCalled();
    });
  });

  describe('streaming toggle — buffered mode', () => {
    it('accumulates text without posting when streaming is false', async () => {
      const delta = createEnvelope('relay.human.slack.D123', {
        type: 'text_delta',
        data: { text: 'Hello' },
      });
      await deliver(
        'relay.human.slack.D123',
        delta,
        client,
        streamState,
        callbacks,
        'UBOTID',
        false
      );

      expect(mockPostMessage).not.toHaveBeenCalled();
      expect(mockChatUpdate).not.toHaveBeenCalled();
      // Should have accumulated text in stream state
      const entry = Array.from(streamState.values())[0];
      expect(entry?.accumulatedText).toBe('Hello');
      expect(entry?.messageTs).toBe(''); // No message posted
    });

    it('sends single message on done when streaming is false', async () => {
      // Accumulate two deltas
      const delta1 = createEnvelope('relay.human.slack.D123', {
        type: 'text_delta',
        data: { text: 'Hello' },
      });
      await deliver(
        'relay.human.slack.D123',
        delta1,
        client,
        streamState,
        callbacks,
        'UBOTID',
        false
      );

      const delta2 = createEnvelope('relay.human.slack.D123', {
        type: 'text_delta',
        data: { text: ' world' },
      });
      await deliver(
        'relay.human.slack.D123',
        delta2,
        client,
        streamState,
        callbacks,
        'UBOTID',
        false
      );

      // Now send done
      const done = createEnvelope('relay.human.slack.D123', { type: 'done', data: {} });
      await deliver(
        'relay.human.slack.D123',
        done,
        client,
        streamState,
        callbacks,
        'UBOTID',
        false
      );

      // Should post once (not update) with complete text
      expect(mockPostMessage).toHaveBeenCalledTimes(1);
      expect(mockPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'D123', text: 'Hello world' })
      );
      expect(mockChatUpdate).not.toHaveBeenCalled();
      expect(callbacks.trackOutbound).toHaveBeenCalled();
    });

    it('handles error in buffered mode by posting accumulated text + error', async () => {
      const delta = createEnvelope('relay.human.slack.D123', {
        type: 'text_delta',
        data: { text: 'Partial' },
      });
      await deliver(
        'relay.human.slack.D123',
        delta,
        client,
        streamState,
        callbacks,
        'UBOTID',
        false
      );

      const error = createEnvelope('relay.human.slack.D123', {
        type: 'error',
        data: { message: 'timeout' },
      });
      await deliver(
        'relay.human.slack.D123',
        error,
        client,
        streamState,
        callbacks,
        'UBOTID',
        false
      );

      expect(mockPostMessage).toHaveBeenCalledTimes(1);
      expect(mockPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Partial'),
        })
      );
      expect(mockPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('[Error: timeout]'),
        })
      );
      expect(mockChatUpdate).not.toHaveBeenCalled();
    });

    it('defaults to streaming mode (existing behavior preserved)', async () => {
      const delta = createEnvelope('relay.human.slack.D123', {
        type: 'text_delta',
        data: { text: 'Hello' },
      });
      // streaming defaults to true in deliver helper
      await deliver('relay.human.slack.D123', delta, client, streamState, callbacks);

      // Should post immediately (streaming mode)
      expect(mockPostMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('native streaming — chat.startStream/appendStream/stopStream', () => {
    it('starts stream on first text_delta', async () => {
      const delta = createEnvelope('relay.human.slack.D123', {
        type: 'text_delta',
        data: { text: 'Hello' },
        platformData: { ts: '1234.0001' },
      });
      await deliver(
        'relay.human.slack.D123',
        delta,
        client,
        streamState,
        callbacks,
        'UBOTID',
        true,
        'none',
        true
      );
      expect(mockStartStream).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'D123', thread_ts: '1234.0001' })
      );
      expect(mockAppendStream).toHaveBeenCalledWith(
        expect.objectContaining({ stream_id: 'stream-123', text: 'Hello' })
      );
      expect(mockPostMessage).not.toHaveBeenCalled();
    });

    it('appends text on subsequent text_delta', async () => {
      const delta1 = createEnvelope('relay.human.slack.D123', {
        type: 'text_delta',
        data: { text: 'Hello' },
        platformData: { ts: '1234.0001' },
      });
      await deliver(
        'relay.human.slack.D123',
        delta1,
        client,
        streamState,
        callbacks,
        'UBOTID',
        true,
        'none',
        true
      );

      const delta2 = createEnvelope('relay.human.slack.D123', {
        type: 'text_delta',
        data: { text: ' world' },
        platformData: { ts: '1234.0001' },
      });
      await deliver(
        'relay.human.slack.D123',
        delta2,
        client,
        streamState,
        callbacks,
        'UBOTID',
        true,
        'none',
        true
      );

      expect(mockAppendStream).toHaveBeenCalledTimes(2);
      expect(mockChatUpdate).not.toHaveBeenCalled();
    });

    it('stops stream on done', async () => {
      const delta = createEnvelope('relay.human.slack.D123', {
        type: 'text_delta',
        data: { text: 'Hello' },
        platformData: { ts: '1234.0001' },
      });
      await deliver(
        'relay.human.slack.D123',
        delta,
        client,
        streamState,
        callbacks,
        'UBOTID',
        true,
        'none',
        true
      );

      const done = createEnvelope('relay.human.slack.D123', {
        type: 'done',
        data: {},
        platformData: { ts: '1234.0001' },
      });
      await deliver(
        'relay.human.slack.D123',
        done,
        client,
        streamState,
        callbacks,
        'UBOTID',
        true,
        'none',
        true
      );

      expect(mockStopStream).toHaveBeenCalledWith(
        expect.objectContaining({ stream_id: 'stream-123' })
      );
    });

    it('appends error and stops stream on error', async () => {
      const delta = createEnvelope('relay.human.slack.D123', {
        type: 'text_delta',
        data: { text: 'Partial' },
        platformData: { ts: '1234.0001' },
      });
      await deliver(
        'relay.human.slack.D123',
        delta,
        client,
        streamState,
        callbacks,
        'UBOTID',
        true,
        'none',
        true
      );

      const error = createEnvelope('relay.human.slack.D123', {
        type: 'error',
        data: { message: 'timeout' },
        platformData: { ts: '1234.0001' },
      });
      await deliver(
        'relay.human.slack.D123',
        error,
        client,
        streamState,
        callbacks,
        'UBOTID',
        true,
        'none',
        true
      );

      expect(mockAppendStream).toHaveBeenLastCalledWith(
        expect.objectContaining({ stream_id: 'stream-123' })
      );
      expect(mockStopStream).toHaveBeenCalled();
    });

    it('falls back to chat.postMessage when startStream fails', async () => {
      mockStartStream.mockRejectedValueOnce(new Error('missing_scope'));
      const delta = createEnvelope('relay.human.slack.D123', {
        type: 'text_delta',
        data: { text: 'Hello' },
        platformData: { ts: '1234.0001' },
      });
      await deliver(
        'relay.human.slack.D123',
        delta,
        client,
        streamState,
        callbacks,
        'UBOTID',
        true,
        'none',
        true
      );

      // Should fall back to chat.postMessage
      expect(mockPostMessage).toHaveBeenCalled();
      expect(callbacks.recordError).toHaveBeenCalled();
    });
  });

  describe('approval_required handling', () => {
    it('renders Block Kit card with Approve and Deny buttons', async () => {
      const envelope = createEnvelope('relay.human.slack.D123', {
        type: 'approval_required',
        data: {
          toolCallId: 'toolu_123',
          toolName: 'Write',
          input: '{"path":"src/index.ts","content":"hello"}',
          timeoutMs: 600000,
          agentId: 'agent-1',
          ccaSessionKey: 'sess-abc',
        },
      });
      const result = await deliver(
        'relay.human.slack.D123',
        envelope,
        client,
        streamState,
        callbacks
      );
      expect(result.success).toBe(true);
      const call = mockPostMessage.mock.calls[0][0];
      expect(call.blocks).toHaveLength(3);
      expect(call.blocks[2].elements).toHaveLength(2);
      expect(call.blocks[2].elements[0].action_id).toBe('tool_approve');
      expect(call.blocks[2].elements[1].action_id).toBe('tool_deny');
      expect(call.blocks[2].block_id).toBe('tool_approval');
    });

    it('encodes only IDs in button value (no sensitive input)', async () => {
      const envelope = createEnvelope('relay.human.slack.D123', {
        type: 'approval_required',
        data: {
          toolCallId: 'toolu_123',
          toolName: 'Write',
          input: '{"path":"src/index.ts","content":"top secret"}',
          timeoutMs: 600000,
          agentId: 'agent-1',
          ccaSessionKey: 'sess-abc',
        },
      });
      await deliver('relay.human.slack.D123', envelope, client, streamState, callbacks);
      const call = mockPostMessage.mock.calls[0][0];
      const value = JSON.parse(call.blocks[2].elements[0].value) as Record<string, unknown>;
      expect(value).toEqual({
        toolCallId: 'toolu_123',
        sessionId: 'sess-abc',
        agentId: 'agent-1',
      });
      // Tool input must NOT appear in button value
      expect(JSON.stringify(value)).not.toContain('top secret');
    });

    it('truncates tool input preview to 500 chars in section block', async () => {
      const longInput = 'a'.repeat(1000);
      const envelope = createEnvelope('relay.human.slack.D123', {
        type: 'approval_required',
        data: {
          toolCallId: 'toolu_123',
          toolName: 'Write',
          input: longInput,
          timeoutMs: 600000,
          agentId: 'agent-1',
          ccaSessionKey: 'sess-abc',
        },
      });
      await deliver('relay.human.slack.D123', envelope, client, streamState, callbacks);
      const call = mockPostMessage.mock.calls[0][0];
      // Second block contains the input preview
      const previewBlock = call.blocks[1] as { text: { text: string } };
      // 500 chars + ``` fences — should be well within 600 chars
      expect(previewBlock.text.text.length).toBeLessThanOrEqual(510);
    });

    it('threads the approval card when threadTs is present', async () => {
      const envelope = createEnvelope('relay.human.slack.D123', {
        type: 'approval_required',
        data: {
          toolCallId: 'toolu_123',
          toolName: 'Bash',
          input: '{"command":"ls"}',
          timeoutMs: 600000,
          agentId: 'agent-1',
          ccaSessionKey: 'sess-abc',
        },
        platformData: { ts: '9999.0001' },
      });
      await deliver('relay.human.slack.D123', envelope, client, streamState, callbacks);
      const call = mockPostMessage.mock.calls[0][0];
      expect(call.thread_ts).toBe('9999.0001');
    });

    it('falls through to whitelist drop when approval data is invalid (missing toolCallId)', async () => {
      const envelope = createEnvelope('relay.human.slack.D123', {
        type: 'approval_required',
        data: { toolName: 'Write' }, // missing toolCallId
      });
      const result = await deliver(
        'relay.human.slack.D123',
        envelope,
        client,
        streamState,
        callbacks
      );
      expect(result.success).toBe(true); // silently dropped
      expect(mockPostMessage).not.toHaveBeenCalled();
    });

    it('sets fallback text field for notification accessibility', async () => {
      const envelope = createEnvelope('relay.human.slack.D123', {
        type: 'approval_required',
        data: {
          toolCallId: 'toolu_xyz',
          toolName: 'Edit',
          input: '{"file_path":"src/app.ts"}',
          timeoutMs: 600000,
          agentId: 'agent-2',
          ccaSessionKey: 'sess-def',
        },
      });
      await deliver('relay.human.slack.D123', envelope, client, streamState, callbacks);
      const call = mockPostMessage.mock.calls[0][0];
      expect(typeof call.text).toBe('string');
      expect(call.text).toContain('Edit');
    });

    it('first section block describes the tool action', async () => {
      const envelope = createEnvelope('relay.human.slack.D123', {
        type: 'approval_required',
        data: {
          toolCallId: 'toolu_abc',
          toolName: 'Write',
          input: '{"path":"src/index.ts","content":"x"}',
          timeoutMs: 600000,
          agentId: 'agent-1',
          ccaSessionKey: 'sess-abc',
        },
      });
      await deliver('relay.human.slack.D123', envelope, client, streamState, callbacks);
      const call = mockPostMessage.mock.calls[0][0];
      const firstBlock = call.blocks[0] as { text: { text: string } };
      expect(firstBlock.text.text).toContain('Write');
      expect(firstBlock.text.text).toContain('wants to write to');
    });

    it('flushes buffered text before posting approval card (buffered mode)', async () => {
      // Simulate text_delta accumulation in buffered mode (streaming=false)
      const deltaEnv = createEnvelope(
        'relay.human.slack.D123',
        {
          type: 'text_delta',
          data: { text: 'Let me search for Art Blocks projects' },
        },
        'agent:sess-1'
      );
      await deliver(
        'relay.human.slack.D123',
        deltaEnv,
        client,
        streamState,
        callbacks,
        'UBOTID',
        false
      );
      expect(mockPostMessage).not.toHaveBeenCalled(); // buffered, not posted yet

      // Now send approval_required — should flush buffered text first
      const approvalEnv = createEnvelope(
        'relay.human.slack.D123',
        {
          type: 'approval_required',
          data: {
            toolCallId: 'toolu_flush',
            toolName: 'WebSearch',
            input: '{"query":"art blocks"}',
            timeoutMs: 600000,
            agentId: 'agent-1',
            ccaSessionKey: 'sess-1',
          },
        },
        'agent:sess-1'
      );
      await deliver(
        'relay.human.slack.D123',
        approvalEnv,
        client,
        streamState,
        callbacks,
        'UBOTID',
        false
      );

      // First postMessage: the flushed text buffer
      expect(mockPostMessage).toHaveBeenCalledTimes(2);
      const flushCall = mockPostMessage.mock.calls[0][0];
      expect(flushCall.text).toContain('Let me search for Art Blocks projects');

      // Second postMessage: the approval card
      const approvalCall = mockPostMessage.mock.calls[1][0];
      expect(approvalCall.blocks).toBeDefined();
      expect(approvalCall.blocks[2].block_id).toBe('tool_approval');
    });

    it('flushes streaming text before posting approval card (streaming mode)', async () => {
      // Simulate text_delta in streaming mode — first delta posts the message
      const deltaEnv = createEnvelope(
        'relay.human.slack.D123',
        {
          type: 'text_delta',
          data: { text: 'Let me look' },
          platformData: { ts: '1234.0001' },
        },
        'agent:sess-2'
      );
      await deliver(
        'relay.human.slack.D123',
        deltaEnv,
        client,
        streamState,
        callbacks,
        'UBOTID',
        true
      );
      expect(mockPostMessage).toHaveBeenCalledTimes(1); // initial post

      // Accumulate more text (within throttle window — no update sent)
      const delta2 = createEnvelope(
        'relay.human.slack.D123',
        {
          type: 'text_delta',
          data: { text: ' into that for you' },
          platformData: { ts: '1234.0001' },
        },
        'agent:sess-2'
      );
      await deliver(
        'relay.human.slack.D123',
        delta2,
        client,
        streamState,
        callbacks,
        'UBOTID',
        true
      );

      // Now send approval — should flush via chat.update then post card
      mockPostMessage.mockClear();
      mockChatUpdate.mockClear();
      const approvalEnv = createEnvelope(
        'relay.human.slack.D123',
        {
          type: 'approval_required',
          data: {
            toolCallId: 'toolu_flush2',
            toolName: 'Bash',
            input: '{"command":"ls"}',
            timeoutMs: 600000,
            agentId: 'agent-2',
            ccaSessionKey: 'sess-2',
          },
          platformData: { ts: '1234.0001' },
        },
        'agent:sess-2'
      );
      await deliver(
        'relay.human.slack.D123',
        approvalEnv,
        client,
        streamState,
        callbacks,
        'UBOTID',
        true
      );

      // Flush should update the existing message with full accumulated text
      expect(mockChatUpdate).toHaveBeenCalledTimes(1);
      const updateCall = mockChatUpdate.mock.calls[0][0];
      expect(updateCall.text).toContain('Let me look into that for you');

      // Approval card should be posted
      expect(mockPostMessage).toHaveBeenCalledTimes(1);
      const approvalCall = mockPostMessage.mock.calls[0][0];
      expect(approvalCall.blocks[2].block_id).toBe('tool_approval');
    });
  });
});
