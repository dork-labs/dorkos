import { describe, it, expect } from 'vitest';
import { ExtensionManifestSchema, SettingDeclarationSchema } from '../manifest-schema.js';

describe('ExtensionManifestSchema', () => {
  // --- Valid manifests ---

  it('parses a complete valid manifest', () => {
    const manifest = {
      id: 'github-prs',
      name: 'GitHub PR Dashboard',
      version: '1.0.0',
      description: 'Shows pending PR reviews',
      author: 'dorkbot',
      minHostVersion: '0.1.0',
      contributions: { 'dashboard.sections': true },
      permissions: ['storage'],
    };
    const result = ExtensionManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
  });

  it('parses a minimal manifest (only required fields)', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'hello-world',
      name: 'Hello World',
      version: '0.1.0',
    });
    expect(result.success).toBe(true);
  });

  it('parses an id with numbers', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'my-plugin-v2',
      name: 'My Plugin V2',
      version: '2.0.0',
    });
    expect(result.success).toBe(true);
  });

  it('parses a single-word lowercase id', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'analytics',
      name: 'Analytics',
      version: '1.0.0',
    });
    expect(result.success).toBe(true);
  });

  // --- Invalid IDs ---

  it('rejects an ID with uppercase letters', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'MyPlugin',
      name: 'My Plugin',
      version: '1.0.0',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an ID with spaces', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'my plugin',
      name: 'My Plugin',
      version: '1.0.0',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty string ID', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: '',
      name: 'No ID',
      version: '1.0.0',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an ID starting with a hyphen', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: '-my-plugin',
      name: 'My Plugin',
      version: '1.0.0',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an ID with special characters', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'my_plugin',
      name: 'My Plugin',
      version: '1.0.0',
    });
    expect(result.success).toBe(false);
  });

  // --- Invalid versions ---

  it('rejects a non-semver version string "latest"', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'test',
      name: 'Test',
      version: 'latest',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a version with "v" prefix', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'test',
      name: 'Test',
      version: 'v1.0.0',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a version with only two parts', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'test',
      name: 'Test',
      version: '1.0',
    });
    expect(result.success).toBe(false);
  });

  // --- Missing required fields ---

  it('rejects when required field id is missing', () => {
    const result = ExtensionManifestSchema.safeParse({
      name: 'No ID',
      version: '1.0.0',
    });
    expect(result.success).toBe(false);
  });

  it('rejects when required field name is missing', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'no-name',
      version: '1.0.0',
    });
    expect(result.success).toBe(false);
  });

  it('rejects when required field version is missing', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'no-version',
      name: 'No Version',
    });
    expect(result.success).toBe(false);
  });

  // --- Optional fields ---

  it('treats description as optional', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'test',
      name: 'Test',
      version: '1.0.0',
      description: 'A description',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.description).toBe('A description');
    }
  });

  it('treats author as optional', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'test',
      name: 'Test',
      version: '1.0.0',
      author: 'Alice',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.author).toBe('Alice');
    }
  });

  it('treats minHostVersion as optional', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'test',
      name: 'Test',
      version: '1.0.0',
      minHostVersion: '0.2.0',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.minHostVersion).toBe('0.2.0');
    }
  });

  // --- Contributions record ---

  it('parses a contributions record correctly', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'dashboard-ext',
      name: 'Dashboard Extension',
      version: '1.0.0',
      contributions: { 'dashboard.sections': true, 'sidebar.footer': false },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contributions).toEqual({
        'dashboard.sections': true,
        'sidebar.footer': false,
      });
    }
  });

  // --- Permissions array ---

  it('parses a permissions array correctly', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'network-ext',
      name: 'Network Extension',
      version: '1.0.0',
      permissions: ['storage', 'network'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.permissions).toEqual(['storage', 'network']);
    }
  });

  it('parses an empty permissions array', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'minimal-ext',
      name: 'Minimal Extension',
      version: '1.0.0',
      permissions: [],
    });
    expect(result.success).toBe(true);
  });

  // --- Backward compatibility ---

  it('parses existing manifests without serverCapabilities or dataProxy', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'legacy-ext',
      name: 'Legacy Extension',
      version: '1.0.0',
      description: 'No server fields',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.serverCapabilities).toBeUndefined();
      expect(result.data.dataProxy).toBeUndefined();
    }
  });

  // --- serverCapabilities ---

  it('parses a manifest with valid serverCapabilities and secrets', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'data-provider',
      name: 'Data Provider',
      version: '1.0.0',
      serverCapabilities: {
        serverEntry: './server.ts',
        externalHosts: ['https://api.example.com'],
        secrets: [
          { key: 'api_key', label: 'API Key', required: true },
          { key: 'webhook_secret', label: 'Webhook Secret', description: 'For verifying webhooks' },
        ],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.serverCapabilities).toBeDefined();
      expect(result.data.serverCapabilities!.serverEntry).toBe('./server.ts');
      expect(result.data.serverCapabilities!.secrets).toHaveLength(2);
      expect(result.data.serverCapabilities!.secrets![0].key).toBe('api_key');
      expect(result.data.serverCapabilities!.secrets![0].required).toBe(true);
      expect(result.data.serverCapabilities!.secrets![1].required).toBe(false);
    }
  });

  it('applies default serverEntry when serverCapabilities is provided without it', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'default-entry',
      name: 'Default Entry',
      version: '1.0.0',
      serverCapabilities: {},
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.serverCapabilities!.serverEntry).toBe('./server.ts');
    }
  });

  it('rejects serverCapabilities.secrets with uppercase key', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'bad-secret-key',
      name: 'Bad Secret Key',
      version: '1.0.0',
      serverCapabilities: {
        secrets: [{ key: 'ApiKey', label: 'API Key' }],
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects serverCapabilities.secrets with key starting with a number', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'numeric-key',
      name: 'Numeric Key',
      version: '1.0.0',
      serverCapabilities: {
        secrets: [{ key: '9key', label: 'Bad Key' }],
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects serverCapabilities.secrets with empty label', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'empty-label',
      name: 'Empty Label',
      version: '1.0.0',
      serverCapabilities: {
        secrets: [{ key: 'valid_key', label: '' }],
      },
    });
    expect(result.success).toBe(false);
  });

  // --- dataProxy ---

  it('parses a manifest with valid dataProxy', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'proxy-ext',
      name: 'Proxy Extension',
      version: '1.0.0',
      dataProxy: {
        baseUrl: 'https://api.linear.app',
        authSecret: 'linear_api_key',
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dataProxy).toBeDefined();
      expect(result.data.dataProxy!.baseUrl).toBe('https://api.linear.app');
      expect(result.data.dataProxy!.authSecret).toBe('linear_api_key');
      expect(result.data.dataProxy!.authHeader).toBe('Authorization');
      expect(result.data.dataProxy!.authType).toBe('Bearer');
    }
  });

  it('parses dataProxy with all fields specified', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'full-proxy',
      name: 'Full Proxy',
      version: '1.0.0',
      dataProxy: {
        baseUrl: 'https://api.github.com',
        authHeader: 'X-Api-Key',
        authType: 'Token',
        authSecret: 'github_token',
        pathRewrite: { '/v1/': '/v2/' },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dataProxy!.authHeader).toBe('X-Api-Key');
      expect(result.data.dataProxy!.authType).toBe('Token');
      expect(result.data.dataProxy!.pathRewrite).toEqual({ '/v1/': '/v2/' });
    }
  });

  it('rejects dataProxy with invalid baseUrl', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'bad-proxy',
      name: 'Bad Proxy',
      version: '1.0.0',
      dataProxy: {
        baseUrl: 'not-a-url',
        authSecret: 'some_key',
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects dataProxy with missing authSecret', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'no-auth-secret',
      name: 'No Auth Secret',
      version: '1.0.0',
      dataProxy: {
        baseUrl: 'https://api.example.com',
      },
    });
    expect(result.success).toBe(false);
  });

  it('only accepts valid authType values', () => {
    for (const validType of ['Bearer', 'Basic', 'Token', 'Custom']) {
      const result = ExtensionManifestSchema.safeParse({
        id: 'auth-type-test',
        name: 'Auth Type Test',
        version: '1.0.0',
        dataProxy: {
          baseUrl: 'https://api.example.com',
          authType: validType,
          authSecret: 'key',
        },
      });
      expect(result.success).toBe(true);
    }

    const invalidResult = ExtensionManifestSchema.safeParse({
      id: 'auth-type-test',
      name: 'Auth Type Test',
      version: '1.0.0',
      dataProxy: {
        baseUrl: 'https://api.example.com',
        authType: 'OAuth',
        authSecret: 'key',
      },
    });
    expect(invalidResult.success).toBe(false);
  });

  // --- Combined serverCapabilities and dataProxy ---

  it('parses a manifest with both serverCapabilities and dataProxy', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'full-server-ext',
      name: 'Full Server Extension',
      version: '1.0.0',
      serverCapabilities: {
        serverEntry: './src/server.ts',
        externalHosts: ['https://api.linear.app'],
        secrets: [{ key: 'api_key', label: 'Linear API Key', required: true }],
      },
      dataProxy: {
        baseUrl: 'https://api.linear.app',
        authSecret: 'api_key',
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.serverCapabilities).toBeDefined();
      expect(result.data.dataProxy).toBeDefined();
    }
  });

  // --- Core extension tier fields (defaultEnabled / canDisable) ---

  it('parses defaultEnabled and canDisable when present (true)', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'core-on',
      name: 'Core On',
      version: '1.0.0',
      defaultEnabled: true,
      canDisable: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.defaultEnabled).toBe(true);
      expect(result.data.canDisable).toBe(true);
    }
  });

  it('parses defaultEnabled and canDisable when present (false)', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'core-off-locked',
      name: 'Core Off Locked',
      version: '1.0.0',
      defaultEnabled: false,
      canDisable: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.defaultEnabled).toBe(false);
      expect(result.data.canDisable).toBe(false);
    }
  });

  it('treats defaultEnabled and canDisable as optional (omitted → undefined)', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'plain-ext',
      name: 'Plain Extension',
      version: '1.0.0',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.defaultEnabled).toBeUndefined();
      expect(result.data.canDisable).toBeUndefined();
    }
  });

  it('round-trips a default-off, user-disableable core manifest', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'linear-issues',
      name: 'Linear Loop',
      version: '2.0.0',
      defaultEnabled: false,
      canDisable: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.defaultEnabled).toBe(false);
      expect(result.data.canDisable).toBe(true);
    }
  });

  it('rejects a non-boolean defaultEnabled', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'bad-default',
      name: 'Bad Default',
      version: '1.0.0',
      defaultEnabled: 'yes',
    });
    expect(result.success).toBe(false);
  });
});

