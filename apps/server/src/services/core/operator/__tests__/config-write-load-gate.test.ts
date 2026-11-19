/**
 * Only a person may change the load gate (DOR-4209). An agent that could switch
 * it off, raise its limit, add slots, shorten the hard cap or take a command off
 * the heavy list would be letting its own job past the wait.
 *
 * Runs the real guarded writer against a real `ConfigManager` over a temp data
 * directory, as `config-write.test.ts` does: the `config_patch` tool's agent
 * authority is refused for every `runtimes.loadGate` leaf and writes nothing,
 * while the same patch under the person's own authority lands, so the refusal
 * is about who asked and not about the value.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ConfigManager } from '../../config-manager.js';
import type { ConfigWriteAuthority } from '../config-write.js';

/** Each leaf, as a patch that changes it away from what ships. */
const LEAF_PATCHES: readonly (readonly [string, Record<string, unknown>])[] = [
  ['runtimes.loadGate.enabled', { enabled: false }],
  ['runtimes.loadGate.maxLoad', { maxLoad: 1024 }],
  ['runtimes.loadGate.slots', { slots: 16 }],
  ['runtimes.loadGate.maxWaitMinutes', { maxWaitMinutes: 1 }],
  ['runtimes.loadGate.hardCapMinutes', { hardCapMinutes: 1 }],
  ['runtimes.loadGate.heavyCommands.add', { heavyCommands: { add: ['made-up'] } }],
  ['runtimes.loadGate.heavyCommands.remove', { heavyCommands: { remove: ['pnpm build'] } }],
];

const SHIPPED = {
  enabled: true,
  maxLoad: 16,
  slots: 1,
  maxWaitMinutes: 60,
  hardCapMinutes: 240,
  heavyCommands: { add: [], remove: [] },
};

describe('the load gate is the person’s to change', () => {
  let tmpDir: string;
  let configManager: ConfigManager;
  let applyGuardedConfigWrite: typeof import('../config-write.js').applyGuardedConfigWrite;
  let LOCAL_OPERATOR_AUTHORITY: ConfigWriteAuthority;
  let OPERATOR_TOOL_AUTHORITY: ConfigWriteAuthority;
  let OPERATOR_ONLY_CONFIG_CODE: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-config-write-load-gate-'));
    process.env.DORK_HOME = tmpDir;
    configManager = (await import('../../config-manager.js')).initConfigManager(tmpDir);
    const writeModule = await import('../config-write.js');
    applyGuardedConfigWrite = writeModule.applyGuardedConfigWrite;
    LOCAL_OPERATOR_AUTHORITY = writeModule.LOCAL_OPERATOR_AUTHORITY;
    OPERATOR_TOOL_AUTHORITY = writeModule.OPERATOR_TOOL_AUTHORITY;
    OPERATOR_ONLY_CONFIG_CODE = (await import('../config-write-policy.js'))
      .OPERATOR_ONLY_CONFIG_CODE;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.resetModules();
  });

  /** The load gate as it sits in the config file. */
  function loadGateOnDisk(): unknown {
    return JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf8')).runtimes?.loadGate;
  }

  it.each(LEAF_PATCHES)(
    'refuses an agent’s config_patch of %s and writes nothing',
    (leaf, patch) => {
      const before = loadGateOnDisk();
      const result = applyGuardedConfigWrite({
        patch: { runtimes: { loadGate: patch } },
        authority: OPERATOR_TOOL_AUTHORITY,
        source: 'the config_patch tool',
        writer: { kind: 'agent', agentName: 'DorkBot' },
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.kind).toBe('refused');
      if (result.kind !== 'refused') throw new Error('unreachable');
      expect(result.refusal.code).toBe(OPERATOR_ONLY_CONFIG_CODE);
      expect(result.refusal.paths).toEqual([leaf]);
      expect(loadGateOnDisk()).toEqual(before);
      expect(configManager.get('runtimes').loadGate).toEqual(SHIPPED);
    }
  );

  it('refuses a whole-section patch, naming every leaf', () => {
    const result = applyGuardedConfigWrite({
      patch: { runtimes: { loadGate: {} } },
      authority: OPERATOR_TOOL_AUTHORITY,
      source: 'the config_patch tool',
      writer: { kind: 'agent', agentName: 'DorkBot' },
    });
    expect(result.ok).toBe(false);
    if (result.ok || result.kind !== 'refused') throw new Error('unreachable');
    expect([...result.refusal.paths].sort()).toEqual(LEAF_PATCHES.map(([leaf]) => leaf).sort());
  });

  it('lets the person make the same change', () => {
    const result = applyGuardedConfigWrite({
      patch: { runtimes: { loadGate: { maxLoad: 8, heavyCommands: { add: ['made-up'] } } } },
      authority: LOCAL_OPERATOR_AUTHORITY,
      source: 'dorkos config set',
      writer: { kind: 'unattributed' },
    });
    expect(result.ok).toBe(true);
    expect(loadGateOnDisk()).toMatchObject({ maxLoad: 8, heavyCommands: { add: ['made-up'] } });
  });
});
