import { describe, it, expect } from 'vitest';
import { parseMarketplaceJson } from '../marketplace-json-parser.js';

describe('parseMarketplaceJson — successful parsing', () => {
  it('round-trips a valid standard CC marketplace.json', () => {
    const input = JSON.stringify({
      name: 'test-marketplace',
      plugins: [
        {
          name: 'a',
          source: 'github:x/y',
        },
      ],
    });

    const result = parseMarketplaceJson(input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.marketplace.name).toBe('test-marketplace');
      expect(result.marketplace.plugins).toHaveLength(1);
      // type is optional and absent on standard CC entries
      expect(result.marketplace.plugins[0]?.type).toBeUndefined();
      expect(result.marketplace.plugins[0]?.name).toBe('a');
      expect(result.marketplace.plugins[0]?.source).toBe('github:x/y');
    }
  });

  it('round-trips a DorkOS-extended marketplace.json with explicit plugin type', () => {
    const input = JSON.stringify({
      name: 'dorkos-marketplace',
      plugins: [
        {
          name: 'fancy-plugin',
          source: 'github:dorkos/fancy',
          type: 'plugin',
          category: 'devtools',
          tags: ['cli'],
          featured: true,
        },
      ],
    });

    const result = parseMarketplaceJson(input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.marketplace.plugins[0]?.type).toBe('plugin');
      expect(result.marketplace.plugins[0]?.category).toBe('devtools');
      expect(result.marketplace.plugins[0]?.tags).toEqual(['cli']);
      expect(result.marketplace.plugins[0]?.featured).toBe(true);
    }
  });

  it('preserves unknown fields via passthrough on the parsed result', () => {
    const input = JSON.stringify({
      name: 'test',
      publisherBadge: 'verified',
      plugins: [
        {
          name: 'a',
          source: 'github:x/y',
          publisherBadge: 'verified',
        },
      ],
    });

    const result = parseMarketplaceJson(input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.marketplace as Record<string, unknown>).publisherBadge).toBe('verified');
      const entry = result.marketplace.plugins[0] as Record<string, unknown>;
      expect(entry.publisherBadge).toBe('verified');
    }
  });
});

describe('parseMarketplaceJson — error cases', () => {
  it('returns an Invalid JSON error for malformed JSON input', () => {
    const result = parseMarketplaceJson('{ invalid json');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.startsWith('Invalid JSON: ')).toBe(true);
    }
  });

  it('returns an Invalid JSON error for non-JSON input', () => {
    const result = parseMarketplaceJson('not json at all');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.startsWith('Invalid JSON: ')).toBe(true);
    }
  });

  it('returns a validation error for an empty object', () => {
    const result = parseMarketplaceJson('{}');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.startsWith('marketplace.json validation failed: ')).toBe(true);
      // The joined issues list should mention the missing fields by path.
      expect(result.error).toContain('name');
      expect(result.error).toContain('plugins');
    }
  });

  it('returns a validation error when plugins is not an array', () => {
    const input = JSON.stringify({ name: 'test', plugins: 'oops' });
    const result = parseMarketplaceJson(input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.startsWith('marketplace.json validation failed: ')).toBe(true);
      expect(result.error).toContain('plugins');
    }
  });

  it('returns a validation error when a plugin entry is missing source', () => {
    const input = JSON.stringify({
      name: 'test',
      plugins: [{ name: 'a' }],
    });
    const result = parseMarketplaceJson(input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.startsWith('marketplace.json validation failed: ')).toBe(true);
      expect(result.error).toContain('source');
    }
  });

  it('formats issue paths with dot notation and joins with semicolons', () => {
    // Two distinct violations: missing top-level name AND a plugin missing name.
    const input = JSON.stringify({
      plugins: [{ source: 'github:x/y' }],
    });
    const result = parseMarketplaceJson(input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.startsWith('marketplace.json validation failed: ')).toBe(true);
      // Multiple issues should be `;`-joined.
      expect(result.error).toContain(';');
    }
  });

  it('uses <root> as the path label for top-level issues', () => {
    // Passing a primitive triggers a top-level (root) issue with no path.
    const result = parseMarketplaceJson('null');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.startsWith('marketplace.json validation failed: ')).toBe(true);
      expect(result.error).toContain('<root>');
    }
  });
});
