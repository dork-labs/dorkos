/**
 * The audited git runner (DOR-3343): real git, real repositories.
 *
 * A repository whose own settings hold any key off the safe list is refused
 * before git starts, and nothing it names runs. The marker is a clean filter
 * that writes a file, the one kind of setting a read like `status` runs. A
 * repository with only safe keys is read as usual, and git starts with the
 * runner's settings and minimal environment, seen through a stand-in `git` on
 * PATH that records them.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  GitRepoConfigUnsafeError,
  SAFE_REPO_CONFIG_KEY,
  assertRepoConfigSafe,
  runSafeGit,
  runSafeGitBuffer,
} from '../safe-git.js';

const realGit = execFileSync('sh', ['-c', 'command -v git']).toString().trim();
const git = (cwd: string, ...args: string[]) =>
  execFileSync(realGit, args, { cwd, stdio: 'pipe' }).toString().trim();

describe('runSafeGit', () => {
  let scratch: string;
  let marker: string;

  /** A repository with one committed file, changed since, so `status` reads it. */
  function repo(name: string): string {
    const dir = path.join(scratch, name);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, '.gitattributes'), '* filter=mark\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    git(dir, 'add', '.');
    git(dir, '-c', 'user.email=a@example.com', '-c', 'user.name=a', 'commit', '-q', '-m', 'one');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
    return dir;
  }

  /** Point the repository's own settings at a clean filter that writes the marker. */
  function plantFilter(configDir: string): void {
    const filter = path.join(scratch, 'filter.sh');
    fs.writeFileSync(filter, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o755 });
    git(configDir, 'config', 'filter.mark.clean', filter);
  }

  beforeAll(() => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'safe-git-')));
    marker = path.join(scratch, 'ran');
  });
  afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(marker, { force: true });
  });

  it('the filter fires with plain git, so the refusals below mean something', () => {
    const dir = repo('control');
    plantFilter(dir);
    git(dir, 'status', '--porcelain=v1');
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('reads a repository whose settings are all on the safe list', async () => {
    const dir = repo('plain');
    git(dir, 'remote', 'add', 'origin', 'https://example.invalid/x.git');
    await expect(runSafeGit(['status', '--porcelain=v1', '--branch'], dir)).resolves.toContain(
      ' M a.txt'
    );
    await expect(runSafeGitBuffer(['show', 'HEAD:a.txt'], dir)).resolves.toEqual(
      Buffer.from('one\n')
    );
  });

  it('refuses a repository whose settings name a program, and runs nothing', async () => {
    const dir = repo('filtered');
    plantFilter(dir);
    const read = runSafeGit(['status', '--porcelain=v1'], dir);
    await expect(read).rejects.toBeInstanceOf(GitRepoConfigUnsafeError);
    await expect(read).rejects.toMatchObject({ keys: ['filter.mark.clean'] });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('refuses from a subfolder, and from inside a planted empty .git folder', async () => {
    const dir = repo('nested');
    plantFilter(dir);
    const sub = path.join(dir, 'sub');
    fs.mkdirSync(path.join(sub, '.git'), { recursive: true });
    await expect(runSafeGit(['status'], sub)).rejects.toBeInstanceOf(GitRepoConfigUnsafeError);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("refuses a worktree whose shared repository's settings name a program", async () => {
    const dir = repo('shared');
    git(dir, 'add', '.');
    git(dir, '-c', 'user.email=a@example.com', '-c', 'user.name=a', 'commit', '-q', '-m', 'two');
    const tree = path.join(scratch, 'shared-tree');
    fs.rmSync(tree, { recursive: true, force: true });
    git(dir, 'worktree', 'add', '-q', '-b', 'side', tree);
    plantFilter(dir);
    fs.writeFileSync(path.join(tree, 'a.txt'), 'three\n');
    await expect(runSafeGit(['status'], tree)).rejects.toBeInstanceOf(GitRepoConfigUnsafeError);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('refuses includes and partial-clone settings rather than following them', async () => {
    const dir = repo('include');
    git(dir, 'config', 'include.path', path.join(scratch, 'elsewhere.cfg'));
    await expect(assertRepoConfigSafe(dir)).rejects.toMatchObject({ keys: ['include.path'] });
    const partial = repo('partial');
    git(partial, 'config', 'extensions.partialClone', 'origin');
    await expect(assertRepoConfigSafe(partial)).rejects.toMatchObject({
      keys: ['extensions.partialclone'],
    });
  });

  it('refuses a .git file that names nothing', async () => {
    const dir = path.join(scratch, 'odd');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.git'), 'not a pointer\n');
    await expect(runSafeGit(['status'], dir)).rejects.toBeInstanceOf(GitRepoConfigUnsafeError);
  });

  it('notices a setting added after a read passed', async () => {
    const dir = repo('later');
    await expect(runSafeGit(['status'], dir)).resolves.toBeTypeOf('string');
    plantFilter(dir);
    await expect(runSafeGit(['status'], dir)).rejects.toBeInstanceOf(GitRepoConfigUnsafeError);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('starts git with no lazy fetch, no transport, no helper and a minimal environment', async () => {
    const dir = repo('env');
    const bin = path.join(scratch, 'bin');
    const seen = path.join(scratch, 'seen.txt');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(
      path.join(bin, 'git'),
      [
        '#!/bin/sh',
        `case "$*" in *"config --file"*) exec '${realGit}' "$@";; esac`,
        `{ echo "args=$*"; echo "lazy=$GIT_NO_LAZY_FETCH"; echo "proto=[$GIT_ALLOW_PROTOCOL]";`,
        ` echo "global=$GIT_CONFIG_GLOBAL"; echo "nosystem=$GIT_CONFIG_NOSYSTEM";`,
        ` echo "probe=[$DORKOS_SAFE_GIT_PROBE]"; } > '${seen}'`,
        `exec '${realGit}' "$@"`,
        '',
      ].join('\n'),
      { mode: 0o755 }
    );
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
    vi.stubEnv('DORKOS_SAFE_GIT_PROBE', 'server-only');
    await runSafeGit(['status'], dir);
    const text = fs.readFileSync(seen, 'utf8');
    expect(text).toContain('protocol.allow=never');
    expect(text).toContain('core.sshCommand=');
    expect(text).toContain('credential.helper=');
    expect(text).toContain('core.fsmonitor=');
    expect(text).toContain('lazy=1');
    expect(text).toContain('proto=[]');
    expect(text).toContain('global=/dev/null');
    expect(text).toContain('nosystem=1');
    expect(text).toContain('probe=[]');
  });

  it('keeps the safe list to keys that run nothing', () => {
    for (const key of ['core.bare', 'remote.origin.url', 'branch.main.merge', 'user.email']) {
      expect(SAFE_REPO_CONFIG_KEY.test(key)).toBe(true);
    }
    for (const key of [
      'core.fsmonitor',
      'core.sshcommand',
      'core.hookspath',
      'core.worktree',
      'filter.x.clean',
      'diff.x.textconv',
      'credential.helper',
      'include.path',
      'remote.origin.promisor',
      'remote.origin.uploadpack',
      'alias.st',
    ]) {
      expect(SAFE_REPO_CONFIG_KEY.test(key)).toBe(false);
    }
  });

  it('reads a .git file exactly as git does, odd spacing included', async () => {
    const main = repo('spacing');
    for (const [name, pointer] of [
      ['trailing', (dir: string) => `gitdir: ${dir} \n`],
      ['leading', (dir: string) => `gitdir:  ${dir}\n`],
    ] as const) {
      const real = path.join(scratch, `${name}-gitdir`);
      const target = name === 'trailing' ? `${real} ` : real;
      fs.rmSync(target, { recursive: true, force: true });
      fs.cpSync(path.join(main, '.git'), target, { recursive: true });
      // A clean decoy where loose parsing would look, so only git's exact reading refuses.
      if (target !== real) {
        fs.rmSync(real, { recursive: true, force: true });
        fs.cpSync(path.join(main, '.git'), real, { recursive: true });
      }
      const filter = path.join(scratch, 'filter.sh');
      fs.writeFileSync(filter, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o755 });
      git(scratch, `--git-dir=${target}`, 'config', 'filter.mark.clean', filter);
      const tree = path.join(scratch, `${name}-tree`);
      fs.rmSync(tree, { recursive: true, force: true });
      fs.cpSync(main, tree, { recursive: true, filter: (src) => !src.endsWith(`${path.sep}.git`) });
      fs.writeFileSync(path.join(tree, '.git'), pointer(real));
      await expect(runSafeGit(['status'], tree)).rejects.toBeInstanceOf(GitRepoConfigUnsafeError);
      expect(fs.existsSync(marker)).toBe(false);
    }
  });

  it('refuses to run inside a .git folder, and audits a folder shaped like one', async () => {
    const dir = repo('inside');
    await expect(runSafeGit(['status'], path.join(dir, '.git'))).rejects.toBeInstanceOf(
      GitRepoConfigUnsafeError
    );
    const shaped = path.join(scratch, 'shaped');
    fs.rmSync(shaped, { recursive: true, force: true });
    fs.cpSync(path.join(dir, '.git'), shaped, { recursive: true });
    git(scratch, `--git-dir=${shaped}`, 'config', 'filter.mark.clean', 'true');
    await expect(assertRepoConfigSafe(path.join(shaped, 'refs'))).rejects.toMatchObject({
      keys: ['filter.mark.clean'],
    });
  });

  it("never recurses into a submodule, whose own settings it doesn't audit", async () => {
    const sub = repo('sub-src');
    git(sub, 'add', '.');
    git(sub, '-c', 'user.email=a@example.com', '-c', 'user.name=a', 'commit', '-q', '-m', 'two');
    const sup = repo('super');
    git(sup, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'mod');
    git(sup, '-c', 'user.email=a@example.com', '-c', 'user.name=a', 'commit', '-q', '-m', 'mod');
    // What an agent can commit without touching the parent's settings: the
    // gitlink and a nested repository, with no `submodule.*` keys to audit.
    git(sup, 'config', '--remove-section', 'submodule.mod');
    const inner = path.join(sup, 'mod');
    plantFilter(inner);
    fs.writeFileSync(path.join(inner, 'a.txt'), 'changed\n');
    // The runner first: plain git refreshes the submodule's index, after
    // which no read needs the filter again.
    await expect(runSafeGit(['status', '--porcelain=v1'], sup)).resolves.toBeTypeOf('string');
    expect(fs.existsSync(marker)).toBe(false);
    git(sup, 'status', '--porcelain=v1');
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('reads a husky repository, but its hooks folder still refuses a write', async () => {
    const dir = repo('husky');
    const hooks = path.join(dir, '.husky');
    fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(path.join(hooks, 'post-checkout'), `#!/bin/sh\ntouch '${marker}'\n`, {
      mode: 0o755,
    });
    git(dir, 'config', 'core.hooksPath', '.husky');
    // A read passes, and runs no hook from the folder the repository names.
    await expect(runSafeGit(['status', '--porcelain=v1'], dir)).resolves.toContain(' M a.txt');
    await expect(runSafeGit(['checkout', '-q', '-b', 'read-side'], dir)).resolves.toBe('');
    expect(fs.existsSync(marker)).toBe(false);
    // A write's audit still refuses it, even right after a read passed.
    await expect(assertRepoConfigSafe(dir)).rejects.toMatchObject({ keys: ['core.hookspath'] });
  });
});
