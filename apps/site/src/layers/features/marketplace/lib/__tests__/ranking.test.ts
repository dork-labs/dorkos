import { describe, it, expect } from 'vitest';
import type { MarketplaceJsonEntry } from '@dorkos/marketplace';
import { rankPackages } from '../ranking';

function makePkg(
  overrides: Partial<MarketplaceJsonEntry> & { name: string }
): MarketplaceJsonEntry {
  return {
    name: overrides.name,
    source: overrides.source ?? `https://github.com/example/${overrides.name}`,
    ...overrides,
  };
}

describe('rankPackages', () => {
  it('ranks featured packages above non-featured when install counts are equal', () => {
    const packages: MarketplaceJsonEntry[] = [
      makePkg({ name: 'plain', featured: false }),
      makePkg({ name: 'starred', featured: true }),
    ];
    const result = rankPackages(packages, { plain: 0, starred: 0 });
    expect(result.map((p) => p.name)).toEqual(['starred', 'plain']);
  });

  it('lets a high-install non-featured package rank above a low-install featured package', () => {
    const packages: MarketplaceJsonEntry[] = [
      makePkg({ name: 'starred', featured: true }),
      makePkg({ name: 'popular', featured: false }),
    ];
    // Featured = 100. Non-featured needs log(installs) * 10 > 100, so installs > e^10 ~ 22026.
    const result = rankPackages(packages, { starred: 1, popular: 25_000 });
    expect(result[0]!.name).toBe('popular');
    expect(result[1]!.name).toBe('starred');
  });

  it('filters by type and excludes wrong-type entries', () => {
    const packages: MarketplaceJsonEntry[] = [
      makePkg({ name: 'agent-a', type: 'agent' }),
      makePkg({ name: 'plugin-a', type: 'plugin' }),
      makePkg({ name: 'agent-b', type: 'agent' }),
    ];
    const result = rankPackages(packages, {}, { type: 'agent' });
    expect(result.map((p) => p.name).sort()).toEqual(['agent-a', 'agent-b']);
  });

  it('filters by category and excludes wrong-category entries', () => {
    const packages: MarketplaceJsonEntry[] = [
      makePkg({ name: 'sec-a', category: 'security' }),
      makePkg({ name: 'fe-a', category: 'frontend' }),
      makePkg({ name: 'sec-b', category: 'security' }),
    ];
    const result = rankPackages(packages, {}, { category: 'security' });
    expect(result.map((p) => p.name).sort()).toEqual(['sec-a', 'sec-b']);
  });

  it('search filter matches name, description, or any tag (case-insensitive)', () => {
    const packages: MarketplaceJsonEntry[] = [
      makePkg({ name: 'audit-tool' }),
      makePkg({ name: 'reviewer', description: 'Performs an AUDIT pass' }),
      makePkg({ name: 'helper', tags: ['Audit', 'security'] }),
      makePkg({ name: 'unrelated', description: 'something else', tags: ['frontend'] }),
    ];
    const result = rankPackages(packages, {}, { q: 'audit' });
    expect(result.map((p) => p.name).sort()).toEqual(['audit-tool', 'helper', 'reviewer']);
  });

  it('composes type, category, and search filters', () => {
    const packages: MarketplaceJsonEntry[] = [
      makePkg({
        name: 'security-audit-agent',
        type: 'agent',
        category: 'security',
        tags: ['audit'],
      }),
      makePkg({ name: 'security-plugin', type: 'plugin', category: 'security', tags: ['audit'] }),
      makePkg({
        name: 'frontend-audit-agent',
        type: 'agent',
        category: 'frontend',
        tags: ['audit'],
      }),
      makePkg({
        name: 'security-agent-other',
        type: 'agent',
        category: 'security',
        tags: ['logging'],
      }),
    ];
    const result = rankPackages(
      packages,
      {},
      {
        type: 'agent',
        category: 'security',
        q: 'audit',
      }
    );
    expect(result.map((p) => p.name)).toEqual(['security-audit-agent']);
  });

  it('returns all packages sorted by score when filters are empty', () => {
    const packages: MarketplaceJsonEntry[] = [
      makePkg({ name: 'a', featured: false }),
      makePkg({ name: 'b', featured: true }),
      makePkg({ name: 'c', featured: false }),
    ];
    const result = rankPackages(packages, { a: 1, b: 1, c: 1 });
    expect(result).toHaveLength(3);
    expect(result[0]!.name).toBe('b');
    // Scores are sorted descending
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1]!.score).toBeGreaterThanOrEqual(result[i]!.score);
    }
  });

  it('treats missing install counts as zero (log(1) = 0 contribution)', () => {
    const packages: MarketplaceJsonEntry[] = [
      makePkg({ name: 'unknown', featured: false }),
      makePkg({ name: 'tracked', featured: false }),
    ];
    const result = rankPackages(packages, { tracked: 1 });
    const unknown = result.find((p) => p.name === 'unknown')!;
    const tracked = result.find((p) => p.name === 'tracked')!;
    expect(unknown.score).toBe(0);
    expect(tracked.score).toBe(0);
  });

  it('preserves all original entry fields plus the score', () => {
    const original = makePkg({
      name: 'preserved',
      description: 'desc',
      type: 'agent',
      category: 'security',
      tags: ['a', 'b'],
      icon: 'icon',
      featured: true,
      version: '1.2.3',
      author: 'someone',
    });
    const [result] = rankPackages([original], { preserved: 5 });
    expect(result).toBeDefined();
    expect(result).toMatchObject(original);
    expect(result!.score).toBeGreaterThan(0);
    expect(typeof result!.score).toBe('number');
  });
});
