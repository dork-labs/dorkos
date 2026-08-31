import { describe, it, expect } from 'vitest';
import {
  AdapterBindingSchema,
  AdapterSecretSchema,
  ConfigFieldSchema,
  AdapterManifestSchema,
  SlackAdapterConfigSchema,
  TelegramAdapterConfigSchema,
  DEFAULT_RESPOND_MODE,
  CreateBindingRequestSchema,
  UpdateBindingRequestSchema,
  bridgeAllowsChatId,
  BRIDGE_REQUIRES_CHAT_ID_MESSAGE,
  TelegramMediaDescriptorSchema,
  TelegramPlatformDataSchema,
} from '../relay-adapter-schemas.js';

describe('AdapterSecretSchema — credential references (DOR-280)', () => {
  it('accepts a keychain: credential reference (the at-rest form)', () => {
    expect(AdapterSecretSchema.safeParse('keychain:relay-adapter-telegram-1-token').success).toBe(
      true
    );
  });

  it('accepts env: and file: credential references', () => {
    expect(AdapterSecretSchema.safeParse('env:TELEGRAM_BOT_TOKEN').success).toBe(true);
    expect(AdapterSecretSchema.safeParse('file:relay-adapter-slack-1-botToken').success).toBe(true);
  });

  it('still accepts a raw pasted token (in-transit / legacy form) so migration never breaks a bound bot', () => {
    expect(AdapterSecretSchema.safeParse('123456789:ABCdef-raw-telegram-token').success).toBe(true);
  });

  it('rejects an empty secret', () => {
    expect(AdapterSecretSchema.safeParse('').success).toBe(false);
  });
});

describe('TelegramAdapterConfigSchema — token as credential reference', () => {
  it('accepts a file: reference for the bot token', () => {
    const result = TelegramAdapterConfigSchema.safeParse({
      token: 'file:relay-adapter-telegram-1-token',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a raw pasted bot token', () => {
    const result = TelegramAdapterConfigSchema.safeParse({ token: '123:ABC' });
    expect(result.success).toBe(true);
  });

  it('rejects an empty token', () => {
    const result = TelegramAdapterConfigSchema.safeParse({ token: '' });
    expect(result.success).toBe(false);
  });
});

describe('TelegramAdapterConfigSchema — group respond mode (DOR-619)', () => {
  it('defaults respondMode to thread-aware, so a new bot does not answer every group message', () => {
    const result = TelegramAdapterConfigSchema.safeParse({ token: '123:ABC' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.respondMode).toBe('thread-aware');
    }
  });

  it('accepts every respond mode', () => {
    for (const mode of ['always', 'mention-only', 'thread-aware'] as const) {
      const result = TelegramAdapterConfigSchema.safeParse({ token: '123:ABC', respondMode: mode });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.respondMode).toBe(mode);
      }
    }
  });

  it('rejects an unknown respond mode', () => {
    const result = TelegramAdapterConfigSchema.safeParse({
      token: '123:ABC',
      respondMode: 'never',
    });
    expect(result.success).toBe(false);
  });
});

describe('DEFAULT_RESPOND_MODE — one place the default is stated (DOR-623)', () => {
  it('is what both adapter schemas resolve an absent respondMode to', () => {
    const slack = SlackAdapterConfigSchema.safeParse({
      botToken: 'xoxb-1',
      appToken: 'xapp-1',
      signingSecret: 'secret',
    });
    const telegram = TelegramAdapterConfigSchema.safeParse({ token: '123:ABC' });

    expect(slack.success && slack.data.respondMode).toBe(DEFAULT_RESPOND_MODE);
    expect(telegram.success && telegram.data.respondMode).toBe(DEFAULT_RESPOND_MODE);
  });
});