describe('ExtensionManifestSchema — capabilities.events', () => {
  it('parses a manifest declaring specific event kinds', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'events-ext',
      name: 'Events Extension',
      version: '1.0.0',
      capabilities: { events: ['turn.completed', 'tool.activity'] },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.capabilities?.events).toEqual(['turn.completed', 'tool.activity']);
    }
  });

  it('parses a manifest declaring whole categories', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'cat-ext',
      name: 'Category Extension',
      version: '1.0.0',
      capabilities: { events: ['session', 'relay'] },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.capabilities?.events).toEqual(['session', 'relay']);
    }
  });

  it('accepts a mix of kinds and categories', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'mixed-ext',
      name: 'Mixed',
      version: '1.0.0',
      capabilities: { events: ['session', 'turn.started'] },
    });
    expect(result.success).toBe(true);
  });

  it('accepts an empty events array', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'empty-ext',
      name: 'Empty',
      version: '1.0.0',
      capabilities: { events: [] },
    });
    expect(result.success).toBe(true);
  });

  it('treats capabilities as optional (omitted → undefined)', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'no-caps',
      name: 'No Caps',
      version: '1.0.0',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.capabilities).toBeUndefined();
    }
  });

  it('rejects an unknown event kind', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'bad-event',
      name: 'Bad Event',
      version: '1.0.0',
      capabilities: { events: ['message.text'] },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a content-bearing kind that is not part of the curated set', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'leaky',
      name: 'Leaky',
      version: '1.0.0',
      capabilities: { events: ['text_delta'] },
    });
    expect(result.success).toBe(false);
  });
});

