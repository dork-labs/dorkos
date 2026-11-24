import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockRelay } from '../../../__tests__/fixtures.js';
import {
  extractChannelId,
  handleInboundMessage,
  createSlackInboundState,
  clearCaches,
  MAX_CONTENT_LENGTH,
} from '../inbound.js';
import type { SlackMessageEvent, InboundOptions, SlackInboundState } from '../inbound.js';
import type { WebClient } from '@slack/web-api';
import type { AdapterInboundCallbacks } from '../../../types.js';
import type { RelayPublisher } from '../../../types.js';
import { SlackThreadIdCodec } from '../../../lib/thread-id.js';
import { ThreadParticipationTracker } from '../thread-tracker.js';
import { createSlackPresenceState } from '../presence.js';

/** Shared codec for tests — no instance ID so prefix is `relay.human.slack`. */
const testCodec = new SlackThreadIdCodec();

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

describe('extractChannelId', () => {
  it('extracts channel ID from DM subject', () => {
    expect(extractChannelId(testCodec, 'relay.human.slack.D12345')).toBe('D12345');
  });

  it('returns null for non-slack subject', () => {
    expect(extractChannelId(testCodec, 'relay.human.telegram.12345')).toBeNull();
  });

  it('returns null for empty group suffix', () => {
    expect(extractChannelId(testCodec, 'relay.human.slack.group.')).toBeNull();
  });
});

