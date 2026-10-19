/**
 * `docs.enabled` (DOR-2993): Docs ship off, an upgrade lands on off, a
 * person's own choice survives a restart, and only a person may make it.
 */
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../config-manager.js';
import { findOperatorOnlyPaths } from '../operator/config-write-policy.js';
import { USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function home(stored: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'docs-config-'));
  homes.push(dir);
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ version: 1, ...stored, __internal__: { migrations: { version: '0.119.0' } } })
  );
  return dir;
}

function onDisk(dir: string): { docs?: unknown } {
  return JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
}

it('ships off, and an upgrade with no section lands on off', () => {
  expect(USER_CONFIG_DEFAULTS.docs).toEqual({ enabled: false });
  const dir = home({});
  new ConfigManager(dir);
  expect(onDisk(dir).docs).toEqual({ enabled: false });
});

it('keeps a person’s choice across a restart, and only a person may make it', () => {
  const dir = home({});
  new ConfigManager(dir).set('docs', { enabled: true });
  expect(new ConfigManager(dir).get('docs').enabled).toBe(true);
  expect(findOperatorOnlyPaths({ docs: { enabled: true } })).toContain('docs.enabled');
});
