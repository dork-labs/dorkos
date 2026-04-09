import { describe, it, expect } from 'vitest';
import {
  parseMarketplaceJson,
  parseMarketplaceJsonLenient,
  parseDorkosSidecar,
  parseMarketplaceWithSidecar,
} from '../marketplace-json-parser.js';

const validMarketplaceJson = JSON.stringify({
  name: 'test',
  owner: { name: 'Test' },
  plugins: [{ name: 'foo', source: { source: 'github', repo: 'owner/repo' } }],
});

const validSidecarJson = JSON.stringify({
  schemaVersion: 1,
  plugins: {
    foo: { type: 'agent', layers: ['agents'] },
  },
});

describe('parseMarketplaceJson', () => {
  it('parses a valid marketplace.json', () => {
    const result = parseMarketplaceJson(validMarketplaceJson);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.marketplace.name).toBe('test');
      expect(result.marketplace.plugins).toHaveLength(1);
    }
  });

  it('returns an error on invalid JSON', () => {
    const result = parseMarketplaceJson('not json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/^Invalid JSON:/);
    }
  });

  it('returns an error on schema violation', () => {
    const result = parseMarketplaceJson(JSON.stringify({ name: 'test', plugins: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/^marketplace\.json validation failed:/);
    }
  });
});

describe('parseDorkosSidecar', () => {
  it('parses a valid sidecar', () => {
    const result = parseDorkosSidecar(validSidecarJson);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sidecar.schemaVersion).toBe(1);
      expect(result.sidecar.plugins.foo?.type).toBe('agent');
    }
  });

  it('returns an error on invalid JSON', () => {
    const result = parseDorkosSidecar('not json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/^Invalid JSON:/);
    }
  });

  it('returns an error on schema violation', () => {
    const result = parseDorkosSidecar(JSON.stringify({ schemaVersion: 2, plugins: {} }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/^dorkos\.json validation failed:/);
    }
  });
});

describe('parseMarketplaceWithSidecar', () => {
  it('merges both documents when both are valid', () => {
    const result = parseMarketplaceWithSidecar(validMarketplaceJson, validSidecarJson);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.merged).toHaveLength(1);
      expect(result.merged[0]?.dorkos).toEqual({ type: 'agent', layers: ['agents'] });
      expect(result.sidecar).not.toBeNull();
      expect(result.orphans).toEqual([]);
    }
  });

  it('succeeds with null sidecar (no sidecar case)', () => {
    const result = parseMarketplaceWithSidecar(validMarketplaceJson, null);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sidecar).toBeNull();
      expect(result.merged).toHaveLength(1);
      expect(result.merged[0]?.dorkos).toBeUndefined();
    }
  });

  it('returns error when marketplace is invalid', () => {
    const result = parseMarketplaceWithSidecar('not json', null);
    expect(result.ok).toBe(false);
  });

  it('returns error when sidecar is invalid JSON', () => {
    const result = parseMarketplaceWithSidecar(validMarketplaceJson, 'not json');
    expect(result.ok).toBe(false);
  });

  it('reports orphans from the sidecar', () => {
    const sidecarWithOrphan = JSON.stringify({
      schemaVersion: 1,
      plugins: {
        foo: { type: 'agent' },
        ghost: { type: 'plugin' },
      },
    });
    const result = parseMarketplaceWithSidecar(validMarketplaceJson, sidecarWithOrphan);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.orphans).toEqual(['ghost']);
      expect(result.merged).toHaveLength(1);
    }
  });
});

describe('parseMarketplaceJsonLenient', () => {
  it('parses a valid marketplace.json', () => {
    const result = parseMarketplaceJsonLenient(validMarketplaceJson);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.marketplace.name).toBe('test');
      expect(result.marketplace.plugins).toHaveLength(1);
      expect(result.skippedPlugins).toEqual([]);
    }
  });

  it('accepts reserved marketplace names (e.g., claude-plugins-official)', () => {
    // The reserved-name list is a publishing policy, not a consumption
    // policy. The real Anthropic marketplace is literally named
    // `claude-plugins-official` — consumers must be able to parse it.
    const raw = JSON.stringify({
      name: 'claude-plugins-official',
      owner: { name: 'Anthropic' },
      plugins: [
        {
          name: 'foo',
          source: { source: 'github', repo: 'anthropics/foo' },
        },
      ],
    });
    const strict = parseMarketplaceJson(raw);
    expect(strict.ok).toBe(false);
    if (!strict.ok) {
      expect(strict.error).toMatch(/Reserved marketplace name/);
    }

    const lenient = parseMarketplaceJsonLenient(raw);
    expect(lenient.ok).toBe(true);
    if (lenient.ok) {
      expect(lenient.marketplace.name).toBe('claude-plugins-official');
    }
  });

  it('accepts plugin names with dots (e.g., wordpress.com)', () => {
    // Real upstream marketplaces ship entries like `wordpress.com` —
    // the strict kebab-case regex is too narrow for consumption.
    const raw = JSON.stringify({
      name: 'upstream',
      owner: { name: 'Upstream' },
      plugins: [
        {
          name: 'wordpress.com',
          source: { source: 'url', url: 'https://github.com/Automattic/foo.git' },
          description: 'WordPress integration',
        },
      ],
    });
    const result = parseMarketplaceJsonLenient(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.marketplace.plugins).toHaveLength(1);
      expect(result.marketplace.plugins[0]?.name).toBe('wordpress.com');
      expect(result.skippedPlugins).toEqual([]);
    }
  });

  it('skips individual invalid plugin entries instead of failing the whole document', () => {
    const raw = JSON.stringify({
      name: 'mixed',
      owner: { name: 'Mixed' },
      plugins: [
        { name: 'valid-one', source: { source: 'github', repo: 'owner/one' } },
        { name: 'Bad_Name', source: { source: 'github', repo: 'owner/two' } }, // caps + underscore
        { notEvenAnEntry: true },
        { name: 'valid-three', source: { source: 'github', repo: 'owner/three' } },
      ],
    });
    const result = parseMarketplaceJsonLenient(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.marketplace.plugins).toHaveLength(2);
      const names = result.marketplace.plugins.map((p) => p.name);
      expect(names).toEqual(['valid-one', 'valid-three']);

      expect(result.skippedPlugins).toHaveLength(2);
      expect(result.skippedPlugins[0]).toMatchObject({ index: 1, name: 'Bad_Name' });
      expect(result.skippedPlugins[0]?.error).toMatch(/kebab-case/i);
      expect(result.skippedPlugins[1]).toMatchObject({ index: 2 });
    }
  });

  it('fails fatally when the top-level envelope is missing required fields', () => {
    const result = parseMarketplaceJsonLenient(JSON.stringify({ name: 'no-owner', plugins: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/^marketplace\.json validation failed:/);
    }
  });

  it('returns an error on invalid JSON', () => {
    const result = parseMarketplaceJsonLenient('not json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/^Invalid JSON:/);
    }
  });
});
