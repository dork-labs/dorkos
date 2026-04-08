import { describe, it, expect } from 'vitest';
import { CcMarketplaceJsonSchema, validateAgainstCcSchema } from '../cc-validator.js';

const validMinimal = {
  name: 'test',
  owner: { name: 'Test' },
  plugins: [{ name: 'foo', source: { source: 'github', repo: 'owner/repo' } }],
};

describe('CcMarketplaceJsonSchema — strict mode', () => {
  it('accepts a minimal valid CC marketplace', () => {
    const result = CcMarketplaceJsonSchema.safeParse(validMinimal);
    expect(result.success).toBe(true);
  });

  it('rejects a marketplace missing owner', () => {
    const result = CcMarketplaceJsonSchema.safeParse({
      name: 'test',
      plugins: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a reserved marketplace name', () => {
    const result = CcMarketplaceJsonSchema.safeParse({
      ...validMinimal,
      name: 'claude-plugins-official',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a plugin entry with inline x-dorkos field', () => {
    const result = CcMarketplaceJsonSchema.safeParse({
      name: 'test',
      owner: { name: 'Test' },
      plugins: [
        {
          name: 'foo',
          source: { source: 'github', repo: 'owner/repo' },
          'x-dorkos': { type: 'agent' },
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join(' ');
      expect(messages.toLowerCase()).toContain('unrecognized');
    }
  });

  it('rejects an unknown top-level key', () => {
    const result = CcMarketplaceJsonSchema.safeParse({
      ...validMinimal,
      unknownTopLevel: 'nope',
    });
    expect(result.success).toBe(false);
  });

  it('accepts all 4 supported git source forms', () => {
    const forms = [
      './plugins/foo',
      { source: 'github', repo: 'owner/repo' },
      { source: 'url', url: 'https://gitlab.com/foo/bar.git' },
      {
        source: 'git-subdir',
        url: 'https://github.com/foo/mono.git',
        path: 'plugins/foo',
      },
    ];
    for (const source of forms) {
      const result = CcMarketplaceJsonSchema.safeParse({
        name: 'test',
        owner: { name: 'Test' },
        plugins: [{ name: 'foo', source }],
      });
      expect(
        result.success,
        `expected source ${JSON.stringify(source)} to parse, got ${result.success ? 'success' : result.error.message}`
      ).toBe(true);
    }
  });

  it('accepts an npm source (schema validates shape only)', () => {
    const result = CcMarketplaceJsonSchema.safeParse({
      name: 'test',
      owner: { name: 'Test' },
      plugins: [
        {
          name: 'foo',
          source: { source: 'npm', package: '@dorkos/foo', version: '1.0.0' },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts optional metadata', () => {
    const result = CcMarketplaceJsonSchema.safeParse({
      ...validMinimal,
      metadata: {
        description: 'Test marketplace',
        version: '0.1.0',
        pluginRoot: './plugins',
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts CC component fields as opaque metadata on plugin entries', () => {
    const result = CcMarketplaceJsonSchema.safeParse({
      name: 'test',
      owner: { name: 'Test' },
      plugins: [
        {
          name: 'foo',
          source: { source: 'github', repo: 'owner/repo' },
          commands: { run: {} },
          agents: { foo: {} },
          hooks: { PreToolUse: [] },
          mcpServers: {},
          lspServers: {},
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe('validateAgainstCcSchema', () => {
  it('returns ok: true for a valid document', () => {
    const result = validateAgainstCcSchema(validMinimal);
    expect(result.ok).toBe(true);
  });

  it('returns ok: false with errors for an invalid document', () => {
    const result = validateAgainstCcSchema({
      name: 'test',
      owner: { name: 'Test' },
      plugins: [
        {
          name: 'foo',
          source: { source: 'github', repo: 'owner/repo' },
          'x-dorkos': { type: 'agent' },
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });
});
