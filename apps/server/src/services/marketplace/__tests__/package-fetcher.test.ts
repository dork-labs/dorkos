import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { Logger } from '@dorkos/shared/logger';
import type { MarketplaceJson } from '@dorkos/marketplace';
import { initBoundary } from '../../../lib/boundary.js';
import { CATALOG_MAX_BYTES } from '@dorkos/shared/bounded-read';
import { MARKETPLACE_JSON_TIMEOUT_MS, PackageFetcher } from '../package-fetcher.js';
import { MarketplaceCache, type CachedMarketplace } from '../marketplace-cache.js';
import {
  GitFetchError,
  GitRefNotFoundError,
  GitRemoteUnreachableError,
  type GitTreeSource,
  type RemoteRef,
  type TreeRequest,
} from '../lib/git/git-tree.js';
import { UnsupportedSourceUrlError } from '../source-url-policy.js';
import type { MarketplaceSource } from '../types.js';

/** Construct a fake logger that records calls for later assertion. */
function buildLogger(): Logger & { calls: { level: string; args: unknown[] }[] } {
  const calls: { level: string; args: unknown[] }[] = [];
  return {
    info: (...args: unknown[]) => calls.push({ level: 'info', args }),
    warn: (...args: unknown[]) => calls.push({ level: 'warn', args }),
    error: (...args: unknown[]) => calls.push({ level: 'error', args }),
    debug: (...args: unknown[]) => calls.push({ level: 'debug', args }),
    calls,
  };
}

/** Construct a MarketplaceCache mock with overridable method spies. */
function buildCacheMock(overrides?: {
  getPackage?: ReturnType<typeof vi.fn>;
  materializePackage?: ReturnType<typeof vi.fn>;
  readMarketplace?: ReturnType<typeof vi.fn>;
  writeMarketplace?: ReturnType<typeof vi.fn>;
  writeFetchStatus?: ReturnType<typeof vi.fn>;
}): MarketplaceCache {
  return {
    getPackage: overrides?.getPackage ?? vi.fn().mockResolvedValue(null),
    materializePackage: overrides?.materializePackage ?? vi.fn(),
    readMarketplace: overrides?.readMarketplace ?? vi.fn().mockResolvedValue(null),
    writeMarketplace: overrides?.writeMarketplace ?? vi.fn().mockResolvedValue(undefined),
    writeFetchStatus: overrides?.writeFetchStatus ?? vi.fn().mockResolvedValue(undefined),
  } as unknown as MarketplaceCache;
}

/** A full commit id made of one repeated hex digit. */
const sha = (digit: string): string => digit.repeat(40);

/**
 * A fake git: `lookup` answers `lookedUp`, and `fetch` writes a marker into the
 * directory it is given and reports `fetched` (the looked-up commit by default).
 */
function buildGitMock(opts?: {
  lookedUp?: RemoteRef;
  fetched?: string;
  fetchImpl?: (req: TreeRequest) => Promise<string>;
}): GitTreeSource & { lookup: ReturnType<typeof vi.fn>; fetch: ReturnType<typeof vi.fn> } {
  const lookedUp = opts?.lookedUp ?? {
    kind: 'found',
    commitSha: sha('a'),
    refName: 'refs/heads/main',
  };
  return {
    lookup: vi.fn().mockResolvedValue(lookedUp),
    fetch: vi.fn(
      opts?.fetchImpl ??
        (async (req: TreeRequest) => {
          await writeFile(path.join(req.destDir, 'marker'), 'tree\n');
          return opts?.fetched ?? req.commitSha;
        })
    ),
  };
}

/** Minimal valid MarketplaceJson document for fetchMarketplaceJson tests. */
function buildMarketplaceJson(name = 'dorkos-community'): MarketplaceJson {
  return {
    name,
    owner: { name: 'dorkos' },
    plugins: [
      {
        name: 'code-review-suite',
        source: { source: 'github', repo: 'dorkos/code-review-suite' },
      },
    ],
  };
}

