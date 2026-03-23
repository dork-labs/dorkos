import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildSubject,
  extractChannelId,
  handleInboundMessage,
  getEffectiveChannelConfig,
  clearCaches,
  SUBJECT_PREFIX,
  MAX_CONTENT_LENGTH,
} from '../inbound.js';
import type { SlackMessageEvent, InboundOptions } from '../inbound.js';
import type { WebClient } from '@slack/web-api';
import type { AdapterInboundCallbacks } from '../../../types.js';
import type { RelayPublisher } from '../../../types.js';
import { SlackThreadIdCodec } from '../../../lib/thread-id.js';
import { ThreadParticipationTracker } from '../thread-tracker.js';

/** Shared codec for tests — no instance ID so prefix is `relay.human.slack`. */
const testCodec = new SlackThreadIdCodec();

function createMockRelay(): RelayPublisher {
  return {
    publish: vi.fn().mockResolvedValue({ messageId: 'msg-1', deliveredTo: 1 }),
    onSignal: vi.fn().mockReturnValue(() => {}),
  };
}

function createMockClient(): WebClient & { reactions: { add: ReturnType<typeof vi.fn> } } {
  return {
    users: {
      info: vi.fn().mockResolvedValue({
        user: { profile: { display_name: 'Alice' }, name: 'alice' },
      }),
    },
    conversations: {
      info: vi.fn().mockResolvedValue({
        channel: { name: 'general' },
      }),
    },
    reactions: {
      add: vi.fn().mockResolvedValue({ ok: true }),
    },
  } as unknown as WebClient & { reactions: { add: ReturnType<typeof vi.fn> } };
}

function createMockCallbacks(): AdapterInboundCallbacks {
  return {
    trackInbound: vi.fn(),
    recordError: vi.fn(),
  };
}

function createEvent(overrides: Partial<SlackMessageEvent> = {}): SlackMessageEvent {
  return {
    type: 'message',
    user: 'U12345',
    text: 'Hello agent!',
    channel: 'D67890',
    ts: '1234567890.123456',
    ...overrides,
  };
}

describe('buildSubject', () => {
  it('returns DM subject for non-group', () => {
    expect(buildSubject(testCodec, 'D12345', false)).toBe('relay.human.slack.D12345');
  });

  it('returns group subject for group channel', () => {
    expect(buildSubject(testCodec, 'C12345', true)).toBe('relay.human.slack.group.C12345');
  });
});

describe('extractChannelId', () => {
  it('extracts channel ID from DM subject', () => {
    expect(extractChannelId(testCodec, 'relay.human.slack.D12345')).toBe('D12345');
  });

  it('extracts channel ID from group subject', () => {
    expect(extractChannelId(testCodec, 'relay.human.slack.group.C12345')).toBe('C12345');
  });

  it('returns null for non-slack subject', () => {
    expect(extractChannelId(testCodec, 'relay.human.telegram.12345')).toBeNull();
  });

  it('returns null for empty remainder', () => {
    expect(extractChannelId(testCodec, 'relay.human.slack')).toBeNull();
  });

  it('returns null for empty group suffix', () => {
    expect(extractChannelId(testCodec, 'relay.human.slack.group.')).toBeNull();
  });
});

