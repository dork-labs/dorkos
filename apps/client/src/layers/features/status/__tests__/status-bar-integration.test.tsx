/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { STATUS_BAR_PREFS_DEFAULTS } from '@dorkos/shared/config-schema';
import { STATUS_BAR_REGISTRY } from '../model/status-bar-registry';

// The status-bar visibility toggles moved from client Zustand/localStorage to
// server config (`ui.statusBar`, DOR-431). These integration checks guard the
// registry ↔ config-schema contract so the two never drift apart.
describe('Status bar registry ↔ config-schema integration', () => {
  it('registry covers every `ui.statusBar` config field', () => {
    const configKeys = Object.keys(STATUS_BAR_PREFS_DEFAULTS);
    const registryKeys = STATUS_BAR_REGISTRY.map((item) => item.key);
    for (const configKey of configKeys) {
      expect(registryKeys).toContain(configKey);
    }
  });

  it('every registry key is a boolean field in the config schema', () => {
    for (const item of STATUS_BAR_REGISTRY) {
      expect(typeof STATUS_BAR_PREFS_DEFAULTS[item.key]).toBe('boolean');
    }
  });

  it('registry count matches the number of `ui.statusBar` config fields', () => {
    expect(STATUS_BAR_REGISTRY).toHaveLength(Object.keys(STATUS_BAR_PREFS_DEFAULTS).length);
  });

  it('registry defaultVisible values match the config schema defaults (all true)', () => {
    for (const item of STATUS_BAR_REGISTRY) {
      expect(item.defaultVisible).toBe(true);
      expect(STATUS_BAR_PREFS_DEFAULTS[item.key]).toBe(true);
    }
  });
});
