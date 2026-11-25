import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { minimalGitEnv } from '@dorkos/shared/safe-git';
import { codexPermissionProfile, codexProtectedConfig } from '../policy/protected-profile.js';
import { gitMetadataReadRules } from '../policy/git-metadata.js';
import { codexExactKeys } from '../policy/codex-path-keys.js';

const MODES = ['default', 'acceptEdits', 'bypassPermissions'];
const INSIDE_GIT = 'Codex can’t work inside a Git folder. Choose the project folder instead.';

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

const rootsFor = (cwd: string) => ({
  cwd,
  home: path.join(root, 'home'),
  data: path.join(root, 'data'),
  accounts: [],
  agentFolders: [cwd],
  agentHomes: [],
});

function render(cwd: string, mode = 'acceptEdits', writable: string[] = []) {
  const policy = { roots: rootsFor(cwd), writable };
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

  it('starts at Full on Linux where Git files inside a protected folder refuse below it', () => {
    const cwd = path.join(root, 'desk');
    const grant = path.join(root, 'home', '.ssh', 'repository');
    fs.mkdirSync(cwd);
    fs.mkdirSync(path.join(grant, '.git'), { recursive: true });
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      expect(() => render(cwd, 'default', [grant])).toThrow(/protected folder on Linux/);
      expect(render(cwd, 'bypassPermissions', [grant])[':root']).toBe('write');
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });

  it('refuses Linux nested-denial mount conflicts below Full only, without dropping the secret denial', () => {
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
    expect(
      gitMetadataReadRules([cwd], roots, { platform: 'linux' })[key(path.join(cwd, '.git'))]
    ).toBe('read');
    expect(() => gitMetadataReadRules([cwd, grant], roots, { platform: 'linux' })).toThrow(
      'Codex can’t keep Git files safe inside a protected folder on Linux. Choose another folder.'
    );
    // Full applies no Git rules, so nothing needs mounting there.
    const full = gitMetadataReadRules([cwd, grant], roots, { platform: 'linux', enforced: false });
    expect(full[key(path.join(grant, '.git'))]).toBe('deny');
    const mac = gitMetadataReadRules([cwd, grant], roots, { platform: 'darwin' });
    expect(mac[key(path.join(grant, '.git'))]).toBe('deny');
  });

  it('keeps a .git file that is not a pointer read-only and starts', () => {
    const cwd = path.join(root, 'project');
    fs.mkdirSync(cwd);
    fs.writeFileSync(path.join(cwd, '.git'), 'not a git pointer');
    expect(render(cwd)[key(path.join(cwd, '.git'))]).toBe('read');
  });

  it.each([
    '[client]',
    'site [old]',
    '{client}',
    // Windows cannot create names containing these characters.
    ...(process.platform === 'win32' ? [] : ['client*', 'client?']),
  ])('protects metadata in a folder Codex would read as a pattern at every level: %s', (name) => {
    const cwd = path.join(root, name);
    fs.mkdirSync(path.join(cwd, '.git'), { recursive: true });
    // Every glob character becomes a one-character class; a lone `]` is plain.
    const escaped = key(cwd).replace(/[*?[{}]/g, (char) => `[${char}]`);
    for (const mode of MODES) {
      const files = render(cwd, mode);
      // An exact path with glob characters takes the scoped spelling Codex reads as written.
      expect(files[key(path.join(cwd, '.git'))]).toEqual(
        mode === 'bypassPermissions' ? undefined : { '.': 'read' }
      );
      expect(files[`${escaped}/**/.credentials*`]).toBe('deny');
      expect(files[`${escaped}/.git/**/.credentials*`]).toBe('deny');
      expect(files[`${key(cwd)}/**/.credentials*`]).toBeUndefined();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a folder with a backslash at every level, and not its look-alike',
    () => {
      // Codex reads a backslash in a glob as an escape: `a\b/**/.env` would guard `ab`.
      const cwd = path.join(root, 'a\\b');
      const lookalike = path.join(root, 'ab');
      for (const dir of [cwd, lookalike]) fs.mkdirSync(dir);
      for (const mode of MODES) {
        expect(() => render(cwd, mode)).toThrow(
          'Codex can’t protect a folder with a backslash in its path. Choose another folder.'
        );
        expect(render(lookalike, mode)[`${key(lookalike)}/**/.env`]).toBe('deny');
      }
    }
  );

  it('on Linux, refuses a folder Codex would read as a pattern below Full only', () => {
    const cwd = path.join(root, 'site [old]');
    const plain = path.join(root, 'plain');
    for (const dir of [cwd, plain]) fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      for (const mode of ['default', 'acceptEdits'])
        expect(() => render(cwd, mode)).toThrow(
          'On Linux, Codex needs Full for a folder with * ? [ ] { } in its path.'
        );
      expect(render(cwd, 'bypassPermissions')[':root']).toBe('write');
      expect(render(plain, 'acceptEdits')[key(path.join(plain, '.git'))]).toBe('read');
      // Without a repository: the folder's own secret globs refuse alone.
      const bare = path.join(root, 'bare [old]');
      fs.mkdirSync(bare);
      expect(() => render(bare, 'default')).toThrow(/needs Full/);
      // And an exact key alone refuses too, wherever it came from.
      expect(() =>
        codexExactKeys({ [key(path.join(cwd, '.git'))]: 'read' }, undefined, true)
      ).toThrow(/needs Full/);
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });

  it('starts a worktree whose git folder is gone at every level, keeping its pointer read-only', () => {
    const cwd = path.join(root, 'tree');
    fs.mkdirSync(cwd);
    const pointer = path.join(cwd, '.git');
    // Outside the temporary folders Edit can write, as a moved main checkout is.
    const gone = path.join(path.parse(root).root, `dor-4542-gone-${path.basename(root)}`, 'tree');
    fs.writeFileSync(pointer, `gitdir: ${gone}\n`);
    for (const mode of MODES) {
      const files = render(cwd, mode);
      expect(files[key(pointer)]).toBe(mode === 'bypassPermissions' ? undefined : 'read');
      expect(files[key(gone)]).toBeUndefined();
    }
    // Repaired mid-session: the next render, which every turn's load fingerprint
    // takes, protects the restored git folder too.
    const restored = path.join(root, 'main', '.git', 'worktrees', 'tree');
    fs.writeFileSync(pointer, `gitdir: ${restored}\n`);
    expect(render(cwd, 'default')[key(restored)]).toBeUndefined();
    fs.mkdirSync(restored, { recursive: true });
    expect(render(cwd, 'default')[key(restored)]).toBe('read');
  });

  it('refuses at Edit only a worktree whose missing git folder this chat could create', () => {
    const cwd = path.join(root, 'tree');
    fs.mkdirSync(cwd);
    fs.writeFileSync(path.join(cwd, '.git'), 'gitdir: ./restorable\n');
    expect(() => render(cwd, 'acceptEdits')).toThrow(
      'This worktree’s Git folder is missing. Repair the worktree, or choose another folder.'
    );
    for (const mode of ['default', 'bypassPermissions'])
      expect(() => render(cwd, mode)).not.toThrow();
    // A missing folder outside every writable folder can't be made by a command.
    expect(() =>
      gitMetadataReadRules([cwd], rootsFor(cwd), { writable: [path.join(root, 'other')] })
    ).not.toThrow();
  });

  it.each(MODES)('still refuses a folder inside a .git folder at %s', (mode) => {
    const cwd = path.join(root, 'project', '.git', 'worktrees', 'side');
    fs.mkdirSync(cwd, { recursive: true });
    expect(() => render(cwd, mode)).toThrow(INSIDE_GIT);
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
    expect(() => render(cwd)).toThrow(
      'Codex can’t read this folder’s Git files. Choose another folder.'
    );
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
