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

  it('includes optionalDependencies, which npm installs by default', async () => {
    // Leaving these out would under-report the fetch: npm installs them unless
    // asked not to, and the preview is what a person consents to.
    await writePackageJson(workDir, {
      dependencies: { zod: '^4.3.6' },
      optionalDependencies: { fsevents: '^2.3.3' },
    });

    await expect(readNpmDependencies(workDir)).resolves.toEqual([
      { name: 'zod', range: '^4.3.6' },
      { name: 'fsevents', range: '^2.3.3', optional: true },
    ]);
  });

  it('reports a name declared in both maps once, as required', async () => {
    await writePackageJson(workDir, {
      dependencies: { zod: '^4.3.6' },
      optionalDependencies: { zod: '^3.0.0' },
    });

    await expect(readNpmDependencies(workDir)).resolves.toEqual([{ name: 'zod', range: '^4.3.6' }]);
  });

  it('skips dependency entries whose range is not a string', async () => {
    await writePackageJson(workDir, { dependencies: { zod: '^4.3.6', bogus: { version: 1 } } });

    await expect(readNpmDependencies(workDir)).resolves.toEqual([{ name: 'zod', range: '^4.3.6' }]);
  });
});

describe('npmInstallCommand', () => {
  it('pins the three flags a package-shipped .npmrc must not be able to override', () => {
    // Each of these is a security boundary, and a command-line flag is the only
    // kind of npm setting a config file in npm's cwd cannot override.
    const { args } = npmInstallCommand(workDir);
    expect(args).toContain('--ignore-scripts'); // no lifecycle code
    expect(args).toContain('--global=false'); // may only write inside staging
    expect(args).toContain('--no-workspaces'); // only the root the preview disclosed
  });

  it('installs production dependencies only, quietly, in the given directory', () => {
    const cmd = npmInstallCommand(workDir);

    expect(cmd.command).toBe(process.platform === 'win32' ? 'npm.cmd' : 'npm');
    expect(cmd.args).toEqual([
      'install',
      '--omit=dev',
      '--ignore-scripts',
      '--global=false',
      '--no-workspaces',
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
 * Containment, pinned against the REAL npm rather than a stub.
 *
 * A stub proves which flags we pass; only real npm proves those flags have the
 * effect we claim when the directory npm runs in was authored by a stranger.
 * Every fixture below was first run against the unprotected version and did the
 * bad thing (DOR-1341 review): a `git` shim in the global bin, and `TOPSECRET`
 * readable through `node_modules`.
 *
 * All dependencies are `file:` paths, so none of this needs a registry or a
 * network. Skipped on win32, where the global prefix layout differs.
 */
describe.skipIf(process.platform === 'win32')('containment, against real npm', () => {
  /** A minimal local package directory usable as a `file:` dependency. */
  async function writeLocalDep(dir: string, manifest: Record<string, unknown>): Promise<string> {
    await mkdir(dir, { recursive: true });
    await writePackageJson(dir, { version: '1.0.0', ...manifest });
    return dir;
  }

  it('does not run a dependency postinstall, even when the package ships .npmrc ignore-scripts=false', async () => {
    const marker = path.join(workDir, 'POSTINSTALL-RAN');
    const pkgDir = path.join(workDir, 'pkg');
    await mkdir(pkgDir, { recursive: true });
    // Inside the staging dir, so the link npm makes for it stays internal and
    // this test measures only the lifecycle-script rule.
    await writeLocalDep(path.join(pkgDir, 'evil-dep'), {
      name: 'evil-dep',
      scripts: { postinstall: `node -e "require('fs').writeFileSync('${marker}','ran')"` },
    });
    await writePackageJson(pkgDir, {
      name: 'hostile',
      version: '1.0.0',
      dependencies: { 'evil-dep': 'file:./evil-dep' },
    });
    await writeFile(path.join(pkgDir, '.npmrc'), 'ignore-scripts=false\n', 'utf-8');

    const warnings = await installStagedNpmDependencies({
      stagingDir: pkgDir,
      installPath: '/data/plugins/hostile',
      logger: noopLogger,
    });

    expect(warnings).toEqual([]);
    expect(existsSync(path.join(pkgDir, 'node_modules', 'evil-dep'))).toBe(true);
    // The postinstall never ran, and the file that asked for it is gone.
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(path.join(pkgDir, '.npmrc'))).toBe(false);
  }, 120_000);

  it('cannot be turned into a global install by the package .npmrc, so no bin shim is planted', async () => {
    // The original escape: `global=true` makes a bare `npm install` install THE
    // CWD PACKAGE ITSELF into the machine's global prefix, bin shims and all —
    // exit code 0, nothing written inside staging for a rollback to undo. A
    // shim named `git` runs the package's code the next time anyone types it.
    const prefix = path.join(workDir, 'global-prefix');
    await mkdir(prefix, { recursive: true });
    vi.stubEnv('npm_config_prefix', prefix);

    const pkgDir = path.join(workDir, 'pkg');
    await mkdir(pkgDir, { recursive: true });
    await writeFile(path.join(pkgDir, 'pwn.js'), 'console.log("pwned")\n', 'utf-8');
    await writeLocalDep(path.join(pkgDir, 'real-dep'), { name: 'real-dep' });
    await writePackageJson(pkgDir, {
      name: 'hostile-plugin',
      version: '1.0.0',
      bin: { git: 'pwn.js' },
      dependencies: { 'real-dep': 'file:./real-dep' },
    });
    await writeFile(path.join(pkgDir, '.npmrc'), 'global=true\n', 'utf-8');

    await installStagedNpmDependencies({
      stagingDir: pkgDir,
      installPath: '/data/plugins/hostile-plugin',
      logger: noopLogger,
    });

    // Nothing reached the global prefix…
    expect(existsSync(path.join(prefix, 'bin', 'git'))).toBe(false);
    expect(existsSync(path.join(prefix, 'lib', 'node_modules', 'hostile-plugin'))).toBe(false);
    // …the dependency landed where it belongs…
    expect(existsSync(path.join(pkgDir, 'node_modules', 'real-dep'))).toBe(true);
    // …and the file that asked for the escape is not on its way to the install root.
    expect(existsSync(path.join(pkgDir, '.npmrc'))).toBe(false);
  }, 120_000);

  it('removes the links npm mints outside the package, and keeps the .bin shims inside it', async () => {
    // `stage-package.ts` strips symlinks as it copies (DOR-279), but npm runs
    // afterwards: a `file:` dependency makes it create a brand-new link to
    // anywhere on the machine, readable for as long as the staged tree lives.
    const secretDir = path.join(workDir, 'outside-secrets');
    await writeLocalDep(secretDir, { name: 'peek' });
    await writeFile(path.join(secretDir, 'creds.txt'), 'TOPSECRET\n', 'utf-8');

    const pkgDir = path.join(workDir, 'pkg');
    await mkdir(pkgDir, { recursive: true });
    // A second dependency INSIDE the package, declaring a bin, so the test can
    // tell "strip escaping links" apart from "strip every link".
    const toolDir = path.join(pkgDir, 'tool-dep');
    await writeLocalDep(toolDir, { name: 'tool-dep', bin: { mytool: 'cli.js' } });
    await writeFile(path.join(toolDir, 'cli.js'), '#!/usr/bin/env node\n', 'utf-8');
    await writePackageJson(pkgDir, {
      name: 'peeker',
      version: '1.0.0',
      dependencies: { peek: `file:${secretDir}`, 'tool-dep': 'file:./tool-dep' },
    });

    const warnings = await installStagedNpmDependencies({
      stagingDir: pkgDir,
      installPath: '/data/plugins/peeker',
      logger: noopLogger,
    });

    // The escaping link is gone — and so is the read through it.
    expect(existsSync(path.join(pkgDir, 'node_modules', 'peek'))).toBe(false);
    expect(existsSync(path.join(pkgDir, 'node_modules', 'peek', 'creds.txt'))).toBe(false);
    // The secret itself is untouched: we removed our link, not the target.
    expect(existsSync(path.join(secretDir, 'creds.txt'))).toBe(true);
    // The internal dependency and its bin shim survive.
    expect(existsSync(path.join(pkgDir, 'node_modules', 'tool-dep'))).toBe(true);
    expect(existsSync(path.join(pkgDir, 'node_modules', '.bin', 'mytool'))).toBe(true);
    // And the person is told, rather than left with a quietly different package.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('outside the package');
    expect(warnings[0]).toContain('peek');
  }, 120_000);
});
