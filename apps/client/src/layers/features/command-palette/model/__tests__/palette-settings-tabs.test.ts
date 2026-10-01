import { describe, it, expect } from 'vitest';
import { SETTINGS_TAB_DIRECTORY } from '@/layers/shared/lib';
import { PALETTE_FEATURES, settingsTabForAction } from '../palette-contributions';

/**
 * DOR-2629 — every Settings tab, the five behind the Advanced fold included,
 * is one palette search away.
 */
describe('palette rows for Settings tabs', () => {
  const rows = PALETTE_FEATURES.filter((row) => row.id.startsWith('settings-'));

  it('offers one row per built-in tab, in sidebar order, named as the sidebar names it', () => {
    expect(rows.map((row) => row.label)).toEqual(
      SETTINGS_TAB_DIRECTORY.map((tab) => `Settings › ${tab.label}`)
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
      'Settings › Server',
      'Settings › Tools',
      'Settings › Room limits',
      'Settings › Experiments',
      'Settings › Danger zone',
    ]);
  });

  it('claims no other action', () => {
    expect(settingsTabForAction('openSettings')).toBeNull();
    expect(settingsTabForAction('ext:hello:openSettingsTab:x')).toBeNull();
  });
});
