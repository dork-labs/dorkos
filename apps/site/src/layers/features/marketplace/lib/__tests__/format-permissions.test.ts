import { describe, it, expect } from 'vitest';
import type { MarketplaceJsonEntry } from '@dorkos/marketplace';
import { formatPermissions } from '../format-permissions';

function makePkg(
  overrides: Partial<MarketplaceJsonEntry> & { name: string }
): MarketplaceJsonEntry {
  return {
    name: overrides.name,
    source: overrides.source ?? `https://github.com/example/${overrides.name}`,
    ...overrides,
  };
}

describe('formatPermissions', () => {
  it('returns one claim per declared layer', () => {
    const pkg = makePkg({
      name: 'multi-layer',
      layers: ['skills', 'tasks', 'commands'],
    });

    const claims = formatPermissions(pkg);

    expect(claims).toHaveLength(3);
    expect(claims.map((c) => c.label)).toEqual([
      'Adds skill files',
      'Schedules background tasks',
      'Adds slash commands',
    ]);
    for (const claim of claims) {
      expect(claim.detail).toContain('.dork/marketplaces/dorkos-community/multi-layer/');
    }
  });

  it('marks hooks and mcp-servers as warn-level', () => {
    const pkg = makePkg({
      name: 'risky',
      layers: ['skills', 'hooks', 'mcp-servers', 'commands'],
    });

    const claims = formatPermissions(pkg);

    const byLabel = new Map(claims.map((c) => [c.label, c.level]));
    expect(byLabel.get('Adds skill files')).toBe('info');
    expect(byLabel.get('Adds slash commands')).toBe('info');
    expect(byLabel.get('Installs lifecycle hooks')).toBe('warn');
    expect(byLabel.get('Adds MCP servers')).toBe('warn');
  });

  it('returns the no-permissions sentinel when layers is missing or empty', () => {
    const missing = formatPermissions(makePkg({ name: 'no-layers' }));
    const empty = formatPermissions(makePkg({ name: 'empty-layers', layers: [] }));

    for (const claims of [missing, empty]) {
      expect(claims).toHaveLength(1);
      expect(claims[0]?.label).toBe('No declared permissions');
      expect(claims[0]?.level).toBe('info');
      expect(claims[0]?.detail).toContain('full preview is shown at install time');
    }
  });

  it('skips unknown layer values and falls back to the sentinel when none are recognized', () => {
    const pkgWithUnknownOnly = makePkg({
      name: 'unknown-only',
      // Cast to bypass the Zod-derived literal union — simulates a future
      // layer name we have not yet added a label for.
      layers: ['something-new' as never],
    });
    const sentinel = formatPermissions(pkgWithUnknownOnly);
    expect(sentinel).toHaveLength(1);
    expect(sentinel[0]?.label).toBe('No declared permissions');

    const pkgMixed = makePkg({
      name: 'mixed',
      layers: ['skills', 'something-new' as never, 'agents'],
    });
    const mixed = formatPermissions(pkgMixed);
    expect(mixed).toHaveLength(2);
    expect(mixed.map((c) => c.label)).toEqual(['Adds skill files', 'Adds agent definitions']);
  });
});
