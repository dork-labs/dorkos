/**
 * @vitest-environment node
 *
 * Which agent tool DorkOS itself runs, read the two ways (DOR-1901).
 *
 * The disk reader exists for one caller — `dorkos harness sync --check`, which
 * is documented as never writing anything (DOR-678) and would otherwise plant a
 * `~/.dork` in whatever folder a person happened to be standing in. So the
 * assertions that matter are about the cases where a file is missing or broken:
 * both must answer as a booting server would, and neither may create anything.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockConfigGet = vi.fn();
vi.mock('../../core/config-manager.js', () => ({
  configManager: { get: (...args: unknown[]) => mockConfigGet(...args) },
}));

import { dorkosHarness, dorkosHarnessFromDisk } from '../dorkos-harness.js';

let home = '';
beforeEach(() => {
  vi.clearAllMocks();
  home = mkdtempSync(join(tmpdir(), 'dorkos-harness-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  home = '';
});

/** Write a `config.json` with the given body. */
function writeConfig(body: string): void {
  writeFileSync(join(home, 'config.json'), body);
}

describe('dorkosHarness', () => {
  it('TR-11: answers the harness the stored default runtime reads', () => {
    mockConfigGet.mockReturnValue({ default: 'opencode' });
    expect(dorkosHarness()).toBe('opencode');
    expect(mockConfigGet).toHaveBeenCalledWith('runtimes');
  });

  it('TR-11: answers nothing for a runtime that reads no harness', () => {
    mockConfigGet.mockReturnValue({ default: 'test-mode' });
    expect(dorkosHarness()).toBeUndefined();
  });
});

describe('dorkosHarnessFromDisk', () => {
  it('TR-11: reads the stored default runtime without creating anything', () => {
    writeConfig(JSON.stringify({ version: 1, runtimes: { default: 'codex' } }));

    expect(dorkosHarnessFromDisk(home)).toBe('codex');
    // The whole reason this function exists rather than a config-store read.
    expect(readdirSync(home)).toEqual(['config.json']);
  });

  it('TR-11: falls back to the schema default on a fresh install, and writes nothing', () => {
    // No `config.json` at all. A server booting here would run Claude Code, so
    // saying "DorkOS runs no harness" would drop the notice for every person
    // whose config has not been written yet — which is every fresh install.
    expect(dorkosHarnessFromDisk(home)).toBe('claude-code');
    expect(readdirSync(home)).toEqual([]);
  });

  it('TR-11: falls back to the schema default when the file cannot be read', () => {
    writeConfig('{ "version": 1, "runtimes": {');
    expect(dorkosHarnessFromDisk(home)).toBe('claude-code');

    writeConfig(JSON.stringify({ version: 1, runtimes: { default: 42 } }));
    expect(dorkosHarnessFromDisk(home)).toBe('claude-code');
  });

  it('TR-11: never opens the config store, whatever the file says', () => {
    writeConfig(JSON.stringify({ version: 1, runtimes: { default: 'opencode' } }));

    expect(dorkosHarnessFromDisk(home)).toBe('opencode');
    expect(mockConfigGet).not.toHaveBeenCalled();
  });
});
