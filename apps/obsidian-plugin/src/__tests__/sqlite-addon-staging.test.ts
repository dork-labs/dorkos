/**
 * The build downloads native code and puts it where the plugin will
 * `require()` it. These are the rules that make that safe (DOR-1563).
 *
 * **Every one of them was decorative before this file existed.** Deleting the
 * `ChecksumMismatchError` rethrow, or the version-drift guard, left the whole
 * suite green — which is to say the lockfile was a comment. A guarantee that
 * only a build can exercise is a guarantee nothing asserts, so the staging
 * boundary is exported and driven directly here, with the network injected so
 * the tests can also assert the requests that must NOT happen.
 *
 * @module obsidian-plugin/__tests__/sqlite-addon-staging
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  ADDON_LOCK_FILE,
  ChecksumMismatchError,
  SQLITE_ADDON_ABIS,
  addonFileName,
  lockKey,
  sha256,
  stageAddons,
  verifyPinned,
  type AddonLock,
} from '../../build-plugins/sqlite-addon.js';

const VERSION = '12.11.1';

/** This machine, which is the only target `stageAddons` ever looks at. */
const HERE = { platform: process.platform, arch: process.arch };

/** The ABI whose pin each test manipulates; the rest are left unpinned. */
const ABI = SQLITE_ADDON_ABIS[0]!;
const KEY = lockKey({ ...HERE, abi: ABI });

let root: string;

/**
 * A tarball that really does contain `build/Release/better_sqlite3.node`, so
 * the unpack step is exercised rather than mocked around.
 *
 * @param body - Bytes to put in the fake add-on, which change its hash.
 */
function makeTarball(into: string, body: string): void {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-tar-'));
  fs.mkdirSync(path.join(staging, 'build', 'Release'), { recursive: true });
  fs.writeFileSync(path.join(staging, 'build', 'Release', 'better_sqlite3.node'), body);
  // Deterministic enough for a hash to be stable within one test, which is all
  // these need — the pin is read back off the file that was just written.
  execFileSync('tar', ['-czf', into, '-C', staging, 'build'], { stdio: 'pipe' });
  fs.rmSync(staging, { recursive: true, force: true });
}

/** Write a lockfile pinning exactly the entries given. */
function writeLock(entries: Record<string, string>, version = VERSION): void {
  const lock: AddonLock = { version, entries };
  fs.writeFileSync(path.join(root, ADDON_LOCK_FILE), JSON.stringify(lock, null, 2));
}

/** Put a tarball in the cache under the name `stageAddons` looks for. */
function cache(key: string, body: string): string {
  const dir = path.join(root, '.native');
  fs.mkdirSync(dir, { recursive: true });
  const at = path.join(dir, `${key}.tar.gz`);
  makeTarball(at, body);
  return at;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-staging-'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the hash gate on its own', () => {
  it('passes a file that matches its pin', () => {
    const at = cache(KEY, 'real');

    expect(() => verifyPinned(at, sha256(at), KEY)).not.toThrow();
  });

  it('throws a ChecksumMismatchError, naming both digests', () => {
    const at = cache(KEY, 'real');

    const thrown = (() => {
      try {
        verifyPinned(at, '0'.repeat(64), KEY);
      } catch (err) {
        return err;
      }
    })();

    expect(thrown).toBeInstanceOf(ChecksumMismatchError);
    expect((thrown as Error).message).toContain(sha256(at));
    expect((thrown as Error).message).toContain('0'.repeat(64));
  });
});

