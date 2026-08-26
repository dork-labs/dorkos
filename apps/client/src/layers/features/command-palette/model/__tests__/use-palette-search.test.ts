import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePaletteSearch, parsePrefix } from '../use-palette-search';
import type { PaletteSearchOptions, SearchableItem } from '../use-palette-search';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';

/** Nothing used, nothing fresh — so these tests read relevance and nothing else. */
const NEUTRAL: PaletteSearchOptions = {
  usage: {},
  now: Date.parse('2026-08-10T12:00:00.000Z'),
  scope: null,
};

/** The ranking fields of a row with no history behind it. */
const UNRANKED = {
  usageKey: null,
  lastActivityAt: null,
  waiting: false,
  demoted: false,
  scopes: [],
} as const;

const mockItems: SearchableItem[] = [
  {
    id: 'agent-1',
    name: 'Auth Service',
    type: 'agent',
    keywords: ['/projects/auth'],
    ...UNRANKED,
    data: {
      id: 'agent-1',
      name: 'Auth Service',
      projectPath: '/projects/auth',
    } satisfies AgentPathEntry,
  },
  {
    id: 'agent-2',
    name: 'API Gateway',
    type: 'agent',
    keywords: ['/projects/api'],
    ...UNRANKED,
    data: {
      id: 'agent-2',
      name: 'API Gateway',
      projectPath: '/projects/api',
    } satisfies AgentPathEntry,
  },
  {
    id: 'feature-1',
    name: 'Scheduled tasks',
    type: 'feature',
    ...UNRANKED,
    data: { id: 'tasks', label: 'Scheduled tasks', icon: 'Clock', action: 'openTasks' },
  },
  {
    id: 'cmd-1',
    name: '/hello',
    type: 'command',
    keywords: ['greeting'],
    ...UNRANKED,
    data: { name: '/hello', description: 'Say hello' },
  },
];

/**
 * Every row the hook produced, best match first.
 *
 * The hook hands the standout row back separately, and almost every claim in
 * this file is about the list as a person reads it — top to bottom, one list.
 */
function allRows(result: ReturnType<typeof usePaletteSearch>) {
  return result.bestMatch ? [result.bestMatch, ...result.rows] : result.rows;
}

describe('parsePrefix', () => {
  it('detects @ prefix for agents', () => {
    expect(parsePrefix('@auth')).toEqual({ prefix: '@', term: 'auth' });
  });

  it('detects > prefix for commands', () => {
    expect(parsePrefix('>hello')).toEqual({ prefix: '>', term: 'hello' });
  });

  it('returns null prefix for plain search', () => {
    expect(parsePrefix('auth')).toEqual({ prefix: null, term: 'auth' });
  });

  it('handles prefix with empty term', () => {
    expect(parsePrefix('@')).toEqual({ prefix: '@', term: '' });
  });
});

