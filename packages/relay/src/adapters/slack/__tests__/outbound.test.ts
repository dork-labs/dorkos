import { describe, it, expect, beforeEach } from 'vitest';
import type { ActiveStream } from '../outbound.js';
import { STREAM_TTL_MS } from '../stream.js';
import type { AdapterOutboundCallbacks } from '../../../types.js';
import {
  createEnvelope,
  deliver,
  env,
  h,
  mockChatUpdate,
  mockPostMessage,
  resetOutboundHarness,
  textDelta,
} from './outbound.fixtures.js';

describe('deliverMessage', () => {
  let streamState: Map<string, ActiveStream>;
  let callbacks: AdapterOutboundCallbacks;

  beforeEach(() => {
    ({ streamState, callbacks } = resetOutboundHarness());
  });

  describe('echo prevention', () => {
    it('skips envelopes from relay.human.slack.* (echo prevention)', async () => {
      const envelope = createEnvelope(
        'relay.human.slack.D123',
        { content: 'echo' },
        'relay.human.slack.bot'
      );
      const result = await deliver(envelope);
      // `skipped`, not a plain success — see the Telegram twin of this test.
      expect(result).toMatchObject({ success: true, skipped: true });
      expect(mockPostMessage).not.toHaveBeenCalled();
    });
  });

  describe('guard conditions', () => {});

  describe('standard payload delivery', () => {
    it('sends standard payload via chat.postMessage', async () => {
      const envelope = env({ content: 'Hello!' });
      const result = await deliver(envelope);
      expect(result.success).toBe(true);
      expect(mockPostMessage).toHaveBeenCalledWith(
        // Real mrkdwn conversion runs here, which ends every block with a newline.
        expect.objectContaining({ channel: 'D123', text: 'Hello!\n' })
      );
      expect(callbacks.trackOutbound).toHaveBeenCalled();
    });

    it('records error and returns failure when postMessage throws', async () => {
      mockPostMessage.mockRejectedValueOnce(new Error('channel_not_found'));
      const envelope = env({ content: 'hi' });
      const result = await deliver(envelope);
      expect(result.success).toBe(false);
      expect(result.error).toBe('channel_not_found');
      expect(callbacks.recordError).toHaveBeenCalled();
    });
  });

  describe('message splitting', () => {
    it('posts all chunks to the same thread_ts', async () => {
      const longContent = 'word '.repeat(1000); // ~5000 chars
      const envelope = env({
        content: longContent,
        platformData: { ts: '9999.0001' },
      });
      await deliver(envelope);
      expect(mockPostMessage.mock.calls.length).toBeGreaterThan(1);
      for (const call of mockPostMessage.mock.calls) {
        const args = call[0] as { thread_ts?: string };
        expect(args.thread_ts).toBe('9999.0001');
      }
    });
  });

  describe('streaming — text_delta', () => {
    it('starts stream on first text_delta via chat.postMessage', async () => {
      const delta = textDelta('Hello');
      await deliver(delta);
      expect(mockPostMessage).toHaveBeenCalledTimes(1);
      // Stream key includes envelope.id for collision prevention
      expect(streamState.has('D123:relay.agent.backend')).toBe(true);
      expect(streamState.get('D123:relay.agent.backend')?.accumulatedText).toBe('Hello');
      expect(streamState.get('D123:relay.agent.backend')?.messageTs).toBe('msg-ts-1');
    });

    it('updates existing stream on subsequent text_delta via chat.update after throttle window', async () => {
      const delta1 = textDelta('Hello');
      await deliver(delta1);

      // Advance past throttle window (1000ms)
      h.now += 1_001;

      const delta2 = textDelta(' world');
      await deliver(delta2);

      expect(mockPostMessage).toHaveBeenCalledTimes(1);
      expect(mockChatUpdate).toHaveBeenCalledTimes(1);
      expect(streamState.get('D123:relay.agent.backend')?.accumulatedText).toBe('Hello world');
    });
  });

  describe('streaming — done', () => {
    it('finalizes stream on done event and removes from streamState', async () => {
      const delta = textDelta('Hi');
      await deliver(delta);

      const done = env({ type: 'done', data: {} });
      const result = await deliver(done);

      expect(result.success).toBe(true);
      expect(streamState.has('D123:relay.agent.backend')).toBe(false);
      expect(mockChatUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'D123', ts: 'msg-ts-1', text: 'Hi\n' })
      );
      expect(callbacks.trackOutbound).toHaveBeenCalled();
    });

    it('splits an over-limit response into follow-up messages instead of truncating', async () => {
      const longText = 'lorem ipsum '.repeat(400); // ~4800 chars → 2 chunks
      const delta = textDelta(longText);
      await deliver(delta);
      expect(mockPostMessage).toHaveBeenCalledTimes(1); // stream start

      const done = env({ type: 'done', data: {} });
      const result = await deliver(done);

      expect(result.success).toBe(true);
      // First chunk finalizes the streamed message via chat.update...
      expect(mockChatUpdate).toHaveBeenCalledTimes(1);
      // ...and the overflow posts as a follow-up message rather than being dropped.
      expect(mockPostMessage).toHaveBeenCalledTimes(2);

      const updateText = (mockChatUpdate.mock.calls[0][0] as { text: string }).text;
      const overflowText = (mockPostMessage.mock.calls[1][0] as { text: string }).text;
      expect(updateText.length).toBeLessThanOrEqual(4000);
      expect(overflowText.length).toBeGreaterThan(0);
      // No text is lost — the tail is carried into the follow-up message.
      expect(overflowText).toContain('lorem');
      expect(streamState.size).toBe(0);
    });

    // A turn that ends having posted nothing at all leaves the person looking
    // at their own question with no sign anything happened (DOR-789).
    it('done with nothing posted says the agent finished without a reply', async () => {
      const done = env({ type: 'done', data: {} });
      const result = await deliver(done);
      expect(result.success).toBe(true);
      expect(mockPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'D123',
          text: expect.stringContaining('finished without sending anything back'),
        })
      );
      expect(mockChatUpdate).not.toHaveBeenCalled();
    });

    // The runtime publishes error THEN done. The done used to find "nothing
    // posted" and add "the agent finished without sending anything back" under
    // the error line — on every crashed turn (DOR-789).
    it('done after an error adds nothing — the error was the answer', async () => {
      const error = env({
        type: 'error',
        data: { message: 'SDK session crashed' },
      });
      await deliver(error);
      expect(mockPostMessage).toHaveBeenCalledTimes(1);
      mockPostMessage.mockClear();

      const done = env({ type: 'done', data: {} });
      await deliver(done);

      expect(mockPostMessage).not.toHaveBeenCalled();
    });
  });

  describe('streaming — error', () => {
    it('handles error event with buffered content via chat.update', async () => {
      const delta = textDelta('Partial response');
      await deliver(delta);

      const error = env({
        type: 'error',
        data: { message: 'Context exceeded' },
      });
      await deliver(error);

      expect(mockChatUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('[Error: Context exceeded]'),
        })
      );
      expect(streamState.has('D123:relay.agent.backend')).toBe(false);
      expect(callbacks.trackOutbound).toHaveBeenCalled();
    });
  });

  describe('silent event types', () => {});

  describe('stale stream reaping', () => {
    it('removes stream entries older than 5 minutes on delivery', async () => {
      // Seed a stale stream entry
      streamState.set('D999', {
        channelId: 'D999',
        threadTs: '',
        messageTs: 'old-ts',
        accumulatedText: 'stale',
        lastUpdateAt: h.now - 6 * 60 * 1_000,
        startedAt: h.now - 6 * 60 * 1_000,
        lastEventAt: h.now - 6 * 60 * 1_000,
        streamId: 'stale-stream',
      });

      const envelope = env({ content: 'hi' });
      await deliver(envelope);

      expect(streamState.has('D999')).toBe(false);
    });

    // Reaping ran off `startedAt`, which nothing refreshed, so an answer longer
    // than the window lost its own stream mid-flight: the accumulated text went,
    // the native stream_id leaked, and the rest of the reply opened a second
    // Slack message (DOR-789).
    it('keeps a stream alive past the window as long as deltas keep arriving', async () => {
      const delta = textDelta('the beginning ');
      await deliver(delta);

      const key = [...streamState.keys()][0]!;
      const stream = streamState.get(key)!;
      // Simulate a turn that has been running far longer than the window, but
      // whose last delta was a moment ago.
      stream.startedAt = Date.now() - STREAM_TTL_MS * 3;
      stream.lastEventAt = Date.now() - 1_000;
      const streamIdBefore = stream.streamId;

      const more = textDelta('and its end');
      await deliver(more);

      const after = streamState.get(key);
      expect(after).toBeDefined();
      // Same stream, not a fresh one — a fresh one is a second Slack message.
      expect(after!.streamId).toBe(streamIdBefore);
      expect(after!.accumulatedText).toBe('the beginning and its end');
    });
  });

  describe('concurrent stream isolation', () => {});

  describe('streaming toggle — buffered mode', () => {
    it('sends single message on done when streaming is false', async () => {
      // Accumulate two deltas
      const delta1 = textDelta('Hello');
      await deliver(delta1, { streaming: false });

      const delta2 = textDelta(' world');
      await deliver(delta2, { streaming: false });

      // Now send done
      const done = env({ type: 'done', data: {} });
      await deliver(done, { streaming: false });

      // Should post once (not update) with complete text
      expect(mockPostMessage).toHaveBeenCalledTimes(1);
      expect(mockPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'D123', text: 'Hello world\n' })
      );
      expect(mockChatUpdate).not.toHaveBeenCalled();
      expect(callbacks.trackOutbound).toHaveBeenCalled();
    });
  });
});
