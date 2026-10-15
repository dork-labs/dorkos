import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { captureProofSource } from '../../../scripts/local-browser/source-snapshot.js';

const exec = promisify(execFile);
const directories: string[] = [];
const fixtureEnv: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
};
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

/** Index and HEAD writes exist only inside this disposable unit-test repository. */
async function repository() {
  const root = await mkdtemp(path.join(tmpdir(), 'browser-source-snapshot-'));
  directories.push(root);
  await mkdir(path.join(root, 'empty-hooks'));
  const git = (args: string[]) =>
    exec('/usr/bin/git', ['-c', 'core.hooksPath=' + path.join(root, 'empty-hooks'), ...args], {
      cwd: root,
      env: fixtureEnv,
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  await git(['init', '--quiet']);
  await writeFile(
    path.join(root, '.gitignore'),
    ['dist/', '.dork/', 'empty-hooks/', ''].join(String.fromCharCode(10))
  );
  await writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0');
  await writeFile(path.join(root, 'tracked.ts'), 'export const value = 1;');
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src/nested.ts'), 'export const nested = true;');
  await mkdir(path.join(root, '.dork'));
  await writeFile(path.join(root, '.dork/private-fixture'), 'private sentinel, not a credential');
  await symlink('.dork/private-fixture', path.join(root, 'fixture-link'));
  await git([
    'add',
    '--',
    '.gitignore',
    'pnpm-lock.yaml',
    'tracked.ts',
    'src/nested.ts',
    'fixture-link',
  ]);
  await git([
    '-c',
    'user.name=Source snapshot fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'Isolated fixture',
  ]);
  return root;
}

describe('CLI proof frozen source inventory', () => {
  it('detects tracked changes, tracked deletions, and new nonignored source files', async () => {
    const root = await repository();
    const before = await captureProofSource(root, fixtureEnv);
    await writeFile(path.join(root, 'tracked.ts'), 'export const value = 2;');
    const changed = await captureProofSource(root, fixtureEnv);
    expect(changed.fingerprint).not.toBe(before.fingerprint);
    await rm(path.join(root, 'tracked.ts'));
    const deleted = await captureProofSource(root, fixtureEnv);
    expect(deleted.files).toContainEqual({ path: 'tracked.ts', kind: 'deleted' });
    expect(deleted.fingerprint).not.toBe(changed.fingerprint);
    await writeFile(path.join(root, 'untracked.ts'), 'export const added = true;');
    const added = await captureProofSource(root, fixtureEnv);
    expect(added.files).toContainEqual(
      expect.objectContaining({ path: 'untracked.ts', kind: 'file' })
    );
    expect(added.fingerprint).not.toBe(deleted.fingerprint);
    expect(added.head).toBe(before.head);
  });

  it('keeps ignored dist and proof artifacts outside the frozen source identity', async () => {
    const root = await repository();
    const before = await captureProofSource(root, fixtureEnv);
    await mkdir(path.join(root, 'dist'));
    await mkdir(path.join(root, '.dork/local-browser'), { recursive: true });
    await writeFile(path.join(root, 'dist/generated.js'), 'generated output');
    await writeFile(path.join(root, '.dork/local-browser/receipt.json'), '{}');
    const after = await captureProofSource(root, fixtureEnv);
    expect(after.fingerprint).toBe(before.fingerprint);
    expect(
      after.files.some((file) => file.path.startsWith('dist/') || file.path.startsWith('.dork/'))
    ).toBe(false);
  });

  it('rejects an indexed file whose parent becomes a link to a private directory', async () => {
    const root = await repository();
    const privateDirectory = await mkdtemp(path.join(tmpdir(), 'browser-source-private-'));
    directories.push(privateDirectory);
    await writeFile(path.join(privateDirectory, 'nested.ts'), 'private target must never be read');
    const before = await captureProofSource(root, fixtureEnv);
    expect(before.files).toContainEqual(
      expect.objectContaining({ path: 'src/nested.ts', kind: 'file' })
    );
    await rm(path.join(root, 'src'), { recursive: true });
    await symlink(privateDirectory, path.join(root, 'src'));
    await expect(captureProofSource(root, fixtureEnv)).rejects.toThrow(
      'Proof source ancestor must be a real directory'
    );
  });

  it('records a tracked link without hashing or following its private target', async () => {
    const root = await repository();
    const before = await captureProofSource(root, fixtureEnv);
    const entry = before.files.find((file) => file.path === 'fixture-link');
    expect(entry).toMatchObject({ kind: 'symlink', target: '.dork/private-fixture' });
    expect(entry).not.toHaveProperty('sha256');
    await writeFile(path.join(root, '.dork/private-fixture'), 'changed private sentinel');
    expect((await captureProofSource(root, fixtureEnv)).fingerprint).toBe(before.fingerprint);
  });
});
