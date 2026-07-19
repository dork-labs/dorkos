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
    const result = filterPackages(ALL, { type: 'all', categories: [], search: '' });
    expect(result).toHaveLength(ALL.length);
  });

  it('filters to only plugin packages', () => {
    const result = filterPackages(ALL, { type: 'plugin', categories: [], search: '' });
    expect(result.map((p) => p.name)).toEqual(
      expect.arrayContaining(['alpha-plugin', 'beta-plugin'])
    );
    expect(result).not.toContainEqual(expect.objectContaining({ name: 'alpha-agent' }));
  });

  it('treats packages with no type field as "plugin"', () => {
    const result = filterPackages(ALL, { type: 'plugin', categories: [], search: '' });
    expect(result).toContainEqual(expect.objectContaining({ name: 'untyped-package' }));
  });

  it('does not include untyped packages when filtering by non-plugin types', () => {
    const result = filterPackages(ALL, { type: 'agent', categories: [], search: '' });
    expect(result).not.toContainEqual(expect.objectContaining({ name: 'untyped-package' }));
  });

  it('filters to only agent packages', () => {
    const result = filterPackages(ALL, { type: 'agent', categories: [], search: '' });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('alpha-agent');
  });

  it('filters to only skill-pack packages', () => {
    const result = filterPackages(ALL, { type: 'skill-pack', categories: [], search: '' });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('code-skills');
  });

  it('returns empty array when no packages match the type', () => {
    const result = filterPackages(ALL, { type: 'adapter', categories: [], search: '' });
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Category filter
// ---------------------------------------------------------------------------

describe('filterPackages — category filter', () => {
  it('returns all packages when no categories are selected', () => {
    const result = filterPackages(ALL, { type: 'all', categories: [], search: '' });
    expect(result).toHaveLength(ALL.length);
  });

  it('filters by exact category match', () => {
    const result = filterPackages(ALL, { type: 'all', categories: ['ui'], search: '' });
    expect(result.map((p) => p.name)).toEqual(
      expect.arrayContaining(['alpha-plugin', 'untyped-package'])
    );
    expect(result).not.toContainEqual(expect.objectContaining({ name: 'alpha-agent' }));
  });

  it('returns empty array when the category matches nothing', () => {
    const result = filterPackages(ALL, { type: 'all', categories: ['nonexistent'], search: '' });
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Category membership filter (categories[] with singular fallback)
// ---------------------------------------------------------------------------

describe('filterPackages — category membership', () => {
  // Primary member: 'security' is categories[0] and the singular category.
  const MULTI = pkg({
    name: 'multi',
    categories: ['security', 'code-review'],
    category: 'security',
  });
  // Non-primary member: 'security' is present but not first.
  const SECONDARY = pkg({ name: 'secondary', categories: ['documentation', 'security'] });
  // Legacy: singular category only, no categories[] list.
  const LEGACY = pkg({ name: 'legacy', category: 'security' });
  // Not a security package at all.
  const OTHER = pkg({ name: 'other', categories: ['documentation'], category: 'documentation' });
  const MEMBERS = [MULTI, SECONDARY, LEGACY, OTHER];

  it('matches a package whose categories[] includes the slug (primary member)', () => {
    const result = filterPackages([MULTI, OTHER], {
      type: 'all',
      categories: ['security'],
      search: '',
    });
    expect(result.map((p) => p.name)).toEqual(['multi']);
  });

  it('matches a package whose categories[] includes the slug as a non-primary member', () => {
    const result = filterPackages([SECONDARY, OTHER], {
      type: 'all',
      categories: ['security'],
      search: '',
    });
    expect(result.map((p) => p.name)).toEqual(['secondary']);
  });

  it('matches a legacy singular-category package via the fallback', () => {
    const result = filterPackages([LEGACY, OTHER], {
      type: 'all',
      categories: ['security'],
      search: '',
    });
    expect(result.map((p) => p.name)).toEqual(['legacy']);
  });

  it('matches every member (categories[] and singular) for a shared slug', () => {
    const result = filterPackages(MEMBERS, { type: 'all', categories: ['security'], search: '' });
    expect(result.map((p) => p.name)).toEqual(['multi', 'secondary', 'legacy']);
  });

  it('excludes non-members', () => {
    const result = filterPackages(MEMBERS, {
      type: 'all',
      categories: ['code-review'],
      search: '',
    });
    expect(result.map((p) => p.name)).toEqual(['multi']);
  });
});

// ---------------------------------------------------------------------------
// Multi-select categories (OR-combined)
// ---------------------------------------------------------------------------

describe('filterPackages — multi-select categories (OR)', () => {
  const SEC = pkg({ name: 'sec', categories: ['security'] });
  const REV = pkg({ name: 'rev', categories: ['code-review'] });
  const DOCS = pkg({ name: 'docs', categories: ['documentation'] });
  const LEGACY_SEC = pkg({ name: 'legacy-sec', category: 'security' });
  const POOL = [SEC, REV, DOCS, LEGACY_SEC];

  it('keeps packages belonging to ANY selected category', () => {
    const result = filterPackages(POOL, {
      type: 'all',
      categories: ['security', 'code-review'],
      search: '',
    });
    // sec + legacy-sec (security) OR rev (code-review); docs is excluded.
    expect(result.map((p) => p.name)).toEqual(['sec', 'rev', 'legacy-sec']);
  });

  it('is inclusive — a package matching two selected categories appears once', () => {
    const BOTH = pkg({ name: 'both', categories: ['security', 'code-review'] });
    const result = filterPackages([BOTH, DOCS], {
      type: 'all',
      categories: ['security', 'code-review'],
      search: '',
    });
    expect(result.map((p) => p.name)).toEqual(['both']);
  });

  it('combines the OR category set with the type filter (AND across axes)', () => {
    const AGENT_SEC = pkg({ name: 'agent-sec', type: 'agent', categories: ['security'] });
    const PLUGIN_REV = pkg({ name: 'plugin-rev', type: 'plugin', categories: ['code-review'] });
    const result = filterPackages([AGENT_SEC, PLUGIN_REV, SEC], {
      type: 'agent',
      categories: ['security', 'code-review'],
      search: '',
    });
    // Only agents whose category is in the OR set survive.
    expect(result.map((p) => p.name)).toEqual(['agent-sec']);
  });
});

// ---------------------------------------------------------------------------
// Search filter
// ---------------------------------------------------------------------------

describe('filterPackages — search filter', () => {
  it('returns all packages when search is empty string', () => {
    const result = filterPackages(ALL, { type: 'all', categories: [], search: '' });
    expect(result).toHaveLength(ALL.length);
  });

  it('returns all packages when search is only whitespace', () => {
    const result = filterPackages(ALL, { type: 'all', categories: [], search: '   ' });
    expect(result).toHaveLength(ALL.length);
  });

  it('matches against package name', () => {
    const result = filterPackages(ALL, { type: 'all', categories: [], search: 'alpha' });
    expect(result.map((p) => p.name)).toEqual(
      expect.arrayContaining(['alpha-plugin', 'alpha-agent'])
    );
    expect(result).not.toContainEqual(expect.objectContaining({ name: 'beta-plugin' }));
  });

  it('matches against description', () => {
    const result = filterPackages(ALL, { type: 'all', categories: [], search: 'AI agent' });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('alpha-agent');
  });

  it('matches against keywords', () => {
    const result = filterPackages(ALL, { type: 'all', categories: [], search: 'theme' });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('alpha-plugin');
  });

  it('matches against tags', () => {
    const taggedPkg = pkg({ name: 'tagged', tags: ['automation', 'llm'] });
    const result = filterPackages([taggedPkg], { type: 'all', categories: [], search: 'llm' });
    expect(result).toHaveLength(1);
  });

  it('is case-insensitive', () => {
    const result = filterPackages(ALL, { type: 'all', categories: [], search: 'ALPHA' });
    expect(result.map((p) => p.name)).toEqual(
      expect.arrayContaining(['alpha-plugin', 'alpha-agent'])
    );
  });

  it('returns empty array when no packages match the search', () => {
    const result = filterPackages(ALL, { type: 'all', categories: [], search: 'zzznomatch' });
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Combined filters
// ---------------------------------------------------------------------------

describe('filterPackages — combined filters', () => {
  it('applies type and category together', () => {
    const result = filterPackages(ALL, {
      type: 'plugin',
      categories: ['productivity'],
      search: '',
    });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('beta-plugin');
  });

  it('applies type and search together', () => {
    const result = filterPackages(ALL, { type: 'plugin', categories: [], search: 'alpha' });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('alpha-plugin');
  });

  it('applies all three filters simultaneously', () => {
    const result = filterPackages(ALL, { type: 'plugin', categories: ['ui'], search: 'alpha' });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('alpha-plugin');
  });

  it('returns empty array when combined filters match nothing', () => {
    const result = filterPackages(ALL, { type: 'agent', categories: ['ui'], search: 'alpha' });
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('filterPackages — edge cases', () => {
  it('returns empty array for empty input', () => {
    const result = filterPackages([], { type: 'all', categories: [], search: '' });
    expect(result).toHaveLength(0);
  });

  it('does not mutate the input array', () => {
    const input = [...ALL];
    filterPackages(input, { type: 'plugin', categories: [], search: '' });
    expect(input).toHaveLength(ALL.length);
  });
});
