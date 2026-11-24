import { describe, it, expect } from 'vitest';
import {
  AdapterBindingSchema,
  WebhookInboundConfigSchema,
  AdapterSecretSchema,
  SlackAdapterConfigSchema,
  TelegramAdapterConfigSchema,
  DEFAULT_RESPOND_MODE,
  CreateBindingRequestSchema,
  bridgeAllowsChatId,
  BRIDGE_REQUIRES_CHAT_ID_MESSAGE,
  TelegramMediaDescriptorSchema,
  TelegramPlatformDataSchema,
} from '../relay-adapter-schemas.js';
import { UpdateBindingRequestSchema } from '../relay-adapter-schemas.js';

describe('AdapterSecretSchema — credential references (DOR-280)', () => {
  it('accepts a keychain: credential reference (the at-rest form)', () => {
    expect(AdapterSecretSchema.safeParse('keychain:relay-adapter-telegram-1-token').success).toBe(
      true
    );
  });

  it('still accepts a raw pasted token (in-transit / legacy form) so migration never breaks a bound bot', () => {
    expect(AdapterSecretSchema.safeParse('123456789:ABCdef-raw-telegram-token').success).toBe(true);
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

describe('AdapterBindingSchema — bridge field (chats-as-channels spec §3.1)', () => {
  const baseBinding = {
    id: '00000000-0000-0000-0000-000000000000',
    adapterId: 'telegram-bot-1',
    agentId: '01ABC123',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

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

  it.each([
    { name: 'AdapterBindingSchema', schema: AdapterBindingSchema },
    { name: 'CreateBindingRequestSchema', schema: CreateBindingRequestSchema },
  ])('$name rejects a present undefined chatId for a room bridge', ({ schema }) => {
    const result = schema.safeParse({ ...baseBinding, bridge: 'room', chatId: undefined });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual([
        expect.objectContaining({ message: BRIDGE_REQUIRES_CHAT_ID_MESSAGE, path: ['chatId'] }),
      ]);
    }
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
  it('rejects bridge: room with no chatId, an empty chatId, or a null chatId', () => {
    expect(bridgeAllowsChatId({ bridge: 'room' })).toBe(false);
    expect(bridgeAllowsChatId({ bridge: 'room', chatId: '' })).toBe(false);
    expect(bridgeAllowsChatId({ bridge: 'room', chatId: null })).toBe(false);
    expect(bridgeAllowsChatId({ bridge: 'room', chatId: undefined })).toBe(false);
  });
});

describe('SlackAdapterConfigSchema', () => {
  const baseConfig = {
    botToken: 'xoxb-test',
    appToken: 'xapp-test',
    signingSecret: 'secret123',
  };

  // DOR-604: a DM starts an agent turn on the operator's machine, so an
  // unconfigured integration answers nobody rather than the whole workspace.
  it('defaults dmPolicy to allowlist', () => {
    const result = SlackAdapterConfigSchema.safeParse(baseConfig);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dmPolicy).toBe('allowlist');
    }
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

describe('TelegramMediaDescriptorSchema (spec chats-as-channels §5.5, §11.2)', () => {
  it('rejects a media kind outside the named six — proves the enum is closed, not permissive', () => {
    // The negative control: without this, an enum that accidentally became
    // `z.string()` would pass every positive case above too.
    expect(TelegramMediaDescriptorSchema.safeParse({ type: 'poll' }).success).toBe(false);
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

  it('rejects a malformed nested media descriptor rather than silently dropping it', () => {
    const result = TelegramPlatformDataSchema.safeParse({
      ...baseline,
      media: { type: 'not-a-real-kind' },
    });
    expect(result.success).toBe(false);
  });
});

describe('webhook namespace ownership', () => {
  it.each([
    'relay.agent.codex.session',
    'relay.human.console',
    'relay.inbox.owner',
    'relay.system.tasks.task',
    'relay.control.stop',
    'relay.doc.canvas-hash',
    'relay',
    'relay.webhook',
    'relay.webhook.',
    'relay.webhooks.x',
    'relay.webhook.*',
    'relay.webhook.>',
    'relay.webhook.x..y',
    ' relay.webhook.x',
    'relay.webhook.x ',
    'Relay.webhook.x',
    'relay.webhook.' + Array(15).fill('x').join('.'),
  ])('refuses ownership of %s', (subject) => {
    expect(
      WebhookInboundConfigSchema.safeParse({ subject, secret: 'fixture-secret-at-least16' }).success
    ).toBe(false);
  });
  it.each(['relay.webhook.x', 'relay.webhook.x2', 'relay.webhook.GitHub.alerts_1'])(
    'accepts literal webhook address %s',
    (subject) => {
      expect(
        WebhookInboundConfigSchema.parse({ subject, secret: 'fixture-secret-at-least16' }).subject
      ).toBe(subject);
    }
  );
});