describe('AdapterBindingSchema', () => {
  const baseBinding = {
    id: '00000000-0000-0000-0000-000000000000',
    adapterId: 'telegram-bot-1',
    agentId: '01ABC123',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it('rejects empty agentId', () => {
    const result = AdapterBindingSchema.safeParse({
      ...baseBinding,
      agentId: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty adapterId', () => {
    const result = AdapterBindingSchema.safeParse({
      ...baseBinding,
      adapterId: '',
    });
    expect(result.success).toBe(false);
  });

  it('accepts valid non-empty IDs', () => {
    const result = AdapterBindingSchema.safeParse(baseBinding);
    expect(result.success).toBe(true);
  });
});

describe('AdapterBindingSchema — enabled field', () => {
  const baseBinding = {
    id: '00000000-0000-0000-0000-000000000000',
    adapterId: 'telegram-bot-1',
    agentId: '01ABC123',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it('defaults enabled to true when not provided', () => {
    const result = AdapterBindingSchema.safeParse(baseBinding);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
    }
  });

  it('round-trips enabled: false', () => {
    const result = AdapterBindingSchema.safeParse({
      ...baseBinding,
      enabled: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(false);
    }
  });

  it('round-trips enabled: true', () => {
    const result = AdapterBindingSchema.safeParse({
      ...baseBinding,
      enabled: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
    }
  });

  it('rejects non-boolean enabled value', () => {
    const result = AdapterBindingSchema.safeParse({
      ...baseBinding,
      enabled: 'yes',
    });
    expect(result.success).toBe(false);
  });
});

describe('AdapterBindingSchema — bridge field (chats-as-channels spec §3.1)', () => {
  const baseBinding = {
    id: '00000000-0000-0000-0000-000000000000',
    adapterId: 'telegram-bot-1',
    agentId: '01ABC123',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it('defaults bridge to off and roomId to null when absent (A11.2)', () => {
    const result = AdapterBindingSchema.safeParse(baseBinding);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.bridge).toBe('off');
      expect(result.data.roomId).toBeNull();
    }
  });

  it('parses a fixture written before this field existed, defaulting to off and routing as before (A11.2)', () => {
    // A binding persisted by a build that predates `bridge`/`roomId` entirely —
    // no such keys on disk at all, not merely `undefined`.
    const legacyFixture = {
      id: '11111111-1111-4111-8111-111111111111',
      adapterId: 'telegram-bot-1',
      agentId: '01ABC123',
      chatId: '555',
      sessionStrategy: 'per-chat',
      label: 'Support',
      permissionMode: 'acceptEdits',
      enabled: true,
      canInitiate: false,
      canReply: true,
      canReceive: true,
      notifyOnTaskComplete: true,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    };
    const result = AdapterBindingSchema.safeParse(legacyFixture);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.bridge).toBe('off');
      expect(result.data.roomId).toBeNull();
      // Every field the legacy fixture actually set survives untouched —
      // "routes exactly as before" means nothing else moved.
      expect(result.data.chatId).toBe('555');
      expect(result.data.canReply).toBe(true);
    }
  });

  it('accepts bridge: room when chatId is present', () => {
    const result = AdapterBindingSchema.safeParse({
      ...baseBinding,
      chatId: '12345',
      bridge: 'room',
      roomId: 'room-1',
    });
    expect(result.success).toBe(true);
  });

  it('rejects bridge: room with no chatId, naming the wildcard reason (A3.5)', () => {
    const result = AdapterBindingSchema.safeParse({
      ...baseBinding,
      bridge: 'room',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message);
      expect(messages).toContain(BRIDGE_REQUIRES_CHAT_ID_MESSAGE);
      expect(result.error.issues.some((issue) => issue.path.includes('chatId'))).toBe(true);
    }
  });

  it('rejects an unknown bridge value', () => {
    const result = AdapterBindingSchema.safeParse({
      ...baseBinding,
      chatId: '12345',
      bridge: 'always',
    });
    expect(result.success).toBe(false);
  });

  it('CreateBindingRequestSchema rejects bridge: room with no chatId the same way (A3.5)', () => {
    const result = CreateBindingRequestSchema.safeParse({
      adapterId: 'telegram-bot-1',
      agentId: '01ABC123',
      bridge: 'room',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toContain(
        BRIDGE_REQUIRES_CHAT_ID_MESSAGE
      );
    }
  });

  it('CreateBindingRequestSchema accepts bridge: room with a chatId', () => {
    const result = CreateBindingRequestSchema.safeParse({
      adapterId: 'telegram-bot-1',
      agentId: '01ABC123',
      chatId: '12345',
      bridge: 'room',
    });
    expect(result.success).toBe(true);
  });

  it('UpdateBindingRequestSchema accepts bridge and roomId as partial fields, unrefined', () => {
    // A PATCH body is partial by design (spec §3.1's note on
    // `UpdateBindingRequestSchema`): setting `bridge` alone, with no `chatId`
    // resent, must parse — the merged-state check is the route's job, not the
    // schema's, because the schema never sees the binding's existing chatId.
    const result = UpdateBindingRequestSchema.safeParse({ bridge: 'room' });
    expect(result.success).toBe(true);
  });

  it('UpdateBindingRequestSchema accepts roomId: null to clear a bridge', () => {
    const result = UpdateBindingRequestSchema.safeParse({ bridge: 'off', roomId: null });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.roomId).toBeNull();
    }
  });
});

describe('bridgeAllowsChatId — the merged-state predicate the PATCH route uses', () => {
  it('allows bridge: off regardless of chatId', () => {
    expect(bridgeAllowsChatId({ bridge: 'off' })).toBe(true);
    expect(bridgeAllowsChatId({ bridge: 'off', chatId: '' })).toBe(true);
  });

  it('allows bridge: room with a non-empty chatId', () => {
    expect(bridgeAllowsChatId({ bridge: 'room', chatId: '12345' })).toBe(true);
  });

  it('rejects bridge: room with no chatId, an empty chatId, or a null chatId', () => {
    expect(bridgeAllowsChatId({ bridge: 'room' })).toBe(false);
    expect(bridgeAllowsChatId({ bridge: 'room', chatId: '' })).toBe(false);
    expect(bridgeAllowsChatId({ bridge: 'room', chatId: null })).toBe(false);
  });
});

describe('ConfigFieldSchema', () => {
  const baseField = {
    key: 'token',
    label: 'Bot Token',
    type: 'password' as const,
    required: true,
  };

  it('accepts field without helpMarkdown (backward compat)', () => {
    const result = ConfigFieldSchema.safeParse(baseField);
    expect(result.success).toBe(true);
  });

  it('accepts field with helpMarkdown string', () => {
    const result = ConfigFieldSchema.safeParse({
      ...baseField,
      helpMarkdown: '1. Go to **Settings**\n2. Copy the token',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.helpMarkdown).toBe('1. Go to **Settings**\n2. Copy the token');
    }
  });

  it('rejects non-string helpMarkdown', () => {
    const result = ConfigFieldSchema.safeParse({
      ...baseField,
      helpMarkdown: 42,
    });
    expect(result.success).toBe(false);
  });
});

describe('SlackAdapterConfigSchema', () => {
  const baseConfig = {
    botToken: 'xoxb-test',
    appToken: 'xapp-test',
    signingSecret: 'secret123',
  };

  it('accepts config without streaming field (defaults to true)', () => {
    const result = SlackAdapterConfigSchema.safeParse(baseConfig);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.streaming).toBe(true);
    }
  });

  it('accepts config with streaming set to false', () => {
    const result = SlackAdapterConfigSchema.safeParse({
      ...baseConfig,
      streaming: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.streaming).toBe(false);
    }
  });

  it('accepts config with streaming set to true', () => {
    const result = SlackAdapterConfigSchema.safeParse({
      ...baseConfig,
      streaming: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.streaming).toBe(true);
    }
  });

  it('rejects non-boolean streaming value', () => {
    const result = SlackAdapterConfigSchema.safeParse({
      ...baseConfig,
      streaming: 'yes',
    });
    expect(result.success).toBe(false);
  });

  it('accepts config without typingIndicator field (defaults to reaction)', () => {
    const result = SlackAdapterConfigSchema.safeParse(baseConfig);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.typingIndicator).toBe('reaction');
    }
  });

  it('accepts config with typingIndicator set to reaction', () => {
    const result = SlackAdapterConfigSchema.safeParse({
      ...baseConfig,
      typingIndicator: 'reaction',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.typingIndicator).toBe('reaction');
    }
  });

  it('accepts config with typingIndicator set to none', () => {
    const result = SlackAdapterConfigSchema.safeParse({
      ...baseConfig,
      typingIndicator: 'none',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.typingIndicator).toBe('none');
    }
  });

  it('rejects invalid typingIndicator value', () => {
    const result = SlackAdapterConfigSchema.safeParse({
      ...baseConfig,
      typingIndicator: 'emoji',
    });
    expect(result.success).toBe(false);
  });

  it('defaults respondMode to thread-aware', () => {
    const result = SlackAdapterConfigSchema.safeParse(baseConfig);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.respondMode).toBe('thread-aware');
    }
  });

  it('accepts explicit respondMode values', () => {
    for (const mode of ['always', 'mention-only', 'thread-aware'] as const) {
      const result = SlackAdapterConfigSchema.safeParse({ ...baseConfig, respondMode: mode });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.respondMode).toBe(mode);
      }
    }
  });

  it('rejects invalid respondMode value', () => {
    const result = SlackAdapterConfigSchema.safeParse({
      ...baseConfig,
      respondMode: 'never',
    });
    expect(result.success).toBe(false);
  });

  // DOR-604: a DM starts an agent turn on the operator's machine, so an
  // unconfigured integration answers nobody rather than the whole workspace.
  it('defaults dmPolicy to allowlist', () => {
    const result = SlackAdapterConfigSchema.safeParse(baseConfig);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dmPolicy).toBe('allowlist');
    }
  });

  it('defaults dmAllowlist to empty array', () => {
    const result = SlackAdapterConfigSchema.safeParse(baseConfig);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dmAllowlist).toEqual([]);
    }
  });

  it('accepts dmAllowlist with user IDs', () => {
    const result = SlackAdapterConfigSchema.safeParse({
      ...baseConfig,
      dmPolicy: 'allowlist',
      dmAllowlist: ['U12345', 'U67890'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dmAllowlist).toEqual(['U12345', 'U67890']);
    }
  });

  it('defaults channelOverrides to empty object', () => {
    const result = SlackAdapterConfigSchema.safeParse(baseConfig);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.channelOverrides).toEqual({});
    }
  });

  it('accepts channelOverrides with per-channel config', () => {
    const result = SlackAdapterConfigSchema.safeParse({
      ...baseConfig,
      channelOverrides: {
        C12345: { enabled: true, respondMode: 'always' },
        C67890: { enabled: false },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.channelOverrides).toEqual({
        C12345: { enabled: true, respondMode: 'always' },
        C67890: { enabled: false },
      });
    }
  });

  it('rejects invalid respondMode in channelOverrides', () => {
    const result = SlackAdapterConfigSchema.safeParse({
      ...baseConfig,
      channelOverrides: {
        C12345: { respondMode: 'invalid' },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects (not silently empties) an unknown key inside a channelOverrides entry (DOR-655)', () => {
    const result = SlackAdapterConfigSchema.safeParse({
      ...baseConfig,
      channelOverrides: {
        C01ABC: { bogusKey: 1 },
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      // Names the offending key rather than failing generically, and must not
      // be confused with the sibling "stored as {}" outcome this pins against.
      expect(JSON.stringify(result.error.issues)).toContain('bogusKey');
    }
  });

  it('preserves backward compatibility with explicit old config', () => {
    const result = SlackAdapterConfigSchema.safeParse({
      ...baseConfig,
      streaming: true,
      nativeStreaming: true,
      typingIndicator: 'none',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.typingIndicator).toBe('none');
      expect(result.data.respondMode).toBe('thread-aware');
      expect(result.data.dmPolicy).toBe('allowlist');
      expect(result.data.dmAllowlist).toEqual([]);
      expect(result.data.channelOverrides).toEqual({});
    }
  });
});

describe('AdapterManifestSchema', () => {
  const baseManifest = {
    type: 'test',
    displayName: 'Test Adapter',
    description: 'A test adapter.',
    category: 'messaging' as const,
    builtin: true,
    configFields: [
      {
        key: 'token',
        label: 'Token',
        type: 'password' as const,
        required: true,
      },
    ],
  };

  it('accepts manifest without setupGuide (backward compat)', () => {
    const result = AdapterManifestSchema.safeParse(baseManifest);
    expect(result.success).toBe(true);
  });

  it('accepts manifest with setupGuide string', () => {
    const result = AdapterManifestSchema.safeParse({
      ...baseManifest,
      setupGuide: '# Quick Start\n\nFollow these steps...',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.setupGuide).toBe('# Quick Start\n\nFollow these steps...');
    }
  });

  it('rejects non-string setupGuide', () => {
    const result = AdapterManifestSchema.safeParse({
      ...baseManifest,
      setupGuide: 123,
    });
    expect(result.success).toBe(false);
  });
});

describe('TelegramMediaDescriptorSchema (spec chats-as-channels §5.5, §11.2)', () => {
  it('round-trips a bare descriptor with only the required type', () => {
    const parsed = TelegramMediaDescriptorSchema.parse({ type: 'sticker' });
    expect(parsed).toEqual({ type: 'sticker' });
  });

  it('round-trips a descriptor carrying every optional field', () => {
    const input = {
      type: 'voice' as const,
      durationSec: 14,
      fileName: 'note.ogg',
      mimeType: 'audio/ogg',
    };
    expect(TelegramMediaDescriptorSchema.parse(input)).toEqual(input);
  });

  it('accepts every media kind §5.5 names', () => {
    for (const type of ['photo', 'sticker', 'voice', 'document', 'video', 'location']) {
      expect(TelegramMediaDescriptorSchema.safeParse({ type }).success).toBe(true);
    }
  });

  it('accepts audio and video_note, added beyond §5.5 for the same property', () => {
    expect(TelegramMediaDescriptorSchema.safeParse({ type: 'audio' }).success).toBe(true);
    expect(TelegramMediaDescriptorSchema.safeParse({ type: 'video_note' }).success).toBe(true);
  });

  it('rejects a media kind outside the named six — proves the enum is closed, not permissive', () => {
    // The negative control: without this, an enum that accidentally became
    // `z.string()` would pass every positive case above too.
    expect(TelegramMediaDescriptorSchema.safeParse({ type: 'poll' }).success).toBe(false);
  });

  it('rejects a descriptor missing its required type', () => {
    expect(TelegramMediaDescriptorSchema.safeParse({ durationSec: 5 }).success).toBe(false);
  });
});

describe('TelegramPlatformDataSchema (spec chats-as-channels §11.2)', () => {
  const baseline = {
    chatId: -100111222,
    messageId: 42,
    chatType: 'group',
    fromId: 12345,
    username: 'alice',
  };

  it('parses a payload predating the four additive fields, defaulting them to absent', () => {
    // A5.7/A5.10/A11.2's shape: a fixture that predates this change must
    // still parse, with the new fields simply undefined rather than required.
    const result = TelegramPlatformDataSchema.safeParse(baseline);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.replyToMessageId).toBeUndefined();
      expect(result.data.messageThreadId).toBeUndefined();
      expect(result.data.threadName).toBeUndefined();
      expect(result.data.media).toBeUndefined();
    }
  });

  it('round-trips every additive field together', () => {
    const withAdditions = {
      ...baseline,
      replyToMessageId: 41,
      messageThreadId: 99,
      threadName: 'Bug Reports',
      media: { type: 'document' as const, fileName: 'report.pdf', mimeType: 'application/pdf' },
    };
    expect(TelegramPlatformDataSchema.parse(withAdditions)).toEqual(withAdditions);
  });

  it('rejects a payload missing a required base field (chatId) — the additions do not loosen the base', () => {
    const { chatId: _chatId, ...withoutChatId } = baseline;
    expect(TelegramPlatformDataSchema.safeParse(withoutChatId).success).toBe(false);
  });

  it('rejects a malformed nested media descriptor rather than silently dropping it', () => {
    const result = TelegramPlatformDataSchema.safeParse({
      ...baseline,
      media: { type: 'not-a-real-kind' },
    });
    expect(result.success).toBe(false);
  });
});
