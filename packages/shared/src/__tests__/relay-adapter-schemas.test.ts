import { describe, it, expect } from 'vitest';
import {
  AdapterBindingSchema,
  ConfigFieldSchema,
  AdapterManifestSchema,
  SlackAdapterConfigSchema,
} from '../relay-adapter-schemas.js';

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

  it('defaults dmPolicy to open', () => {
    const result = SlackAdapterConfigSchema.safeParse(baseConfig);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dmPolicy).toBe('open');
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
      expect(result.data.dmPolicy).toBe('open');
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
