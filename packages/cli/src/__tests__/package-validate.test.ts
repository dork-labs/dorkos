import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';

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

    it('exits 1 for a Claude Code plugin without .dork/manifest.json', async () => {
      const code = await runPackageValidate({ packagePath: fixture('claude-code-plugin') });
      expect(code).toBe(1);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[MANIFEST_MISSING]'));
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
});