describe('handleInboundMessage', () => {
  let relay: RelayPublisher;
  let client: WebClient;
  let callbacks: AdapterInboundCallbacks;

  beforeEach(() => {
    vi.clearAllMocks();
    clearCaches();
    relay = createMockRelay();
    client = createMockClient();
    callbacks = createMockCallbacks();
  });

  it('publishes DM message to relay.human.slack.{channelId}', async () => {
    const event = createEvent({ channel: 'D67890' });
    await handleInboundMessage(event, client, relay, 'UBOTID', callbacks);

    expect(relay.publish).toHaveBeenCalledWith(
      'relay.human.slack.D67890',
      expect.objectContaining({
        content: 'Hello agent!',
        channelType: 'dm',
      }),
      { from: 'relay.human.slack.bot', replyTo: 'relay.human.slack.D67890' }
    );
  });

  it('publishes group message with group segment', async () => {
    const event = createEvent({ channel: 'C12345' });
    await handleInboundMessage(event, client, relay, 'UBOTID', callbacks);

    expect(relay.publish).toHaveBeenCalledWith(
      'relay.human.slack.group.C12345',
      expect.objectContaining({ channelType: 'group' }),
      expect.any(Object)
    );
  });

  it('skips bot own messages (echo prevention)', async () => {
    const event = createEvent({ user: 'UBOTID' });
    await handleInboundMessage(event, client, relay, 'UBOTID', callbacks);
    expect(relay.publish).not.toHaveBeenCalled();
  });

  it('skips bot_message subtype', async () => {
    const event = createEvent({ subtype: 'bot_message' });
    await handleInboundMessage(event, client, relay, 'UBOTID', callbacks);
    expect(relay.publish).not.toHaveBeenCalled();
  });

  it('skips channel_join subtype', async () => {
    const event = createEvent({ subtype: 'channel_join' });
    await handleInboundMessage(event, client, relay, 'UBOTID', callbacks);
    expect(relay.publish).not.toHaveBeenCalled();
  });

  it('skips messages with bot_id', async () => {
    const event = createEvent({ bot_id: 'B12345' });
    await handleInboundMessage(event, client, relay, 'UBOTID', callbacks);
    expect(relay.publish).not.toHaveBeenCalled();
  });

  it('skips messages without text', async () => {
    const event = createEvent({ text: undefined });
    await handleInboundMessage(event, client, relay, 'UBOTID', callbacks);
    expect(relay.publish).not.toHaveBeenCalled();
  });

  it('caps content at MAX_CONTENT_LENGTH', async () => {
    const longText = 'X'.repeat(40_000);
    const event = createEvent({ text: longText });
    await handleInboundMessage(event, client, relay, 'UBOTID', callbacks);

    const published = (relay.publish as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(published.content.length).toBe(MAX_CONTENT_LENGTH);
  });

  it('includes platformData with channel, user, ts', async () => {
    const event = createEvent({ ts: '1234.5678', thread_ts: '1234.0000', team: 'T123' });
    await handleInboundMessage(event, client, relay, 'UBOTID', callbacks);

    expect(relay.publish).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        platformData: expect.objectContaining({
          ts: '1234.5678',
          threadTs: '1234.0000',
          teamId: 'T123',
        }),
      }),
      expect.any(Object)
    );
  });

  it('records error when publish fails without throwing', async () => {
    (relay.publish as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('fail'));
    const event = createEvent();
    await expect(
      handleInboundMessage(event, client, relay, 'UBOTID', callbacks)
    ).resolves.toBeUndefined();
    expect(callbacks.recordError).toHaveBeenCalled();
  });

  it('calls trackInbound on successful publish', async () => {
    const event = createEvent();
    await handleInboundMessage(event, client, relay, 'UBOTID', callbacks);
    expect(callbacks.trackInbound).toHaveBeenCalled();
  });

  it('uses SUBJECT_PREFIX constant for bot from field', async () => {
    const event = createEvent();
    await handleInboundMessage(event, client, relay, 'UBOTID', callbacks);
    expect(relay.publish).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({ from: `${SUBJECT_PREFIX}.bot` })
    );
  });

  it('does not include channelName for DM messages', async () => {
    const event = createEvent({ channel: 'D67890' });
    await handleInboundMessage(event, client, relay, 'UBOTID', callbacks);

    const published = (relay.publish as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(published.channelName).toBeUndefined();
  });

  it('resolves and includes channelName for group messages', async () => {
    const event = createEvent({ channel: 'C12345' });
    await handleInboundMessage(event, client, relay, 'UBOTID', callbacks);

    const published = (relay.publish as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(published.channelName).toBe('general');
  });

  it('falls back to userId when user resolution fails', async () => {
    const failingClient = {
      users: { info: vi.fn().mockRejectedValue(new Error('api error')) },
      conversations: { info: vi.fn().mockResolvedValue({ channel: { name: 'general' } }) },
    } as unknown as WebClient;
    const event = createEvent({ user: 'U99999' });
    await handleInboundMessage(event, failingClient, relay, 'UBOTID', callbacks);

    const published = (relay.publish as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(published.senderName).toBe('U99999');
  });

  describe('typing indicator — inbound reaction', () => {
    it('adds hourglass reaction immediately on message receipt when typingIndicator is reaction', async () => {
      const event = createEvent({ ts: '1234.5678' });
      const pendingReactions = new Map<string, string[]>();

      await handleInboundMessage(
        event,
        client,
        relay,
        'UBOTID',
        callbacks,
        undefined,
        'reaction',
        pendingReactions
      );

      // Wait a tick for the fire-and-forget promise to resolve
      await new Promise((r) => setTimeout(r, 10));

      expect(client.reactions.add).toHaveBeenCalledWith({
        channel: 'D67890',
        name: 'hourglass_flowing_sand',
        timestamp: '1234.5678',
      });
    });

    it('tracks pending reaction in FIFO queue', async () => {
      const event = createEvent({ ts: '1234.5678' });
      const pendingReactions = new Map<string, string[]>();

      await handleInboundMessage(
        event,
        client,
        relay,
        'UBOTID',
        callbacks,
        undefined,
        'reaction',
        pendingReactions
      );
      await new Promise((r) => setTimeout(r, 10));

      expect(pendingReactions.get('D67890')).toEqual(['1234.5678']);
    });

    it('does not add reaction when typingIndicator is none', async () => {
      const event = createEvent({ ts: '1234.5678' });

      await handleInboundMessage(event, client, relay, 'UBOTID', callbacks, undefined, 'none');
      await new Promise((r) => setTimeout(r, 10));

      expect(client.reactions.add).not.toHaveBeenCalled();
    });

    it('does not add reaction when typingIndicator is omitted (default)', async () => {
      const event = createEvent({ ts: '1234.5678' });

      await handleInboundMessage(event, client, relay, 'UBOTID', callbacks);
      await new Promise((r) => setTimeout(r, 10));

      expect(client.reactions.add).not.toHaveBeenCalled();
    });

    it('logs warning when reaction add fails', async () => {
      client.reactions.add.mockRejectedValueOnce(new Error('no_permission'));
      const event = createEvent({ ts: '1234.5678' });
      const mockLogger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

      await handleInboundMessage(event, client, relay, 'UBOTID', callbacks, mockLogger, 'reaction');
      await new Promise((r) => setTimeout(r, 10));

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('failed to add typing reaction')
      );
    });

    it('does not track reaction when add fails', async () => {
      client.reactions.add.mockRejectedValueOnce(new Error('no_permission'));
      const event = createEvent({ ts: '1234.5678' });
      const pendingReactions = new Map<string, string[]>();

      await handleInboundMessage(
        event,
        client,
        relay,
        'UBOTID',
        callbacks,
        undefined,
        'reaction',
        pendingReactions
      );
      await new Promise((r) => setTimeout(r, 10));

      // Should not track a reaction that failed to add
      expect(pendingReactions.has('D67890')).toBe(false);
    });
  });

  describe('event deduplication', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('skips duplicate event_id (no relay.publish call)', async () => {
      const event = createEvent();
      const options: InboundOptions = { eventId: 'evt-abc-123' };

      // First call — should process normally
      await handleInboundMessage(
        event,
        client,
        relay,
        'UBOTID',
        callbacks,
        undefined,
        'none',
        undefined,
        undefined,
        options
      );
      expect(relay.publish).toHaveBeenCalledTimes(1);

      // Second call with same event_id — should be skipped
      await handleInboundMessage(
        event,
        client,
        relay,
        'UBOTID',
        callbacks,
        undefined,
        'none',
        undefined,
        undefined,
        options
      );
      expect(relay.publish).toHaveBeenCalledTimes(1);
    });

    it('processes different event_id normally', async () => {
      const event = createEvent();

      await handleInboundMessage(
        event,
        client,
        relay,
        'UBOTID',
        callbacks,
        undefined,
        'none',
        undefined,
        undefined,
        { eventId: 'evt-1' }
      );
      await handleInboundMessage(
        event,
        client,
        relay,
        'UBOTID',
        callbacks,
        undefined,
        'none',
        undefined,
        undefined,
        { eventId: 'evt-2' }
      );

      expect(relay.publish).toHaveBeenCalledTimes(2);
    });

    it('processes normally when no event_id is provided', async () => {
      const event = createEvent();

      await handleInboundMessage(
        event,
        client,
        relay,
        'UBOTID',
        callbacks,
        undefined,
        'none',
        undefined,
        undefined,
        {}
      );
      await handleInboundMessage(event, client, relay, 'UBOTID', callbacks);

      expect(relay.publish).toHaveBeenCalledTimes(2);
    });

    it('cleans up expired entries and allows reprocessing', async () => {
      vi.useFakeTimers();
      const event = createEvent();

      // Process with event_id
      await handleInboundMessage(
        event,
        client,
        relay,
        'UBOTID',
        callbacks,
        undefined,
        'none',
        undefined,
        undefined,
        { eventId: 'evt-expire' }
      );
      expect(relay.publish).toHaveBeenCalledTimes(1);

      // Advance past TTL (5 minutes)
      vi.advanceTimersByTime(5 * 60 * 1_000 + 1);

      // Same event_id should now process again (entry expired)
      await handleInboundMessage(
        event,
        client,
        relay,
        'UBOTID',
        callbacks,
        undefined,
        'none',
        undefined,
        undefined,
        { eventId: 'evt-expire' }
      );
      expect(relay.publish).toHaveBeenCalledTimes(2);
    });

    it('clearCaches clears the dedup cache', async () => {
      const event = createEvent();

      await handleInboundMessage(
        event,
        client,
        relay,
        'UBOTID',
        callbacks,
        undefined,
        'none',
        undefined,
        undefined,
        { eventId: 'evt-clear' }
      );
      expect(relay.publish).toHaveBeenCalledTimes(1);

      // Clear all caches including dedup
      clearCaches();

      // Same event_id should now process again
      await handleInboundMessage(
        event,
        client,
        relay,
        'UBOTID',
        callbacks,
        undefined,
        'none',
        undefined,
        undefined,
        { eventId: 'evt-clear' }
      );
      expect(relay.publish).toHaveBeenCalledTimes(2);
    });
  });

  describe('respond mode gating', () => {
    const BOT_ID = 'UBOTID';

    /** Helper to call handleInboundMessage with InboundOptions shorthand. */
    async function callWithOptions(event: SlackMessageEvent, opts: InboundOptions): Promise<void> {
      await handleInboundMessage(
        event,
        client,
        relay,
        BOT_ID,
        callbacks,
        undefined,
        'none',
        undefined,
        undefined,
        opts
      );
    }

    it("'always' processes all messages", async () => {
      const event = createEvent({ channel: 'C12345', text: 'hello' });
      await callWithOptions(event, { respondMode: 'always' });
      expect(relay.publish).toHaveBeenCalledTimes(1);
    });

    it("'mention-only' processes @mentions", async () => {
      const event = createEvent({ channel: 'C12345', text: `Hey <@${BOT_ID}> help` });
      await callWithOptions(event, { respondMode: 'mention-only' });
      expect(relay.publish).toHaveBeenCalledTimes(1);
    });

    it("'mention-only' skips non-mentions", async () => {
      const event = createEvent({ channel: 'C12345', text: 'just chatting' });
      await callWithOptions(event, { respondMode: 'mention-only' });
      expect(relay.publish).not.toHaveBeenCalled();
    });

    it("'thread-aware' processes DMs always", async () => {
      const event = createEvent({ channel: 'D67890', text: 'hi in DM' });
      await callWithOptions(event, { respondMode: 'thread-aware' });
      expect(relay.publish).toHaveBeenCalledTimes(1);
    });

    it("'thread-aware' processes @mentions in main channel", async () => {
      const event = createEvent({ channel: 'C12345', text: `<@${BOT_ID}> help` });
      await callWithOptions(event, { respondMode: 'thread-aware' });
      expect(relay.publish).toHaveBeenCalledTimes(1);
    });

    it("'thread-aware' skips non-mention in main channel", async () => {
      const event = createEvent({ channel: 'C12345', text: 'general chatter' });
      await callWithOptions(event, { respondMode: 'thread-aware' });
      expect(relay.publish).not.toHaveBeenCalled();
    });

    it("'thread-aware' processes in participating threads", async () => {
      const tracker = new ThreadParticipationTracker();
      tracker.markParticipating('C12345', '1111.0000');
      const event = createEvent({
        channel: 'C12345',
        text: 'follow-up',
        thread_ts: '1111.0000',
      });
      await callWithOptions(event, { respondMode: 'thread-aware', threadTracker: tracker });
      expect(relay.publish).toHaveBeenCalledTimes(1);
    });

    it("'thread-aware' skips non-participating threads without mention", async () => {
      const tracker = new ThreadParticipationTracker();
      const event = createEvent({
        channel: 'C12345',
        text: 'thread reply',
        thread_ts: '2222.0000',
      });
      await callWithOptions(event, { respondMode: 'thread-aware', threadTracker: tracker });
      expect(relay.publish).not.toHaveBeenCalled();
    });

    it("'thread-aware' processes @mentions in non-participating threads", async () => {
      const tracker = new ThreadParticipationTracker();
      const event = createEvent({
        channel: 'C12345',
        text: `<@${BOT_ID}> can you help?`,
        thread_ts: '3333.0000',
      });
      await callWithOptions(event, { respondMode: 'thread-aware', threadTracker: tracker });
      expect(relay.publish).toHaveBeenCalledTimes(1);
    });
  });

  describe('DM policy gating', () => {
    it('allowlist: allowed user processes', async () => {
      const event = createEvent({ channel: 'D67890', user: 'U12345', text: 'hi' });
      await handleInboundMessage(
        event,
        client,
        relay,
        'UBOTID',
        callbacks,
        undefined,
        'none',
        undefined,
        undefined,
        { dmPolicy: 'allowlist', dmAllowlist: ['U12345'] }
      );
      expect(relay.publish).toHaveBeenCalledTimes(1);
    });

    it('allowlist: non-allowed user skips silently', async () => {
      const event = createEvent({ channel: 'D67890', user: 'U99999', text: 'hi' });
      await handleInboundMessage(
        event,
        client,
        relay,
        'UBOTID',
        callbacks,
        undefined,
        'none',
        undefined,
        undefined,
        { dmPolicy: 'allowlist', dmAllowlist: ['U12345'] }
      );
      expect(relay.publish).not.toHaveBeenCalled();
    });

    it('open policy: all DMs process', async () => {
      const event = createEvent({ channel: 'D67890', user: 'U99999', text: 'hi' });
      await handleInboundMessage(
        event,
        client,
        relay,
        'UBOTID',
        callbacks,
        undefined,
        'none',
        undefined,
        undefined,
        { dmPolicy: 'open' }
      );
      expect(relay.publish).toHaveBeenCalledTimes(1);
    });
  });

  describe('channel overrides', () => {
    it('enabled: false skips the channel', async () => {
      const event = createEvent({ channel: 'C12345', text: 'hello' });
      await handleInboundMessage(
        event,
        client,
        relay,
        'UBOTID',
        callbacks,
        undefined,
        'none',
        undefined,
        undefined,
        { respondMode: 'always', channelOverrides: { C12345: { enabled: false } } }
      );
      expect(relay.publish).not.toHaveBeenCalled();
    });

    it('respondMode override takes precedence over global', async () => {
      // Global is 'always' but channel override is 'mention-only' — should skip non-mention
      const event = createEvent({ channel: 'C12345', text: 'hello' });
      await handleInboundMessage(
        event,
        client,
        relay,
        'UBOTID',
        callbacks,
        undefined,
        'none',
        undefined,
        undefined,
        {
          respondMode: 'always',
          channelOverrides: { C12345: { respondMode: 'mention-only' } },
        }
      );
      expect(relay.publish).not.toHaveBeenCalled();
    });
  });
});

describe('getEffectiveChannelConfig', () => {
  it('returns global defaults when no override exists', () => {
    const config = getEffectiveChannelConfig('C12345', 'thread-aware', {});
    expect(config).toEqual({ enabled: true, respondMode: 'thread-aware' });
  });

  it('merges channel override respondMode', () => {
    const config = getEffectiveChannelConfig('C12345', 'thread-aware', {
      C12345: { respondMode: 'always' },
    });
    expect(config).toEqual({ enabled: true, respondMode: 'always' });
  });

  it('merges channel override enabled: false', () => {
    const config = getEffectiveChannelConfig('C12345', 'always', {
      C12345: { enabled: false },
    });
    expect(config).toEqual({ enabled: false, respondMode: 'always' });
  });
});
