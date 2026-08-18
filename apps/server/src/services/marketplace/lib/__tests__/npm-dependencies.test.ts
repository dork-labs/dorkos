/**
 * Tests for the staged-package npm dependency installer.
 *
 * Three layers of coverage:
 *
 * 1. `readNpmDependencies` — the package.json reader that both the permission
 *    preview and the installer share. A missing, unreadable, or dependency-free
 *    package.json must read as "no dependencies", never as a thrown error that
 *    would fail an otherwise-fine install.
 * 2. `installStagedNpmDependencies` with an injected runner — the policy layer.
 *    Deps present → the runner is invoked with the security-critical argv in the
 *    staging directory; deps absent → the runner is never invoked; npm missing
 *    or npm failing → a warning is returned and nothing throws.
 * 3. The default runner against a stub `npm` on `PATH` — proves the real
 *    `spawn` wiring executes the command we think it does, which an injected
 *    runner can never show. Skipped on win32, where the stub would need a
 *    `.cmd` shim and the PATH semantics differ.
 */
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { noopLogger } from '@dorkos/shared/logger';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installStagedNpmDependencies,
  npmInstallCommand,
  readNpmDependencies,
  type NpmInstallRunner,
} from '../npm-dependencies.js';

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'dorkos-npm-deps-test-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** Write a package.json into `dir`. */
async function writePackageJson(dir: string, contents: unknown): Promise<void> {
  await writeFile(path.join(dir, 'package.json'), JSON.stringify(contents), 'utf-8');
}

describe('readNpmDependencies', () => {
  it('reads the dependencies map into name/range pairs', async () => {
    await writePackageJson(workDir, {
      name: 'flow',
      dependencies: { zod: '^4.3.6', cronstrue: '~2.0.0' },
    });

    await expect(readNpmDependencies(workDir)).resolves.toEqual([
      { name: 'zod', range: '^4.3.6' },
      { name: 'cronstrue', range: '~2.0.0' },
    ]);
  });

  it('ignores devDependencies', async () => {
    await writePackageJson(workDir, { name: 'flow', devDependencies: { zod: '^4.3.6' } });

    await expect(readNpmDependencies(workDir)).resolves.toEqual([]);
  });

  it('returns nothing when the package has no package.json', async () => {
    await expect(readNpmDependencies(workDir)).resolves.toEqual([]);
  });

  it('returns nothing when package.json is malformed', async () => {
    await writeFile(path.join(workDir, 'package.json'), '{ not json', 'utf-8');

    await expect(readNpmDependencies(workDir)).resolves.toEqual([]);
  });

  it('skips dependency entries whose range is not a string', async () => {
    await writePackageJson(workDir, { dependencies: { zod: '^4.3.6', bogus: { version: 1 } } });

    await expect(readNpmDependencies(workDir)).resolves.toEqual([{ name: 'zod', range: '^4.3.6' }]);
  });
});

describe('npmInstallCommand', () => {
  it('never lets a package run lifecycle scripts', () => {
    expect(npmInstallCommand(workDir).args).toContain('--ignore-scripts');
  });

  it('installs production dependencies only, quietly, in the given directory', () => {
    const cmd = npmInstallCommand(workDir);

    expect(cmd.command).toBe(process.platform === 'win32' ? 'npm.cmd' : 'npm');
    expect(cmd.args).toEqual([
      'install',
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
    ]);
    expect(cmd.cwd).toBe(workDir);
  });
});

