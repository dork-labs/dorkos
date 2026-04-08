import { describe, it, expect } from 'vitest';
import type { AggregatedPackage } from '@dorkos/shared/marketplace-schemas';
import { filterPackages } from '../package-filter';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function pkg(overrides: Partial<AggregatedPackage> & { name: string }): AggregatedPackage {
  return {
    source: 'https://github.com/example/pkg',
    marketplace: 'official',
    ...overrides,
  };
}

const PLUGIN_A = pkg({ name: 'alpha-plugin', type: 'plugin', category: 'ui', keywords: ['theme'] });
const PLUGIN_B = pkg({
  name: 'beta-plugin',
  type: 'plugin',
  category: 'productivity',
  keywords: ['workflow'],
});
const AGENT_A = pkg({
  name: 'alpha-agent',
  type: 'agent',
  category: 'ai',
  description: 'An AI agent',
});
const SKILL_PACK = pkg({ name: 'code-skills', type: 'skill-pack', category: 'productivity' });
// No `type` field — should default to 'plugin'
const UNTYPED = pkg({ name: 'untyped-package', category: 'ui', description: 'Mystery package' });

const ALL = [PLUGIN_A, PLUGIN_B, AGENT_A, SKILL_PACK, UNTYPED];

// ---------------------------------------------------------------------------
// Type filter
// ---------------------------------------------------------------------------

describe('filterPackages — type filter', () => {
  it('returns all packages when type is "all"', () => {
    const result = filterPackages(ALL, { type: 'all', category: null, search: '' });
    expect(result).toHaveLength(ALL.length);
  });

  it('filters to only plugin packages', () => {
    const result = filterPackages(ALL, { type: 'plugin', category: null, search: '' });
    expect(result.map((p) => p.name)).toEqual(
      expect.arrayContaining(['alpha-plugin', 'beta-plugin'])
    );
    expect(result).not.toContainEqual(expect.objectContaining({ name: 'alpha-agent' }));
  });

  it('treats packages with no type field as "plugin"', () => {
    const result = filterPackages(ALL, { type: 'plugin', category: null, search: '' });
    expect(result).toContainEqual(expect.objectContaining({ name: 'untyped-package' }));
  });

  it('does not include untyped packages when filtering by non-plugin types', () => {
    const result = filterPackages(ALL, { type: 'agent', category: null, search: '' });
    expect(result).not.toContainEqual(expect.objectContaining({ name: 'untyped-package' }));
  });

  it('filters to only agent packages', () => {
    const result = filterPackages(ALL, { type: 'agent', category: null, search: '' });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('alpha-agent');
  });

  it('filters to only skill-pack packages', () => {
    const result = filterPackages(ALL, { type: 'skill-pack', category: null, search: '' });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('code-skills');
  });

  it('returns empty array when no packages match the type', () => {
    const result = filterPackages(ALL, { type: 'adapter', category: null, search: '' });
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Category filter
// ---------------------------------------------------------------------------

describe('filterPackages — category filter', () => {
  it('returns all packages when category is null', () => {
    const result = filterPackages(ALL, { type: 'all', category: null, search: '' });
    expect(result).toHaveLength(ALL.length);
  });

  it('filters by exact category match', () => {
    const result = filterPackages(ALL, { type: 'all', category: 'ui', search: '' });
    expect(result.map((p) => p.name)).toEqual(
      expect.arrayContaining(['alpha-plugin', 'untyped-package'])
    );
    expect(result).not.toContainEqual(expect.objectContaining({ name: 'alpha-agent' }));
  });

  it('returns empty array when category matches nothing', () => {
    const result = filterPackages(ALL, { type: 'all', category: 'nonexistent', search: '' });
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Search filter
// ---------------------------------------------------------------------------

describe('filterPackages — search filter', () => {
  it('returns all packages when search is empty string', () => {
    const result = filterPackages(ALL, { type: 'all', category: null, search: '' });
    expect(result).toHaveLength(ALL.length);
  });

  it('returns all packages when search is only whitespace', () => {
    const result = filterPackages(ALL, { type: 'all', category: null, search: '   ' });
    expect(result).toHaveLength(ALL.length);
  });

  it('matches against package name', () => {
    const result = filterPackages(ALL, { type: 'all', category: null, search: 'alpha' });
    expect(result.map((p) => p.name)).toEqual(
      expect.arrayContaining(['alpha-plugin', 'alpha-agent'])
    );
    expect(result).not.toContainEqual(expect.objectContaining({ name: 'beta-plugin' }));
  });

  it('matches against description', () => {
    const result = filterPackages(ALL, { type: 'all', category: null, search: 'AI agent' });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('alpha-agent');
  });

  it('matches against keywords', () => {
    const result = filterPackages(ALL, { type: 'all', category: null, search: 'theme' });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('alpha-plugin');
  });

  it('matches against tags', () => {
    const taggedPkg = pkg({ name: 'tagged', tags: ['automation', 'llm'] });
    const result = filterPackages([taggedPkg], { type: 'all', category: null, search: 'llm' });
    expect(result).toHaveLength(1);
  });

  it('is case-insensitive', () => {
    const result = filterPackages(ALL, { type: 'all', category: null, search: 'ALPHA' });
    expect(result.map((p) => p.name)).toEqual(
      expect.arrayContaining(['alpha-plugin', 'alpha-agent'])
    );
  });

  it('returns empty array when no packages match the search', () => {
    const result = filterPackages(ALL, { type: 'all', category: null, search: 'zzznomatch' });
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Combined filters
// ---------------------------------------------------------------------------

describe('filterPackages — combined filters', () => {
  it('applies type and category together', () => {
    const result = filterPackages(ALL, { type: 'plugin', category: 'productivity', search: '' });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('beta-plugin');
  });

  it('applies type and search together', () => {
    const result = filterPackages(ALL, { type: 'plugin', category: null, search: 'alpha' });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('alpha-plugin');
  });

  it('applies all three filters simultaneously', () => {
    const result = filterPackages(ALL, { type: 'plugin', category: 'ui', search: 'alpha' });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('alpha-plugin');
  });

  it('returns empty array when combined filters match nothing', () => {
    const result = filterPackages(ALL, { type: 'agent', category: 'ui', search: 'alpha' });
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('filterPackages — edge cases', () => {
  it('returns empty array for empty input', () => {
    const result = filterPackages([], { type: 'all', category: null, search: '' });
    expect(result).toHaveLength(0);
  });

  it('does not mutate the input array', () => {
    const input = [...ALL];
    filterPackages(input, { type: 'plugin', category: null, search: '' });
    expect(input).toHaveLength(ALL.length);
  });
});
