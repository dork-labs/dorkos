import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { validatePackage } from '@dorkos/marketplace/package-validator';

import { parseValidateRemoteArgs, runValidateRemote } from '../package-validate-remote.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('@dorkos/marketplace/package-validator', () => ({
  validatePackage: vi.fn(),
}));

const mockedSpawn = vi.mocked(spawn);
const mockedValidatePackage = vi.mocked(validatePackage);

/**
 * Build a fake `ChildProcess`-shaped EventEmitter that fires `exit` with
 * the given exit code on the next tick. The shape is reduced to the bits
 * that {@link runValidateRemote} actually consumes (`on('exit', …)` and
 * `on('error', …)`), so we don't have to satisfy the full type.
 */
function makeFakeChild(exitCode: number | null, error?: Error): EventEmitter {
  const emitter = new EventEmitter();
  setImmediate(() => {
    if (error) {
      emitter.emit('error', error);
    } else {
      emitter.emit('exit', exitCode);
    }
  });
  return emitter;
}

/**
 * Collapse all `process.stdout.write` / `process.stderr.write` invocations
 * captured by a Vitest spy into a single string. Avoids the implicit-any
 * pitfall of `mock.calls.map((c) => …)` against the overloaded `write`
 * signature.
 */
function collectWrites(spy: ReturnType<typeof vi.spyOn>): string {
  return (spy.mock.calls as unknown[][]).map((call) => String(call[0])).join('');
}

describe('parseValidateRemoteArgs', () => {
  it('returns the first positional as the URL', () => {
    expect(parseValidateRemoteArgs(['https://github.com/dorkos-community/code-reviewer'])).toEqual({
      url: 'https://github.com/dorkos-community/code-reviewer',
    });
  });

  it('ignores flag-style arguments when extracting positionals', () => {
    expect(
      parseValidateRemoteArgs(['--quiet', 'https://github.com/dorkos-community/code-reviewer'])
    ).toEqual({ url: 'https://github.com/dorkos-community/code-reviewer' });
  });

  it('throws when no URL is supplied', () => {
    expect(() => parseValidateRemoteArgs([])).toThrow(/Missing required <github-url>/);
  });
});

describe('runValidateRemote', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  /** Captured destination directory passed to `git clone`. */
  let capturedDest: string | undefined;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    capturedDest = undefined;

    mockedSpawn.mockImplementation((..._args: unknown[]) => {
      // git clone --depth 1 <url> <dest>
      const argv = (_args[1] ?? []) as string[];
      capturedDest = argv[argv.length - 1];
      return makeFakeChild(0) as unknown as ReturnType<typeof spawn>;
    });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    mockedSpawn.mockReset();
    mockedValidatePackage.mockReset();
  });

  it('returns 0 when clone and validation both succeed', async () => {
    mockedValidatePackage.mockResolvedValue({ ok: true, issues: [] });

    const exitCode = await runValidateRemote({
      url: 'https://github.com/dorkos-community/code-reviewer',
    });

    expect(exitCode).toBe(0);
    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    expect(mockedSpawn).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining([
        'clone',
        '--depth',
        '1',
        'https://github.com/dorkos-community/code-reviewer',
      ]),
      expect.objectContaining({ stdio: 'inherit' })
    );
    expect(mockedValidatePackage).toHaveBeenCalledWith(capturedDest);
    const stdoutCalls = collectWrites(stdoutSpy);
    expect(stdoutCalls).toContain('OK: https://github.com/dorkos-community/code-reviewer');
  });

  it('returns 1 when git clone exits with a non-zero code', async () => {
    mockedSpawn.mockImplementation((..._args: unknown[]) => {
      const argv = (_args[1] ?? []) as string[];
      capturedDest = argv[argv.length - 1];
      return makeFakeChild(128) as unknown as ReturnType<typeof spawn>;
    });

    const exitCode = await runValidateRemote({
      url: 'https://github.com/dorkos-community/missing-repo',
    });

    expect(exitCode).toBe(1);
    expect(mockedValidatePackage).not.toHaveBeenCalled();
    const stderrCalls = collectWrites(stderrSpy);
    expect(stderrCalls).toContain('Clone failed');
  });

  it('returns 1 when spawn itself emits an error event', async () => {
    mockedSpawn.mockImplementation((..._args: unknown[]) => {
      const argv = (_args[1] ?? []) as string[];
      capturedDest = argv[argv.length - 1];
      return makeFakeChild(null, new Error('git not found')) as unknown as ReturnType<typeof spawn>;
    });

    const exitCode = await runValidateRemote({
      url: 'https://github.com/dorkos-community/code-reviewer',
    });

    expect(exitCode).toBe(1);
    expect(mockedValidatePackage).not.toHaveBeenCalled();
    const stderrCalls = collectWrites(stderrSpy);
    expect(stderrCalls).toContain('Clone failed');
  });

  it('returns 2 when validatePackage reports error-level issues', async () => {
    mockedValidatePackage.mockResolvedValue({
      ok: false,
      issues: [
        {
          level: 'error',
          code: 'MANIFEST_MISSING',
          message: 'Required file missing: .dork/manifest.json',
          path: '.dork/manifest.json',
        },
      ],
    });

    const exitCode = await runValidateRemote({
      url: 'https://github.com/dorkos-community/broken-package',
    });

    expect(exitCode).toBe(2);
    const stderrCalls = collectWrites(stderrSpy);
    expect(stderrCalls).toContain('Validation failed');
    expect(stderrCalls).toContain('MANIFEST_MISSING');
  });

  it('removes the temp directory after a successful run', async () => {
    mockedValidatePackage.mockResolvedValue({ ok: true, issues: [] });

    await runValidateRemote({ url: 'https://github.com/dorkos-community/code-reviewer' });

    expect(capturedDest).toBeDefined();
    expect(fs.existsSync(capturedDest!)).toBe(false);
  });

  it('removes the temp directory even when validation fails', async () => {
    mockedValidatePackage.mockResolvedValue({
      ok: false,
      issues: [
        {
          level: 'error',
          code: 'MANIFEST_MISSING',
          message: 'Required file missing: .dork/manifest.json',
        },
      ],
    });

    await runValidateRemote({ url: 'https://github.com/dorkos-community/broken-package' });

    expect(capturedDest).toBeDefined();
    expect(fs.existsSync(capturedDest!)).toBe(false);
  });

  it('removes the temp directory even when clone fails', async () => {
    mockedSpawn.mockImplementation((..._args: unknown[]) => {
      const argv = (_args[1] ?? []) as string[];
      capturedDest = argv[argv.length - 1];
      return makeFakeChild(1) as unknown as ReturnType<typeof spawn>;
    });

    await runValidateRemote({ url: 'https://github.com/dorkos-community/missing-repo' });

    expect(capturedDest).toBeDefined();
    expect(fs.existsSync(capturedDest!)).toBe(false);
  });

  it('creates the temp directory under os.tmpdir() with the dorkos-validate prefix', async () => {
    mockedValidatePackage.mockResolvedValue({ ok: true, issues: [] });

    await runValidateRemote({ url: 'https://github.com/dorkos-community/code-reviewer' });

    expect(capturedDest).toBeDefined();
    expect(path.basename(capturedDest!)).toMatch(/^dorkos-validate-/);
  });
});
