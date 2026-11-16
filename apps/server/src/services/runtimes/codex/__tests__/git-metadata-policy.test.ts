import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { minimalGitEnv } from '@dorkos/shared/safe-git';
import { codexPermissionProfile, codexProtectedConfig } from '../policy/protected-profile.js';
import { gitMetadataReadRules } from '../policy/git-metadata.js';

const key = (file: string) => file.split(path.sep).join('/');
let root: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-git-policy-')));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    env: minimalGitEnv(),
    stdio: 'pipe',
  });
}

function render(cwd: string, mode = 'acceptEdits', writable: string[] = []) {
  const policy = {
    roots: {
      cwd,
      home: path.join(root, 'home'),
      data: path.join(root, 'data'),
      accounts: [],
      agentFolders: [cwd],
      agentHomes: [],
    },
    writable,
  };
  fs.mkdirSync(policy.roots.home, { recursive: true });
  fs.mkdirSync(policy.roots.data, { recursive: true });
  const config = codexProtectedConfig(cwd, policy, { permissionMode: mode });
  const profiles = config.permissions as Record<string, { filesystem: Record<string, string> }>;
  return profiles[codexPermissionProfile({ permissionMode: mode })]!.filesystem;
}

// Explicit literal restrictions survive an ancestor's broader writable temporary root.
describe('Codex git metadata below Full (DOR-4485)', () => {
  it.each(['default', 'acceptEdits'])('keeps an existing .git directory readable at %s', (mode) => {
    const cwd = path.join(root, 'project');
    fs.mkdirSync(path.join(cwd, '.git'), { recursive: true });
    const files = render(cwd, mode);
    expect(files[key(path.join(cwd, '.git'))]).toBe('read');
    expect(files[key(path.join(root, 'data', 'host.key'))]).toBe('deny');
    expect(files[cwd]).not.toBe('read');
  });

  it('protects the worktree pointer, its git directory and the shared common directory from a subfolder', () => {
    const main = path.join(root, 'main');
    const tree = path.join(root, 'tree');
    fs.mkdirSync(main);
    git(main, 'init', '-q', '--initial-branch=main');
    git(
      main,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'fixture'
    );
    git(main, 'worktree', 'add', '-q', '-b', 'side', tree);
    const cwd = path.join(tree, 'subfolder');
    fs.mkdirSync(cwd);
    const pointer = path.join(tree, '.git');
    const gitDir = fs.readFileSync(pointer, 'utf8').trim().slice('gitdir: '.length);
    const files = render(cwd);
    for (const target of [pointer, gitDir, path.join(main, '.git')]) {
      expect(files[key(target)], target).toBe('read');
    }
  });

  it('protects existing metadata in an additional writable folder too', () => {
    const cwd = path.join(root, 'desk');
    const grant = path.join(root, 'grant');
    fs.mkdirSync(cwd);
    fs.mkdirSync(path.join(grant, '.git'), { recursive: true });
    const files = render(cwd, 'acceptEdits', [grant]);
    expect(files[key(path.join(grant, '.git'))]).toBe('read');
    expect(files[grant]).not.toBe('read');
    expect(files[cwd]).not.toBe('read');
  });

  it('protects both a temporary folder alias and its canonical spelling', () => {
    const real = path.join(root, 'real');
    const alias = path.join(root, 'alias');
    fs.mkdirSync(path.join(real, '.git'), { recursive: true });
    fs.symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const files = render(alias);
    expect(files[key(path.join(alias, '.git'))]).toBe('read');
    expect(files[key(path.join(real, '.git'))]).toBe('read');
    for (const dir of [alias, real])
      expect(files[key(path.join(dir, '.git', '**', '.credentials*'))]).toBe('deny');
  });

  it('does not reopen metadata underneath a protected secret folder', () => {
    const cwd = path.join(root, 'desk');
    const secret = path.join(root, 'home', '.ssh');
    const grant = path.join(secret, 'repository');
    fs.mkdirSync(cwd);
    fs.mkdirSync(path.join(grant, '.git'), { recursive: true });
    if (process.platform === 'linux') {
      expect(() => render(cwd, 'acceptEdits', [grant])).toThrow(/Choose another folder/);
    } else {
      const files = render(cwd, 'acceptEdits', [grant]);
      expect(files[key(secret)]).toBe('deny');
      expect(files[key(path.join(grant, '.git'))]).toBe('deny');
    }
  });

  it('refuses Linux nested-denial mount conflicts without dropping the secret denial', () => {
    const cwd = path.join(root, 'desk');
    const home = path.join(root, 'home');
    const grant = path.join(home, '.ssh', 'repository');
    fs.mkdirSync(path.join(cwd, '.git'), { recursive: true });
    fs.mkdirSync(path.join(grant, '.git'), { recursive: true });
    const roots = {
      cwd,
      home,
      data: path.join(root, 'data'),
      accounts: [],
      agentFolders: [cwd],
      agentHomes: [],
    };
    expect(gitMetadataReadRules([cwd], roots, 'linux')[key(path.join(cwd, '.git'))]).toBe('read');
    expect(() => gitMetadataReadRules([cwd, grant], roots, 'linux')).toThrow(
      /Choose another folder/
    );
    expect(gitMetadataReadRules([cwd, grant], roots, 'darwin')[key(path.join(grant, '.git'))]).toBe(
      'deny'
    );
  });

  it('refuses an unreadable git pointer instead of quietly granting its folder writes', () => {
    const cwd = path.join(root, 'project');
    fs.mkdirSync(cwd);
    fs.writeFileSync(path.join(cwd, '.git'), 'not a git pointer');
    expect(() => render(cwd)).toThrow(/git/i);
  });

  it.each([
    '[client]',
    '{client}',
    // Windows cannot create names containing these characters.
    ...(process.platform === 'win32' ? [] : ['client*', 'client?']),
  ])('refuses metadata paths that Codex would interpret as patterns: %s', (name) => {
    const cwd = path.join(root, name);
    fs.mkdirSync(path.join(cwd, '.git'), { recursive: true });
    for (const mode of ['default', 'acceptEdits', 'bypassPermissions']) {
      // Full still needs literal metadata roots for the shared secret scan.
      expect(() => render(cwd, mode)).toThrow(/Choose another folder/);
    }
  });

  it('protects a git pointer target without a worktree common-directory marker', () => {
    const cwd = path.join(root, 'submodule');
    const metadata = path.join(root, 'module-data');
    fs.mkdirSync(cwd);
    fs.mkdirSync(metadata);
    fs.writeFileSync(path.join(cwd, '.git'), 'gitdir: ../module-data\n');
    const files = render(cwd);
    expect(files[key(path.join(cwd, '.git'))]).toBe('read');
    expect(files[key(metadata)]).toBe('read');
  });

  it('refuses a common-directory marker that exists but cannot be read as a file', () => {
    const cwd = path.join(root, 'tree');
    const metadata = path.join(root, 'metadata');
    fs.mkdirSync(cwd);
    fs.mkdirSync(path.join(metadata, 'commondir'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.git'), 'gitdir: ../metadata\n');
    expect(() => render(cwd)).toThrow(/git/i);
  });

  it('leaves Full git writes and a non-repository folder alone', () => {
    const cwd = path.join(root, 'project');
    fs.mkdirSync(cwd);
    expect(render(cwd)[path.join(cwd, '.git')]).toBeUndefined();
    fs.mkdirSync(path.join(cwd, '.git'));
    const full = render(cwd, 'bypassPermissions');
    expect(full[key(path.join(cwd, '.git'))]).not.toBe('read');
    expect(full[':root']).toBe('write');
    expect(full[key(path.join(root, 'data', 'host.key'))]).toBe('deny');
  });
});
