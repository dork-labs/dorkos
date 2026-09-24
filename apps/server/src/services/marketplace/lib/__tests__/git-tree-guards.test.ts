/**
 * `git-tree`'s guards, with git scripted (DOR-2248).
 *
 * The real-git suite (`git-tree.test.ts`) proves the happy paths and the
 * fallbacks against real servers, but a real git never lies about what it
 * fetched and never reaches github.com. These cases script git's answers to
 * prove the checks that only fire when something is wrong, and the credential
 * rule on the one host the real suite cannot reach.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** One scripted git answer: stdout, or a failure with stderr. */
type Answer = { stdout: string; stderr?: string } | { fail: string };

/** Picks git's answer for a given argv. */
let respond: (args: string[]) => Answer = () => ({ stdout: '' });
const calls: string[][] = [];
/** The environment each call ran with, index-aligned with `calls`. */
const envs: NodeJS.ProcessEnv[] = [];
/** What `git --version` prints; answered outside `calls`, since it runs once. */
let gitVersionOutput = 'git version 2.49.1\n';
/** How many times `git --version` ran. */
let versionReads = 0;

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    // Node's callback shape: (err, stdout, stderr), with git's output also on
    // the error, as the real execFile gives it.
    execFile: vi.fn(
      (
        _cmd: string,
        args: string[],
        opts: { env: NodeJS.ProcessEnv },
        callback: (...a: unknown[]) => void
      ) => {
        if (args[0] === '--version') {
          versionReads += 1;
          setImmediate(() => callback(null, gitVersionOutput, ''));
          return;
        }
        calls.push(args);
        envs.push(opts.env);
        const answer = respond(args);
        setImmediate(() => {
          if ('fail' in answer) {
            callback(
              Object.assign(new Error('Command failed: git'), { stderr: answer.fail }),
              '',
              answer.fail
            );
          } else {
            callback(null, answer.stdout, answer.stderr ?? '');
          }
        });
      }
    ),
  };
});

const resolveGitAuth = vi.fn(() => 'ghp_secret');
// The git steps are faked and never write a tree, so the size check after the
// fetch has nothing to measure; it has its own test (git-tree-size.test.ts).
vi.mock('@dorkos/marketplace/package-size', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@dorkos/marketplace/package-size')>()),
  measurePackageTree: vi.fn().mockResolvedValue({ files: 0, bytes: 0 }),
}));

vi.mock('../../../core/template-downloader.js', async () => {
  const actual = await vi.importActual<typeof import('../../../core/template-downloader.js')>(
    '../../../core/template-downloader.js'
  );
  return { ...actual, resolveGitAuth: () => resolveGitAuth() };
});

import { fetchTree, GitFetchError, lookupRemoteRef, parseGitVersion } from '../git-tree.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

/** A git that fetches fine and reports `fetched` for FETCH_HEAD and `head` for HEAD. */
function gitReporting(fetched: string, head: string): (args: string[]) => Answer {
  return (args) => {
    if (args[0] === 'rev-parse') {
      return { stdout: `${args.at(-1)?.startsWith('HEAD') ? head : fetched}\n` };
    }
    return { stdout: '' };
  };
}

/** The URL `git remote add` was given. */
function remoteUrl(): string | undefined {
  return calls.find((a) => a[0] === 'remote')?.at(-1);
}

/** The git config entries an environment carries through GIT_CONFIG_COUNT. */
function envConfig(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < Number(env.GIT_CONFIG_COUNT ?? 0); i++) {
    out[env[`GIT_CONFIG_KEY_${i}`]!] = env[`GIT_CONFIG_VALUE_${i}`]!;
  }
  return out;
}

const HEADER = `Authorization: Basic ${Buffer.from('x-access-token:ghp_secret').toString('base64')}`;

beforeEach(() => {
  calls.length = 0;
  envs.length = 0;
  gitVersionOutput = 'git version 2.49.1\n';
  resolveGitAuth.mockClear();
  respond = () => ({ stdout: '' });
});

const req = (cloneUrl: string) => ({
  cloneUrl,
  commitSha: A,
  refName: 'refs/heads/main',
  subpath: '',
  destDir: '/nonexistent/git-tree-guards',
});

