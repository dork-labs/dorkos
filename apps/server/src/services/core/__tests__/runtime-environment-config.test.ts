import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConfigManager, initConfigManager } from '../config-manager.js';
import {
  applyGuardedConfigWrite,
  LOCAL_OPERATOR_AUTHORITY,
  OPERATOR_TOOL_AUTHORITY,
} from '../operator/config-write.js';
import { projectDisclosedConfig } from '../operator/config-disclosure.js';

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'runtime-env-config-'));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});
const disk = () => JSON.parse(readFileSync(path.join(directory, 'config.json'), 'utf8'));

describe('real runtime environment configuration', () => {
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
