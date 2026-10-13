import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.hoisted(() => {
  process.env.DORKOS_VERSION_OVERRIDE = '0.114.0';
});
import { ConfigManager } from '../config-manager.js';
import { findOperatorOnlyPaths } from '../operator/config-write-policy.js';
import { USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
it('persists default-off on upgrade and preserves an explicit person choice across restart', () => {
  expect(USER_CONFIG_DEFAULTS.computers).toEqual({ enabled: false });
  const home = mkdtempSync(join(tmpdir(), 'computer-config-'));
  homes.push(home);
  const path = join(home, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      computers: {},
      __internal__: { migrations: { version: '0.113.0' } },
    })
  );
  const manager = new ConfigManager(home);
  expect(JSON.parse(readFileSync(path, 'utf8')).computers).toEqual({ enabled: false });
  manager.set('computers', { enabled: true });
  expect(new ConfigManager(home).get('computers').enabled).toBe(true);
  expect(findOperatorOnlyPaths({ computers: { enabled: false } })).toContain('computers.enabled');
});
