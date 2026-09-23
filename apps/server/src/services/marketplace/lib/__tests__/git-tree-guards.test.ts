/**
 * `git-tree`'s guards, with git scripted (DOR-2248).
 *
 * The real-git suite (`git-tree.test.ts`) proves the happy paths and the
 * fallbacks against real servers, but a real git never lies about what it
 * fetched and never reaches github.com. These cases script git's answers to
 * prove the checks that only fire when something is wrong, and the credential
 * rule on the one host the real suite cannot reach.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** One scripted git answer: stdout, or a failure with stderr. */
type Answer = { stdout: string } | { fail: string };

/** Picks git's answer for a given argv. */
let respond: (args: string[]) => Answer = () => ({ stdout: '' });
const calls: string[][] = [];

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    // Callback-style, so `promisify(execFile)` resolves `{ stdout, stderr }`.
    execFile: vi.fn(
      (_cmd: string, args: string[], _opts: unknown, callback: (...a: unknown[]) => void) => {
        calls.push(args);
        const answer = respond(args);
        setImmediate(() => {
          if ('fail' in answer) {
            callback(Object.assign(new Error('Command failed: git'), { stderr: answer.fail }));
          } else {
            callback(null, { stdout: answer.stdout, stderr: '' });
          }
        });
      }
    ),
  };
});

const resolveGitAuth = vi.fn(() => 'ghp_secret');
vi.mock('../../../core/template-downloader.js', async () => {
  const actual = await vi.importActual<typeof import('../../../core/template-downloader.js')>(
    '../../../core/template-downloader.js'
  );
  return { ...actual, resolveGitAuth: () => resolveGitAuth() };
});

import { fetchTree, GitFetchError, lookupRemoteRef } from '../git-tree.js';

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

beforeEach(() => {
  calls.length = 0;
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
  it('reaches a github.com fetch and lookup', async () => {
    // Purpose: private GitHub packages must still install; the lookup needs
    // the token too, because a failed lookup now stops the fetch.
    respond = gitReporting(A, A);
    await fetchTree(req('https://github.com/org/pkg.git'));
    expect(remoteUrl()).toBe('https://x-access-token:ghp_secret@github.com/org/pkg.git');

    respond = () => ({ stdout: `${A}\trefs/heads/main\n` });
    await lookupRemoteRef('https://github.com/org/pkg.git', 'main');
    expect(calls.at(-1)).toContain('https://x-access-token:ghp_secret@github.com/org/pkg.git');
  });

  it('never reaches another host, and is not even resolved for one', async () => {
    // Purpose: DOR-1833 — a marketplace `url` source can name any host.
    respond = gitReporting(A, A);
    await fetchTree(req('https://gitlab.example.com/org/pkg.git'));
    expect(remoteUrl()).toBe('https://gitlab.example.com/org/pkg.git');
    expect(JSON.stringify(calls)).not.toContain('ghp_secret');
    expect(resolveGitAuth).not.toHaveBeenCalled();
  });

  it('is redacted from a failure message', async () => {
    // Purpose: git echoes the URL it was given; the token must not reach the
    // person, the log, or the HTTP response.
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

  it('passes every author-supplied value after --end-of-options', async () => {
    // Purpose: a ref, URL or subpath starting with `-` is a value, never a flag.
    respond = gitReporting(A, A);
    await fetchTree({ ...req('https://gitlab.example.com/o/r.git'), subpath: '--stdin' });
    for (const [verb, value] of [
      ['remote', 'https://gitlab.example.com/o/r.git'],
      ['sparse-checkout', '--stdin'],
      ['fetch', A],
    ] as const) {
      const argv = calls.find((a) => a[0] === verb)!;
      expect(argv.indexOf('--end-of-options')).toBeLessThan(argv.indexOf(value));
      expect(argv.indexOf('--end-of-options')).toBeGreaterThan(-1);
    }
  });
});