describe('the GitHub token', () => {
  it('reaches every github.com step as an env header, never on argv', async () => {
    // Purpose: private GitHub packages must install, and the token must not
    // be visible in `ps` (argv) or left in `.git/config` (the remote URL). The
    // checkout needs it too: a sparse checkout fetches missing blobs.
    respond = gitReporting(A, A);
    await fetchTree({ ...req('https://github.com/org/pkg.git'), subpath: 'plugins/pkg' });
    expect(remoteUrl()).toBe('https://github.com/org/pkg.git');
    for (const env of envs) {
      expect(envConfig(env)['http.https://github.com/.extraHeader']).toBe(HEADER);
    }
    expect(JSON.stringify(calls)).not.toContain('ghp_secret');
    expect(JSON.stringify(calls)).not.toContain(
      Buffer.from('x-access-token:ghp_secret').toString('base64')
    );

    respond = () => ({ stdout: `${A}\trefs/heads/main\n` });
    await lookupRemoteRef('https://github.com/org/pkg.git', 'main');
    expect(calls.at(-1)).toContain('https://github.com/org/pkg.git');
    expect(envConfig(envs.at(-1)!)['http.https://github.com/.extraHeader']).toBe(HEADER);
  });

  it('keeps config the environment already carries', async () => {
    // Purpose: the header is appended after existing GIT_CONFIG_* entries,
    // never over them.
    respond = gitReporting(A, A);
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'protocol.version');
    vi.stubEnv('GIT_CONFIG_VALUE_0', '2');
    try {
      await lookupRemoteRef('https://github.com/org/pkg.git', 'main');
    } finally {
      vi.unstubAllEnvs();
    }
    expect(envConfig(envs[0]!)).toEqual({
      'protocol.version': '2',
      'http.https://github.com/.extraHeader': HEADER,
    });
  });

  it('never reaches another host, and is not even resolved for one', async () => {
    // Purpose: DOR-1833 — a marketplace `url` source can name any host.
    respond = gitReporting(A, A);
    await fetchTree(req('https://gitlab.example.com/org/pkg.git'));
    expect(remoteUrl()).toBe('https://gitlab.example.com/org/pkg.git');
    for (const env of envs) expect(JSON.stringify(envConfig(env))).not.toContain('Authorization');
    expect(resolveGitAuth).not.toHaveBeenCalled();
  });

  it('is resolved once a minute, not once per git call', async () => {
    // Purpose: `resolveGitAuth` may run `gh auth token` synchronously; an
    // update check looks up many packages at once.
    const now = vi.spyOn(Date, 'now').mockReturnValue(10_000_000_000_000);
    try {
      respond = gitReporting(A, A);
      await fetchTree(req('https://github.com/org/pkg.git'));
      await lookupRemoteRef('https://github.com/org/other.git', 'main');
      expect(resolveGitAuth).toHaveBeenCalledTimes(1);

      now.mockReturnValue(10_000_000_000_000 + 61_000);
      await lookupRemoteRef('https://github.com/org/other.git', 'main');
      expect(resolveGitAuth).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  it('is redacted from a failure message', async () => {
    // Purpose: whatever git echoes, a token must not reach the person, the
    // log, or the HTTP response.
    respond = (args) =>
      args[0] === 'fetch'
        ? {
            fail: "fatal: unable to access 'https://x-access-token:ghp_secret@github.com/org/pkg.git/': 403",
          }
        : { stdout: '' };
    const error = await fetchTree(req('https://github.com/org/pkg.git')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitFetchError);
    expect(String((error as Error).message)).not.toContain('ghp_secret');
    expect(String((error as Error).message)).toContain('[REDACTED]');
  });
});

describe('the installed git decides how the token travels', () => {
  it.each([
    ['git version 2.49.1\n', [2, 49]],
    ['git version 2.39.5 (Apple Git-154)\n', [2, 39]],
    ['git version 2.43.0.windows.1\n', [2, 43]],
    ['git version 2.30.0\n', [2, 30]],
    ['not git', undefined],
  ] as const)('parses %j', (out, expected) => {
    // Purpose: vendor suffixes must not hide the version.
    expect(parseGitVersion(out)).toEqual(expected);
  });

  /**
   * A fresh copy of the module, so its once-per-process version read sees
   * `version` (restored to 2.49.1 before the next test).
   */
  async function withGit(version: string) {
    vi.resetModules();
    gitVersionOutput = version;
    versionReads = 0;
    return import('../git-tree.js');
  }

  it.each(['git version 2.30.0\n', 'git version 2.26.2\n', 'unreadable\n'])(
    'embeds the token in the remote URL on %j, as execGitClone does',
    async (version) => {
      // Purpose: git before 2.31 ignores GIT_CONFIG_COUNT; the header would
      // silently not be sent and a private repository would stop installing.
      const mod = await withGit(version);
      respond = gitReporting(A, A);
      await mod.fetchTree({ ...req('https://github.com/org/pkg.git'), subpath: 'plugins/pkg' });
      expect(remoteUrl()).toBe('https://x-access-token:ghp_secret@github.com/org/pkg.git');
      for (const env of envs) expect(JSON.stringify(envConfig(env))).not.toContain('Authorization');

      respond = () => ({ stdout: `${A}\trefs/heads/main\n` });
      await mod.lookupRemoteRef('https://github.com/org/pkg.git', 'main');
      expect(calls.at(-1)).toContain('https://x-access-token:ghp_secret@github.com/org/pkg.git');
      expect(versionReads).toBe(1);
    }
  );

  it('keeps the token out of a failure message on old git too', async () => {
    const mod = await withGit('git version 2.30.0\n');
    respond = (args) =>
      args[0] === 'fetch'
        ? {
            fail: "fatal: repository 'https://x-access-token:ghp_secret@github.com/org/pkg.git/' not found",
          }
        : { stdout: '' };
    const error = (await mod.fetchTree(req('https://github.com/org/pkg.git')).then(
      () => new Error('resolved'),
      (e: unknown) => e
    )) as Error;
    expect(error.message).not.toContain('ghp_secret');
    expect(error.message).toContain('github.com/org/pkg');
  });

  it('uses the environment header from git 2.31', async () => {
    const mod = await withGit('git version 2.31.0\n');
    respond = gitReporting(A, A);
    await mod.fetchTree(req('https://github.com/org/pkg.git'));
    expect(remoteUrl()).toBe('https://github.com/org/pkg.git');
    expect(envConfig(envs[0]!)['http.https://github.com/.extraHeader']).toBe(HEADER);
  });

  it('never embeds a token for another host, whatever the git', async () => {
    const mod = await withGit('git version 2.26.2\n');
    respond = gitReporting(A, A);
    await mod.fetchTree(req('https://gitlab.example.com/org/pkg.git'));
    expect(remoteUrl()).toBe('https://gitlab.example.com/org/pkg.git');
    expect(versionReads).toBe(0);
  });
});

describe('verification', () => {
  it('refuses a by-id fetch that brought back a different commit', async () => {
    // Purpose: the only commit a by-id fetch may report is the one asked for.
    respond = gitReporting(B, B);
    await expect(fetchTree(req('https://gitlab.example.com/o/r.git'))).rejects.toBeInstanceOf(
      GitFetchError
    );
    expect(calls.some((a) => a.includes('checkout'))).toBe(false);
  });

  it('refuses a checkout whose HEAD is not the fetched commit', async () => {
    // Purpose: the check the cache relies on — HEAD is read, never assumed.
    respond = gitReporting(A, B);
    await expect(fetchTree(req('https://gitlab.example.com/o/r.git'))).rejects.toThrow(
      /checked out b{40}, expected a{40}/
    );
  });

  it('refuses a rev-parse answer that is not a full commit id', async () => {
    // Purpose: nothing but a full commit id may ever become a key.
    respond = gitReporting('tmp-123', 'tmp-123');
    await expect(fetchTree(req('https://gitlab.example.com/o/r.git'))).rejects.toBeInstanceOf(
      GitFetchError
    );
  });

  it('does not fall back on a failure that is not a refusal', async () => {
    // Purpose: only "won't serve that commit" earns a second fetch; a missing
    // repository or a network error is reported as it is.
    respond = (args) =>
      args[0] === 'fetch' ? { fail: "fatal: repository 'x' not found" } : { stdout: '' };
    await expect(fetchTree(req('https://gitlab.example.com/o/r.git'))).rejects.toThrow(
      "Couldn't fetch gitlab.example.com/o/r: repository 'x' not found"
    );
    expect(calls.filter((a) => a[0] === 'fetch')).toHaveLength(1);
  });

  it('runs the exact command sequence the git floor was measured against', async () => {
    // Purpose: scripts/git-floor-probe.sh measured these argvs in Docker on
    // git 2.26–2.49. Two are version traps: `checkout --detach` rejects
    // `--end-of-options` up to 2.43, and `sparse-checkout set --cone` leaves
    // cone mode off before 2.35. Any drift here must be re-measured.
    respond = gitReporting(A, A);
    await fetchTree({ ...req('https://gitlab.example.com/o/r.git'), subpath: '--stdin' });
    expect(calls).toEqual([
      ['init', '--quiet'],
      ['remote', 'add', '--end-of-options', 'origin', 'https://gitlab.example.com/o/r.git'],
      ['sparse-checkout', 'init', '--cone'],
      // A subpath starting with `-` is a value, never a flag.
      ['sparse-checkout', 'set', '--end-of-options', '--stdin'],
      ['config', 'core.repositoryformatversion', '1'],
      ['config', 'extensions.partialClone', 'origin'],
      ['config', 'remote.origin.promisor', 'true'],
      ['config', 'remote.origin.partialclonefilter', 'blob:none'],
      [
        'fetch',
        '--quiet',
        '--no-tags',
        '--depth=1',
        '--filter=blob:none',
        '--end-of-options',
        'origin',
        A,
      ],
      ['rev-parse', '--verify', '--quiet', 'FETCH_HEAD^{commit}'],
      // The tree is listed before anything is checked out (DOR-2321); a
      // blobless fetch has no sizes, so no `-l`.
      ['ls-tree', '-r', '-t', A, '--', '--stdin'],
      ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', A],
      ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'],
      ['ls-files', '--deleted'],
    ]);
  });

  it.each([
    ['a checkout that exits 0 but reports an error', 'checkout'],
    ['a checkout that leaves files missing', 'ls-files'],
  ])('refuses %s (git 2.30–2.36 does this), retrying unfiltered once', async (_label, verb) => {
    // Purpose: git 2.30–2.36 can print `error: invalid object … for 'pkg/f'`
    // after a failed lazy blob fetch, exit 0 and leave HEAD right. Without
    // these checks the broken tree was cached and served forever.
    const destDir = await mkdtemp(path.join(tmpdir(), 'git-tree-guards-'));
    let broken = 0;
    const brokenAnswer = (args: string[]): Answer | undefined => {
      if (verb === 'checkout' && args.includes('checkout')) {
        broken += 1;
        return { stdout: '', stderr: `error: invalid object 100644 ${B} for 'pkg/f'\n` };
      }
      if (verb === 'ls-files' && args[0] === 'ls-files') {
        broken += 1;
        return { stdout: 'pkg/f\n' };
      }
      return undefined;
    };
    try {
      // Broken both times: the retry happens once, then the failure is reported.
      respond = (args) => brokenAnswer(args) ?? gitReporting(A, A)(args);
      const error = await fetchTree({
        ...req('https://gitlab.example.com/o/r.git'),
        subpath: 'pkg',
        destDir,
      }).then(
        () => undefined,
        (e: unknown) => e
      );
      expect(error).toBeInstanceOf(GitFetchError);
      expect(broken).toBe(2);
      expect(calls.filter((a) => a[0] === 'fetch')).toHaveLength(2);

      // Broken only on the filtered try: the unfiltered retry succeeds.
      calls.length = 0;
      broken = 0;
      respond = (args) =>
        (broken === 0 ? brokenAnswer(args) : undefined) ?? gitReporting(A, A)(args);
      await expect(
        fetchTree({ ...req('https://gitlab.example.com/o/r.git'), subpath: 'pkg', destDir })
      ).resolves.toBe(A);
      expect(calls.filter((a) => a[0] === 'fetch')[1]).not.toContain('--filter=blob:none');
    } finally {
      await rm(destDir, { recursive: true, force: true });
    }
  });

  it('retries a subpath unfiltered after ANY filtered failure, once', async () => {
    // Purpose: git words a refused partial clone differently by version
    // (`bad pack header` on 2.26); the optimisation must never be the
    // reason a package fails to install.
    const destDir = await mkdtemp(path.join(tmpdir(), 'git-tree-guards-'));
    try {
      respond = (args) =>
        args[0] === 'fetch' && args.includes('--filter=blob:none')
          ? { fail: 'fatal: protocol error: bad pack header' }
          : gitReporting(A, A)(args);
      await expect(
        fetchTree({ ...req('https://gitlab.example.com/o/r.git'), subpath: 'pkg', destDir })
      ).resolves.toBe(A);
      expect(calls.filter((a) => a[0] === 'fetch')).toHaveLength(2);
    } finally {
      await rm(destDir, { recursive: true, force: true });
    }
  });

  it('starts a subpath over unfiltered when the server refuses the lazy blob fetch', async () => {
    // Purpose: a server that refuses unadvertised objects refuses a partial
    // checkout's blob requests too; the retry fetches every blob it needs.
    let refusedOnce = false;
    respond = (args) => {
      if (args.includes('checkout') && !refusedOnce) {
        refusedOnce = true;
        return { fail: `fatal: could not fetch ${A} from promisor remote` };
      }
      return gitReporting(A, A)(args);
    };
    const destDir = await mkdtemp(path.join(tmpdir(), 'git-tree-guards-'));
    try {
      await expect(
        fetchTree({ ...req('https://gitlab.example.com/o/r.git'), subpath: 'plugins/p', destDir })
      ).resolves.toBe(A);
    } finally {
      await rm(destDir, { recursive: true, force: true });
    }
    const fetches = calls.filter((a) => a[0] === 'fetch');
    expect(fetches).toHaveLength(2);
    expect(fetches[1]).not.toContain('--filter=blob:none');
  });
});
