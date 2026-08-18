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
    const result = filterPackages(ALL, { type: 'all', categories: [], sources: [], search: '' });
    expect(result).toHaveLength(ALL.length);
  });

  it('filters to only plugin packages', () => {
    const result = filterPackages(ALL, { type: 'plugin', categories: [], sources: [], search: '' });
    expect(result.map((p) => p.name)).toEqual(
      expect.arrayContaining(['alpha-plugin', 'beta-plugin'])
    );
    expect(result).not.toContainEqual(expect.objectContaining({ name: 'alpha-agent' }));
  });

  it('treats packages with no type field as "plugin"', () => {
    const result = filterPackages(ALL, { type: 'plugin', categories: [], sources: [], search: '' });
    expect(result).toContainEqual(expect.objectContaining({ name: 'untyped-package' }));
  });

  it('does not include untyped packages when filtering by non-plugin types', () => {
    const result = filterPackages(ALL, { type: 'agent', categories: [], sources: [], search: '' });
    expect(result).not.toContainEqual(expect.objectContaining({ name: 'untyped-package' }));
  });

  it('filters to only agent packages', () => {
    const result = filterPackages(ALL, { type: 'agent', categories: [], sources: [], search: '' });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('alpha-agent');
  });

  it('filters to only skill-pack packages', () => {
    const result = filterPackages(ALL, {
      type: 'skill-pack',
      categories: [],
      sources: [],
      search: '',
    });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('code-skills');
  });

  it('returns empty array when no packages match the type', () => {
    const result = filterPackages(ALL, {
      type: 'adapter',
      categories: [],
      sources: [],
      search: '',
    });
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Connector filter (refinement of the adapter facet)
// ---------------------------------------------------------------------------

describe('filterPackages — connector filter', () => {
  const CONNECTOR = pkg({ name: 'composio-gateway', type: 'adapter', adapterType: 'connector' });
  const PLAIN_ADAPTER = pkg({ name: 'slack-adapter', type: 'adapter', adapterType: 'slack' });
  const UNTYPED_ADAPTER = pkg({ name: 'bare-adapter', type: 'adapter' });
  // adapterType without type: 'adapter' — must NOT read as a connector.
  const MISLABELED = pkg({ name: 'mislabeled-plugin', type: 'plugin', adapterType: 'connector' });
  const POOL = [CONNECTOR, PLAIN_ADAPTER, UNTYPED_ADAPTER, MISLABELED, AGENT_A];

  it('narrows to adapters whose adapterType is the connector value', () => {
    const result = filterPackages(POOL, {
      type: 'connector',
      categories: [],
      sources: [],
      search: '',
    });
    expect(result.map((p) => p.name)).toEqual(['composio-gateway']);
  });

  it('keeps connector adapters inside the generic adapter filter', () => {
    const result = filterPackages(POOL, {
      type: 'adapter',
      categories: [],
      sources: [],
      search: '',
    });
    expect(result.map((p) => p.name)).toEqual([
      'composio-gateway',
      'slack-adapter',
      'bare-adapter',
    ]);
  });

  it('ignores adapterType on non-adapter packages', () => {
    const result = filterPackages([MISLABELED], {
      type: 'connector',
      categories: [],
      sources: [],
      search: '',
    });
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Category filter
// ---------------------------------------------------------------------------

describe('filterPackages — category filter', () => {
  it('returns all packages when no categories are selected', () => {
    const result = filterPackages(ALL, { type: 'all', categories: [], sources: [], search: '' });
    expect(result).toHaveLength(ALL.length);
  });

  it('filters by exact category match', () => {
    const result = filterPackages(ALL, {
      type: 'all',
      categories: ['ui'],
      sources: [],
      search: '',
    });
    expect(result.map((p) => p.name)).toEqual(
      expect.arrayContaining(['alpha-plugin', 'untyped-package'])
    );
    expect(result).not.toContainEqual(expect.objectContaining({ name: 'alpha-agent' }));
  });

  it('returns empty array when the category matches nothing', () => {
    const result = filterPackages(ALL, {
      type: 'all',
      categories: ['nonexistent'],
      sources: [],
      search: '',
    });
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
      sources: [],
      search: '',
    });
    expect(result.map((p) => p.name)).toEqual(['multi']);
  });

  it('matches a package whose categories[] includes the slug as a non-primary member', () => {
    const result = filterPackages([SECONDARY, OTHER], {
      type: 'all',
      categories: ['security'],
      sources: [],
      search: '',
    });
    expect(result.map((p) => p.name)).toEqual(['secondary']);
  });

  it('matches a legacy singular-category package via the fallback', () => {
    const result = filterPackages([LEGACY, OTHER], {
      type: 'all',
      categories: ['security'],
      sources: [],
      search: '',
    });
    expect(result.map((p) => p.name)).toEqual(['legacy']);
  });

  it('matches every member (categories[] and singular) for a shared slug', () => {
    const result = filterPackages(MEMBERS, {
      type: 'all',
      categories: ['security'],
      sources: [],
      search: '',
    });
    expect(result.map((p) => p.name)).toEqual(['multi', 'secondary', 'legacy']);
  });

  it('excludes non-members', () => {
    const result = filterPackages(MEMBERS, {
      type: 'all',
      categories: ['code-review'],
      sources: [],
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
      sources: [],
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
      sources: [],
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
      sources: [],
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
    const result = filterPackages(ALL, { type: 'all', categories: [], sources: [], search: '' });
    expect(result).toHaveLength(ALL.length);
  });

  it('returns all packages when search is only whitespace', () => {
    const result = filterPackages(ALL, { type: 'all', categories: [], sources: [], search: '   ' });
    expect(result).toHaveLength(ALL.length);
  });

  it('matches against package name', () => {
    const result = filterPackages(ALL, {
      type: 'all',
      categories: [],
      sources: [],
      search: 'alpha',
    });
    expect(result.map((p) => p.name)).toEqual(
      expect.arrayContaining(['alpha-plugin', 'alpha-agent'])
    );
    expect(result).not.toContainEqual(expect.objectContaining({ name: 'beta-plugin' }));
  });

  it('matches against description', () => {
    const result = filterPackages(ALL, {
      type: 'all',
      categories: [],
      sources: [],
      search: 'AI agent',
    });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('alpha-agent');
  });

  it('matches against keywords', () => {
    const result = filterPackages(ALL, {
      type: 'all',
      categories: [],
      sources: [],
      search: 'theme',
    });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('alpha-plugin');
  });

  it('matches against tags', () => {
    const taggedPkg = pkg({ name: 'tagged', tags: ['automation', 'llm'] });
    const result = filterPackages([taggedPkg], {
      type: 'all',
      categories: [],
      sources: [],
      search: 'llm',
    });
    expect(result).toHaveLength(1);
  });

  it('is case-insensitive', () => {
    const result = filterPackages(ALL, {
      type: 'all',
      categories: [],
      sources: [],
      search: 'ALPHA',
    });
    expect(result.map((p) => p.name)).toEqual(
      expect.arrayContaining(['alpha-plugin', 'alpha-agent'])
    );
  });

  it('returns empty array when no packages match the search', () => {
    const result = filterPackages(ALL, {
      type: 'all',
      categories: [],
      sources: [],
      search: 'zzznomatch',
    });
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
      sources: [],
      search: '',
    });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('beta-plugin');
  });

  it('applies type and search together', () => {
    const result = filterPackages(ALL, {
      type: 'plugin',
      categories: [],
      sources: [],
      search: 'alpha',
    });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('alpha-plugin');
  });

  it('applies all three filters simultaneously', () => {
    const result = filterPackages(ALL, {
      type: 'plugin',
      categories: ['ui'],
      sources: [],
      search: 'alpha',
    });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('alpha-plugin');
  });

  it('returns empty array when combined filters match nothing', () => {
    const result = filterPackages(ALL, {
      type: 'agent',
      categories: ['ui'],
      sources: [],
      search: 'alpha',
    });
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('filterPackages — edge cases', () => {
  it('returns empty array for empty input', () => {
    const result = filterPackages([], { type: 'all', categories: [], sources: [], search: '' });
    expect(result).toHaveLength(0);
  });

  it('does not mutate the input array', () => {
    const input = [...ALL];
    filterPackages(input, { type: 'plugin', categories: [], sources: [], search: '' });
    expect(input).toHaveLength(ALL.length);
  });
});

// ---------------------------------------------------------------------------
// Source filter
// ---------------------------------------------------------------------------

describe('filterPackages — source filter', () => {
  const NATIVE = pkg({ name: 'flow', marketplace: 'dorkos-community' });
  const MIRRORED = pkg({ name: 'mirrored', marketplace: 'claude-plugins-official' });
  const CUSTOM = pkg({ name: 'mine', marketplace: 'my-own-registry' });
  const CATALOG = [NATIVE, MIRRORED, CUSTOM];

  it('returns every package when no source is selected', () => {
    const result = filterPackages(CATALOG, {
      type: 'all',
      categories: [],
      sources: [],
      search: '',
    });
    expect(result).toHaveLength(3);
  });

  it('keeps only packages from the selected source', () => {
    const result = filterPackages(CATALOG, {
      type: 'all',
      categories: [],
      sources: ['claude-plugins-official'],
      search: '',
    });
    expect(result.map((p) => p.name)).toEqual(['mirrored']);
  });

  it('ORs across several selected sources', () => {
    const result = filterPackages(CATALOG, {
      type: 'all',
      categories: [],
      sources: ['dorkos-community', 'my-own-registry'],
      search: '',
    });
    expect(result.map((p) => p.name)).toEqual(['flow', 'mine']);
  });

  it('combines with the type filter rather than replacing it', () => {
    const result = filterPackages(
      [pkg({ name: 'agent-x', type: 'agent', marketplace: 'dorkos-community' }), NATIVE],
      { type: 'agent', categories: [], sources: ['dorkos-community'], search: '' }
    );
    expect(result.map((p) => p.name)).toEqual(['agent-x']);
  });
});
