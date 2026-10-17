/**
 * `sessionRelay.enabled` (DOR-2946): chatting from the web ships off, an
 * upgrade lands on off, a stored section missing its leaf is healed to off,
 * and a person's own choice survives a restart.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.hoisted(() => {
  process.env.DORKOS_VERSION_OVERRIDE = '0.120.0';
});
import { ConfigManager } from '../config-manager.js';
import { findOperatorOnlyPaths } from '../operator/config-write-policy.js';
import { USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function home(stored: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'session-relay-config-'));
  homes.push(dir);
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ version: 1, ...stored, __internal__: { migrations: { version: '0.119.0' } } })
  );
  return dir;
}

function onDisk(dir: string): { sessionRelay?: unknown } {
  return JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
}

it('ships off, and an upgrade with no section lands on off', () => {
  expect(USER_CONFIG_DEFAULTS.sessionRelay).toEqual({ enabled: false });
  const dir = home({});
  new ConfigManager(dir);
  expect(onDisk(dir).sessionRelay).toEqual({ enabled: false });
});

it('heals a stored section missing its leaf, which only the 0.120.0 body writes', () => {
  const dir = home({ sessionRelay: {} });
  new ConfigManager(dir);
  expect(onDisk(dir).sessionRelay).toEqual({ enabled: false });
});

it('keeps a person’s choice across a restart, and only a person may make it', () => {
  const dir = home({});
  new ConfigManager(dir).set('sessionRelay', { enabled: true });
  expect(new ConfigManager(dir).get('sessionRelay').enabled).toBe(true);
  expect(findOperatorOnlyPaths({ sessionRelay: { enabled: true } })).toContain(
    'sessionRelay.enabled'
  );
});
