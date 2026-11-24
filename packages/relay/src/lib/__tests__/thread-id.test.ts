import { describe, it, expect } from 'vitest';
import { TelegramThreadIdCodec, SlackThreadIdCodec } from '../thread-id.js';
import type { ThreadIdCodec } from '../thread-id.js';

// === TelegramThreadIdCodec ===

describe('TelegramThreadIdCodec', () => {
  const codec: ThreadIdCodec = new TelegramThreadIdCodec();

  describe('encode', () => {
    it('encodes a DM subject', () => {
      expect(codec.encode('123456789', 'dm')).toBe('relay.human.telegram.123456789');
    });
  });

  describe('decode', () => {
    it('decodes a DM subject', () => {
      expect(codec.decode('relay.human.telegram.123456789')).toEqual({
        platformId: '123456789',
        channelType: 'dm',
      });
    });

    it('returns null for a non-matching prefix', () => {
      expect(codec.decode('relay.human.slack.123456789')).toBeNull();
    });

    it('round-trips a DM subject', () => {
      const platformId = '42';
      const subject = codec.encode(platformId, 'dm');
      expect(codec.decode(subject)).toEqual({ platformId, channelType: 'dm' });
    });
  });
});

// === SlackThreadIdCodec ===

describe('SlackThreadIdCodec', () => {
  const codec: ThreadIdCodec = new SlackThreadIdCodec();

  describe('encode', () => {
    it('encodes a DM subject', () => {
      expect(codec.encode('D01234567', 'dm')).toBe('relay.human.slack.D01234567');
    });
  });

  describe('decode', () => {
    it('decodes a DM subject', () => {
      expect(codec.decode('relay.human.slack.D01234567')).toEqual({
        platformId: 'D01234567',
        channelType: 'dm',
      });
    });

    it('returns null for a non-matching prefix', () => {
      expect(codec.decode('relay.human.telegram.D01234567')).toBeNull();
    });

    it('round-trips a DM subject', () => {
      const platformId = 'D01234567';
      const subject = codec.encode(platformId, 'dm');
      expect(codec.decode(subject)).toEqual({ platformId, channelType: 'dm' });
    });
  });
});

// === Instance ID support ===

describe('TelegramThreadIdCodec with instanceId', () => {
  const codec = new TelegramThreadIdCodec('bot-alpha');

  it('encodes a DM subject with instance ID', () => {
    expect(codec.encode('123', 'dm')).toBe('relay.human.telegram.bot-alpha.123');
  });

  it('round-trips a DM subject', () => {
    const subject = codec.encode('42', 'dm');
    expect(codec.decode(subject)).toEqual({ platformId: '42', channelType: 'dm' });
  });

  it('does not decode subjects from a different instance', () => {
    const other = new TelegramThreadIdCodec('bot-beta');
    const subject = other.encode('123', 'dm');
    expect(codec.decode(subject)).toBeNull();
  });

  it('does not decode legacy (no-instance) subjects', () => {
    const legacy = new TelegramThreadIdCodec();
    const subject = legacy.encode('123', 'dm');
    expect(codec.decode(subject)).toBeNull();
  });

  it('legacy codec sees instance ID as part of platformId (known overlap)', () => {
    // The legacy prefix `relay.human.telegram` is a leading substring of the
    // instance-aware prefix `relay.human.telegram.bot-alpha`, so the legacy
    // codec will match but treat the instance ID as part of the platform ID.
    // This is expected — consumers should not mix legacy and instance-aware
    // codecs for the same adapter type.
    const legacy = new TelegramThreadIdCodec();
    const subject = codec.encode('123', 'dm');
    expect(legacy.decode(subject)).toEqual({
      platformId: 'bot-alpha.123',
      channelType: 'dm',
    });
  });
});

describe('SlackThreadIdCodec with instanceId', () => {
  const codec = new SlackThreadIdCodec('workspace-a');

  it('round-trips a DM subject', () => {
    const subject = codec.encode('D999', 'dm');
    expect(codec.decode(subject)).toEqual({ platformId: 'D999', channelType: 'dm' });
  });

  it('does not decode subjects from a different instance', () => {
    const other = new SlackThreadIdCodec('workspace-b');
    const subject = other.encode('D999', 'dm');
    expect(codec.decode(subject)).toBeNull();
  });
});

// === Prefix isolation ===

describe('Codec prefix isolation', () => {
  const telegram = new TelegramThreadIdCodec();
  const slack = new SlackThreadIdCodec();

  it('Telegram codec does not decode Slack subjects', () => {
    expect(telegram.decode(slack.encode('C123', 'dm'))).toBeNull();
  });

  it('Slack codec does not decode Telegram subjects', () => {
    expect(slack.decode(telegram.encode('999', 'dm'))).toBeNull();
  });
});