/** Construct a MarketplaceSource fixture. */
function buildSource(overrides?: Partial<MarketplaceSource>): MarketplaceSource {
  return {
    name: 'dorkos-community',
    source: 'https://github.com/dorkos/marketplace.git',
    enabled: true,
    addedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

let workDirForStatus: string | undefined;
afterEach(async () => {
  if (workDirForStatus) await rm(workDirForStatus, { recursive: true, force: true });
  workDirForStatus = undefined;
});

describe('PackageFetcher', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /**
   * The one path every git tree takes (DOR-2248), against a REAL cache so the
   * key an entry lands under is what is asserted, not what a mock was told.
   */
  describe('git trees', () => {
    let dorkHome: string;
    let cache: MarketplaceCache;

    beforeEach(async () => {
      dorkHome = await mkdtemp(path.join(tmpdir(), 'pkg-fetcher-git-'));
      cache = new MarketplaceCache(dorkHome);
    });

    afterEach(async () => {
      await rm(dorkHome, { recursive: true, force: true });
    });

    const fetchMain = (fetcher: PackageFetcher, force?: boolean) =>
      fetcher.fetchFromGit({
        packageName: 'my-plugin',
        gitUrl: 'https://gitlab.example.com/example/my-plugin.git',
        ref: 'main',
        force,
      });

    it('fetches the looked-up commit and caches it under that commit', async () => {
      // Purpose: a miss fetches exactly the commit the lookup named, by id.
      const git = buildGitMock();
      const result = await fetchMain(new PackageFetcher(cache, git, buildLogger()));

      expect(git.lookup).toHaveBeenCalledWith(
        'https://gitlab.example.com/example/my-plugin.git',
        'main'
      );
      expect(git.fetch).toHaveBeenCalledWith(
        expect.objectContaining({ commitSha: sha('a'), refName: 'refs/heads/main', subpath: '' })
      );
      expect(result).toEqual({
        path: path.join(cache.cacheRoot, 'trees', `my-plugin@${sha('a')}`),
        commitSha: sha('a'),
        fromCache: false,
      });
    });

    it('serves a cached tree for the looked-up commit without fetching', async () => {
      const git = buildGitMock();
      const fetcher = new PackageFetcher(cache, git, buildLogger());
      await fetchMain(fetcher);
      git.fetch.mockClear();

      const again = await fetchMain(fetcher);
      expect(again.fromCache).toBe(true);
      expect(again.commitSha).toBe(sha('a'));
      expect(git.fetch).not.toHaveBeenCalled();
    });

    it('records and keys the commit that arrived when the ref moved mid-fetch', async () => {
      // Purpose: the regression. A push between lookup and fetch used to land
      // the new tree under the old key; now key and record follow the tree.
      const git = buildGitMock({ fetched: sha('b') });
      const result = await fetchMain(new PackageFetcher(cache, git, buildLogger()));

      expect(result.commitSha).toBe(sha('b'));
      expect(result.path).toBe(path.join(cache.cacheRoot, 'trees', `my-plugin@${sha('b')}`));
      expect(await cache.getPackage('my-plugin', sha('a'), '')).toBeNull();
    });

    it('fails plainly, fetching nothing, when the ref does not exist', async () => {
      // Purpose: a typo'd ref used to fall back to a placeholder and clone the
      // default branch; now it is an error a person can act on.
      const git = buildGitMock({ lookedUp: { kind: 'missing' } });
      const error = await fetchMain(new PackageFetcher(cache, git, buildLogger())).catch((e) => e);

      expect(error).toBeInstanceOf(GitRefNotFoundError);
      expect(error.message).toBe(
        'There\'s no branch or tag named "main" in gitlab.example.com/example/my-plugin.'
      );
      expect(git.fetch).not.toHaveBeenCalled();
    });

    it('says an empty repository has no commits, rather than no branch named HEAD', async () => {
      // Purpose: a ref-less source on an empty repository misses `HEAD`;
      // "no branch or tag named HEAD" is true and useless.
      const git = buildGitMock({ lookedUp: { kind: 'missing' } });
      await expect(
        new PackageFetcher(cache, git, buildLogger()).fetchFromGit({
          packageName: 'x',
          gitUrl: 'https://gitlab.example.com/o/empty.git',
        })
      ).rejects.toThrow('gitlab.example.com/o/empty has no commits yet.');
    });

    it('fails plainly, fetching nothing, when the remote cannot be reached', async () => {
      // Purpose: "never a placeholder masquerading as a commit" — an
      // unreachable remote no longer yields a `tmp-` key.
      const git = buildGitMock({
        lookedUp: { kind: 'unreachable', reason: 'Could not resolve host' },
      });
      await expect(fetchMain(new PackageFetcher(cache, git, buildLogger()))).rejects.toThrow(
        new GitRemoteUnreachableError(
          'https://gitlab.example.com/example/my-plugin.git',
          'Could not resolve host'
        )
      );
      expect(git.fetch).not.toHaveBeenCalled();
      expect(await cache.listPackages()).toEqual([]);
    });

    it('refuses an unsafe address before any git runs', async () => {
      const git = buildGitMock();
      await expect(
        new PackageFetcher(cache, git, buildLogger()).fetchFromGit({
          packageName: 'x',
          gitUrl: "ext::sh -c 'id'",
        })
      ).rejects.toBeInstanceOf(UnsupportedSourceUrlError);
      expect(git.lookup).not.toHaveBeenCalled();
    });

    it('asks for HEAD when a bare git URL names no ref', async () => {
      // Purpose: the default is the repository's default branch, not `main`.
      const git = buildGitMock();
      await new PackageFetcher(cache, git, buildLogger()).fetchFromGit({
        packageName: 'x',
        gitUrl: 'https://gitlab.example.com/o/r.git',
      });
      expect(git.lookup).toHaveBeenCalledWith('https://gitlab.example.com/o/r.git', 'HEAD');
    });

    it('two concurrent fetches of one package both succeed and fetch exactly once', async () => {
      // The regression for the failing `flow` install: a UI preview and an
      // install fire together, and two git processes must never share a dir.
      const git = buildGitMock({
        fetchImpl: async (req) => {
          await new Promise((r) => setTimeout(r, 25));
          await writeFile(path.join(req.destDir, 'marker'), 'tree\n');
          return req.commitSha;
        },
      });
      const fetcher = new PackageFetcher(cache, git, buildLogger());
      const source = {
        source: 'git-subdir' as const,
        url: 'https://github.com/dork-labs/marketplace.git',
        path: 'plugins/flow',
      };

      const [a, b] = await Promise.all([
        fetcher.fetchPackage({ packageName: 'flow', source }),
        fetcher.fetchPackage({ packageName: 'flow', source }),
      ]);

      const expected = path.join(
        (await cache.getPackage('flow', sha('a'), 'plugins/flow'))!.path,
        'plugins/flow'
      );
      expect(a.path).toBe(expected);
      expect(b.path).toBe(expected);
      expect(git.fetch).toHaveBeenCalledTimes(1);
      expect(git.fetch).toHaveBeenCalledWith(expect.objectContaining({ subpath: 'plugins/flow' }));
    });

    it('surfaces the real fetch failure and leaves nothing cached', async () => {
      // A git failure must reach the person as itself, never as a later
      // "manifest missing" read from an empty directory.
      const git = buildGitMock({
        fetchImpl: async (req) => {
          throw new GitFetchError(req.cloneUrl, "repository 'x' not found");
        },
      });
      await expect(fetchMain(new PackageFetcher(cache, git, buildLogger()))).rejects.toThrow(
        /repository 'x' not found/
      );
      expect(await cache.listPackages()).toEqual([]);
    });
  });

  describe('lookupCommitSha', () => {
    it('answers with the same lookup a fetch uses', async () => {
      const git = buildGitMock();
      const fetcher = new PackageFetcher(buildCacheMock(), git, buildLogger());
      expect(await fetcher.lookupCommitSha('https://gitlab.example.com/o/r.git', 'v1')).toBe(
        sha('a')
      );
      expect(git.lookup).toHaveBeenCalledWith('https://gitlab.example.com/o/r.git', 'v1');
    });

    it.each<RemoteRef>([{ kind: 'missing' }, { kind: 'unreachable', reason: 'offline' }])(
      'returns a placeholder isRealCommitSha rejects when the lookup is %j',
      async (lookedUp) => {
        // Purpose: the update check's contract — a failed lookup is never a commit.
        const fetcher = new PackageFetcher(
          buildCacheMock(),
          buildGitMock({ lookedUp }),
          buildLogger()
        );
        expect(await fetcher.lookupCommitSha('https://gitlab.example.com/o/r.git', 'main')).toMatch(
          /^tmp-\d+$/
        );
      }
    );
  });

  describe('fetchMarketplaceJson', () => {
    it('fetches, parses, and caches a marketplace.json document', async () => {
      const json = buildMarketplaceJson();
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(json)));
      vi.stubGlobal('fetch', fetchMock);

      const cache = buildCacheMock();
      const fetcher = new PackageFetcher(cache, buildGitMock(), buildLogger());

      const result = await fetcher.fetchMarketplaceJson(buildSource());

      expect(result.name).toBe('dorkos-community');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const firstCall = fetchMock.mock.calls[0];
      expect(firstCall?.[0]).toContain('marketplace.json');
      expect(cache.writeMarketplace).toHaveBeenCalledWith('dorkos-community', expect.any(Object));
    });

    it('serves stale cache when the network fetch fails', async () => {
      const staleJson = buildMarketplaceJson('dorkos-community');
      const cached: CachedMarketplace = {
        json: staleJson,
        fetchedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        stale: true,
      };
      const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
      vi.stubGlobal('fetch', fetchMock);

      const cache = buildCacheMock({
        readMarketplace: vi.fn().mockResolvedValue(cached),
      });
      const logger = buildLogger();
      const fetcher = new PackageFetcher(cache, buildGitMock(), logger);

      const result = await fetcher.fetchMarketplaceJson(buildSource());

      expect(result).toBe(staleJson);
      expect(cache.readMarketplace).toHaveBeenCalledWith('dorkos-community');
      expect(cache.writeMarketplace).not.toHaveBeenCalled();
      expect(logger.calls.some((c) => c.level === 'warn')).toBe(true);
    });

    it('gives up on a marketplace server that stops answering, with a plain reason', async () => {
      // Purpose: a bare fetch has no deadline, so one slow server could hold an
      // update-check slot for minutes. The request carries a timeout signal,
      // and running out of time reads as a sentence, not a DOMException.
      const timeout = vi
        .spyOn(AbortSignal, 'timeout')
        .mockImplementation(() =>
          AbortSignal.abort(new DOMException('The operation timed out.', 'TimeoutError'))
        );
      const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
        init?.signal?.aborted ? Promise.reject(init.signal.reason) : new Promise(() => {})
      );
      vi.stubGlobal('fetch', fetchMock);
      const cache = buildCacheMock({ readMarketplace: vi.fn().mockResolvedValue(null) });
      const fetcher = new PackageFetcher(cache, buildGitMock(), buildLogger());

      await expect(fetcher.fetchMarketplaceJson(buildSource())).rejects.toThrow(
        `the marketplace server didn't answer within ${MARKETPLACE_JSON_TIMEOUT_MS / 1000} seconds`
      );
      expect(timeout).toHaveBeenCalledWith(MARKETPLACE_JSON_TIMEOUT_MS);
      timeout.mockRestore();
    });

    it('with staleFallback off, rethrows instead of serving the cached copy (DOR-2304)', async () => {
      // Purpose: "fetched" must mean fetched now. Adding a source asks for a
      // fresh fetch, and an old copy on disk is not an answer to that.
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
      const cache = buildCacheMock({
        readMarketplace: vi.fn().mockResolvedValue({
          json: buildMarketplaceJson('dorkos-community'),
          fetchedAt: new Date(),
          stale: false,
        } satisfies CachedMarketplace),
      });
      const fetcher = new PackageFetcher(cache, buildGitMock(), buildLogger());

      await expect(
        fetcher.fetchMarketplaceJson(buildSource(), { staleFallback: false })
      ).rejects.toThrow(/network down/);
      expect(cache.readMarketplace).not.toHaveBeenCalled();
    });

    it.each([
      [404, 'Not Found', "there's no marketplace listing at that address"],
      [
        500,
        'Internal Server Error',
        'the marketplace server answered with an error (500 Internal Server Error)',
      ],
    ])('says what an HTTP %i means in plain words', async (status, statusText, reason) => {
      // Purpose: the reason reaches a person (the add response, the CLI,
      // refresh), so it reads as a sentence rather than a status line.
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status, statusText }));
      const cache = buildCacheMock({ readMarketplace: vi.fn().mockResolvedValue(null) });
      const fetcher = new PackageFetcher(cache, buildGitMock(), buildLogger());

      await expect(fetcher.fetchMarketplaceJson(buildSource())).rejects.toThrow(reason);
    });

    it.each([
      ['ENOTFOUND', "couldn't find a server at that address"],
      ['EAI_AGAIN', "couldn't find a server at that address"],
      ['ECONNREFUSED', 'the server at that address refused the connection'],
      ['ECONNRESET', 'the connection to the marketplace server was cut off'],
      ['EFOOBAR', "couldn't reach the marketplace server (EFOOBAR)"],
    ])('unwraps a network failure coded %s into plain words', async (code, reason) => {
      // Purpose: undici's bare "fetch failed" hides the one useful fact, which
      // sits on `cause.code`.
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockRejectedValue(
            new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) })
          )
      );
      const cache = buildCacheMock({ readMarketplace: vi.fn().mockResolvedValue(null) });
      const fetcher = new PackageFetcher(cache, buildGitMock(), buildLogger());

      const failure = fetcher.fetchMarketplaceJson(buildSource());
      await expect(failure).rejects.toThrow(reason);
      await expect(failure).rejects.not.toThrow(/fetch failed/);
    });

    describe('records how each fetch went (DOR-2324)', () => {
      // Purpose: every door that fetches a listing (add, refresh, browse, the
      // update check) comes through here, so this is where the last outcome is
      // written down for GET /sources to report.
      it('records a fetched listing', async () => {
        vi.stubGlobal(
          'fetch',
          vi.fn().mockResolvedValue(new Response(JSON.stringify(buildMarketplaceJson())))
        );
        const cache = buildCacheMock();
        const fetcher = new PackageFetcher(cache, buildGitMock(), buildLogger());

        await fetcher.fetchMarketplaceJson(buildSource());

        expect(cache.writeFetchStatus).toHaveBeenCalledWith('dorkos-community', {
          startedAt: expect.any(String),
          checkedAt: expect.any(String),
          ok: true,
          packageCount: buildMarketplaceJson().plugins.length,
        });
      });

      it('records a failure with its reason, even when an old copy is served', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));
        const cache = buildCacheMock({
          readMarketplace: vi.fn().mockResolvedValue({
            json: buildMarketplaceJson(),
            fetchedAt: new Date(),
            stale: false,
          }),
        });
        const fetcher = new PackageFetcher(cache, buildGitMock(), buildLogger());

        await fetcher.fetchMarketplaceJson(buildSource());

        expect(cache.writeFetchStatus).toHaveBeenCalledWith('dorkos-community', {
          startedAt: expect.any(String),
          checkedAt: expect.any(String),
          ok: false,
          reason: "there's no marketplace listing at that address",
        });
      });

      it('records a local folder that has no listing', async () => {
        workDirForStatus = await mkdtemp(path.join(tmpdir(), 'pkg-fetcher-status-'));
        const cache = buildCacheMock();
        const fetcher = new PackageFetcher(cache, buildGitMock(), buildLogger());

        await expect(
          fetcher.fetchMarketplaceJson(
            buildSource({ name: 'local', source: pathToFileURL(workDirForStatus).href })
          )
        ).rejects.toThrow();

        expect(cache.writeFetchStatus).toHaveBeenCalledWith('local', {
          startedAt: expect.any(String),
          checkedAt: expect.any(String),
          ok: false,
          reason: "there's no marketplace listing in that folder",
        });
      });

      it('still answers when the record cannot be written', async () => {
        // Purpose: the record is bookkeeping; it must never cost a listing.
        vi.stubGlobal(
          'fetch',
          vi.fn().mockResolvedValue(new Response(JSON.stringify(buildMarketplaceJson())))
        );
        const cache = buildCacheMock({
          writeFetchStatus: vi.fn().mockRejectedValue(new Error('disk full')),
        });
        const fetcher = new PackageFetcher(cache, buildGitMock(), buildLogger());

        await expect(fetcher.fetchMarketplaceJson(buildSource())).resolves.toMatchObject({
          name: 'dorkos-community',
        });
      });
    });

    it('rethrows when both network fetch and stale cache fail', async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
      vi.stubGlobal('fetch', fetchMock);

      const cache = buildCacheMock({
        readMarketplace: vi.fn().mockResolvedValue(null),
      });
      const fetcher = new PackageFetcher(cache, buildGitMock(), buildLogger());

      await expect(fetcher.fetchMarketplaceJson(buildSource())).rejects.toThrow(/network down/);
    });
  });

  describe('bounded catalog reads (DOR-2319)', () => {
    /** A streamed body of `total` bytes, recording how many were pulled. */
    function endlessBody(total: number): {
      body: ReadableStream<Uint8Array>;
      pulled: () => number;
    } {
      const chunk = new Uint8Array(64 * 1024).fill(0x20);
      let sent = 0;
      return {
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent >= total) return controller.close();
            sent += chunk.length;
            controller.enqueue(chunk);
          },
        }),
        pulled: () => sent,
      };
    }

    // Purpose: a marketplace server that streams an endless catalog is cut off
    // at the limit, not read into memory, and the reason is a sentence.
    it('refuses a marketplace.json larger than the limit while streaming it', async () => {
      const { body, pulled } = endlessBody(50 * 1024 * 1024);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)));
      const cache = buildCacheMock({ readMarketplace: vi.fn().mockResolvedValue(null) });
      const fetcher = new PackageFetcher(cache, buildGitMock(), buildLogger());

      await expect(fetcher.fetchMarketplaceJson(buildSource())).rejects.toThrow(
        "The marketplace's marketplace.json is larger than 5 MB, which is more than DorkOS will read."
      );
      expect(pulled()).toBeLessThanOrEqual(CATALOG_MAX_BYTES + 256 * 1024);
    });

    // Purpose: the sidecar fetch now has the same deadline as marketplace.json.
    it('gives the dorkos.json fetch a timeout', async () => {
      const timeout = vi
        .spyOn(AbortSignal, 'timeout')
        .mockImplementation(() =>
          AbortSignal.abort(new DOMException('The operation timed out.', 'TimeoutError'))
        );
      const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
        init?.signal?.aborted ? Promise.reject(init.signal.reason) : new Promise(() => {})
      );
      vi.stubGlobal('fetch', fetchMock);
      const fetcher = new PackageFetcher(buildCacheMock(), buildGitMock(), buildLogger());

      expect(await fetcher.fetchDorkosSidecar(buildSource())).toBeNull();
      expect(timeout).toHaveBeenCalledWith(MARKETPLACE_JSON_TIMEOUT_MS);
      timeout.mockRestore();
    });

    // Purpose: an oversized sidecar is dropped (sidecars are optional) without
    // reading it all, and the reason is logged where someone can see it.
    it('drops a dorkos.json larger than the limit, and says why', async () => {
      const { body, pulled } = endlessBody(50 * 1024 * 1024);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)));
      const logger = buildLogger();
      const fetcher = new PackageFetcher(buildCacheMock(), buildGitMock(), logger);

      expect(await fetcher.fetchDorkosSidecar(buildSource())).toBeNull();
      expect(pulled()).toBeLessThanOrEqual(CATALOG_MAX_BYTES + 256 * 1024);
      expect(
        logger.calls.some(
          (c) => c.level === 'warn' && JSON.stringify(c.args).includes('larger than 5 MB')
        )
      ).toBe(true);
    });

    // Purpose: a local (file://) catalog is capped the same way.
    it('refuses a local marketplace.json larger than the limit', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'pkg-fetcher-big-'));
      try {
        await writeFile(path.join(dir, 'marketplace.json'), ' '.repeat(CATALOG_MAX_BYTES + 1));
        vi.stubGlobal('fetch', vi.fn());
        const cache = buildCacheMock({ readMarketplace: vi.fn().mockResolvedValue(null) });
        const fetcher = new PackageFetcher(cache, buildGitMock(), buildLogger());
        await expect(
          fetcher.fetchMarketplaceJson(
            buildSource({ name: 'personal', source: pathToFileURL(dir).href })
          )
        ).rejects.toThrow(/larger than 5 MB/);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    // Purpose: a root marketplace.json that is there but too large is the
    // answer; the reader must not fall back to .claude-plugin/marketplace.json.
    it('does not fall back past an oversized root marketplace.json', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'pkg-fetcher-big-'));
      try {
        await writeFile(path.join(dir, 'marketplace.json'), ' '.repeat(CATALOG_MAX_BYTES + 1));
        await mkdir(path.join(dir, '.claude-plugin'));
        await writeFile(
          path.join(dir, '.claude-plugin', 'marketplace.json'),
          JSON.stringify(buildMarketplaceJson('personal'))
        );
        vi.stubGlobal('fetch', vi.fn());
        const cache = buildCacheMock({ readMarketplace: vi.fn().mockResolvedValue(null) });
        const fetcher = new PackageFetcher(cache, buildGitMock(), buildLogger());
        await expect(
          fetcher.fetchMarketplaceJson(
            buildSource({ name: 'personal', source: pathToFileURL(dir).href })
          )
        ).rejects.toThrow("The marketplace's marketplace.json is larger than 5 MB");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('file:// source support', () => {
    let workDir: string;

    afterEach(async () => {
      if (workDir) {
        await rm(workDir, { recursive: true, force: true });
      }
    });

    it('fetchMarketplaceJson reads a local marketplace.json from a file:// URL', async () => {
      workDir = await mkdtemp(path.join(tmpdir(), 'pkg-fetcher-file-'));
      const json = buildMarketplaceJson('personal');
      await writeFile(path.join(workDir, 'marketplace.json'), JSON.stringify(json), 'utf-8');

      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const cache = buildCacheMock();
      const fetcher = new PackageFetcher(cache, buildGitMock(), buildLogger());

      const result = await fetcher.fetchMarketplaceJson(
        buildSource({ name: 'personal', source: pathToFileURL(workDir).href })
      );

      expect(result.name).toBe('personal');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(cache.writeMarketplace).toHaveBeenCalledWith('personal', expect.any(Object));
    });

    it('fetchMarketplaceJson reads .claude-plugin/marketplace.json when the root has none', async () => {
      // Mirrors the Claude Code standard layout used by dork-labs/marketplace:
      // marketplace.json lives under .claude-plugin/, not the source root.
      workDir = await mkdtemp(path.join(tmpdir(), 'pkg-fetcher-file-'));
      const json = buildMarketplaceJson('dork-labs');
      await mkdir(path.join(workDir, '.claude-plugin'), { recursive: true });
      await writeFile(
        path.join(workDir, '.claude-plugin', 'marketplace.json'),
        JSON.stringify(json),
        'utf-8'
      );

      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const cache = buildCacheMock();
      const fetcher = new PackageFetcher(cache, buildGitMock(), buildLogger());

      const result = await fetcher.fetchMarketplaceJson(
        buildSource({ name: 'dork-labs', source: pathToFileURL(workDir).href })
      );

      expect(result.name).toBe('dork-labs');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(cache.writeMarketplace).toHaveBeenCalledWith('dork-labs', expect.any(Object));
    });

    it('fetchMarketplaceJson prefers the root marketplace.json when both layouts exist', async () => {
      workDir = await mkdtemp(path.join(tmpdir(), 'pkg-fetcher-file-'));
      const rootJson = buildMarketplaceJson('root-wins');
      const pluginJson = buildMarketplaceJson('claude-plugin-loses');
      await mkdir(path.join(workDir, '.claude-plugin'), { recursive: true });
      await writeFile(path.join(workDir, 'marketplace.json'), JSON.stringify(rootJson), 'utf-8');
      await writeFile(
        path.join(workDir, '.claude-plugin', 'marketplace.json'),
        JSON.stringify(pluginJson),
        'utf-8'
      );

      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const cache = buildCacheMock();
      const fetcher = new PackageFetcher(cache, buildGitMock(), buildLogger());

      const result = await fetcher.fetchMarketplaceJson(
        buildSource({ name: 'root-wins', source: pathToFileURL(workDir).href })
      );

      expect(result.name).toBe('root-wins');
      expect(cache.writeMarketplace).toHaveBeenCalledWith('root-wins', expect.any(Object));
    });

    it('says in plain words that a folder has no listing, and logs both paths it tried', async () => {
      // Purpose: this reason reaches a person (the add note, refresh). Two
      // absolute paths and an ENOENT dump filled a phone screen (DOR-2304);
      // the paths belong in the log, where a support question is answered.
      workDir = await mkdtemp(path.join(tmpdir(), 'pkg-fetcher-file-'));
      // Note: do not seed marketplace.json at either the root or .claude-plugin/ on purpose.

      const cache = buildCacheMock();
      const logger = buildLogger();
      const fetcher = new PackageFetcher(cache, buildGitMock(), logger);

      const sourceUrl = pathToFileURL(workDir).href;
      await expect(
        fetcher.fetchMarketplaceJson(buildSource({ name: 'personal', source: sourceUrl }))
      ).rejects.toThrow(/^there's no marketplace listing in that folder$/);
      expect(cache.writeMarketplace).not.toHaveBeenCalled();
      const logged = JSON.stringify(logger.calls.filter((c) => c.level === 'warn'));
      expect(logged).toMatch(/marketplace\.json/);
      expect(logged).toMatch(/\.claude-plugin/);
    });

    it('fetchMarketplaceJson throws when the local marketplace.json is invalid JSON', async () => {
      workDir = await mkdtemp(path.join(tmpdir(), 'pkg-fetcher-file-'));
      await writeFile(path.join(workDir, 'marketplace.json'), '{ not valid json', 'utf-8');

      const cache = buildCacheMock();
      const fetcher = new PackageFetcher(cache, buildGitMock(), buildLogger());

      await expect(
        fetcher.fetchMarketplaceJson(
          buildSource({ name: 'personal', source: pathToFileURL(workDir).href })
        )
      ).rejects.toThrow();
      expect(cache.writeMarketplace).not.toHaveBeenCalled();
    });

    it('fetchFromGit returns the local directory immediately when gitUrl is file://', async () => {
      // Realpath'd and made the boundary root: a `file://` install is confined
      // to the directory boundary (DOR-1825), so a suite exercising the happy
      // path has to say which directory it is installing from within. What the
      // boundary REFUSES is `install-address-policy.test.ts`'s subject.
      workDir = await realpath(await mkdtemp(path.join(tmpdir(), 'pkg-fetcher-file-')));
      await initBoundary(workDir);
      const pkgDir = path.join(workDir, 'packages', 'my-plugin');
      await mkdir(pkgDir, { recursive: true });

      const cache = buildCacheMock();
      const fetcher = new PackageFetcher(cache, buildGitMock(), buildLogger());

      const result = await fetcher.fetchFromGit({
        packageName: 'my-plugin',
        gitUrl: pathToFileURL(pkgDir).href,
      });

      expect(result.fromCache).toBe(true);
      expect(result.commitSha).toBe('local');
      expect(result.path).toBe(pkgDir);
      expect(cache.getPackage).not.toHaveBeenCalled();
      expect(cache.materializePackage).not.toHaveBeenCalled();
    });

    it('fetchFromGit decodes a file:// path whose directory name contains a space', async () => {
      // node:url's fileURLToPath decodes percent-escapes (e.g. %20 -> ' ');
      // new URL(source).pathname does not, and previously left the encoded
      // form in the returned path (DOR-412).
      workDir = await realpath(await mkdtemp(path.join(tmpdir(), 'pkg-fetcher-file-')));
      await initBoundary(workDir);
      const pkgDir = path.join(workDir, 'my plugin');
      await mkdir(pkgDir, { recursive: true });

      const cache = buildCacheMock();
      const fetcher = new PackageFetcher(cache, buildGitMock(), buildLogger());

      const result = await fetcher.fetchFromGit({
        packageName: 'my-plugin',
        gitUrl: pathToFileURL(pkgDir).href,
      });

      expect(result.path).toBe(pkgDir);
      expect(result.path).not.toContain('%20');
    });
  });
});