describe('handleInboundMessage', () => {
  let relay: RelayPublisher;
  let client: WebClient;
  let callbacks: AdapterInboundCallbacks;
  let state: SlackInboundState;

  beforeEach(() => {
    vi.clearAllMocks();
    state = createSlackInboundState();
    relay = createMockRelay();
    client = createMockClient();
    callbacks = createMockCallbacks();
  });

  it('publishes DM message to relay.human.slack.{channelId}', async () => {
    const event = createEvent({ channel: 'D67890' });
    await handleInboundMessage(event, client, relay, 'UBOTID', callbacks, state);

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
    // @mentions the bot, because a channel message that names nobody is
    // filtered by the default respond mode. This used to publish unmentioned:
    // the call sites here fell back to 'always' while the schema said
    // 'thread-aware' (DOR-623). This test is about the subject, not the gate.
    const event = createEvent({ channel: 'C12345', text: '<@UBOTID> hello' });
    await handleInboundMessage(event, client, relay, 'UBOTID', callbacks, state);

    expect(relay.publish).toHaveBeenCalledWith(
      'relay.human.slack.group.C12345',
      expect.objectContaining({ channelType: 'group' }),
      expect.any(Object)
    );
  });

  it('skips bot own messages (echo prevention)', async () => {
    const event = createEvent({ user: 'UBOTID' });
    await handleInboundMessage(event, client, relay, 'UBOTID', callbacks, state);
    expect(relay.publish).not.toHaveBeenCalled();
  });

  it('skips bot_message subtype', async () => {
    const event = createEvent({ subtype: 'bot_message' });
    await handleInboundMessage(event, client, relay, 'UBOTID', callbacks, state);
    expect(relay.publish).not.toHaveBeenCalled();
  });

  it('skips messages with bot_id', async () => {
    const event = createEvent({ bot_id: 'B12345' });
    await handleInboundMessage(event, client, relay, 'UBOTID', callbacks, state);
    expect(relay.publish).not.toHaveBeenCalled();
  });

  it('caps content at MAX_CONTENT_LENGTH', async () => {
    const longText = 'X'.repeat(40_000);
    const event = createEvent({ text: longText });
    await handleInboundMessage(event, client, relay, 'UBOTID', callbacks, state);

    const published = (relay.publish as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(published.content.length).toBe(MAX_CONTENT_LENGTH);
  });

  it('records error when publish fails without throwing', async () => {
    (relay.publish as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('fail'));
    const event = createEvent();
    await expect(
      handleInboundMessage(event, client, relay, 'UBOTID', callbacks, state)
    ).resolves.toBeUndefined();
    expect(callbacks.recordError).toHaveBeenCalled();
  });

  describe('working presence — the trigger message is queued, not marked', () => {
    it('queues the message without touching Slack when typingIndicator is reaction', async () => {
      const event = createEvent({ ts: '1234.5678' });
      const presence = createSlackPresenceState();

      await handleInboundMessage(
        event,
        client,
        relay,
        'UBOTID',
        callbacks,
        state,
        undefined,
        'reaction',
        presence
      );
      await new Promise((r) => setTimeout(r, 10));

      // Receipt is not work. The `:eyes:` goes on when a turn claims the message.
      expect(client.reactions.add).not.toHaveBeenCalled();
      expect(presence.pendingReactions.get('D67890')?.map((e) => e.ts)).toEqual(['1234.5678']);
    });

    it('forgets the queued message when the publish is rejected', async () => {
      const event = createEvent({ ts: '1234.5678' });
      const presence = createSlackPresenceState();
      (relay.publish as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        deliveredTo: 0,
        rejected: [{ reason: 'rate_limited' }],
      });

      await handleInboundMessage(
        event,
        client,
        relay,
        'UBOTID',
        callbacks,
        state,
        undefined,
        'reaction',
        presence
      );
      await new Promise((r) => setTimeout(r, 10));

      expect(presence.pendingReactions.has('D67890')).toBe(false);
    });

    // The router's own drops (paused binding, missing agent, no binding) come
    // back as deliveredTo: 0 with NOTHING in `rejected` — and the queue was only
    // cleared for an explicit rejection, so every one of those left a trigger
    // behind and offset the `:eyes:` on every later turn in the channel by one
    // (DOR-789).
    it('forgets the queued message when the router silently drops it', async () => {
      const event = createEvent({ ts: '1234.5678' });
      const presence = createSlackPresenceState();
      (relay.publish as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ deliveredTo: 0 });

      await handleInboundMessage(
        event,
        client,
        relay,
        'UBOTID',
        callbacks,
        state,
        undefined,
        'reaction',
        presence
      );
      await new Promise((r) => setTimeout(r, 10));

      expect(presence.pendingReactions.has('D67890')).toBe(false);
    });
  });

  describe('event deduplication', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('dedups the same message delivered as message and app_mention with distinct event_ids', async () => {
      // Slack delivers a channel @mention as TWO events with DIFFERENT
      // event_ids: a `message` event and an `app_mention` event. Both carry
      // the same channel + ts. Without message-identity dedup, the agent is
      // invoked twice for one message.
      const mentionText = '<@UBOTID> deploy the thing';
      const messageEvent = createEvent({ channel: 'C12345', ts: '3333.0001', text: mentionText });
      const mentionEvent = createEvent({
        type: 'app_mention',
        channel: 'C12345',
        ts: '3333.0001',
        text: mentionText,
      });

      // `message` path: thread-aware mode — mention passes gating
      await handleInboundMessage(
        messageEvent,
        client,
        relay,
        'UBOTID',
        callbacks,
        state,
        undefined,
        'none',
        undefined,
        undefined,
        { eventId: 'Ev-message-path', respondMode: 'thread-aware' }
      );
      // `app_mention` path: the adapter forces respondMode 'always'
      await handleInboundMessage(
        mentionEvent,
        client,
        relay,
        'UBOTID',
        callbacks,
        state,
        undefined,
        'none',
        undefined,
        undefined,
        { eventId: 'Ev-mention-path', respondMode: 'always' }
      );

      expect(relay.publish).toHaveBeenCalledTimes(1);
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
        state,
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
        state,
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
      const options: InboundOptions = { eventId: 'evt-clear' };
      const deliver = () =>
        handleInboundMessage(
          event,
          client,
          relay,
          'UBOTID',
          callbacks,
          state,
          undefined,
          'none',
          undefined,
          undefined,
          options
        );

      await deliver();
      clearCaches(state);
      await deliver();

      expect(relay.publish).toHaveBeenCalledTimes(2);
    });
  });

  describe('instance-scoped caches', () => {
    it('re-processes a message after a rejected publish (dedup rolled back)', async () => {
      (relay.publish as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        messageId: 'm',
        deliveredTo: 0,
        rejected: [{ reason: 'rate_limited' }],
      });
      const event = createEvent({ channel: 'C12345', ts: '6000.0001' });

      // First delivery rejected (e.g. rate-limited) — dedup must be rolled back.
      await handleInboundMessage(
        event,
        client,
        relay,
        'UBOTID',
        callbacks,
        state,
        undefined,
        'none',
        undefined,
        undefined,
        { eventId: 'evt-1', respondMode: 'always' }
      );
      expect(relay.publish).toHaveBeenCalledTimes(1);

      // The message's twin event (distinct event_id, same channel:ts) must be
      // able to reprocess instead of being permanently suppressed for the TTL.
      await handleInboundMessage(
        { ...event, type: 'app_mention' },
        client,
        relay,
        'UBOTID',
        callbacks,
        state,
        undefined,
        'none',
        undefined,
        undefined,
        { eventId: 'evt-2', respondMode: 'always' }
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
        state,
        undefined,
        'none',
        undefined,
        undefined,
        opts
      );
    }

    it('with no respondMode supplied, falls back to the schema default and not to always', async () => {
      // DOR-623: the default is stated once, in `DEFAULT_RESPOND_MODE`. These
      // call sites used to restate it as 'always', so whether an unaddressed
      // channel message was answered depended on whether the config had
      // travelled through the schema.
      const event = createEvent({ channel: 'C12345', text: 'general chatter' });
      await callWithOptions(event, {});
      expect(relay.publish).not.toHaveBeenCalled();
    });

    it("'mention-only' skips non-mentions", async () => {
      const event = createEvent({ channel: 'C12345', text: 'just chatting' });
      await callWithOptions(event, { respondMode: 'mention-only' });
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
  });

  describe('DM policy gating', () => {
    it('allowlist: a non-allowed user is turned away', async () => {
      const event = createEvent({ channel: 'D67890', user: 'U99999', text: 'hi' });
      await handleInboundMessage(
        event,
        client,
        relay,
        'UBOTID',
        callbacks,
        state,
        undefined,
        'none',
        undefined,
        undefined,
        { dmPolicy: 'allowlist', dmAllowlist: ['U12345'] }
      );
      expect(relay.publish).not.toHaveBeenCalled();
    });

    it('says so out loud, with the id to add and the setting to change', async () => {
      // This used to drop at `debug`, i.e. invisibly. Right after setup the
      // allowlist is empty, so silence was the first thing a person met.
      const warnings: string[] = [];
      const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn((...args: unknown[]) => warnings.push(args.map(String).join(' '))),
        error: vi.fn(),
      };
      const event = createEvent({ channel: 'D67890', user: 'U99999', text: 'hi' });

      await handleInboundMessage(
        event,
        client,
        relay,
        'UBOTID',
        callbacks,
        state,
        logger,
        'none',
        undefined,
        undefined,
        {
          dmPolicy: 'allowlist',
          dmAllowlist: [],
        }
      );

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('U99999');
      expect(warnings[0]).toContain('DM Allowlist');
      expect(warnings[0]).toContain('the allowlist is empty');
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
        state,
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
        state,
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
