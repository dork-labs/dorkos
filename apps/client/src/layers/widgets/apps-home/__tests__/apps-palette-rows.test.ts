import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { CommandPaletteContribution } from '@/layers/shared/model';
import { usePaletteSearch, type SearchableItem } from '@/layers/features/command-palette';
import { appSettingsPaletteRow } from '../model/use-apps-palette';

/** A feature row, shaped as `usePaletteItems` shapes it, with no history. */
function featureItem(row: CommandPaletteContribution): SearchableItem {
  return {
    id: row.id,
    name: row.label,
    type: 'feature',
    keywords: row.keywords,
    usageKey: null,
    lastActivityAt: null,
    waiting: false,
    demoted: false,
    scopes: [],
    data: row,
  };
}

const PLAIN_SETTINGS: CommandPaletteContribution = {
  id: 'settings',
  label: 'Settings',
  icon: 'Settings',
  action: 'openSettings',
  category: 'feature',
};

// Ids that sort before "settings", the way the tie used to break.
const ITEMS: SearchableItem[] = [
  featureItem(PLAIN_SETTINGS),
  featureItem(appSettingsPaletteRow({ id: 'board', name: 'Board' })),
  featureItem(appSettingsPaletteRow({ id: 'agent-notes', name: 'Agent Notes' })),
];

/** The labels the real search and ranking put first-to-last for a query. */
function ranked(query: string): string[] {
  const { result } = renderHook(() =>
    usePaletteSearch(ITEMS, query, {
      usage: {},
      now: Date.parse('2026-11-08T12:00:00.000Z'),
      scope: null,
    })
  );
  const rows = result.current.bestMatch
    ? [result.current.bestMatch, ...result.current.rows]
    : result.current.rows;
  return rows.map((row) => row.item.item.name);
}

describe('app settings rows in the palette', () => {
  // ⌘K, "settings", Enter opened Settings on the first app's row (Board).
  it.each(['settings', 'sett', 'Settings'])('leave the plain Settings row first for "%s"', (q) => {
    expect(ranked(q)[0]).toBe('Settings');
  });

  it('still come up for "settings", below the plain row', () => {
    expect(ranked('settings')).toEqual(
      expect.arrayContaining(['Board settings', 'Agent Notes settings'])
    );
  });

  it('put an app first when you type its name', () => {
    expect(ranked('board')[0]).toBe('Board settings');
  });

  it('find an app by its full row title', () => {
    expect(ranked('board settings')[0]).toBe('Board settings');
    expect(ranked('Agent Notes settings')[0]).toBe('Agent Notes settings');
  });
});
