import { describe, it, expect } from 'vitest';
import {
  ConfigFieldSchema,
  AdapterManifestSchema,
  SlackAdapterConfigSchema,
} from '../relay-adapter-schemas.js';

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

  it('accepts config without typingIndicator field (defaults to none)', () => {
    const result = SlackAdapterConfigSchema.safeParse(baseConfig);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.typingIndicator).toBe('none');
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