describe('usePaletteSearch', () => {
  it('returns all items when search is empty', () => {
    const { result } = renderHook(() => usePaletteSearch(mockItems, '', NEUTRAL));
    expect(allRows(result.current)).toHaveLength(4);
    expect(allRows(result.current)[0]!.item.matches).toBeUndefined();
  });

  it('filters by @ prefix (agents only)', () => {
    const { result } = renderHook(() => usePaletteSearch(mockItems, '@', NEUTRAL));
    expect(allRows(result.current).every((r) => r.item.item.type === 'agent')).toBe(true);
    expect(result.current.prefix).toBe('@');
  });

  it('filters by > prefix (commands only)', () => {
    const { result } = renderHook(() => usePaletteSearch(mockItems, '>', NEUTRAL));
    expect(allRows(result.current).every((r) => r.item.item.type === 'command')).toBe(true);
    expect(result.current.prefix).toBe('>');
  });

  it('returns match indices for highlighting', () => {
    const { result } = renderHook(() => usePaletteSearch(mockItems, 'auth', NEUTRAL));
    const authResult = allRows(result.current).find((r) => r.item.item.id === 'agent-1');
    expect(authResult).toBeDefined();
    expect(authResult!.item.matches).toBeDefined();
    expect(authResult!.item.matches!.length).toBeGreaterThan(0);
  });

  it('handles typo-tolerant matching', () => {
    const { result } = renderHook(() => usePaletteSearch(mockItems, 'autth', NEUTRAL));
    expect(allRows(result.current).map((r) => r.item.item.id)).toContain('agent-1');
  });

  it('returns empty results when no match', () => {
    const { result } = renderHook(() => usePaletteSearch(mockItems, 'zzzznotexist', NEUTRAL));
    expect(allRows(result.current)).toHaveLength(0);
  });

  it('scores exact matches higher than partial matches', () => {
    const { result } = renderHook(() => usePaletteSearch(mockItems, 'Auth Service', NEUTRAL));
    expect(allRows(result.current)[0]!.item.item.id).toBe('agent-1');
  });

  // A palette entry's keywords are only useful if Fuse actually surfaces the
  // entry when someone types the alias, not the label — this is what a Wave 2
  // rename (e.g. "Integrations" gaining a "connectors" alias) depends on. The
  // fixture's label ("Relay & Adapters") shares no substring with "connectors",
  // so a pass here can only be explained by the keyword match, not the label
  // — and it pins Fuse's 0.3 threshold as the knob that could silently break
  // this (DOR-854 review).
  it('surfaces an entry by its keyword alias, not just its label', () => {
    const itemsWithAlias: SearchableItem[] = [
      ...mockItems,
      {
        id: 'feature-relay',
        name: 'Relay & Adapters',
        type: 'feature',
        keywords: ['connectors', 'telegram', 'slack'],
        ...UNRANKED,
        data: {
          id: 'relay',
          label: 'Relay & Adapters',
          icon: 'Radio',
          action: 'openRelay',
        },
      },
    ];

    const { result } = renderHook(() => usePaletteSearch(itemsWithAlias, 'connectors', NEUTRAL));
    expect(allRows(result.current).map((r) => r.item.item.id)).toContain('feature-relay');
  });
});

/**
 * The hook's own half of the ranking claim: that a real Fuse score reaches the
 * ranker at all.
 *
 * `palette-ranking.test.ts` proves what the scorer does with a distance; this
 * proves the hook produces one, from real Fuse, and that usage keyed off the
 * corpus lands on the right row. Between them the wire is covered end to end —
 * the failure this guards against is the one the programme keeps catching, a
 * mechanism that is correct and never called.
 */
describe('the ranking the hook actually feeds', () => {
  it('separates a strong match from a weak one instead of scoring both alike', () => {
    const { result } = renderHook(() => usePaletteSearch(mockItems, 'auth', NEUTRAL));
    const rows = allRows(result.current);
    const auth = rows.find((r) => r.item.item.id === 'agent-1');
    expect(auth).toBeDefined();
    // Relevance is a real, varying number — not the flat 1 that `includeScore:
    // false` would leave every row with.
    expect(auth!.signals.relevance).toBeGreaterThan(0);
    expect(auth!.signals.relevance).toBeLessThanOrEqual(1);
    const others = rows.filter((r) => r.item.item.id !== 'agent-1');
    for (const other of others) {
      expect(other.signals.relevance).toBeLessThan(auth!.signals.relevance);
    }
  });

  it('lifts the agent you use over an equally-named one you never touch', () => {
    // Two rows that match `gateway` and `service` differently is not the point;
    // this asks the same query of two rows and changes only the history.
    const twins: SearchableItem[] = [
      { ...mockItems[0]!, id: 'twin-a', name: 'Deploy Runner', usageKey: 'agent:/a' },
      { ...mockItems[1]!, id: 'twin-b', name: 'Deploy Runner', usageKey: 'agent:/b' },
    ];
    const now = Date.parse('2026-08-10T12:00:00.000Z');
    const { result } = renderHook(() =>
      usePaletteSearch(twins, 'deploy', {
        now,
        scope: null,
        usage: { 'agent:/b': { lastUsedAt: now - 60_000, useCount: 12 } },
      })
    );
    expect(allRows(result.current).map((r) => r.item.item.id)).toEqual(['twin-b', 'twin-a']);
  });
});
