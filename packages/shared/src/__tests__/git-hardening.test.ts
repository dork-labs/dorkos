import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SESSION_GIT_CONFIG,
  gitProtectionCheck,
  gitProtectionLevel,
  parseGitVersion,
  gitConfigArgs,
  internalGitConfig,
  withGitConfigEnv,
} from '../git-hardening.js';

describe('git hardening (DOR-2326)', () => {
  // Purpose: agent sessions refuse a found bare repository and any
  // file-system monitor, and keep a person's own hooks.
  it('gives sessions the two settings that stop a folder running a program', () => {
    expect(SESSION_GIT_CONFIG).toEqual([
      { key: 'safe.bareRepository', value: 'explicit' },
      { key: 'core.fsmonitor', value: '' },
    ]);
  });

  // Purpose: DorkOS's own git also runs no hooks, pointed at the platform's
  // empty device.
  it.each([
    ['linux', '/dev/null'],
    ['darwin', '/dev/null'],
    ['win32', 'NUL'],
  ] as const)('turns hooks off for DorkOS on %s', (platform, device) => {
    expect(internalGitConfig(platform)).toEqual([
      ...SESSION_GIT_CONFIG,
      { key: 'core.hooksPath', value: device },
      { key: 'submodule.recurse', value: 'false' },
    ]);
  });

  it('keeps DorkOS out of submodules in both forms', () => {
    const args = gitConfigArgs(internalGitConfig());
    expect(args[args.indexOf('submodule.recurse=false') - 1]).toBe('-c');
    const env = withGitConfigEnv({}, internalGitConfig());
    const at = Object.entries(env).find(([, value]) => value === 'submodule.recurse')?.[0];
    expect(at).toMatch(/^GIT_CONFIG_KEY_\d+$/);
    expect(env[at!.replace('KEY', 'VALUE')]).toBe('false');
  });

  it('renders -c arguments', () => {
    expect(gitConfigArgs(SESSION_GIT_CONFIG)).toEqual([
      '-c',
      'safe.bareRepository=explicit',
      '-c',
      'core.fsmonitor=',
    ]);
  });

  // Purpose: settings are appended after any the environment carries, which
  // keep their places, and the input is not changed.
  it('appends to the environment settings already present', () => {
    const env = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: 'c' };
    expect(withGitConfigEnv(env, SESSION_GIT_CONFIG)).toEqual({
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'a.b',
      GIT_CONFIG_VALUE_0: 'c',
      GIT_CONFIG_KEY_1: 'safe.bareRepository',
      GIT_CONFIG_VALUE_1: 'explicit',
      GIT_CONFIG_KEY_2: 'core.fsmonitor',
      GIT_CONFIG_VALUE_2: '',
    });
    expect(env.GIT_CONFIG_COUNT).toBe('1');
  });
});

describe('the installed git (DOR-2326)', () => {
  it.each([
    ['git version 2.39.5 (Apple Git-154)', [2, 39]],
    ['git version 2.43.0.windows.1', [2, 43]],
    ['not git', undefined],
  ] as const)('parses %j', (out, expected) => {
    expect(parseGitVersion(out)).toEqual(expected);
  });

  // Purpose: sessions' settings travel in the environment (git 2.31+), and
  // safe.bareRepository needs 2.38; the boundaries are exact.
  it.each([
    [[2, 25], 'none'],
    [[2, 30], 'none'],
    [[2, 31], 'partial'],
    [[2, 37], 'partial'],
    [[2, 38], 'full'],
    [[3, 0], 'full'],
  ] as const)('rates git %j as %s', (version, level) => {
    expect(gitProtectionLevel(version)).toBe(level);
  });

  it.each([
    ['git version 2.30.0\n', 'warn'],
    ['git version 2.37.1\n', 'warn'],
    ['git version 2.38.0\n', 'pass'],
    ['garbled', 'info'],
    [undefined, 'info'],
  ] as const)('reports %j as %s', (out, status) => {
    const check = gitProtectionCheck(out);
    expect(check.status).toBe(status);
    if (status === 'warn') expect(check.fix).toContain('2.38');
  });
});

describe('DorkOS git in a repo with a submodule', () => {
  let root: string;
  let marker: string;
  let env: NodeJS.ProcessEnv;
  const git = (cwd: string, args: string[], extra: NodeJS.ProcessEnv = {}) =>
    execFileSync('git', args, { cwd, env: { ...env, ...extra }, stdio: 'pipe' });

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-hardening-sm-')));
    marker = path.join(root, 'smudged');
    // A person's own global settings, which DorkOS's git inherits, ask for recursion.
    const global = path.join(root, 'global.gitconfig');
    fs.writeFileSync(global, '[submodule]\n\trecurse = true\n');
    env = {
      // eslint-disable-next-line no-restricted-syntax -- git needs PATH; nothing else of this process's environment reaches it.
      PATH: process.env.PATH,
      HOME: root,
      GIT_CONFIG_GLOBAL: global,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Ana',
      GIT_AUTHOR_EMAIL: 'ana@example.com',
      GIT_COMMITTER_NAME: 'Ana',
      GIT_COMMITTER_EMAIL: 'ana@example.com',
    };
    const origin = path.join(root, 'origin');
    fs.mkdirSync(origin);
    git(origin, ['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(origin, '.gitattributes'), '* filter=mark\n');
    fs.writeFileSync(path.join(origin, 'a.txt'), 'one\n');
    git(origin, ['add', '.']);
    git(origin, ['commit', '-q', '-m', 'one']);
    const holder = path.join(root, 'holder');
    fs.mkdirSync(holder);
    git(holder, ['init', '-q', '-b', 'main']);
    git(holder, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', origin, 'sm']);
    git(holder, ['commit', '-q', '-m', 'sm']);
    // The submodule's own git folder, which no audit of the holder reads, names a filter.
    const filter = path.join(root, 'smudge.sh');
    fs.writeFileSync(filter, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o755 });
    const modules = path.join(holder, '.git', 'modules', 'sm', 'config');
    git(root, ['config', '--file', modules, 'filter.mark.smudge', filter]);
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  /** Change the submodule's file, then reset the holder with `hardening` before the subcommand. */
  function reset(args: string[], extra: NodeJS.ProcessEnv = {}): boolean {
    const holder = path.join(root, 'holder');
    fs.writeFileSync(path.join(holder, 'sm', 'a.txt'), 'changed\n');
    fs.rmSync(marker, { force: true });
    git(holder, [...args, 'reset', '-q', '--hard'], extra);
    return fs.existsSync(marker);
  }

  it('runs the submodule’s filter without the hardening (the control)', () => {
    expect(reset([])).toBe(true);
  });

  it('never recurses into it with the -c settings', () => {
    expect(reset(gitConfigArgs(internalGitConfig()))).toBe(false);
  });

  it('never recurses into it with the environment settings', () => {
    expect(reset([], withGitConfigEnv({}, internalGitConfig()))).toBe(false);
  });
});
