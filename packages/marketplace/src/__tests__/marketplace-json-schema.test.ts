import { describe, it, expect } from 'vitest';
import {
  MarketplaceJsonSchema,
  MarketplaceJsonEntrySchema,
  PluginSourceSchema,
  RESERVED_MARKETPLACE_NAMES,
} from '../marketplace-json-schema.js';

const validOwner = { name: 'Test Owner' };

describe('PluginSourceSchema — five source forms', () => {
  it('accepts a relative-path source starting with ./', () => {
    const result = PluginSourceSchema.safeParse('./plugins/foo');
    expect(result.success).toBe(true);
  });

  it('rejects a relative-path source without ./', () => {
    // A bare "foo" is a valid pluginRoot-relative source at the entry level,
    // but the PluginSourceSchema union itself requires either ./ prefix or
    // an object form. The bare-name case is handled by the source resolver.
    const result = PluginSourceSchema.safeParse('foo');
    expect(result.success).toBe(false);
  });

  it('rejects a relative-path containing ..', () => {
    const result = PluginSourceSchema.safeParse('./plugins/../evil');
    expect(result.success).toBe(false);
  });

  it('accepts a github source', () => {
    const result = PluginSourceSchema.safeParse({ source: 'github', repo: 'owner/repo' });
    expect(result.success).toBe(true);
  });

  it('accepts a github source with ref and sha', () => {
    const result = PluginSourceSchema.safeParse({
      source: 'github',
      repo: 'owner/repo',
      ref: 'main',
      sha: 'a'.repeat(40),
    });
    expect(result.success).toBe(true);
  });

  it('rejects a github source with an invalid repo format', () => {
    const result = PluginSourceSchema.safeParse({ source: 'github', repo: 'not-a-repo' });
    expect(result.success).toBe(false);
  });

  it('rejects a github source with a short sha', () => {
    const result = PluginSourceSchema.safeParse({
      source: 'github',
      repo: 'owner/repo',
      sha: 'abc',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a url source', () => {
    const result = PluginSourceSchema.safeParse({
      source: 'url',
      url: 'https://gitlab.com/foo/bar.git',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a url source with a non-URL string', () => {
    const result = PluginSourceSchema.safeParse({ source: 'url', url: 'not-a-url' });
    expect(result.success).toBe(false);
  });

  it('accepts a git-subdir source', () => {
    const result = PluginSourceSchema.safeParse({
      source: 'git-subdir',
      url: 'https://github.com/foo/monorepo.git',
      path: 'plugins/qa',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a git-subdir source with empty path', () => {
    const result = PluginSourceSchema.safeParse({
      source: 'git-subdir',
      url: 'https://github.com/foo/monorepo.git',
      path: '',
    });
    expect(result.success).toBe(false);
  });

  it('accepts an npm source', () => {
    const result = PluginSourceSchema.safeParse({
      source: 'npm',
      package: '@dorkos/example',
      version: '1.2.3',
    });
    expect(result.success).toBe(true);
  });
});

describe('MarketplaceJsonEntrySchema', () => {
  it('accepts a minimal valid entry with a github source', () => {
    const result = MarketplaceJsonEntrySchema.safeParse({
      name: 'foo',
      source: { source: 'github', repo: 'owner/repo' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts author as object with required name', () => {
    const result = MarketplaceJsonEntrySchema.safeParse({
      name: 'foo',
      source: { source: 'github', repo: 'owner/repo' },
      author: { name: 'Alice', email: 'alice@example.com' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects author as a bare string', () => {
    const result = MarketplaceJsonEntrySchema.safeParse({
      name: 'foo',
      source: { source: 'github', repo: 'owner/repo' },
      author: 'Alice',
    });
    expect(result.success).toBe(false);
  });

  it('rejects uppercase names', () => {
    const result = MarketplaceJsonEntrySchema.safeParse({
      name: 'Foo',
      source: { source: 'github', repo: 'owner/repo' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects names starting with a dash', () => {
    const result = MarketplaceJsonEntrySchema.safeParse({
      name: '-foo',
      source: { source: 'github', repo: 'owner/repo' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts strict: true', () => {
    const result = MarketplaceJsonEntrySchema.safeParse({
      name: 'foo',
      source: { source: 'github', repo: 'owner/repo' },
      strict: true,
    });
    expect(result.success).toBe(true);
  });

  it('preserves unknown fields via passthrough', () => {
    const result = MarketplaceJsonEntrySchema.safeParse({
      name: 'foo',
      source: { source: 'github', repo: 'owner/repo' },
      publisherBadge: 'verified',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).publisherBadge).toBe('verified');
    }
  });

  it('preserves inline CC commands field as opaque metadata', () => {
    const result = MarketplaceJsonEntrySchema.safeParse({
      name: 'foo',
      source: { source: 'github', repo: 'owner/repo' },
      commands: { run: { description: 'A command' } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.commands).toBeDefined();
    }
  });

  it('rejects more than 20 tags', () => {
    const result = MarketplaceJsonEntrySchema.safeParse({
      name: 'foo',
      source: { source: 'github', repo: 'owner/repo' },
      tags: Array.from({ length: 21 }, (_, i) => `tag-${i}`),
    });
    expect(result.success).toBe(false);
  });

  it('rejects category longer than 64 characters', () => {
    const result = MarketplaceJsonEntrySchema.safeParse({
      name: 'foo',
      source: { source: 'github', repo: 'owner/repo' },
      category: 'c'.repeat(65),
    });
    expect(result.success).toBe(false);
  });
});

describe('MarketplaceJsonSchema — top-level document', () => {
  it('accepts a minimal valid document', () => {
    const result = MarketplaceJsonSchema.safeParse({
      name: 'test',
      owner: validOwner,
      plugins: [{ name: 'foo', source: { source: 'github', repo: 'owner/repo' } }],
    });
    expect(result.success).toBe(true);
  });

  it('requires owner at the top level', () => {
    const result = MarketplaceJsonSchema.safeParse({
      name: 'test',
      plugins: [],
    });
    expect(result.success).toBe(false);
  });

  it('requires owner.name', () => {
    const result = MarketplaceJsonSchema.safeParse({
      name: 'test',
      owner: {},
      plugins: [],
    });
    expect(result.success).toBe(false);
  });

  it('accepts metadata with pluginRoot', () => {
    const result = MarketplaceJsonSchema.safeParse({
      name: 'test',
      owner: validOwner,
      metadata: {
        description: 'Test',
        version: '0.1.0',
        pluginRoot: './plugins',
      },
      plugins: [],
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty marketplace name', () => {
    const result = MarketplaceJsonSchema.safeParse({
      name: '',
      owner: validOwner,
      plugins: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects uppercase marketplace name', () => {
    const result = MarketplaceJsonSchema.safeParse({
      name: 'Test',
      owner: validOwner,
      plugins: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects all 8 reserved marketplace names', () => {
    for (const reserved of RESERVED_MARKETPLACE_NAMES) {
      const result = MarketplaceJsonSchema.safeParse({
        name: reserved,
        owner: validOwner,
        plugins: [],
      });
      expect(result.success, `expected reserved name "${reserved}" to fail`).toBe(false);
    }
  });

  it('preserves unknown top-level fields via passthrough', () => {
    const result = MarketplaceJsonSchema.safeParse({
      name: 'test',
      owner: validOwner,
      plugins: [],
      publisherBadge: 'verified',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).publisherBadge).toBe('verified');
    }
  });
});
