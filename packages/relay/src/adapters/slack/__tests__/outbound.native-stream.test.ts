import { describe, it, expect, beforeEach } from 'vitest';
import type { AdapterOutboundCallbacks } from '../../../types.js';
import { ThreadParticipationTracker } from '../thread-tracker.js';
import {
  createEnvelope,
  deliver,
  env,
  mockAppendStream,
  mockChatUpdate,
  mockPostMessage,
  mockStartStream,
  mockStopStream,
  resetOutboundHarness,
  textDelta,
} from './outbound.fixtures.js';

describe('deliverMessage', () => {
  let callbacks: AdapterOutboundCallbacks;

  beforeEach(() => {
    ({ callbacks } = resetOutboundHarness());
  });

  describe('native streaming — chat.startStream/appendStream/stopStream', () => {
    it('starts stream on first text_delta and buffers until a line boundary', async () => {
      const delta = env({
        type: 'text_delta',
        data: { text: 'Hello' }, // no newline yet
        platformData: { ts: '1234.0001' },
      });
      await deliver(delta, { nativeStreaming: true });
      expect(mockStartStream).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'D123', thread_ts: '1234.0001' })
      );
      // The fragment has no complete line, so it is buffered rather than
      // formatted + appended in isolation (which would mangle split tokens).
      expect(mockAppendStream).not.toHaveBeenCalled();
      expect(mockPostMessage).not.toHaveBeenCalled();
    });

    it('formats and appends only complete lines across deltas', async () => {
      // A bold token split across two deltas: '**Hel' then 'lo**\n'.
      const delta1 = textDelta('**Hel', '1234.0001');
      await deliver(delta1, { nativeStreaming: true });
      // No line boundary yet — nothing appended.
      expect(mockAppendStream).not.toHaveBeenCalled();

      const delta2 = textDelta('lo**\n', '1234.0001');
      await deliver(delta2, { nativeStreaming: true });

      // A single append carries the reunited token — fragments were coalesced
      // and formatted as one whole line rather than in isolation.
      expect(mockAppendStream).toHaveBeenCalledTimes(1);
      const appended = mockAppendStream.mock.calls[0][0] as { text: string };
      // Formatted as one Slack bold span, not two broken halves.
      expect(appended.text).toContain('*Hello*');
      expect(appended.text).not.toContain('**');
      expect(mockChatUpdate).not.toHaveBeenCalled();
    });

    it('force-flushes a newline-free buffer once it exceeds the size threshold', async () => {
      // A response with no newlines must not stay invisible until done: the
      // buffer flushes whole once it crosses the threshold (600 chars).
      const part1 = 'a'.repeat(400); // below threshold — buffered
      const delta1 = textDelta(part1, '1234.0001');
      await deliver(delta1, { nativeStreaming: true });
      expect(mockAppendStream).not.toHaveBeenCalled();

      const part2 = 'b'.repeat(400); // total 800 >= threshold — flush whole buffer
      const delta2 = textDelta(part2, '1234.0001');
      await deliver(delta2, { nativeStreaming: true });

      expect(mockAppendStream).toHaveBeenCalledTimes(1);
      const appended = mockAppendStream.mock.calls[0][0] as { text: string };
      expect(appended.text).toContain(part1);
      expect(appended.text).toContain(part2);
    });

    it('stops stream on done', async () => {
      const delta = textDelta('Hello', '1234.0001');
      await deliver(delta, { nativeStreaming: true });

      const done = env({
        type: 'done',
        data: {},
        platformData: { ts: '1234.0001' },
      });
      await deliver(done, { nativeStreaming: true });

      expect(mockStopStream).toHaveBeenCalledWith(
        expect.objectContaining({ stream_id: 'stream-123' })
      );
    });

    it('appends error and stops stream on error', async () => {
      const delta = textDelta('Partial', '1234.0001');
      await deliver(delta, { nativeStreaming: true });

      const error = env({
        type: 'error',
        data: { message: 'timeout' },
        platformData: { ts: '1234.0001' },
      });
      await deliver(error, { nativeStreaming: true });

      expect(mockAppendStream).toHaveBeenLastCalledWith(
        expect.objectContaining({ stream_id: 'stream-123' })
      );
      expect(mockStopStream).toHaveBeenCalled();
    });

    it('falls back to chat.postMessage when startStream fails', async () => {
      mockStartStream.mockRejectedValueOnce(new Error('missing_scope'));
      const delta = textDelta('Hello', '1234.0001');
      await deliver(delta, { nativeStreaming: true });

      // Should fall back to chat.postMessage
      expect(mockPostMessage).toHaveBeenCalled();
      expect(callbacks.recordError).toHaveBeenCalled();
    });
  });

  describe('approval_required handling', () => {
    it('renders Block Kit card with Approve and Deny buttons', async () => {
      const envelope = env({
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
      const result = await deliver(envelope);
      expect(result.success).toBe(true);
      const call = mockPostMessage.mock.calls[0][0];
      expect(call.blocks).toHaveLength(3);
      expect(call.blocks[2].elements).toHaveLength(2);
      expect(call.blocks[2].elements[0].action_id).toBe('tool_approve');
      expect(call.blocks[2].elements[1].action_id).toBe('tool_deny');
      expect(call.blocks[2].block_id).toBe('tool_approval');
    });

    it('encodes only IDs in button value (no sensitive input)', async () => {
      const envelope = env({
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
      await deliver(envelope);
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
      const envelope = env({
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
      await deliver(envelope);
      const call = mockPostMessage.mock.calls[0][0];
      // Second block contains the input preview
      const previewBlock = call.blocks[1] as { text: { text: string } };
      // 500 chars + ``` fences — should be well within 600 chars
      expect(previewBlock.text.text.length).toBeLessThanOrEqual(510);
    });

    it('falls through to whitelist drop when approval data is invalid (missing toolCallId)', async () => {
      const envelope = env({
        type: 'approval_required',
        data: { toolName: 'Write' }, // missing toolCallId
      });
      const result = await deliver(envelope);
      expect(result.success).toBe(true); // silently dropped
      expect(mockPostMessage).not.toHaveBeenCalled();
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
      await deliver(deltaEnv, { streaming: false });
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
      await deliver(approvalEnv, { streaming: false });

      // First postMessage: the flushed text buffer
      expect(mockPostMessage).toHaveBeenCalledTimes(2);
      const flushCall = mockPostMessage.mock.calls[0][0];
      expect(flushCall.text).toContain('Let me search for Art Blocks projects');

      // Second postMessage: the approval card
      const approvalCall = mockPostMessage.mock.calls[1][0];
      expect(approvalCall.blocks).toBeDefined();
      expect(approvalCall.blocks[2].block_id).toBe('tool_approval');
    });
  });

  describe('thread participation tracking', () => {
    it('marks participation after successful standard delivery with threadTs', async () => {
      const tracker = new ThreadParticipationTracker();
      const envelope = env({
        content: 'Hello!',
        platformData: { ts: '1234.0001' },
      });
      await deliver(envelope, { threadTracker: tracker });
      expect(tracker.isParticipating('D123', '1234.0001')).toBe(true);
    });

    it('does not mark participation when delivery fails', async () => {
      mockPostMessage.mockRejectedValueOnce(new Error('channel_not_found'));
      const tracker = new ThreadParticipationTracker();
      const envelope = env({
        content: 'fail',
        platformData: { ts: '1234.0001' },
      });
      await deliver(envelope, { threadTracker: tracker });
      expect(tracker.isParticipating('D123', '1234.0001')).toBe(false);
    });

    it('marks participation on native stream start', async () => {
      const tracker = new ThreadParticipationTracker();
      const delta = textDelta('Hello', '1234.0001');
      await deliver(delta, { nativeStreaming: true, threadTracker: tracker });
      expect(tracker.isParticipating('D123', '1234.0001')).toBe(true);
    });
  });
});
