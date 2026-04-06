import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { runPackageInit, parsePackageInitArgs } from '../package-init-command.js';
import type { PackageType } from '@dorkos/marketplace/package-types';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-package-init-test-'));
}

const PACKAGE_TYPES: readonly PackageType[] = ['plugin', 'agent', 'skill-pack', 'adapter'] as const;

describe('parsePackageInitArgs', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('parses a bare name with no options', () => {
    const args = parsePackageInitArgs(['my-pkg']);
    expect(args.name).toBe('my-pkg');
    expect(args.type).toBeUndefined();
    expect(args.parentDir).toBeUndefined();
  });

  it('parses --type, --parent-dir, --description, --author', () => {
    const args = parsePackageInitArgs([
      'my-pkg',
      '--type',
      'agent',
      '--parent-dir',
      '/tmp/foo',
      '--description',
      'A test package',
      '--author',
      'Tester',
    ]);
    expect(args).toEqual({
      name: 'my-pkg',
      type: 'agent',
      parentDir: '/tmp/foo',
      description: 'A test package',
      author: 'Tester',
    });
  });

  it('exits with non-zero when name is missing', () => {
    expect(() => parsePackageInitArgs([])).toThrow(/process\.exit\(1\)/);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
  });

  it('exits with non-zero when --type is invalid', () => {
    expect(() => parsePackageInitArgs(['my-pkg', '--type', 'bogus'])).toThrow(/process\.exit\(1\)/);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid --type value'));
  });

  it('exits with non-zero on unknown option', () => {
    expect(() => parsePackageInitArgs(['my-pkg', '--nope', 'x'])).toThrow(/process\.exit\(1\)/);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("Unknown option for 'package init'")
    );
  });
});

describe('runPackageInit', () => {
  let tmpDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = createTempDir();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe.each(PACKAGE_TYPES)('package type "%s"', (type) => {
    it(`scaffolds a ${type} with a manifest`, async () => {
      const name = `test-${type}`;
      await runPackageInit({ name, type, parentDir: tmpDir });

      const packagePath = path.join(tmpDir, name);
      const manifestPath = path.join(packagePath, '.dork', 'manifest.json');
      expect(fs.existsSync(packagePath)).toBe(true);
      expect(fs.existsSync(manifestPath)).toBe(true);

      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      expect(manifest.name).toBe(name);
      expect(manifest.type).toBe(type);
      expect(manifest.schemaVersion).toBe(1);
      expect(manifest.version).toBe('0.0.1');
    });
  });

  it("defaults type to 'plugin' when not specified", async () => {
    const name = 'default-type-pkg';
    await runPackageInit({ name, parentDir: tmpDir });

    const manifest = JSON.parse(
      fs.readFileSync(path.join(tmpDir, name, '.dork', 'manifest.json'), 'utf-8')
    );
    expect(manifest.type).toBe('plugin');
  });

  it('prints the created path and the list of files written', async () => {
    const name = 'logged-pkg';
    await runPackageInit({ name, type: 'plugin', parentDir: tmpDir });

    const packagePath = path.join(tmpDir, name);
    expect(logSpy).toHaveBeenCalledWith(`Created package at: ${packagePath}`);
    expect(logSpy).toHaveBeenCalledWith('Files written:');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('.dork/manifest.json'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('README.md'));
  });

  it('writes a Claude Code plugin manifest for plugin/skill-pack/adapter types', async () => {
    for (const type of ['plugin', 'skill-pack', 'adapter'] as const) {
      const name = `cc-${type}`;
      await runPackageInit({ name, type, parentDir: tmpDir });
      expect(fs.existsSync(path.join(tmpDir, name, '.claude-plugin', 'plugin.json'))).toBe(true);
    }
  });

  it('does not write a Claude Code plugin manifest for agent type', async () => {
    const name = 'agent-no-cc';
    await runPackageInit({ name, type: 'agent', parentDir: tmpDir });
    expect(fs.existsSync(path.join(tmpDir, name, '.claude-plugin'))).toBe(false);
  });

  it('refuses to overwrite an existing directory', async () => {
    const name = 'already-here';
    fs.mkdirSync(path.join(tmpDir, name), { recursive: true });

    await expect(runPackageInit({ name, type: 'plugin', parentDir: tmpDir })).rejects.toThrow(
      /already exists/
    );
  });

  it('writes the manifest as-is even when name is uppercase (validator catches it later)', async () => {
    // Documents current CLI behavior: the scaffolder is permissive on names —
    // downstream `validatePackage` is what enforces the kebab-case rule.
    const name = 'BadName';
    await runPackageInit({ name, type: 'plugin', parentDir: tmpDir });

    const manifest = JSON.parse(
      fs.readFileSync(path.join(tmpDir, name, '.dork', 'manifest.json'), 'utf-8')
    );
    expect(manifest.name).toBe('BadName');
  });
});
