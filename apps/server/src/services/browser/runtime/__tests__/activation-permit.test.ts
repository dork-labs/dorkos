import { expect, it } from 'vitest';
import type { ConfigManager } from '../../../core/config-manager.js';
import {
  mintProductionBrowserEnablePermit,
  consumeProductionBrowserEnablePermit,
} from '../activation/activation-permit.js';
it('binds one-use original permit to exact config receiver and refuses copied DTOs', () => {
  const config = {} as ConfigManager,
    other = {} as ConfigManager;
  const original = mintProductionBrowserEnablePermit(config, () => true);
  expect(() => consumeProductionBrowserEnablePermit({ ...original }, config)).toThrow();
  expect(() => consumeProductionBrowserEnablePermit(original, other)).toThrow();
  const finalCheck = consumeProductionBrowserEnablePermit(original, config);
  finalCheck();
  expect(() => consumeProductionBrowserEnablePermit(original, config)).toThrow();
});
it('retained original post-write callback observes currentness loss and preserves falsy callback failure', () => {
  const config = {} as ConfigManager;
  let current = true;
  const original = mintProductionBrowserEnablePermit(config, () => current);
  const finalCheck = consumeProductionBrowserEnablePermit(original, config);
  current = false;
  expect(finalCheck).toThrow();
  const falsy = mintProductionBrowserEnablePermit(config, () => {
    throw undefined;
  });
  let observed = false;
  try {
    consumeProductionBrowserEnablePermit(falsy, config);
  } catch (value) {
    observed = true;
    expect(value).toBeUndefined();
  }
  expect(observed).toBe(true);
});
