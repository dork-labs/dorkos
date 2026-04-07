import { describe, it, expect } from 'vitest';
import { mergeMarketplace } from '../merge-marketplace.js';
import type { MarketplaceJson } from '../marketplace-json-schema.js';
import type { DorkosSidecar } from '../dorkos-sidecar-schema.js';

const mkMarketplace = (plugins: MarketplaceJson['plugins']): MarketplaceJson => ({
  name: 'test',
  owner: { name: 'Test' },
  plugins,
});

const mkSidecar = (plugins: DorkosSidecar['plugins']): DorkosSidecar => ({
  schemaVersion: 1,
  plugins,
});

describe('mergeMarketplace', () => {
  it('returns entries with dorkos: undefined when sidecar is null', () => {
    const cc = mkMarketplace([
      { name: 'foo', source: { source: 'github', repo: 'o/r' } },
      { name: 'bar', source: { source: 'github', repo: 'o/r' } },
    ]);
    const result = mergeMarketplace(cc, null);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]?.dorkos).toBeUndefined();
    expect(result.entries[1]?.dorkos).toBeUndefined();
    expect(result.orphans).toEqual([]);
  });

  it('attaches sidecar entries to matching marketplace entries', () => {
    const cc = mkMarketplace([
      { name: 'foo', source: { source: 'github', repo: 'o/r' } },
      { name: 'bar', source: { source: 'github', repo: 'o/r' } },
    ]);
    const sidecar = mkSidecar({
      foo: { type: 'agent', layers: ['agents'] },
      bar: { type: 'plugin' },
    });
    const result = mergeMarketplace(cc, sidecar);
    expect(result.entries[0]?.dorkos).toEqual({ type: 'agent', layers: ['agents'] });
    expect(result.entries[1]?.dorkos).toEqual({ type: 'plugin' });
    expect(result.orphans).toEqual([]);
  });

  it('reports orphan sidecar plugins', () => {
    const cc = mkMarketplace([{ name: 'foo', source: { source: 'github', repo: 'o/r' } }]);
    const sidecar = mkSidecar({
      foo: { type: 'agent' },
      ghost: { type: 'plugin' },
    });
    const result = mergeMarketplace(cc, sidecar);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.name).toBe('foo');
    expect(result.orphans).toEqual(['ghost']);
  });

  it('handles empty marketplace with populated sidecar (all entries become orphans)', () => {
    const cc = mkMarketplace([]);
    const sidecar = mkSidecar({
      a: { type: 'agent' },
      b: { type: 'plugin' },
    });
    const result = mergeMarketplace(cc, sidecar);
    expect(result.entries).toEqual([]);
    expect(result.orphans.sort()).toEqual(['a', 'b']);
  });

  it('handles empty sidecar with populated marketplace', () => {
    const cc = mkMarketplace([{ name: 'foo', source: { source: 'github', repo: 'o/r' } }]);
    const sidecar = mkSidecar({});
    const result = mergeMarketplace(cc, sidecar);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.dorkos).toBeUndefined();
    expect(result.orphans).toEqual([]);
  });

  it('preserves all marketplace entry fields in merged result', () => {
    const cc = mkMarketplace([
      {
        name: 'foo',
        source: { source: 'github', repo: 'o/r' },
        description: 'desc',
        author: { name: 'Alice' },
      },
    ]);
    const result = mergeMarketplace(cc, null);
    expect(result.entries[0]).toMatchObject({
      name: 'foo',
      description: 'desc',
      author: { name: 'Alice' },
    });
  });
});
