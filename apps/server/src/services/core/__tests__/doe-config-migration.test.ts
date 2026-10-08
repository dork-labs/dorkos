import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';
import { ConfigManager } from '../config-manager.js';
vi.mock('../../../lib/version.js', () => ({ SERVER_VERSION: '0.101.0' }));

describe('DorkOS runtime configuration migration', () => {
  it('persists missing nested defaults across an upgrade and preserves prior choices', () => {
    const directory = mkdtempSync(join(tmpdir(), 'doe-config-'));
    try {
      const prior = structuredClone(USER_CONFIG_DEFAULTS);
      const runtimes = prior.runtimes as Record<string, unknown>;
      delete runtimes.doe;
      delete (prior.runtimes.environment.inherit as Record<string, unknown>).doe;
      prior.runtimes.default = 'codex';
      prior.runtimes.environment.inherit.codex = ['UNIT_TEST_SETTING'];
      const filename = join(directory, 'config.json');
      writeFileSync(
        filename,
        JSON.stringify({ ...prior, __internal__: { migrations: { version: '0.100.0' } } })
      );
      new ConfigManager(directory);
      const upgraded = JSON.parse(readFileSync(filename, 'utf8'));
      expect(upgraded.runtimes.doe).toEqual({
        enabled: true,
        inference: null,
        defaultTrustStop: null,
      });
      expect(upgraded.runtimes.default).toBe('codex');
      expect(upgraded.runtimes.environment.inherit).toMatchObject({
        codex: ['UNIT_TEST_SETTING'],
        doe: [],
      });
      new ConfigManager(directory);
      expect(JSON.parse(readFileSync(filename, 'utf8'))).toEqual(upgraded);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
