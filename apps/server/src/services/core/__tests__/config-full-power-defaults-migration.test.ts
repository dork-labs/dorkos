/** Explicit execution and permission choices survive supported upgrades. */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DORKOS_VERSION_OVERRIDE = '0.135.5';
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigManager } from '../config-manager.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function seed(runtimes: Record<string, unknown>): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-execution-upgrade-'));
  dirs.push(dir);
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      permissions: { preset: 'careful', defaults: { areas: { messages: 'blocked' }, actions: {} } },
      scheduler: { enabled: true, maxConcurrentRuns: 1, retentionCount: 100 },
      runtimes,
      __internal__: { migrations: { version: '0.115.0' } },
    })
  );
  return { dir, file };
}

describe('execution choices across supported upgrades', () => {
  it('keeps deliberately low concurrency and warm agents off through two boots', () => {
    const { dir, file } = seed({
      defaultTrustStop: 'ask',
      claudeCode: { persistentSession: false },
    });
    new ConfigManager(dir);
    const reopened = new ConfigManager(dir);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(stored.scheduler.maxConcurrentRuns).toBe(1);
    expect(stored.runtimes.claudeCode.persistentSession).toBe(false);
    expect(reopened.getDot('scheduler.maxConcurrentRuns')).toBe(1);
    expect(reopened.getDot('runtimes.claudeCode.persistentSession')).toBe(false);
    expect(reopened.validate()).toEqual({ valid: true });
    expect(fs.readdirSync(dir)).toEqual(['config.json']);
  });

  it.each(['ask', 'act', 'autonomy'] as const)(
    'keeps the chosen %s stop and per-runtime overrides',
    (stop) => {
      const { dir, file } = seed({
        defaultTrustStop: stop,
        claudeCode: { defaultTrustStop: 'ask' },
        codex: { defaultTrustStop: 'act' },
        opencode: { defaultTrustStop: 'autonomy' },
      });
      new ConfigManager(dir);
      const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(stored.runtimes.defaultTrustStop).toBe(stop);
      expect(stored.runtimes.claudeCode.defaultTrustStop).toBe('ask');
      expect(stored.runtimes.codex.defaultTrustStop).toBe('act');
      expect(stored.runtimes.opencode.defaultTrustStop).toBe('autonomy');
      expect(stored.permissions.preset).toBe('careful');
      expect(stored.permissions.defaults.areas.messages).toBe('blocked');
    }
  );

  it('gives a fresh install the current execution defaults', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-execution-fresh-'));
    dirs.push(dir);
    const manager = new ConfigManager(dir);
    expect(manager.getDot('scheduler.maxConcurrentRuns')).toBe(4);
    expect(manager.getDot('runtimes.claudeCode.persistentSession')).toBe(true);
    expect(manager.validate()).toEqual({ valid: true });
  });
});