describe('staging what is already cached', () => {
  it('unpacks a pinned tarball into dist/', () => {
    const at = cache(KEY, 'real');
    writeLock({ [KEY]: sha256(at) });

    const staged = stageAddons({ root, version: VERSION }, { download: unreachable });

    expect(staged).toBe(1);
    expect(fs.existsSync(path.join(root, 'dist', addonFileName({ ...HERE, abi: ABI })))).toBe(true);
  });

  it('rechecks the CACHED file and heals it, rather than trusting it forever', () => {
    // The pin protected the first download and nothing after it: a cache
    // poisoned or left stale after that was copied into dist/ unexamined for
    // the rest of the checkout's life. The cache holds the pinned artifact now,
    // so a cached file that no longer hashes to its pin is thrown away and
    // fetched again — the build heals instead of failing, and the bytes that
    // reach dist/ are the pinned ones either way.
    cache(KEY, 'stale');
    const wanted = path.join(root, 'wanted.tar.gz');
    makeTarball(wanted, 'real');
    writeLock({ [KEY]: sha256(wanted) });

    const staged = stageAddons(
      { root, version: VERSION },
      { download: (_url, into) => fs.copyFileSync(wanted, into) }
    );

    expect(staged).toBe(1);
    expect(
      fs.readFileSync(path.join(root, 'dist', addonFileName({ ...HERE, abi: ABI })), 'utf-8')
    ).toBe('real');
  });

  it('refuses rather than looping when the refetch is wrong too', () => {
    cache(KEY, 'tampered');
    writeLock({ [KEY]: '0'.repeat(64) });

    expect(() =>
      stageAddons(
        { root, version: VERSION },
        { download: (_url, into) => makeTarball(into, 'tampered') }
      )
    ).toThrow(ChecksumMismatchError);

    expect(fs.existsSync(path.join(root, 'dist', addonFileName({ ...HERE, abi: ABI })))).toBe(
      false
    );
  });
});

describe('what a mismatch does to the build', () => {
  it('escapes the best-effort catch instead of degrading to a warning', () => {
    // A failed DOWNLOAD is survivable and warns. A wrong HASH is not, and the
    // only thing standing between the two is one `instanceof` rethrow — the
    // line whose deletion left this suite green.
    writeLock({ [KEY]: '0'.repeat(64) });

    expect(() =>
      stageAddons(
        { root, version: VERSION },
        { download: (_url, into) => makeTarball(into, 'substituted') }
      )
    ).toThrow(ChecksumMismatchError);
  });

  it('still shrugs off a download that simply failed', () => {
    // The positive control for the test above: without it, "throws" would pass
    // just as loudly if every failure threw and no build could survive an
    // offline runner.
    const at = cache(KEY, 'real');
    const pin = sha256(at);
    fs.rmSync(at);
    writeLock({ [KEY]: pin });

    expect(() =>
      stageAddons(
        { root, version: VERSION },
        {
          download: () => {
            throw new Error('curl: (6) Could not resolve host');
          },
        }
      )
    ).not.toThrow();
  });

  it('leaves nothing half-written in the cache when a download fails', () => {
    writeLock({ [KEY]: '0'.repeat(64) });

    stageAddons(
      { root, version: VERSION },
      {
        download: (_url, into) => {
          fs.writeFileSync(into, 'half a file');
          throw new Error('connection reset');
        },
      }
    );

    expect(fs.existsSync(path.join(root, '.native', `${KEY}.tar.gz`))).toBe(false);
  });
});

describe('what the build refuses to do at all', () => {
  it('throws when the lockfile pins a different better-sqlite3 than the bundle carries', () => {
    // The pins would be for a DIFFERENT binary than the JavaScript in the
    // bundle expects — a silently wrong add-on rather than an absent one.
    const at = cache(KEY, 'real');
    writeLock({ [KEY]: sha256(at) }, '12.10.0');

    expect(() => stageAddons({ root, version: VERSION }, { download: unreachable })).toThrow(
      /pins hashes for better-sqlite3 12\.10\.0/
    );
  });

  it('never fetches a target it has no pin for', () => {
    // Skipping an unpinned target is the safe direction — it costs search on an
    // exotic machine and cannot cost anything worse. What must not happen is a
    // download nobody vouched for, and the only way to see a request that did
    // not happen is to hold the seam.
    writeLock({});
    const download = vi.fn();

    const staged = stageAddons({ root, version: VERSION }, { download });

    expect(staged).toBe(0);
    expect(download).not.toHaveBeenCalled();
  });

  it('does not reach the network at all when the build says not to', () => {
    writeLock({ [KEY]: '0'.repeat(64) });
    const download = vi.fn();

    const staged = stageAddons({ root, version: VERSION }, { download, mayFetch: () => false });

    expect(staged).toBe(0);
    expect(download).not.toHaveBeenCalled();
  });
});

/** A download seam that must not be reached. */
function unreachable(): never {
  throw new Error('the build reached the network when it should not have');
}
