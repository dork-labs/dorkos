import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { SETTINGS_TAB_DIRECTORY } from '@/layers/shared/lib';
import { PALETTE_FEATURES, settingsTabForAction } from '../palette-contributions';
import { usePaletteSearch, type SearchableItem } from '../use-palette-search';

/** Every built-in feature row, shaped as `usePaletteItems` shapes it, with no history. */
const FEATURE_ITEMS: SearchableItem[] = PALETTE_FEATURES.map((f) => ({
  id: f.id,
  name: f.label,
  type: 'feature',
  keywords: f.keywords,
  usageKey: null,
  lastActivityAt: null,
  waiting: false,
  demoted: false,
  scopes: [],
  data: f,
}));

/** The labels the real search and ranking put first-to-last for a query. */
function ranked(query: string): string[] {
  const { result } = renderHook(() =>
    usePaletteSearch(FEATURE_ITEMS, query, {
      usage: {},
      now: Date.parse('2026-10-01T12:00:00.000Z'),
      scope: null,
    })
  );
  const rows = result.current.bestMatch
    ? [result.current.bestMatch, ...result.current.rows]
    : result.current.rows;
  return rows.map((row) => row.item.item.name);
}

/**
 * DOR-2629 — every Settings tab, the five behind the Advanced fold included,
 * is one palette search away.
 */
describe('palette rows for Settings tabs', () => {
  const rows = PALETTE_FEATURES.filter((row) => row.id.startsWith('settings-'));

  it('offers one row per built-in tab, in sidebar order, named as the sidebar names it', () => {
    expect(rows.map((row) => row.label)).toEqual(
      SETTINGS_TAB_DIRECTORY.map((tab) => `${tab.label} — Settings`)
    );
  });

  it('opens each row on its own tab id', () => {
    expect(rows.map((row) => settingsTabForAction(row.action))).toEqual(
      SETTINGS_TAB_DIRECTORY.map((tab) => tab.id)
    );
  });

  it('finds the Advanced tabs by the word "advanced"', () => {
    const advanced = rows.filter((row) => row.keywords?.includes('advanced'));
    expect(advanced.map((row) => row.label)).toEqual([
      'Server — Settings',
      'Tools — Settings',
      'Room limits — Settings',
      'Experiments — Settings',
      'Danger zone — Settings',
    ]);
  });

  it('claims no other action', () => {
    expect(settingsTabForAction('openSettings')).toBeNull();
    expect(settingsTabForAction('ext:hello:openSettingsTab:x')).toBeNull();
  });

  // The regression the first version shipped: sixteen "Settings › …" rows
  // outranked the plain Settings row, so ⌘K, "settings", Enter opened a tab.
  it.each(['settings', 'sett', 'Settings'])('puts the plain Settings row first for "%s"', (q) => {
    expect(ranked(q)[0]).toBe('Settings');
  });

  it('puts a tab first when you type its name', () => {
    expect(ranked('danger')[0]).toBe('Danger zone — Settings');
    expect(ranked('room limits')[0]).toBe('Room limits — Settings');
  });
});
