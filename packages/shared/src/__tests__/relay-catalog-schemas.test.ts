import { describe, it, expect } from 'vitest';
import {
  ConfigFieldTypeSchema,
  ConfigFieldSchema,
  AdapterManifestSchema,
  AdapterCategorySchema,
  CatalogEntrySchema,
  AdapterSetupStepSchema,
  ConfigFieldOptionSchema,
} from '../relay-schemas.js';

// === Fixtures ===

const telegramManifest = {
  type: 'telegram',
  displayName: 'Telegram',
  description: 'Send and receive messages via a Telegram bot.',
  iconEmoji: '✈️',
  category: 'messaging' as const,
  docsUrl: 'https://core.telegram.org/bots',
  builtin: true,
  multiInstance: false,
  configFields: [
    {
      key: 'token',
      label: 'Bot Token',
      type: 'password',
      required: true,
      placeholder: '123456789:ABCDefGHijklMNOpqrSTUvwxYZ',
      description: 'Token from @BotFather on Telegram.',
    },
    {
      key: 'mode',
      label: 'Receiving Mode',
      type: 'select',
      required: true,
      default: 'polling',
      options: [
        { label: 'Long Polling', value: 'polling' },
        { label: 'Webhook', value: 'webhook' },
      ],
      description: 'Polling requires no public URL.',
    },
    {
      key: 'webhookUrl',
      label: 'Webhook URL',
      type: 'url',
      required: true,
      placeholder: 'https://your-domain.com/relay/webhooks/telegram',
      showWhen: { field: 'mode', equals: 'webhook' },
    },
  ],
  setupInstructions: 'Open Telegram and search for @BotFather.',
};

const webhookManifest = {
  type: 'webhook',
  displayName: 'Webhook',
  description: 'Send and receive messages via HMAC-signed HTTP webhooks.',
  iconEmoji: '🔗',
  category: 'automation' as const,
  builtin: true,
  multiInstance: true,
  configFields: [
    {
      key: 'inbound.subject',
      label: 'Inbound Subject',
      type: 'text',
      required: true,
      section: 'Inbound',
    },
    {
      key: 'outbound.url',
      label: 'Outbound URL',
      type: 'url',
      required: true,
      section: 'Outbound',
    },
  ],
};

const claudeCodeManifest = {
  type: 'claude-code',
  displayName: 'Claude Code',
  description: 'Routes messages to Claude Agent SDK sessions.',
  iconEmoji: '🤖',
  category: 'internal' as const,
  builtin: true,
  multiInstance: false,
  configFields: [
    {
      key: 'maxConcurrent',
      label: 'Max Concurrent Sessions',
      type: 'number',
      required: false,
      default: 3,
    },
  ],
};

// === Tests ===

describe('ConfigFieldTypeSchema', () => {
  it('accepts all valid field types', () => {
    const validTypes = ['text', 'password', 'number', 'boolean', 'select', 'textarea', 'url'];
    for (const type of validTypes) {
      expect(ConfigFieldTypeSchema.safeParse(type).success).toBe(true);
    }
  });

  it('rejects invalid field types', () => {
    expect(ConfigFieldTypeSchema.safeParse('dropdown').success).toBe(false);
    expect(ConfigFieldTypeSchema.safeParse('').success).toBe(false);
  });
});

describe('ConfigFieldOptionSchema', () => {
  it('accepts valid option', () => {
    const result = ConfigFieldOptionSchema.safeParse({ label: 'Polling', value: 'polling' });
    expect(result.success).toBe(true);
  });

  it('rejects option missing label', () => {
    const result = ConfigFieldOptionSchema.safeParse({ value: 'polling' });
    expect(result.success).toBe(false);
  });
});

