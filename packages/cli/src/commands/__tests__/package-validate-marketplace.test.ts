import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  parseValidateMarketplaceArgs,
  runValidateMarketplace,
} from '../package-validate-marketplace.js';

/**
 * Build a temp directory with a `marketplace.json` containing `payload`
 * and return the absolute path to that file. Caller is responsible for
 * cleanup via the suite-level `tmpRoot` mechanism.
 */
function writeMarketplaceFixture(tmpRoot: string, payload: unknown): string {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'marketplace-'));
  const filePath = path.join(dir, 'marketplace.json');
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  return filePath;
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

describe('parseValidateMarketplaceArgs', () => {
  it('returns the first positional argument as path', () => {
    expect(parseValidateMarketplaceArgs(['./marketplace.json'])).toEqual({
      path: './marketplace.json',
    });
  });

  it('ignores flag-style arguments when extracting positionals', () => {
    expect(parseValidateMarketplaceArgs(['--quiet', './marketplace.json'])).toEqual({
      path: './marketplace.json',
    });
  });

  it('throws when no positional argument is supplied', () => {
    expect(() => parseValidateMarketplaceArgs([])).toThrow(/Missing required <path>/);
  });

  it('throws when only flags are supplied', () => {
    expect(() => parseValidateMarketplaceArgs(['--quiet'])).toThrow(/Missing required <path>/);
  });
});

describe('runValidateMarketplace', () => {
  let tmpRoot: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `dorkos-vm-${randomUUID()}-`));
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns 0 and prints OK on a valid marketplace.json fixture', async () => {
    const filePath = writeMarketplaceFixture(tmpRoot, {
      name: 'dorkos-community',
      description: 'Seed registry',
      plugins: [
        {
          name: 'code-reviewer',
          source: 'https://github.com/dorkos-community/code-reviewer',
          description: 'Reviews PRs',
          type: 'agent',
        },
        {
          name: 'docs-keeper',
          source: 'https://github.com/dorkos-community/docs-keeper',
          description: 'Keeps docs in sync',
          type: 'agent',
        },
      ],
    });

    const exitCode = await runValidateMarketplace({ path: filePath });

    expect(exitCode).toBe(0);
    const stdoutCalls = collectWrites(stdoutSpy);
    expect(stdoutCalls).toContain(`OK: ${filePath}`);
    expect(stdoutCalls).toContain('(2 packages)');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('returns 1 and writes to stderr when the file is missing', async () => {
    const missingPath = path.join(tmpRoot, 'does-not-exist.json');

    const exitCode = await runValidateMarketplace({ path: missingPath });

    expect(exitCode).toBe(1);
    const stderrCalls = collectWrites(stderrSpy);
    expect(stderrCalls).toContain(`Failed to read ${missingPath}`);
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('returns 2 when the marketplace.json is missing the required name field', async () => {
    const filePath = writeMarketplaceFixture(tmpRoot, {
      // Intentionally omit `name` — schema requires it.
      description: 'No name here',
      plugins: [],
    });

    const exitCode = await runValidateMarketplace({ path: filePath });

    expect(exitCode).toBe(2);
    const stderrCalls = collectWrites(stderrSpy);
    expect(stderrCalls).toContain('Validation failed');
    expect(stderrCalls).toContain('name');
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('returns 2 when the file contains invalid JSON', async () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'marketplace-'));
    const filePath = path.join(dir, 'marketplace.json');
    fs.writeFileSync(filePath, '{ this is not valid json');

    const exitCode = await runValidateMarketplace({ path: filePath });

    expect(exitCode).toBe(2);
    const stderrCalls = collectWrites(stderrSpy);
    expect(stderrCalls).toContain('Validation failed');
    expect(stderrCalls).toContain('Invalid JSON');
  });

  it('resolves relative paths against process.cwd()', async () => {
    const filePath = writeMarketplaceFixture(tmpRoot, {
      name: 'rel-test',
      description: 'Relative path resolution test',
      plugins: [],
    });

    const originalCwd = process.cwd();
    try {
      process.chdir(path.dirname(filePath));
      const exitCode = await runValidateMarketplace({ path: './marketplace.json' });
      expect(exitCode).toBe(0);
    } finally {
      process.chdir(originalCwd);
    }
  });
});
