import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const scratchDirs: string[] = [];
const installScript = join(import.meta.dirname, '..', 'install.sh');

async function runInstaller(nodeVersion: string) {
  const scratch = await mkdtemp(join(tmpdir(), 'dorkos-install-node-'));
  scratchDirs.push(scratch);
  const fakeNode = join(scratch, 'node');
  const fakeNpm = join(scratch, 'npm');
  await writeFile(
    fakeNode,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "v${nodeVersion}"; exit 0; fi\nexec "${process.execPath}" "$@"\n`
  );
  await writeFile(fakeNpm, '#!/bin/sh\necho "10.0.0"\n');
  await Promise.all([chmod(fakeNode, 0o755), chmod(fakeNpm, 0o755)]);

  return execFileAsync('/bin/bash', [installScript, '--dry-run'], {
    env: { ...process.env, PATH: `${scratch}:${process.env.PATH}` },
  });
}

afterEach(async () => {
  await Promise.all(
    scratchDirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe('install script Node.js compatibility floor', () => {
  it.each(['22.21.9', '22.22.2'])('rejects unsupported Node.js %s', async (version) => {
    await expect(runInstaller(version)).rejects.toMatchObject({
      stderr: '',
      stdout: expect.stringContaining(`Node.js 22.22.3 or later is required`),
    });
  });

  it.each(['22.22.3', '24.14.1'])('accepts supported Node.js %s', async (version) => {
    await expect(runInstaller(version)).resolves.toMatchObject({
      stderr: '',
      stdout: expect.stringContaining(`[dry-run] Node.js v${version} ✓`),
    });
  });
});

/**
 * Run the installer for real against fake `node`, `npm` and `dorkos` binaries.
 * The fake `dorkos` appends each call's arguments to `dorkos-calls.log`.
 */
async function runFullInstall(args: string[]) {
  const scratch = await mkdtemp(join(tmpdir(), 'dorkos-install-ref-'));
  scratchDirs.push(scratch);
  const log = join(scratch, 'dorkos-calls.log');
  await writeFile(
    join(scratch, 'node'),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "v24.14.1"; exit 0; fi\nexec "${process.execPath}" "$@"\n`
  );
  await writeFile(join(scratch, 'npm'), '#!/bin/sh\nexit 0\n');
  await writeFile(join(scratch, 'dorkos'), `#!/bin/sh\necho "$@" >> "${log}"\necho "0.99.0"\n`);
  await Promise.all(['node', 'npm', 'dorkos'].map((bin) => chmod(join(scratch, bin), 0o755)));

  const result = await execFileAsync('/bin/bash', [installScript, ...args], {
    env: { ...process.env, PATH: `${scratch}:${process.env.PATH}`, DORKOS_NO_PROMPT: '1' },
  });
  const calls = await readFile(log, 'utf8').then(
    (text) => text.trim().split('\n'),
    () => [] as string[]
  );
  return { ...result, calls };
}

describe('install script --ref (DOR-2862)', () => {
  it('hands the install tag to the CLI once after installing', async () => {
    const { calls } = await runFullInstall(['--ref=k3j4mnb8x2qa.hn.launch']);
    expect(calls).toContain('--ref=k3j4mnb8x2qa.hn.launch --version');
  });

  it('never passes a ref when the command carried none', async () => {
    const { calls } = await runFullInstall([]);
    expect(calls.some((call) => call.includes('--ref'))).toBe(false);
  });

  it('drops a ref with characters outside the plain set', async () => {
    const { calls } = await runFullInstall(['--ref=k3j4mnb8x2qa;rm -rf']);
    expect(calls.some((call) => call.includes('--ref'))).toBe(false);
  });

  it('is not mistaken for a version number', async () => {
    const { stdout } = await execFileAsync(
      '/bin/bash',
      [installScript, '--ref=k3j4mnb8x2qa', '--dry-run'],
      { env: process.env }
    );
    expect(stdout).toContain('Would run: npm install -g dorkos@latest');
    expect(stdout).toContain('Would keep install tag on this computer: k3j4mnb8x2qa');
  });
});
