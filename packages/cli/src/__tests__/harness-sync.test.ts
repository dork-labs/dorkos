import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { runHarnessSync, parseHarnessSyncArgs } from '../harness-sync-command.js';
import { runHarnessDispatcher } from '../commands/harness-dispatcher.js';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-harness-sync-test-'));
}

/** Build a minimal but realistic two-harness fixture repo at `root`. */
function writeFixtureRepo(root: string): void {
  fs.mkdirSync(path.join(root, '.agents', 'skills', 'demo'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.agents', 'harness.manifest.json'),
    JSON.stringify({ version: 1, harnesses: ['claude-code', 'codex'] }, null, 2)
  );
  fs.writeFileSync(
    path.join(root, '.agents', 'skills', 'demo', 'SKILL.md'),
    '# Demo skill\n\nA demo skill.\n'
  );

  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.claude', 'settings.json'),
    JSON.stringify(
      { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] } },
      null,
      2
    )
  );

  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Agents\n\nCanonical instructions.\n');
}

describe('parseHarnessSyncArgs', () => {
  it('defaults both flags to false with no args', () => {
    const args = parseHarnessSyncArgs([]);
    expect(args).toEqual({ check: false, fix: false, harness: undefined });
  });

  it('parses --check and --fix booleans', () => {
    expect(parseHarnessSyncArgs(['--check'])).toEqual({
      check: true,
      fix: false,
      harness: undefined,
    });
    expect(parseHarnessSyncArgs(['--fix'])).toEqual({
      check: false,
      fix: true,
      harness: undefined,
    });
  });

  it('captures --harness codex', () => {
    const args = parseHarnessSyncArgs(['--check', '--harness', 'codex']);
    expect(args.check).toBe(true);
    expect(args.harness).toBe('codex');
  });

  it('throws with a clear message on unknown option', () => {
    expect(() => parseHarnessSyncArgs(['--nope'])).toThrow(
      /Unknown option for 'harness sync': --nope/
    );
  });
});

describe('runHarnessSync', () => {
  let tmpDir: string;
  let originalCwd: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = createTempDir();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(originalCwd);
    logSpy.mockRestore();
    errorSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns exit code 1 when no harness manifest exists', async () => {
    process.chdir(tmpDir);
    const result = await runHarnessSync({ check: true, fix: false });
    expect(result.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('No harness manifest found'));
  });

  it('returns exit code 1 when both --check and --fix are passed', async () => {
    writeFixtureRepo(tmpDir);
    process.chdir(tmpDir);
    const result = await runHarnessSync({ check: true, fix: true });
    expect(result.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('not both'));
  });

  it('reports drift on an unprojected fixture (--check) then applies and is idempotent (--fix)', async () => {
    writeFixtureRepo(tmpDir);
    process.chdir(tmpDir);

    // --check on the un-projected fixture: drift present.
    const firstCheck = await runHarnessSync({ check: true, fix: false });
    expect(firstCheck.exitCode).toBe(1);

    // --fix realizes the plan with no conflicts.
    const fix = await runHarnessSync({ check: false, fix: true });
    expect(fix.exitCode).toBe(0);

    // The projected files now exist.
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'CLAUDE.md'))).toBe(true);
    expect(fs.lstatSync(path.join(tmpDir, '.claude', 'skills', 'demo')).isSymbolicLink()).toBe(
      true
    );
    expect(fs.existsSync(path.join(tmpDir, '.codex', 'hooks.json'))).toBe(true);

    // A second --check is clean.
    const secondCheck = await runHarnessSync({ check: false, fix: false });
    expect(secondCheck.exitCode).toBe(0);
  });

  it('narrows the plan with --harness and rejects an unknown harness', async () => {
    writeFixtureRepo(tmpDir);
    process.chdir(tmpDir);

    const scoped = await runHarnessSync({ check: true, fix: false, harness: 'codex' });
    expect(scoped.exitCode).toBe(1); // codex still has the generated hooks drift

    const bogus = await runHarnessSync({ check: true, fix: false, harness: 'bogus' });
    expect(bogus.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown harness'));
  });
});

describe('runHarnessDispatcher', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('prints help (not a parse error) for `harness` with no subcommand', async () => {
    expect(await runHarnessDispatcher(undefined, [])).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Usage: dorkos harness'));
  });

  it('prints help for `harness sync --help` instead of an unknown-option error', async () => {
    expect(await runHarnessDispatcher('sync', ['--help'])).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Usage: dorkos harness'));
    // Must NOT have reached the strict arg parser and reported --help as unknown.
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('prints help for `harness sync -h`', async () => {
    expect(await runHarnessDispatcher('sync', ['-h'])).toBe(0);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('returns exit code 1 for an unknown subcommand', async () => {
    expect(await runHarnessDispatcher('bogus', [])).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown harness subcommand'));
  });
});
