import { describe, it, expect } from 'vitest';
import { DorkosSidecarSchema, DorkosEntrySchema, PricingSchema } from '../dorkos-sidecar-schema.js';

describe('DorkosEntrySchema', () => {
  it('accepts all valid type enum values', () => {
    for (const type of ['agent', 'plugin', 'skill-pack', 'adapter'] as const) {
      const result = DorkosEntrySchema.safeParse({ type });
      expect(result.success, `expected type=${type} to parse`).toBe(true);
    }
  });

  it('rejects invalid type value', () => {
    const result = DorkosEntrySchema.safeParse({ type: 'extension' });
    expect(result.success).toBe(false);
  });

  it('accepts all valid layer enum values', () => {
    const layers = [
      'skills',
      'tasks',
      'commands',
      'hooks',
      'extensions',
      'adapters',
      'mcp-servers',
      'lsp-servers',
      'agents',
    ] as const;
    const result = DorkosEntrySchema.safeParse({ layers });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid layer value', () => {
    const result = DorkosEntrySchema.safeParse({ layers: ['invalid'] });
    expect(result.success).toBe(false);
  });

  it('accepts requires with agent: prefix', () => {
    const result = DorkosEntrySchema.safeParse({ requires: ['agent:foo'] });
    expect(result.success).toBe(true);
  });

  it('accepts requires with plugin: prefix and version range', () => {
    const result = DorkosEntrySchema.safeParse({
      requires: ['plugin:bar@^1.0.0'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts requires with all four dependency types', () => {
    const result = DorkosEntrySchema.safeParse({
      requires: ['agent:one', 'plugin:two', 'skill-pack:three', 'adapter:four'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a random string in requires', () => {
    const result = DorkosEntrySchema.safeParse({ requires: ['not-a-dep'] });
    expect(result.success).toBe(false);
  });

  it('accepts dorkosMinVersion in semver format', () => {
    const result = DorkosEntrySchema.safeParse({ dorkosMinVersion: '1.2.3' });
    expect(result.success).toBe(true);
  });

  it('accepts dorkosMinVersion with prerelease tag', () => {
    const result = DorkosEntrySchema.safeParse({ dorkosMinVersion: '1.2.3-beta.1' });
    expect(result.success).toBe(true);
  });

  it('rejects non-semver dorkosMinVersion', () => {
    const result = DorkosEntrySchema.safeParse({ dorkosMinVersion: 'not-semver' });
    expect(result.success).toBe(false);
  });

  it('accepts all pricing.model enum values', () => {
    for (const model of ['free', 'paid', 'freemium', 'byo-license'] as const) {
      const result = PricingSchema.safeParse({ model });
      expect(result.success, `expected pricing.model=${model} to parse`).toBe(true);
    }
  });

  it('rejects negative priceUsd', () => {
    const result = PricingSchema.safeParse({ model: 'paid', priceUsd: -1 });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer trialDays', () => {
    const result = PricingSchema.safeParse({ model: 'freemium', trialDays: 7.5 });
    expect(result.success).toBe(false);
  });
});

describe('DorkosSidecarSchema', () => {
  it('accepts a valid sidecar with schemaVersion 1', () => {
    const result = DorkosSidecarSchema.safeParse({
      schemaVersion: 1,
      plugins: {
        foo: { type: 'agent', layers: ['agents'] },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts an empty plugins record', () => {
    const result = DorkosSidecarSchema.safeParse({
      schemaVersion: 1,
      plugins: {},
    });
    expect(result.success).toBe(true);
  });

  it('rejects schemaVersion other than 1', () => {
    const result = DorkosSidecarSchema.safeParse({
      schemaVersion: 2,
      plugins: {},
    });
    expect(result.success).toBe(false);
  });

  it('accepts optional $schema field', () => {
    const result = DorkosSidecarSchema.safeParse({
      $schema: 'https://example.com/schema.json',
      schemaVersion: 1,
      plugins: {},
    });
    expect(result.success).toBe(true);
  });
});
