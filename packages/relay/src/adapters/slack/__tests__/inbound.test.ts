import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildSubject,
  extractChannelId,
  handleInboundMessage,
  clearCaches,
  SUBJECT_PREFIX,
  MAX_CONTENT_LENGTH,
} from '../inbound.js';
import type { SlackMessageEvent } from '../inbound.js';
import type { WebClient } from '@slack/web-api';
import type { AdapterInboundCallbacks } from '../../../types.js';
import type { RelayPublisher } from '../../../types.js';

function createMockRelay(): RelayPublisher {
  return {
    publish: vi.fn().mockResolvedValue({ messageId: 'msg-1', deliveredTo: 1 }),
    onSignal: vi.fn().mockReturnValue(() => {}),
  };
}

function createMockClient(): WebClient {
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
  } as unknown as WebClient;
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
    expect(buildSubject('D12345', false)).toBe('relay.human.slack.D12345');
  });

  it('returns group subject for group channel', () => {
    expect(buildSubject('C12345', true)).toBe('relay.human.slack.group.C12345');
  });
});

describe('extractChannelId', () => {
  it('extracts channel ID from DM subject', () => {
    expect(extractChannelId('relay.human.slack.D12345')).toBe('D12345');
  });

  it('extracts channel ID from group subject', () => {
    expect(extractChannelId('relay.human.slack.group.C12345')).toBe('C12345');
  });

  it('returns null for non-slack subject', () => {
    expect(extractChannelId('relay.human.telegram.12345')).toBeNull();
  });

  it('returns null for empty remainder', () => {
    expect(extractChannelId('relay.human.slack')).toBeNull();
  });

  it('returns null for empty group suffix', () => {
    expect(extractChannelId('relay.human.slack.group.')).toBeNull();
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
      { from: 'relay.human.slack.bot', replyTo: 'relay.human.slack.D67890' },
    );
  });

  it('publishes group message with group segment', async () => {
    const event = createEvent({ channel: 'C12345' });
    await handleInboundMessage(event, client, relay, 'UBOTID', callbacks);

    expect(relay.publish).toHaveBeenCalledWith(
      'relay.human.slack.group.C12345',
      expect.objectContaining({ channelType: 'group' }),
      expect.any(Object),
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
      expect.any(Object),
    );
  });

  it('records error when publish fails without throwing', async () => {
    (relay.publish as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('fail'));
    const event = createEvent();
    await expect(
      handleInboundMessage(event, client, relay, 'UBOTID', callbacks),
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
      expect.objectContaining({ from: `${SUBJECT_PREFIX}.bot` }),
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
});
