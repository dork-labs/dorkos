import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
vi.hoisted(() => {
  process.env.DORKOS_VERSION_OVERRIDE = '0.99.0';
});
import { ConfigManager } from '../config-manager.js';
import { USER_CONFIG_DEFAULTS, UserConfigSchema } from '@dorkos/shared/config-schema';
import { configManager, initConfigManager } from '../config-manager.js';
import { applyConfigPatch } from '../operator/config-patch.js';
import { BROWSER_SETTING_UNAVAILABLE } from '../config/browser-setting.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function home(browser?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'browser-setting-'));
  homes.push(dir);
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({
      version: 1,
      relay: { enabled: true, dataDir: null },
      ...(browser === undefined ? {} : { browser }),
      __internal__: { migrations: { version: '0.98.0' } },
    })
  );
  return dir;
}
function disk(dir: string) {
  return JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
}
describe('Shared browser configuration foundation', () => {
  it('defaults the enclosing section and the explicit empty section off', () => {
    expect(USER_CONFIG_DEFAULTS.browser).toEqual({ enabled: false });
    expect(UserConfigSchema.parse({ version: 1, browser: {} }).browser.enabled).toBe(false);
  });
  it('boots fresh and pre-section real disk configurations off without losing another section', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'browser-setting-'));
    homes.push(fresh);
    new ConfigManager(fresh);
    expect(disk(fresh).browser).toEqual({ enabled: false });
    const stale = home();
    new ConfigManager(stale);
    // Top-level defaults write before migrations; this is an upgrade-boot assertion.
    expect(disk(stale).browser).toEqual({ enabled: false });
    expect(disk(stale).relay.enabled).toBe(true);
  });
  it('really persists the nested leaf for an existing empty browser section', () => {
    const dir = home({});
    new ConfigManager(dir);
    expect(disk(dir).browser).toEqual({ enabled: false });
    expect(disk(dir).__internal__.migrations.version).toBe('0.99.0');
    new ConfigManager(dir);
    expect(disk(dir).browser.enabled).toBe(false);
  });
  it('preserves a stored operator choice across migration and repeated boots', () => {
    const dir = home({ enabled: true });
    const manager = new ConfigManager(dir);
    expect(disk(dir).browser.enabled).toBe(true);
    new ConfigManager(dir);
    expect(disk(dir).browser.enabled).toBe(true);
    expect(() => manager.set('browser', { enabled: true })).toThrow(BROWSER_SETTING_UNAVAILABLE);
    manager.set('browser', { enabled: false });
    expect(disk(dir).browser.enabled).toBe(false);
  });
  it('refuses an entire mixed patch before another section can be persisted', () => {
    const dir = home();
    const manager = new ConfigManager(dir);
    const before = readFileSync(join(dir, 'config.json'), 'utf8');
    initConfigManager(dir);
    const getAll = vi.spyOn(configManager, 'getAll').mockImplementation(() => manager.getAll());
    const set = vi
      .spyOn(configManager, 'set')
      .mockImplementation((key, value) => manager.set(key, value));
    try {
      expect(applyConfigPatch({ relay: { enabled: false }, browser: { enabled: true } })).toEqual({
        ok: false,
        error: BROWSER_SETTING_UNAVAILABLE,
      });
      expect(set).not.toHaveBeenCalled();
      expect(readFileSync(join(dir, 'config.json'), 'utf8')).toBe(before);
    } finally {
      getAll.mockRestore();
      set.mockRestore();
    }
  });
  it('refuses direct section and CLI-shaped dotted enables before writing disk', () => {
    const dir = home();
    const manager = new ConfigManager(dir);
    const before = readFileSync(join(dir, 'config.json'), 'utf8');
    expect(() => manager.set('browser', { enabled: true })).toThrow(BROWSER_SETTING_UNAVAILABLE);
    expect(() => manager.setDot('browser.enabled', true)).toThrow(BROWSER_SETTING_UNAVAILABLE);
    expect(readFileSync(join(dir, 'config.json'), 'utf8')).toBe(before);
    manager.setDot('browser.enabled', false);
    expect(disk(dir).browser.enabled).toBe(false);
  });
});
