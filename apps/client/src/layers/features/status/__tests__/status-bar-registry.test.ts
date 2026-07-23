import { describe, it, expect } from 'vitest';
import { STATUS_BAR_PREFS_DEFAULTS } from '@dorkos/shared/config-schema';
import { STATUS_BAR_REGISTRY, getGroupedRegistryItems } from '../model/status-bar-registry';

describe('STATUS_BAR_REGISTRY', () => {
  it('contains exactly 10 items', () => {
    expect(STATUS_BAR_REGISTRY).toHaveLength(10);
  });

  it('has unique keys', () => {
    const keys = STATUS_BAR_REGISTRY.map((item) => item.key);
    const uniqueKeys = new Set(keys);
    expect(uniqueKeys.size).toBe(keys.length);
  });

  it('has the expected keys in order', () => {
    const keys = STATUS_BAR_REGISTRY.map((item) => item.key);
    expect(keys).toEqual([
      'cwd',
      'git',
      'runtime',
      'model',
      'cache',
      'context',
      'usage',
      'permission',
      'sound',
      'polling',
    ]);
  });

  it('every item has label, description, group, icon, and defaultVisible', () => {
    for (const item of STATUS_BAR_REGISTRY) {
      expect(item.label).toBeTruthy();
      expect(item.description).toBeTruthy();
      expect(['session', 'controls']).toContain(item.group);
      expect(item.icon).toBeDefined();
      expect(typeof item.defaultVisible).toBe('boolean');
    }
  });

  it('every registry key maps to a boolean in the `ui.statusBar` config schema (DOR-431)', () => {
    const configKeys = Object.keys(STATUS_BAR_PREFS_DEFAULTS);
    for (const item of STATUS_BAR_REGISTRY) {
      expect(configKeys).toContain(item.key);
      expect(typeof STATUS_BAR_PREFS_DEFAULTS[item.key]).toBe('boolean');
    }
  });

  it('registry covers every `ui.statusBar` config field exactly (no drift)', () => {
    const registryKeys = STATUS_BAR_REGISTRY.map((item) => item.key).sort();
    const configKeys = Object.keys(STATUS_BAR_PREFS_DEFAULTS).sort();
    expect(registryKeys).toEqual(configKeys);
  });

  it("each item's defaultVisible matches the config schema default", () => {
    for (const item of STATUS_BAR_REGISTRY) {
      expect(item.defaultVisible).toBe(STATUS_BAR_PREFS_DEFAULTS[item.key]);
    }
  });
});

describe('getGroupedRegistryItems', () => {
  it('returns exactly 2 groups', () => {
    const groups = getGroupedRegistryItems();
    expect(groups).toHaveLength(2);
  });

  it('returns groups in order: session, controls', () => {
    const groups = getGroupedRegistryItems();
    expect(groups[0].group).toBe('session');
    expect(groups[1].group).toBe('controls');
  });

  it('session group has 7 items', () => {
    const groups = getGroupedRegistryItems();
    const sessionGroup = groups.find((g) => g.group === 'session');
    expect(sessionGroup?.items).toHaveLength(7);
  });

  it('controls group has 3 items', () => {
    const groups = getGroupedRegistryItems();
    const controlsGroup = groups.find((g) => g.group === 'controls');
    expect(controlsGroup?.items).toHaveLength(3);
  });

  it('includes correct group labels', () => {
    const groups = getGroupedRegistryItems();
    expect(groups[0].label).toBe('Session Info');
    expect(groups[1].label).toBe('Controls');
  });
});
