import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDarwinProcessObserver, darwinBirth } from '../runtime/darwin-process-observer.js';
import {
  acceptsDarwinOwnedChildReturn,
  createDarwinOwnedChildLauncher,
} from '../runtime/darwin-owned-child.js';
import type { ProcessIdentity } from '../configuration.js';

describe.skipIf(process.platform !== 'darwin')('genuine supervisor-owned Darwin child', () => {
  let directory: string, artifact: { path: string; sha256: string }, manager: ProcessIdentity;
  beforeAll(async () => {
    directory = await mkdtemp(join(await realpath(tmpdir()), 'darwin-owned-child-'));
    const binary = join(directory, 'observer');
    const source = fileURLToPath(
      new URL('../runtime/native/darwin-process-observer.c', import.meta.url)
    );
    execFileSync(
      '/usr/bin/xcrun',
      [
        '--sdk',
        'macosx',
        'clang',
        '-std=c11',
        '-Wall',
        '-Wextra',
        '-Werror',
        source,
        '-lproc',
        '-o',
        binary,
      ],
      { maxBuffer: 512 * 1024 }
    );
    artifact = {
      path: binary,
      sha256: createHash('sha256')
        .update(await readFile(binary))
        .digest('hex'),
    };
    const batch = await createDarwinProcessObserver(artifact).inspect([process.ppid]);
    const parent = batch.processes[0];
    if (parent?.kind !== 'present' || parent.zombie) throw new Error('GENUINE_MANAGER_REQUIRED');
    manager = darwinBirth(parent.identity);
  });
  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  const command = (body: string) => ({
    executable: process.execPath,
    argv: ['-e', body],
    cwd: directory,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  });

  it('retains the actual child and both pipes through native birth and natural return', async () => {
    const launcher = createDarwinOwnedChildLauncher({ artifact, manager });
    const child = await launcher.launch(
      command(
        'setTimeout(() => { process.stdout.write("out"); process.stderr.write("err"); }, 250)'
      )
    );
    const birth = await child.identity();
    expect(birth.pid).toBe(child.child.pid);
    expect(child.custody().pending).toBe(true);
    expect(acceptsDarwinOwnedChildReturn(child, { returned: true, pid: birth.pid })).toBe(false);
    const receipt = await child.completion();
    expect(receipt.firstCause).toBeNull();
    expect(receipt.exitCode).toBe(0);
    expect(Buffer.from(receipt.stdout).toString()).toBe('out');
    expect(Buffer.from(receipt.stderr).toString()).toBe('err');
    const returned = await child.returned();
    expect(acceptsDarwinOwnedChildReturn(child, returned)).toBe(true);
    expect(acceptsDarwinOwnedChildReturn(child, receipt)).toBe(false);
    expect(child.custody()).toEqual({ pending: false, firstCause: null });
  });
  it('continues draining overflow to natural close while preserving uncertainty', async () => {
    const child = await createDarwinOwnedChildLauncher({ artifact, manager }).launch(
      command('setTimeout(() => process.stdout.write(Buffer.alloc(300000, 65)), 250)')
    );
    await child.identity();
    const receipt = await child.completion();
    expect(receipt.exitCode).toBe(0);
    expect(receipt.firstCause).toBe('CHILD_PIPE_OVERFLOW');
    expect(receipt.stdout.byteLength).toBeLessThanOrEqual(256 * 1024);
    expect(await child.returned()).toBeNull();
    expect(child.custody().pending).toBe(true);
  });
  it('refuses to acquire the child in the manager process itself', async () => {
    await expect(
      createDarwinOwnedChildLauncher({
        artifact,
        manager: { pid: process.pid, birth: 'not-authority' },
      }).launch(command('process.exit(0)'))
    ).rejects.toThrow('SUPERVISOR_PROCESS_REQUIRED');
  });
});
