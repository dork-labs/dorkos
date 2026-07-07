import { describe, it, expect } from 'vitest';
import { TelegramThreadIdCodec, SlackThreadIdCodec } from '../thread-id.js';
import type { ThreadIdCodec } from '../thread-id.js';

// === TelegramThreadIdCodec ===

describe('TelegramThreadIdCodec', () => {
  const codec: ThreadIdCodec = new TelegramThreadIdCodec();

  it('has the correct prefix', () => {
    expect(codec.prefix).toBe('relay.human.telegram');
  });

  describe('encode', () => {
    it('encodes a DM subject', () => {
      expect(codec.encode('123456789', 'dm')).toBe('relay.human.telegram.123456789');
    });

    it('encodes a group subject', () => {
      expect(codec.encode('-100987654321', 'group')).toBe(
        'relay.human.telegram.group.-100987654321'
      );
    });
  });

  describe('decode', () => {
    it('decodes a DM subject', () => {
      expect(codec.decode('relay.human.telegram.123456789')).toEqual({
        platformId: '123456789',
        channelType: 'dm',
      });
    });

    it('decodes a group subject', () => {
      expect(codec.decode('relay.human.telegram.group.-100987654321')).toEqual({
        platformId: '-100987654321',
        channelType: 'group',
      });
    });

    it('returns null for a non-matching prefix', () => {
      expect(codec.decode('relay.human.slack.123456789')).toBeNull();
    });

    it('returns null for a prefix-only subject with no chat ID', () => {
      expect(codec.decode('relay.human.telegram')).toBeNull();
    });

    it('returns null for a group prefix with no ID', () => {
      expect(codec.decode('relay.human.telegram.group.')).toBeNull();
    });

    it('returns null for an unrelated subject', () => {
      expect(codec.decode('relay.agent.outbound.some-id')).toBeNull();
    });

    it('round-trips a DM subject', () => {
      const platformId = '42';
      const subject = codec.encode(platformId, 'dm');
      expect(codec.decode(subject)).toEqual({ platformId, channelType: 'dm' });
    });

    it('round-trips a group subject', () => {
      const platformId = '-100123';
      const subject = codec.encode(platformId, 'group');
      expect(codec.decode(subject)).toEqual({ platformId, channelType: 'group' });
    });
  });
});

// === SlackThreadIdCodec ===

describe('SlackThreadIdCodec', () => {
  const codec: ThreadIdCodec = new SlackThreadIdCodec();

  it('has the correct prefix', () => {
    expect(codec.prefix).toBe('relay.human.slack');
  });

  describe('encode', () => {
    it('encodes a DM subject', () => {
      expect(codec.encode('D01234567', 'dm')).toBe('relay.human.slack.D01234567');
    });

    it('encodes a group subject', () => {
      expect(codec.encode('C09876543', 'group')).toBe('relay.human.slack.group.C09876543');
    });
  });

  describe('decode', () => {
    it('decodes a DM subject', () => {
      expect(codec.decode('relay.human.slack.D01234567')).toEqual({
        platformId: 'D01234567',
        channelType: 'dm',
      });
    });

    it('decodes a group subject', () => {
      expect(codec.decode('relay.human.slack.group.C09876543')).toEqual({
        platformId: 'C09876543',
        channelType: 'group',
      });
    });

    it('returns null for a non-matching prefix', () => {
      expect(codec.decode('relay.human.telegram.D01234567')).toBeNull();
    });

    it('returns null for a prefix-only subject with no channel ID', () => {
      expect(codec.decode('relay.human.slack')).toBeNull();
    });

    it('returns null for a group prefix with no ID', () => {
      expect(codec.decode('relay.human.slack.group.')).toBeNull();
    });

    it('returns null for an unrelated subject', () => {
      expect(codec.decode('relay.agent.outbound.some-id')).toBeNull();
    });

    it('round-trips a DM subject', () => {
      const platformId = 'D01234567';
      const subject = codec.encode(platformId, 'dm');
      expect(codec.decode(subject)).toEqual({ platformId, channelType: 'dm' });
    });

    it('round-trips a group subject', () => {
      const platformId = 'C09876543';
      const subject = codec.encode(platformId, 'group');
      expect(codec.decode(subject)).toEqual({ platformId, channelType: 'group' });
    });
  });
});