describe('SettingDeclarationSchema', () => {
  it('accepts a text setting with all fields', () => {
    const result = SettingDeclarationSchema.safeParse({
      type: 'text',
      key: 'label_prefix',
      label: 'Label Prefix',
      description: 'Prefix for labels',
      placeholder: 'gh:',
      default: 'gh:',
      group: 'GitHub',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a number setting with min/max', () => {
    const result = SettingDeclarationSchema.safeParse({
      type: 'number',
      key: 'refresh_interval',
      label: 'Refresh',
      default: 60,
      min: 10,
      max: 3600,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a boolean setting with default', () => {
    const result = SettingDeclarationSchema.safeParse({
      type: 'boolean',
      key: 'show_archived',
      label: 'Show Archived',
      default: false,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a select setting with options', () => {
    const result = SettingDeclarationSchema.safeParse({
      type: 'select',
      key: 'theme',
      label: 'Theme',
      options: [
        { label: 'Dark', value: 'dark' },
        { label: 'Light', value: 'light' },
      ],
      default: 'dark',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a minimal text setting (only required fields)', () => {
    const result = SettingDeclarationSchema.safeParse({
      type: 'text',
      key: 'prefix',
      label: 'Prefix',
    });
    expect(result.success).toBe(true);
  });

  it('defaults required to false', () => {
    const result = SettingDeclarationSchema.safeParse({
      type: 'text',
      key: 'prefix',
      label: 'Prefix',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.required).toBe(false);
    }
  });

  it('rejects invalid key format (uppercase)', () => {
    const result = SettingDeclarationSchema.safeParse({
      type: 'text',
      key: 'InvalidKey',
      label: 'X',
    });
    expect(result.success).toBe(false);
  });

  it('rejects key starting with a number', () => {
    const result = SettingDeclarationSchema.safeParse({
      type: 'text',
      key: '9key',
      label: 'X',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid type', () => {
    const result = SettingDeclarationSchema.safeParse({
      type: 'password',
      key: 'foo',
      label: 'X',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty label', () => {
    const result = SettingDeclarationSchema.safeParse({
      type: 'text',
      key: 'foo',
      label: '',
    });
    expect(result.success).toBe(false);
  });

  it('accepts select options with numeric values', () => {
    const result = SettingDeclarationSchema.safeParse({
      type: 'select',
      key: 'priority',
      label: 'Priority',
      options: [
        { label: 'Low', value: 1 },
        { label: 'High', value: 2 },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe('SecretDeclarationSchema — placeholder and group', () => {
  it('accepts placeholder and group', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'test-ext',
      name: 'Test',
      version: '1.0.0',
      serverCapabilities: {
        secrets: [
          {
            key: 'api_key',
            label: 'API Key',
            placeholder: 'sk_xxxx',
            group: 'Service',
          },
        ],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const secret = result.data.serverCapabilities!.secrets![0];
      expect(secret.placeholder).toBe('sk_xxxx');
      expect(secret.group).toBe('Service');
    }
  });

  it('still works without placeholder and group (backward compat)', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'test-ext',
      name: 'Test',
      version: '1.0.0',
      serverCapabilities: {
        secrets: [{ key: 'api_key', label: 'API Key', required: true }],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const secret = result.data.serverCapabilities!.secrets![0];
      expect(secret.placeholder).toBeUndefined();
      expect(secret.group).toBeUndefined();
    }
  });
});

describe('ServerCapabilitiesSchema — settings', () => {
  it('accepts settings alongside secrets', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'combined-ext',
      name: 'Combined',
      version: '1.0.0',
      serverCapabilities: {
        secrets: [{ key: 'token', label: 'Token' }],
        settings: [{ type: 'boolean', key: 'enabled', label: 'Enabled' }],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.serverCapabilities!.secrets).toHaveLength(1);
      expect(result.data.serverCapabilities!.settings).toHaveLength(1);
    }
  });

  it('accepts settings without secrets', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'settings-only',
      name: 'Settings Only',
      version: '1.0.0',
      serverCapabilities: {
        settings: [{ type: 'text', key: 'prefix', label: 'Prefix' }],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.serverCapabilities!.secrets).toBeUndefined();
      expect(result.data.serverCapabilities!.settings).toHaveLength(1);
    }
  });

  it('rejects settings with invalid field type', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'bad-settings',
      name: 'Bad',
      version: '1.0.0',
      serverCapabilities: {
        settings: [{ type: 'password', key: 'bad', label: 'Bad' }],
      },
    });
    expect(result.success).toBe(false);
  });

  it('existing manifests without settings still parse correctly', () => {
    const result = ExtensionManifestSchema.safeParse({
      id: 'legacy',
      name: 'Legacy',
      version: '1.0.0',
      serverCapabilities: {
        serverEntry: './server.ts',
        secrets: [{ key: 'key', label: 'Key' }],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.serverCapabilities!.settings).toBeUndefined();
    }
  });
});
