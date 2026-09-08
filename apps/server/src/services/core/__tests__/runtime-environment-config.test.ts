import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';
import { ConfigManager, initConfigManager } from '../config-manager.js';
import {
  applyGuardedConfigWrite,
  LOCAL_OPERATOR_AUTHORITY,
  OPERATOR_TOOL_AUTHORITY,
} from '../operator/config-write.js';
import { projectDisclosedConfig } from '../operator/config-disclosure.js';

vi.mock('../../../lib/version.js', () => ({ SERVER_VERSION: '0.76.0' }));
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'runtime-env-config-'));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});
const disk = () => JSON.parse(readFileSync(path.join(directory, 'config.json'), 'utf8'));

describe('real runtime environment configuration', () => {
  it('persists prior-shape nested defaults across a real upgrade and second boot', () => {
    const previous = structuredClone(USER_CONFIG_DEFAULTS) as Record<string, unknown>;
    const runtimes = previous.runtimes as Record<string, unknown>;
    delete runtimes.environment;
    runtimes.default = 'codex';
    previous.__internal__ = { migrations: { version: '0.75.0' } };
    writeFileSync(path.join(directory, 'config.json'), JSON.stringify(previous));
    new ConfigManager(directory);
    const upgraded = disk();
    expect(upgraded.runtimes.environment).toEqual({
      inherit: { claudeCode: [], codex: [], opencode: [] },
    });
    expect(upgraded.runtimes.default).toBe('codex');
    expect(upgraded.__internal__.migrations.version).toBe('0.76.0');
    new ConfigManager(directory);
    expect(disk()).toEqual(upgraded);
  });
  it('allows a real owner write, refuses agent widening, and withholds all names', () => {
    const manager = initConfigManager(directory);
    const patch = { runtimes: { environment: { inherit: { codex: ['SYNTHETIC_TOOL_SETTING'] } } } };
    const denied = applyGuardedConfigWrite({
      patch,
      authority: OPERATOR_TOOL_AUTHORITY,
      source: 'config_patch',
      writer: { kind: 'unattributed' },
    });
    expect(denied.ok).toBe(false);
    expect(disk().runtimes.environment.inherit.codex).toEqual([]);
    const owner = applyGuardedConfigWrite({
      patch,
      authority: LOCAL_OPERATOR_AUTHORITY,
      source: 'dorkos config set',
      writer: { kind: 'unattributed' },
    });
    expect(owner.ok).toBe(true);
    expect(disk().runtimes.environment.inherit.codex).toEqual(['SYNTHETIC_TOOL_SETTING']);
    const disclosed = JSON.stringify(projectDisclosedConfig(manager.getAll()));
    expect(disclosed).not.toContain('SYNTHETIC_TOOL_SETTING');
    expect(disclosed).not.toContain('inherit');
    // Constructor restart must preserve an explicit owner decision.
    new ConfigManager(directory);
    expect(disk().runtimes.environment.inherit.codex).toEqual(['SYNTHETIC_TOOL_SETTING']);
  });
  it.each(
    [['MCP_API_KEY'], ['nango_encryption_key'], ['DORKOS_AGENT_TOKEN'], ['TOOL', 'tool']].map(
      (names) => ({ names })
    )
  )('refuses invalid owner inheritance %j without a disk change', ({ names }) => {
    initConfigManager(directory);
    const before = disk();
    const result = applyGuardedConfigWrite({
      patch: { runtimes: { environment: { inherit: { codex: names } } } },
      authority: LOCAL_OPERATOR_AUTHORITY,
      source: 'dorkos config set',
      writer: { kind: 'unattributed' },
    });
    expect(result.ok).toBe(false);
    expect(disk()).toEqual(before);
  });
});