// === Instance ID support ===

describe('TelegramThreadIdCodec with instanceId', () => {
  const codec = new TelegramThreadIdCodec('bot-alpha');

  it('uses instance-aware prefix', () => {
    expect(codec.prefix).toBe('relay.human.telegram.bot-alpha');
  });

  it('encodes a DM subject with instance ID', () => {
    expect(codec.encode('123', 'dm')).toBe('relay.human.telegram.bot-alpha.123');
  });

  it('encodes a group subject with instance ID', () => {
    expect(codec.encode('-100999', 'group')).toBe('relay.human.telegram.bot-alpha.group.-100999');
  });

  it('round-trips a DM subject', () => {
    const subject = codec.encode('42', 'dm');
    expect(codec.decode(subject)).toEqual({ platformId: '42', channelType: 'dm' });
  });

  it('round-trips a group subject', () => {
    const subject = codec.encode('-100123', 'group');
    expect(codec.decode(subject)).toEqual({ platformId: '-100123', channelType: 'group' });
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

  it('uses instance-aware prefix', () => {
    expect(codec.prefix).toBe('relay.human.slack.workspace-a');
  });

  it('encodes a DM subject with instance ID', () => {
    expect(codec.encode('D999', 'dm')).toBe('relay.human.slack.workspace-a.D999');
  });

  it('encodes a group subject with instance ID', () => {
    expect(codec.encode('C111', 'group')).toBe('relay.human.slack.workspace-a.group.C111');
  });

  it('round-trips a DM subject', () => {
    const subject = codec.encode('D999', 'dm');
    expect(codec.decode(subject)).toEqual({ platformId: 'D999', channelType: 'dm' });
  });

  it('round-trips a group subject', () => {
    const subject = codec.encode('C111', 'group');
    expect(codec.decode(subject)).toEqual({ platformId: 'C111', channelType: 'group' });
  });

  it('does not decode subjects from a different instance', () => {
    const other = new SlackThreadIdCodec('workspace-b');
    const subject = other.encode('D999', 'dm');
    expect(codec.decode(subject)).toBeNull();
  });

  it('does not decode legacy (no-instance) subjects', () => {
    const legacy = new SlackThreadIdCodec();
    const subject = legacy.encode('D999', 'dm');
    expect(codec.decode(subject)).toBeNull();
  });
});

describe('backward compatibility: no instanceId produces legacy format', () => {
  it('TelegramThreadIdCodec without instanceId has legacy prefix', () => {
    const codec = new TelegramThreadIdCodec();
    expect(codec.prefix).toBe('relay.human.telegram');
    expect(codec.encode('123', 'dm')).toBe('relay.human.telegram.123');
  });

  it('SlackThreadIdCodec without instanceId has legacy prefix', () => {
    const codec = new SlackThreadIdCodec();
    expect(codec.prefix).toBe('relay.human.slack');
    expect(codec.encode('D01', 'dm')).toBe('relay.human.slack.D01');
  });
});

// === Prefix isolation ===

describe('Codec prefix isolation', () => {
  const telegram = new TelegramThreadIdCodec();
  const slack = new SlackThreadIdCodec();

  it('each codec has a distinct prefix', () => {
    const prefixes = [telegram.prefix, slack.prefix];
    expect(new Set(prefixes).size).toBe(2);
  });

  it('Telegram codec does not decode Slack subjects', () => {
    expect(telegram.decode(slack.encode('C123', 'dm'))).toBeNull();
  });

  it('Slack codec does not decode Telegram subjects', () => {
    expect(slack.decode(telegram.encode('999', 'dm'))).toBeNull();
  });
});