describe('ConfigFieldSchema', () => {
  it('accepts a minimal config field', () => {
    const result = ConfigFieldSchema.safeParse({
      key: 'token',
      label: 'API Token',
      type: 'text',
      required: true,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a config field with all optional fields', () => {
    const result = ConfigFieldSchema.safeParse({
      key: 'mode',
      label: 'Mode',
      type: 'select',
      required: true,
      default: 'polling',
      placeholder: 'Choose mode',
      description: 'Select the operating mode.',
      options: [
        { label: 'Polling', value: 'polling' },
        { label: 'Webhook', value: 'webhook' },
      ],
      section: 'Connection',
      showWhen: { field: 'advanced', equals: true },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.showWhen).toEqual({ field: 'advanced', equals: true });
      expect(result.data.options).toHaveLength(2);
      expect(result.data.section).toBe('Connection');
      expect(result.data.default).toBe('polling');
    }
  });

  it('accepts numeric default value', () => {
    const result = ConfigFieldSchema.safeParse({
      key: 'port',
      label: 'Port',
      type: 'number',
      required: false,
      default: 8443,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.default).toBe(8443);
    }
  });

  it('accepts boolean default value', () => {
    const result = ConfigFieldSchema.safeParse({
      key: 'verbose',
      label: 'Verbose',
      type: 'boolean',
      required: false,
      default: false,
    });
    expect(result.success).toBe(true);
  });

  it('rejects field missing required key', () => {
    const result = ConfigFieldSchema.safeParse({
      label: 'Token',
      type: 'text',
      required: true,
    });
    expect(result.success).toBe(false);
  });

  it('rejects field with invalid type', () => {
    const result = ConfigFieldSchema.safeParse({
      key: 'token',
      label: 'Token',
      type: 'dropdown',
      required: true,
    });
    expect(result.success).toBe(false);
  });

  it('accepts field without showWhen', () => {
    const result = ConfigFieldSchema.safeParse({
      key: 'token',
      label: 'Token',
      type: 'text',
      required: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.showWhen).toBeUndefined();
    }
  });

  it('accepts field without options', () => {
    const result = ConfigFieldSchema.safeParse({
      key: 'url',
      label: 'URL',
      type: 'url',
      required: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.options).toBeUndefined();
    }
  });
});

describe('AdapterSetupStepSchema', () => {
  it('accepts valid setup step', () => {
    const result = AdapterSetupStepSchema.safeParse({
      stepId: 'create-bot',
      title: 'Create Bot',
      description: 'Create a new bot via BotFather.',
      fields: ['token'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts step without description', () => {
    const result = AdapterSetupStepSchema.safeParse({
      stepId: 'configure',
      title: 'Configure',
      fields: ['mode', 'webhookUrl'],
    });
    expect(result.success).toBe(true);
  });
});

describe('AdapterCategorySchema', () => {
  it('accepts all valid categories', () => {
    const categories = ['messaging', 'automation', 'internal', 'custom'];
    for (const cat of categories) {
      expect(AdapterCategorySchema.safeParse(cat).success).toBe(true);
    }
  });

  it('rejects invalid category', () => {
    expect(AdapterCategorySchema.safeParse('social').success).toBe(false);
  });
});

describe('AdapterManifestSchema', () => {
  it('parses Telegram manifest successfully', () => {
    const result = AdapterManifestSchema.safeParse(telegramManifest);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('telegram');
      expect(result.data.category).toBe('messaging');
      expect(result.data.configFields).toHaveLength(3);
    }
  });

  it('parses Webhook manifest successfully', () => {
    const result = AdapterManifestSchema.safeParse(webhookManifest);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('webhook');
      expect(result.data.multiInstance).toBe(true);
    }
  });

  it('parses ClaudeCode manifest successfully', () => {
    const result = AdapterManifestSchema.safeParse(claudeCodeManifest);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('claude-code');
      expect(result.data.category).toBe('internal');
    }
  });

  it('defaults multiInstance to false when omitted', () => {
    const manifest = {
      type: 'custom',
      displayName: 'Custom',
      description: 'A custom adapter.',
      category: 'custom',
      builtin: false,
      configFields: [],
    };
    const result = AdapterManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.multiInstance).toBe(false);
    }
  });

  it('rejects manifest missing displayName', () => {
    const { displayName: _, ...invalid } = telegramManifest;
    const result = AdapterManifestSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects manifest missing description', () => {
    const { description: _, ...invalid } = telegramManifest;
    const result = AdapterManifestSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects manifest missing configFields', () => {
    const { configFields: _, ...invalid } = telegramManifest;
    const result = AdapterManifestSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects manifest missing builtin', () => {
    const { builtin: _, ...invalid } = telegramManifest;
    const result = AdapterManifestSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects manifest with invalid category', () => {
    const result = AdapterManifestSchema.safeParse({
      ...telegramManifest,
      category: 'social',
    });
    expect(result.success).toBe(false);
  });

  it('rejects manifest with invalid docsUrl', () => {
    const result = AdapterManifestSchema.safeParse({
      ...telegramManifest,
      docsUrl: 'not-a-url',
    });
    expect(result.success).toBe(false);
  });

  it('accepts manifest with setupSteps', () => {
    const result = AdapterManifestSchema.safeParse({
      ...telegramManifest,
      setupSteps: [
        {
          stepId: 'create-bot',
          title: 'Create Bot',
          fields: ['token'],
        },
        {
          stepId: 'configure',
          title: 'Configure Mode',
          fields: ['mode', 'webhookUrl', 'webhookPort'],
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.setupSteps).toHaveLength(2);
    }
  });
});

describe('CatalogEntrySchema', () => {
  it('parses a catalog entry with instances', () => {
    const result = CatalogEntrySchema.safeParse({
      manifest: claudeCodeManifest,
      instances: [
        {
          id: 'claude-code-1',
          enabled: true,
          status: {
            id: 'claude-code-1',
            type: 'claude-code',
            displayName: 'Claude Code',
            state: 'connected',
            messageCount: { inbound: 10, outbound: 5 },
            errorCount: 0,
          },
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.instances).toHaveLength(1);
      expect(result.data.instances[0].status.state).toBe('connected');
    }
  });

  it('parses a catalog entry with no instances', () => {
    const result = CatalogEntrySchema.safeParse({
      manifest: webhookManifest,
      instances: [],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.instances).toHaveLength(0);
    }
  });
});
