import { describe, it, expect } from 'vitest';
import {
  parseMarketplaceJson,
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
