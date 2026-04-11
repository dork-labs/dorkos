import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

import { runPackageValidate } from '../package-validate-command.js';

const FIXTURES_DIR = path.resolve(__dirname, '../../../marketplace/src/__tests__/fixtures');

function fixture(name: string): string {
  return path.join(FIXTURES_DIR, name);
}

describe('runPackageValidate', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    if (process.cwd() !== originalCwd) {
      process.chdir(originalCwd);
    }
  });

  describe('valid packages return exit code 0', () => {
    it.each([
      ['valid-plugin', 'plugin'],
      ['valid-agent', 'agent'],
      ['valid-skill-pack', 'skill-pack'],
      ['valid-adapter', 'adapter'],
    ])('exits 0 for %s fixture', async (dirName, type) => {
      const code = await runPackageValidate({ packagePath: fixture(dirName) });
      expect(code).toBe(0);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(`Package: ${dirName}`));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(`(${type})`));
      expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/Package is valid/));
    });
  });

  describe('invalid packages return exit code 1', () => {
    it('exits 1 when manifest is missing', async () => {
      const code = await runPackageValidate({ packagePath: fixture('invalid-no-manifest') });
      expect(code).toBe(1);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[MANIFEST_MISSING]'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Package validation failed'));
    });

    it('exits 1 when manifest schema is invalid', async () => {
      const code = await runPackageValidate({
        packagePath: fixture('invalid-manifest-shape'),
      });
      expect(code).toBe(1);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[MANIFEST_SCHEMA_INVALID]'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Package validation failed'));
    });

    it('exits 0 for a Claude Code plugin without .dork/manifest.json (manifest synthesized from plugin.json)', async () => {
      const code = await runPackageValidate({ packagePath: fixture('claude-code-plugin') });
      expect(code).toBe(0);
    });
  });

  it('does not emit CLAUDE_PLUGIN_MISSING for valid agent fixture', async () => {
    const code = await runPackageValidate({ packagePath: fixture('valid-agent') });
    expect(code).toBe(0);
    const allLogged = logSpy.mock.calls.flat().join('\n');
    expect(allLogged).not.toContain('CLAUDE_PLUGIN_MISSING');
  });

  it('prints the package summary line for a valid package', async () => {
    await runPackageValidate({ packagePath: fixture('valid-plugin') });
    // The summary line uses `name@version (type)`
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^Package: valid-plugin@\d+\.\d+\.\d+ \(plugin\)$/)
    );
  });

  it('prints a trailing status line', async () => {
    await runPackageValidate({ packagePath: fixture('valid-plugin') });
    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    const lastLine = calls[calls.length - 1];
    expect(lastLine).toMatch(/Package is valid/);
  });

  it('defaults to process.cwd() when packagePath is omitted', async () => {
    process.chdir(fixture('valid-plugin'));

    const code = await runPackageValidate({});

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Package: valid-plugin'));
  });

  describe('warnings-only success path', () => {
    let tmpRoot: string;

    beforeEach(() => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `dorkos-validate-warn-${randomUUID()}-`));
    });

    afterEach(() => {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('exits 0 with the with-warnings status line on NAME_DIRECTORY_MISMATCH', async () => {
      // Build a package whose directory name does NOT match manifest.name.
      // This triggers NAME_DIRECTORY_MISMATCH, which is a warning-level issue
      // — the package is still `ok: true` and the CLI should exit 0.
      const pkgDir = path.join(tmpRoot, 'wrong-dir-name');
      fs.mkdirSync(path.join(pkgDir, '.dork'), { recursive: true });
      fs.mkdirSync(path.join(pkgDir, '.claude-plugin'), { recursive: true });
      fs.writeFileSync(
        path.join(pkgDir, '.dork', 'manifest.json'),
        JSON.stringify({
          schemaVersion: 1,
          name: 'right-name',
          version: '1.0.0',
          type: 'plugin',
          description: 'A package whose directory name intentionally mismatches the manifest',
        }) + '\n'
      );
      fs.writeFileSync(
        path.join(pkgDir, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: 'right-name', version: '1.0.0' }) + '\n'
      );

      const code = await runPackageValidate({ packagePath: pkgDir });

      expect(code).toBe(0);
      const calls = logSpy.mock.calls.map((c) => String(c[0]));
      expect(calls.some((line) => line.includes('[NAME_DIRECTORY_MISMATCH]'))).toBe(true);
      expect(calls.some((line) => line.includes('⚠'))).toBe(true);
      expect(calls.some((line) => /Package is valid \(with warnings\)/.test(line))).toBe(true);
    });
  });
});
