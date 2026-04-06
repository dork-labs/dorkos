import { describe, it, expect } from 'vitest';
import { MarketplaceJsonSchema, MarketplaceJsonEntrySchema } from '../marketplace-json-schema.js';

describe('MarketplaceJsonSchema — valid documents', () => {
  it('accepts a standard Claude Code marketplace.json (no DorkOS fields)', () => {
    const result = MarketplaceJsonSchema.safeParse({
      name: 'test-marketplace',
      plugins: [
        {
          name: 'a',
          source: 'github:x/y',
        },
      ],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('test-marketplace');
      expect(result.data.plugins).toHaveLength(1);
      expect(result.data.plugins[0]?.name).toBe('a');
      expect(result.data.plugins[0]?.source).toBe('github:x/y');
      // type is optional and absent on standard CC entries
      expect(result.data.plugins[0]?.type).toBeUndefined();
    }
  });

  it('accepts a fully DorkOS-extended marketplace.json', () => {
    const result = MarketplaceJsonSchema.safeParse({
      name: 'dorkos-marketplace',
      plugins: [
        {
          name: 'fancy-plugin',
          source: 'github:dorkos/fancy',
          description: 'A fancy DorkOS plugin',
          version: '1.0.0',
          author: 'Dorkos Team',
          homepage: 'https://example.com',
          repository: 'https://github.com/dorkos/fancy',
          license: 'MIT',
          keywords: ['fancy', 'plugin'],
          type: 'plugin',
          category: 'devtools',
          tags: ['cli', 'ops'],
          icon: '🛠️',
          layers: ['skills', 'commands'],
          requires: ['adapter:slack@^1.0.0'],
          featured: true,
          dorkosMinVersion: '0.5.0',
        },
      ],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      const entry = result.data.plugins[0];
      expect(entry?.type).toBe('plugin');
      expect(entry?.category).toBe('devtools');
      expect(entry?.tags).toEqual(['cli', 'ops']);
      expect(entry?.layers).toEqual(['skills', 'commands']);
      expect(entry?.requires).toEqual(['adapter:slack@^1.0.0']);
      expect(entry?.featured).toBe(true);
      expect(entry?.dorkosMinVersion).toBe('0.5.0');
    }
  });

  it('accepts each PackageType enum value on plugin entries', () => {
    for (const type of ['agent', 'plugin', 'skill-pack', 'adapter'] as const) {
      const result = MarketplaceJsonEntrySchema.safeParse({
        name: 'pkg',
        source: 'github:x/y',
        type,
      });
      expect(result.success).toBe(true);
    }
  });

  it('preserves unknown fields on plugin entries via passthrough', () => {
    const result = MarketplaceJsonEntrySchema.parse({
      name: 'a',
      source: 'github:x/y',
      publisherBadge: 'verified',
    });

    // passthrough preserves the unknown field on the parsed output
    expect((result as Record<string, unknown>).publisherBadge).toBe('verified');
  });

  it('preserves unknown fields at the top level via passthrough', () => {
    const result = MarketplaceJsonSchema.parse({
      name: 'test',
      plugins: [
        {
          name: 'a',
          source: 'github:x/y',
          publisherBadge: 'verified',
        },
      ],
      publisherBadge: 'verified',
    });

    expect((result as Record<string, unknown>).publisherBadge).toBe('verified');
    const entry = result.plugins[0] as Record<string, unknown>;
    expect(entry.publisherBadge).toBe('verified');
  });

  it('accepts an empty plugins array', () => {
    const result = MarketplaceJsonSchema.safeParse({
      name: 'empty',
      plugins: [],
    });
    expect(result.success).toBe(true);
  });
});

describe('MarketplaceJsonSchema — invalid top-level structures', () => {
  it('rejects documents missing the name field', () => {
    const result = MarketplaceJsonSchema.safeParse({
      plugins: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects documents with an empty name', () => {
    const result = MarketplaceJsonSchema.safeParse({
      name: '',
      plugins: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects documents missing the plugins field', () => {
    const result = MarketplaceJsonSchema.safeParse({
      name: 'test',
    });
    expect(result.success).toBe(false);
  });

  it('rejects documents where plugins is not an array', () => {
    const result = MarketplaceJsonSchema.safeParse({
      name: 'test',
      plugins: 'not-an-array',
    });
    expect(result.success).toBe(false);
  });

  it('rejects documents where plugins is an object', () => {
    const result = MarketplaceJsonSchema.safeParse({
      name: 'test',
      plugins: { foo: 'bar' },
    });
    expect(result.success).toBe(false);
  });
});

describe('MarketplaceJsonEntrySchema — invalid plugin entries', () => {
  it('rejects entries missing name', () => {
    const result = MarketplaceJsonEntrySchema.safeParse({
      source: 'github:x/y',
    });
    expect(result.success).toBe(false);
  });

  it('rejects entries with empty name', () => {
    const result = MarketplaceJsonEntrySchema.safeParse({
      name: '',
      source: 'github:x/y',
    });
    expect(result.success).toBe(false);
  });

  it('rejects entries missing source', () => {
    const result = MarketplaceJsonEntrySchema.safeParse({
      name: 'test',
    });
    expect(result.success).toBe(false);
  });

  it('rejects entries with empty source', () => {
    const result = MarketplaceJsonEntrySchema.safeParse({
      name: 'test',
      source: '',
    });
    expect(result.success).toBe(false);
  });
});

describe('MarketplaceJsonEntrySchema — DorkOS extension field validation', () => {
  it('rejects entries with more than 20 tags', () => {
    const result = MarketplaceJsonEntrySchema.safeParse({
      name: 'a',
      source: 'github:x/y',
      tags: Array.from({ length: 21 }, (_, i) => `tag-${i}`),
    });
    expect(result.success).toBe(false);
  });

  it('accepts entries with exactly 20 tags', () => {
    const result = MarketplaceJsonEntrySchema.safeParse({
      name: 'a',
      source: 'github:x/y',
      tags: Array.from({ length: 20 }, (_, i) => `tag-${i}`),
    });
    expect(result.success).toBe(true);
  });

  it('rejects category longer than 64 characters', () => {
    const result = MarketplaceJsonEntrySchema.safeParse({
      name: 'a',
      source: 'github:x/y',
      category: 'c'.repeat(65),
    });
    expect(result.success).toBe(false);
  });

  it('rejects type values outside the PackageType enum', () => {
    const result = MarketplaceJsonEntrySchema.safeParse({
      name: 'a',
      source: 'github:x/y',
      type: 'extension',
    });
    expect(result.success).toBe(false);
  });

  it('rejects icon longer than 64 characters', () => {
    const result = MarketplaceJsonEntrySchema.safeParse({
      name: 'a',
      source: 'github:x/y',
      icon: 'i'.repeat(65),
    });
    expect(result.success).toBe(false);
  });

  it('rejects layers values outside the layer enum', () => {
    const result = MarketplaceJsonEntrySchema.safeParse({
      name: 'a',
      source: 'github:x/y',
      layers: ['not-a-real-layer'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects individual tag strings longer than 32 characters', () => {
    const result = MarketplaceJsonEntrySchema.safeParse({
      name: 'a',
      source: 'github:x/y',
      tags: ['t'.repeat(33)],
    });
    expect(result.success).toBe(false);
  });
});
