import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  codexProtectedConfig,
  codexPermissionProfile,
  type CodexFilePolicy,
} from '../policy/protected-profile.js';
import {
  prepareCodexLoadParents,
  prepareCodexProtectedParents,
  prepareProtectedParents,
} from '../policy/protected-parents.js';

const folders: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-parent-prep-')));
  folders.push(root);
  const own = path.join(root, 'own');
  const other = path.join(root, 'data', 'agents', 'other');
  for (const dir of [own, other, path.join(root, 'person'), path.join(root, 'account')])
    fs.mkdirSync(dir, { recursive: true });
  const policy: CodexFilePolicy = {
    roots: {
      cwd: own,
      home: path.join(root, 'person'),
      data: path.join(root, 'data'),
      accounts: [path.join(root, 'account')],
      agentFolders: [own],
      agentHomes: [own, other],
    },
    writable: [own],
    ownAgentHomes: [own],
  };
  const config = codexProtectedConfig(own, policy, { permissionMode: 'acceptEdits' });
  const profiles = config.permissions as Record<string, { filesystem: Record<string, unknown> }>;
  const filesystem =
    profiles[codexPermissionProfile({ permissionMode: 'acceptEdits' })]!.filesystem;
  return { root, own, other, policy, filesystem };
}

it('prepares general literal parents, never protected targets, other homes or wildcard paths', () => {
  const { own, other, policy, filesystem } = fixture();
  const before = codexProtectedConfig(own, policy, { permissionMode: 'acceptEdits' });
  prepareCodexProtectedParents(policy, filesystem);
  expect(fs.existsSync(path.join(own, '.claude'))).toBe(true);
  expect(fs.lstatSync(path.join(own, '.claude')).isDirectory()).toBe(true);
  expect(fs.lstatSync(path.join(policy.roots.home, '.config', 'gh')).isDirectory()).toBe(true);
  expect(fs.lstatSync(path.join(own, '.dork')).isDirectory()).toBe(true);
  for (const name of ['settings.json', 'settings.local.json', 'skills', 'commands', 'agents'])
    expect(fs.existsSync(path.join(own, '.claude', name))).toBe(false);
  expect(fs.existsSync(path.join(other, '.claude'))).toBe(false);
  expect(fs.existsSync(path.join(policy.roots.data, 'agents', '*'))).toBe(false);
  expect(codexProtectedConfig(own, policy, { permissionMode: 'acceptEdits' })).toEqual(before);
});

it.each(['symlink', 'file'] as const)(
  'leaves an obstructing %s and its target untouched',
  (kind) => {
    const { root, own, policy, filesystem } = fixture();
    const blocked = path.join(own, '.claude');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    if (kind === 'symlink') fs.symlinkSync(outside, blocked);
    else fs.writeFileSync(blocked, 'leave this file');
    prepareCodexProtectedParents(policy, filesystem);
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.lstatSync(blocked).isSymbolicLink()).toBe(kind === 'symlink');
    if (kind === 'file') expect(fs.readFileSync(blocked, 'utf8')).toBe('leave this file');
  }
);

it('does not treat cwd membership as ownership of another registered home', () => {
  const { own, policy, filesystem } = fixture();
  policy.ownAgentHomes = [];
  prepareCodexProtectedParents(policy, filesystem);
  expect(fs.existsSync(path.join(own, '.claude'))).toBe(false);
});

it('does not create a discovered Claude account home', () => {
  const { policy, filesystem } = fixture();
  const account = policy.roots.accounts[0]!;
  fs.rmdirSync(account);
  prepareCodexProtectedParents(policy, filesystem);
  expect(fs.existsSync(account)).toBe(false);
});

it('does not follow a symlink at the captured home itself', () => {
  const { root, own, policy, filesystem } = fixture();
  const outside = path.join(root, 'outside-home');
  fs.mkdirSync(outside);
  fs.rmdirSync(own);
  fs.symlinkSync(outside, own);
  prepareCodexProtectedParents(policy, filesystem);
  expect(fs.readdirSync(outside)).toEqual([]);
  expect(fs.lstatSync(own).isSymbolicLink()).toBe(true);
});

it('never materializes wildcard parents or an uncaptured launch policy', () => {
  const { own, policy } = fixture();
  prepareProtectedParents({ [path.join(own, 'missing*', 'target')]: 'deny' }, [own]);
  expect(fs.existsSync(path.join(own, 'missing*'))).toBe(false);
  const config = codexProtectedConfig(own, policy, { permissionMode: 'acceptEdits' });
  prepareCodexLoadParents(undefined, config, { permissionMode: 'acceptEdits' });
  expect(fs.existsSync(path.join(own, '.claude'))).toBe(false);
  prepareCodexLoadParents(policy, config, { permissionMode: 'acceptEdits' });
  expect(fs.lstatSync(path.join(own, '.claude')).isDirectory()).toBe(true);
});

it('retains every rule when mkdir fails, without creating the protected target', () => {
  const { own, policy, filesystem } = fixture();
  const before = codexProtectedConfig(own, policy, { permissionMode: 'acceptEdits' });
  const mkdir = fs.mkdirSync;
  vi.spyOn(fs, 'mkdirSync').mockImplementation(((
    target: fs.PathLike,
    options?: fs.MakeDirectoryOptions
  ) => {
    if (String(target) === path.join(own, '.claude'))
      throw Object.assign(new Error('denied by fixture'), { code: 'EACCES' });
    return mkdir(target, options);
  }) as typeof fs.mkdirSync);
  expect(() => prepareCodexProtectedParents(policy, filesystem)).not.toThrow();
  expect(fs.existsSync(path.join(own, '.claude'))).toBe(false);
  expect(codexProtectedConfig(own, policy, { permissionMode: 'acceptEdits' })).toEqual(before);
});