describe('installStagedNpmDependencies', () => {
  const installPath = '/data/plugins/flow';

  it('runs npm in the staging directory when the package declares dependencies', async () => {
    await writePackageJson(workDir, { name: 'flow', dependencies: { zod: '^4.3.6' } });
    const run = vi.fn<NpmInstallRunner>().mockResolvedValue({ ok: true });

    const warnings = await installStagedNpmDependencies({
      stagingDir: workDir,
      installPath,
      logger: noopLogger,
      run,
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0]).toEqual(npmInstallCommand(workDir));
    expect(warnings).toEqual([]);
  });

  it('does not run npm when the package declares no dependencies', async () => {
    await writePackageJson(workDir, { name: 'flow', devDependencies: { zod: '^4.3.6' } });
    const run = vi.fn<NpmInstallRunner>().mockResolvedValue({ ok: true });

    const warnings = await installStagedNpmDependencies({
      stagingDir: workDir,
      installPath,
      logger: noopLogger,
      run,
    });

    expect(run).not.toHaveBeenCalled();
    expect(warnings).toEqual([]);
  });

  it('does not run npm when the package has no package.json at its root', async () => {
    const run = vi.fn<NpmInstallRunner>().mockResolvedValue({ ok: true });

    await installStagedNpmDependencies({
      stagingDir: workDir,
      installPath,
      logger: noopLogger,
      run,
    });

    expect(run).not.toHaveBeenCalled();
  });

  it('warns, without failing, when npm is not installed', async () => {
    await writePackageJson(workDir, { name: 'flow', dependencies: { zod: '^4.3.6' } });
    const run = vi
      .fn<NpmInstallRunner>()
      .mockResolvedValue({ ok: false, reason: 'npm-not-found', detail: 'spawn npm ENOENT' });

    const warnings = await installStagedNpmDependencies({
      stagingDir: workDir,
      installPath,
      logger: noopLogger,
      run,
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('npm is not installed');
    expect(warnings[0]).toContain('npm install --omit=dev');
    expect(warnings[0]).toContain(installPath);
  });

  it('warns, without failing, when npm exits non-zero', async () => {
    await writePackageJson(workDir, { name: 'flow', dependencies: { zod: '^4.3.6' } });
    const run = vi.fn<NpmInstallRunner>().mockResolvedValue({
      ok: false,
      reason: 'failed',
      detail: 'npm error code E404\nnpm error 404 Not Found',
    });

    const warnings = await installStagedNpmDependencies({
      stagingDir: workDir,
      installPath,
      logger: noopLogger,
      run,
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('npm error code E404');
    expect(warnings[0]).toContain('npm install --omit=dev');
    expect(warnings[0]).toContain(installPath);
    // Only the first line of npm's output survives into user-facing copy.
    expect(warnings[0]).not.toContain('404 Not Found');
  });

  it('warns rather than throwing when the runner itself blows up', async () => {
    await writePackageJson(workDir, { name: 'flow', dependencies: { zod: '^4.3.6' } });
    const run = vi.fn<NpmInstallRunner>().mockRejectedValue(new Error('boom'));

    const warnings = await installStagedNpmDependencies({
      stagingDir: workDir,
      installPath,
      logger: noopLogger,
      run,
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('boom');
  });
});

describe.skipIf(process.platform === 'win32')('the default runner', () => {
  /**
   * Put an executable stub named `npm` at the front of `PATH` and return the
   * marker file it writes its argv and cwd to when invoked.
   */
  async function installNpmStub(script: string): Promise<string> {
    const binDir = path.join(workDir, 'bin');
    await mkdir(binDir, { recursive: true });
    const stub = path.join(binDir, 'npm');
    await writeFile(stub, script, 'utf-8');
    await chmod(stub, 0o755);
    vi.stubEnv('PATH', `${binDir}${path.delimiter}${process.env.PATH ?? ''}`);
    return path.join(workDir, 'npm-invocation.txt');
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('spawns the real npm command and reports success', async () => {
    const markerPath = path.join(workDir, 'npm-invocation.txt');
    await installNpmStub(`#!/bin/sh\nprintf '%s\\n' "$PWD" "$@" > "${markerPath}"\nexit 0\n`);
    const packageDir = path.join(workDir, 'pkg');
    await mkdir(packageDir, { recursive: true });
    await writePackageJson(packageDir, { name: 'flow', dependencies: { zod: '^4.3.6' } });

    const warnings = await installStagedNpmDependencies({
      stagingDir: packageDir,
      installPath: '/data/plugins/flow',
      logger: noopLogger,
    });

    expect(warnings).toEqual([]);
    const marker = (await readFile(markerPath, 'utf-8')).trim().split('\n');
    // The stub reports the cwd npm ran in, then every argument it received.
    expect(marker.slice(1)).toEqual(npmInstallCommand(packageDir).args);
    // Pinned literally too: no refactor of `npmInstallCommand` may quietly drop
    // the flag that stops a dependency running code at install time.
    expect(marker).toContain('--ignore-scripts');
    await expect(realpath(marker[0]!)).resolves.toBe(await realpath(packageDir));
  });

  it('reports a non-zero exit as a failure carrying npm stderr', async () => {
    await installNpmStub(`#!/bin/sh\necho 'npm error code E404' >&2\nexit 1\n`);
    await writePackageJson(workDir, { name: 'flow', dependencies: { zod: '^4.3.6' } });

    const warnings = await installStagedNpmDependencies({
      stagingDir: workDir,
      installPath: '/data/plugins/flow',
      logger: noopLogger,
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('npm error code E404');
  });

  it('reports a missing npm binary as npm-not-found', async () => {
    // An empty PATH guarantees the lookup fails the way a machine without npm does.
    vi.stubEnv('PATH', path.join(workDir, 'definitely-empty'));
    await writePackageJson(workDir, { name: 'flow', dependencies: { zod: '^4.3.6' } });

    const warnings = await installStagedNpmDependencies({
      stagingDir: workDir,
      installPath: '/data/plugins/flow',
      logger: noopLogger,
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('npm is not installed');
  });
});

/**
 * The security rule, pinned against the REAL npm rather than a stub.
 *
 * A stub proves we pass `--ignore-scripts`; only real npm proves the flag has
 * the effect we claim — and, crucially, that it survives a package shipping its
 * own `.npmrc` that turns it back on. npm reads a project `.npmrc` from its
 * cwd, which for us is a directory whose contents a stranger authored, so
 * "command-line flags outrank config files" is load-bearing rather than
 * incidental. The dependency is a `file:` path so this needs no registry and no
 * network.
 *
 * Skipped on win32 (the marker script is `/bin/sh`) and when npm is absent.
 */
describe.skipIf(process.platform === 'win32')('lifecycle scripts, against real npm', () => {
  it('does not run a dependency postinstall, even when the package ships .npmrc ignore-scripts=false', async () => {
    const marker = path.join(workDir, 'POSTINSTALL-RAN');

    // A local dependency whose postinstall would announce itself on disk.
    const evilDir = path.join(workDir, 'evil-dep');
    await mkdir(evilDir, { recursive: true });
    await writePackageJson(evilDir, {
      name: 'evil-dep',
      version: '1.0.0',
      scripts: { postinstall: `node -e "require('fs').writeFileSync('${marker}','ran')"` },
    });

    const pkgDir = path.join(workDir, 'pkg');
    await mkdir(pkgDir, { recursive: true });
    await writePackageJson(pkgDir, {
      name: 'hostile',
      version: '1.0.0',
      dependencies: { 'evil-dep': `file:${evilDir}` },
    });
    // The package's own attempt to switch the protection back off.
    await writeFile(path.join(pkgDir, '.npmrc'), 'ignore-scripts=false\n', 'utf-8');

    const warnings = await installStagedNpmDependencies({
      stagingDir: pkgDir,
      installPath: '/data/plugins/hostile',
      logger: noopLogger,
    });

    // The dependency itself is installed…
    expect(warnings).toEqual([]);
    expect(existsSync(path.join(pkgDir, 'node_modules', 'evil-dep'))).toBe(true);
    // …and its postinstall never ran.
    expect(existsSync(marker)).toBe(false);
  }, 120_000);
});
