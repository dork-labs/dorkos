/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { access, chmod, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { readProjectInstalls, recordProjectInstall } from '../lib/project-install-index.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '@dorkos/shared/logger';
import { MARKETPLACE_BACKUP_DIR_MARKER } from '@dorkos/shared/marketplace-schemas';
import { MarketplaceCache, subpathDigest, type CachedPackage } from '../marketplace-cache.js';
import { INSTALL_METADATA_PATH } from '../installed-metadata.js';
import {
  PackageCacheRetention,
  UnreadableInstallsError,
  keepRule,
  listRecordedTrees,
  type RecordedTree,
} from '../package-cache-retention.js';

/** A full commit id made of one repeated hex digit. */
const sha = (digit: string): string => digit.repeat(40);

const HOUR_MS = 60 * 60 * 1000;

/** Build a listed entry for the pure rule, last used `agoMs` before now. */
function entry(packageName: string, commit: string, subpath: string, agoMs: number): CachedPackage {
  const digest = subpathDigest(subpath);
  return {
    packageName,
    commitSha: commit,
    subpathDigest: digest,
    path: `/trees/${packageName}@${commit}${digest === '' ? '' : `~${digest}`}`,
    lastUsedAt: new Date(Date.now() - agoMs),
  };
}

/** A logger whose calls a test can read. */
function spyLogger() {
  return {
    info: vi.fn<Logger['info']>(),
    warn: vi.fn<Logger['warn']>(),
    error: vi.fn<Logger['error']>(),
    debug: vi.fn<Logger['debug']>(),
  } satisfies Logger;
}

describe('keepRule', () => {
  it('keeps the entry at a recorded commit whatever name the cache used', () => {
    // Purpose: a direct git install keys the cache by the name a person typed
    // while the sidecar records the manifest's name; the commit is what binds.
    const recorded: RecordedTree[] = [{ name: 'flow', commitSha: sha('a'), subpath: '' }];
    const typed = entry('my-flow', sha('a'), '', HOUR_MS);
    const other = entry('my-flow', sha('b'), '', 2 * HOUR_MS);

    expect(keepRule([typed, other], recorded).has(typed.path)).toBe(true);
    expect(keepRule([typed, other], recorded).has(other.path)).toBe(false);
  });

  it('matches the recorded subfolder, not another subfolder at the same commit', () => {
    // Purpose: one marketplace commit holds every same-repo package; only the
    // installed package's subfolder is its recorded tree.
    const recorded: RecordedTree[] = [
      { name: 'flow', commitSha: sha('a'), subpath: 'plugins/flow' },
    ];
    const mine = entry('flow', sha('a'), 'plugins/flow', HOUR_MS);
    const sibling = entry('lint', sha('a'), 'plugins/lint', HOUR_MS);

    const kept = keepRule([mine, sibling], recorded);
    expect(kept.has(mine.path)).toBe(true);
    expect(kept.has(sibling.path)).toBe(false);
  });

  it('keeps every entry at the commit when the sidecar does not say which subfolder', () => {
    // Purpose: sidecars from before DOR-2244 carry a commit but no source
    // key; dropping their tree because we cannot tell which is the wrong way to fail.
    const recorded: RecordedTree[] = [{ name: 'flow', commitSha: sha('a') }];
    const whole = entry('flow', sha('a'), '', HOUR_MS);
    const sparse = entry('flow', sha('a'), 'plugins/flow', HOUR_MS);

    const kept = keepRule([whole, sparse], recorded);
    expect(kept.has(whole.path)).toBe(true);
    expect(kept.has(sparse.path)).toBe(true);
  });

  it('keeps the most recently used entry of an installed package: the staged update', () => {
    // Purpose: applying an update reuses the tree the check staged; older
    // staged versions go.
    const recorded: RecordedTree[] = [
      { name: 'flow', commitSha: sha('a'), subpath: 'plugins/flow' },
    ];
    const installed = entry('flow', sha('a'), 'plugins/flow', 3 * HOUR_MS);
    const superseded = entry('flow', sha('b'), 'plugins/flow', 2 * HOUR_MS);
    const pending = entry('flow', sha('c'), 'plugins/flow', HOUR_MS);

    const kept = keepRule([installed, superseded, pending], recorded);
    expect([...kept].sort()).toEqual([installed.path, pending.path].sort());
  });

  it('keeps the staged update even when the installed commit was read more recently', () => {
    // Purpose: rebuilding an install's file record (DOR-2245) reads the
    // installed commit; that must not make it "newest" and cost the staged
    // update its place.
    const recorded: RecordedTree[] = [
      { name: 'flow', commitSha: sha('a'), subpath: 'plugins/flow' },
    ];
    const installedJustRead = entry('flow', sha('a'), 'plugins/flow', 60_000);
    const pending = entry('flow', sha('c'), 'plugins/flow', HOUR_MS);
    const superseded = entry('flow', sha('b'), 'plugins/flow', 2 * HOUR_MS);

    const kept = keepRule([installedJustRead, pending, superseded], recorded);
    expect([...kept].sort()).toEqual([installedJustRead.path, pending.path].sort());
  });

  it('keeps the newest entry of each subfolder when an old sidecar names none', () => {
    // Purpose: without a recorded subfolder the rule cannot tell which of a
    // name's subfolders is the installed one, so it keeps each one's newest.
    const recorded: RecordedTree[] = [{ name: 'flow', commitSha: sha('a') }];
    const first = entry('flow', sha('b'), 'plugins/flow', HOUR_MS);
    const second = entry('flow', sha('c'), 'packages/flow', 2 * HOUR_MS);

    const kept = keepRule([first, second], recorded);
    expect([...kept].sort()).toEqual([first.path, second.path].sort());
  });

  it('keeps nothing for a package that is not installed', () => {
    // Purpose: browsing stages one entry per package opened; keeping the
    // newest of each for ever would grow without bound.
    const previewed = entry('stranger', sha('a'), '', HOUR_MS);

    expect(keepRule([previewed], []).size).toBe(0);
  });

  it('treats the whole repository and a subfolder of one name as separate packages', () => {
    // Purpose: an install of the subfolder must not pin the newest
    // whole-repository entry of the same name, or the reverse.
    const recorded: RecordedTree[] = [
      { name: 'flow', commitSha: sha('a'), subpath: 'plugins/flow' },
    ];
    const installed = entry('flow', sha('a'), 'plugins/flow', 2 * HOUR_MS);
    const wholeNewest = entry('flow', sha('b'), '', HOUR_MS);

    const kept = keepRule([installed, wholeNewest], recorded);
    expect(kept.has(wholeNewest.path)).toBe(false);
    expect(kept.has(installed.path)).toBe(true);
  });
});

describe('with a real data directory', () => {
  let dorkHome: string;
  let projectPath: string;
  let cache: MarketplaceCache;

  beforeEach(async () => {
    dorkHome = await mkdtemp(join(tmpdir(), 'cache-retention-'));
    projectPath = await mkdtemp(join(tmpdir(), 'cache-retention-project-'));
    cache = new MarketplaceCache(dorkHome);
  });

  afterEach(async () => {
    await rm(dorkHome, { recursive: true, force: true });
    await rm(projectPath, { recursive: true, force: true });
  });

  /** Install a package (manifest + sidecar) under a scope root. */
  async function install(
    scopeRoot: string,
    name: string,
    metadata: Record<string, unknown>
  ): Promise<void> {
    const root = join(scopeRoot, 'plugins', name);
    await mkdir(join(root, '.dork'), { recursive: true });
    await writeFile(
      join(root, '.dork', 'manifest.json'),
      JSON.stringify({ schemaVersion: 1, type: 'plugin', name, version: '1.0.0' })
    );
    await writeFile(
      join(root, INSTALL_METADATA_PATH),
      JSON.stringify({
        name,
        version: '1.0.0',
        type: 'plugin',
        installedAt: '2026-09-01T00:00:00.000Z',
        ...metadata,
      })
    );
  }

  /** Cache an entry and mark it last used `agoMs` ago. */
  async function cached(name: string, commit: string, subpath: string, agoMs = HOUR_MS) {
    const { path } = await cache.materializePackage(name, commit, subpath, async (dir) => {
      await writeFile(join(dir, 'README.md'), 'tree\n');
      return commit;
    });
    const then = new Date(Date.now() - agoMs);
    await utimes(path, then, then);
    return path;
  }

  describe('listRecordedTrees', () => {
    it('reads the commit and subfolder of every install, global and agent-scoped', async () => {
      // Purpose: an agent-scoped install records a tree just as a global one
      // does; missing either scope deletes what that install needs.
      await install(dorkHome, 'flow', {
        commitSha: sha('a'),
        sourceKey: { cloneUrl: 'https://github.com/o/m.git', subpath: 'plugins/flow', ref: 'HEAD' },
      });
      await install(join(projectPath, '.dork'), 'lint', { commitSha: sha('b') });
      await install(dorkHome, 'local-thing', {});

      const { trees } = await listRecordedTrees(dorkHome, [{ projectPath }]);

      expect(trees).toEqual(
        expect.arrayContaining([
          { name: 'flow', commitSha: sha('a'), subpath: 'plugins/flow' },
          { name: 'lint', commitSha: sha('b') },
        ])
      );
      // The install with no commit (a local or file:// one) records nothing.
      expect(trees).toHaveLength(2);
    });

    it('refuses when the agent registry is unavailable', async () => {
      // Purpose: with no registry, every agent-scoped install is invisible;
      // reading that as "none" deletes what they record.
      await expect(listRecordedTrees(dorkHome, undefined)).rejects.toThrow(UnreadableInstallsError);
    });

    it("refuses when a registered agent's project folder is missing", async () => {
      // Purpose: an unplugged drive looks exactly like this, and its installs
      // still record trees.
      await expect(
        listRecordedTrees(dorkHome, [{ projectPath: join(projectPath, 'unplugged') }])
      ).rejects.toThrow(/unplugged/);
    });

    it('refuses when an install root exists but cannot be read', async () => {
      // Purpose: `chmod 000 ~/.dork/plugins` used to read as "nothing installed".
      await install(dorkHome, 'flow', { commitSha: sha('a') });
      const plugins = join(dorkHome, 'plugins');
      await chmod(plugins, 0o000);
      try {
        await expect(listRecordedTrees(dorkHome, [])).rejects.toThrow(UnreadableInstallsError);
      } finally {
        await chmod(plugins, 0o755);
      }
    });

    it('refuses when a sidecar exists but cannot be read', async () => {
      await install(dorkHome, 'flow', { commitSha: sha('a') });
      const sidecar = join(dorkHome, 'plugins', 'flow', INSTALL_METADATA_PATH);
      await chmod(sidecar, 0o000);
      try {
        await expect(listRecordedTrees(dorkHome, [])).rejects.toThrow(/install-metadata/);
      } finally {
        await chmod(sidecar, 0o644);
      }
    });

    it("skips the install engine's own siblings, such as a crash-left backup", async () => {
      // Purpose: a backup is bookkeeping (DOR-2273); a torn one must not pause
      // cleanup, and it is not an install whose tree needs keeping.
      await install(dorkHome, 'flow', { commitSha: sha('a') });
      const backup = join(
        dorkHome,
        'plugins',
        `flow${MARKETPLACE_BACKUP_DIR_MARKER}1727100000000-x`
      );
      await mkdir(join(backup, '.dork'), { recursive: true });
      await writeFile(join(backup, INSTALL_METADATA_PATH), '{"name":');

      const { trees } = await listRecordedTrees(dorkHome, []);

      expect(trees).toEqual([{ name: 'flow', commitSha: sha('a') }]);
    });

    it('refuses when a sidecar does not parse', async () => {
      // Purpose: a torn sidecar still names a commit we cannot see; guessing
      // "none" deletes it.
      await install(dorkHome, 'flow', { commitSha: sha('a') });
      await writeFile(join(dorkHome, 'plugins', 'flow', INSTALL_METADATA_PATH), '{"name":');
      await expect(listRecordedTrees(dorkHome, [])).rejects.toThrow(/make sense/);
    });

    it('reads a project install in a folder that is not a registered agent', async () => {
      // Purpose: installs into an unregistered folder, or left behind by an
      // unregistered agent, are found through the installer's record.
      const scope = join(projectPath, '.dork');
      await install(scope, 'lint', { commitSha: sha('b') });
      await recordProjectInstall(dorkHome, {
        projectPath,
        installRoot: join(scope, 'plugins', 'lint'),
        name: 'lint',
        commitSha: sha('b'),
      });

      const { trees } = await listRecordedTrees(dorkHome, []);

      expect(trees).toEqual([{ name: 'lint', commitSha: sha('b') }]);
    });

    it('protects a recorded install whose project cannot be reached', async () => {
      // Purpose: a project on a drive that is not plugged in stays protected
      // by what the installer recorded, and its record is kept.
      const away = join(projectPath, 'on-a-drive');
      await recordProjectInstall(dorkHome, {
        projectPath: away,
        installRoot: join(away, '.dork', 'plugins', 'lint'),
        name: 'lint',
        commitSha: sha('b'),
        subpath: '',
      });

      const result = await listRecordedTrees(dorkHome, []);

      expect(result.trees).toEqual([{ name: 'lint', commitSha: sha('b'), subpath: '' }]);
      expect(result.goneProjectInstalls).toEqual([]);
    });

    it('reports a recorded install whose project exists but whose install is gone', async () => {
      // Purpose: that is an uninstall; its record may go, and it protects nothing.
      const record = {
        projectPath,
        installRoot: join(projectPath, '.dork', 'plugins', 'lint'),
        name: 'lint',
        commitSha: sha('b'),
      };
      await recordProjectInstall(dorkHome, record);

      const result = await listRecordedTrees(dorkHome, []);

      expect(result.trees).toEqual([]);
      expect(result.goneProjectInstalls).toEqual([record]);
    });
  });

  describe('PackageCacheRetention', () => {
    function retention(logger: Logger = spyLogger(), agents = [{ projectPath }]) {
      return new PackageCacheRetention({
        cache,
        dorkHome,
        listAgentScopes: () => agents,
        logger,
      });
    }

    it('removes what no install needs and keeps what one records', async () => {
      // Purpose: the whole rule end to end, on disk.
      await install(dorkHome, 'flow', {
        commitSha: sha('a'),
        sourceKey: { cloneUrl: 'https://github.com/o/m.git', subpath: 'plugins/flow', ref: 'HEAD' },
      });
      const recorded = await cached('flow', sha('a'), 'plugins/flow', 3 * HOUR_MS);
      const superseded = await cached('flow', sha('b'), 'plugins/flow', 2 * HOUR_MS);
      const pending = await cached('flow', sha('c'), 'plugins/flow', HOUR_MS);
      const previewed = await cached('stranger', sha('d'), '');

      const result = await retention().sweep();

      expect(result.removed.map((e) => e.path).sort()).toEqual([superseded, previewed].sort());
      expect(result.freedBytes).toBe(2 * 'tree\n'.length);
      await expect(access(recorded)).resolves.toBeUndefined();
      await expect(access(pending)).resolves.toBeUndefined();
    });

    it('removes nothing when an install root cannot be read', async () => {
      // Purpose: the sweep deletes what the scan does not return, so a scan
      // that cannot see an install must stop the sweep, not shrink the answer.
      await install(dorkHome, 'flow', { commitSha: sha('a') });
      const recorded = await cached('flow', sha('a'), '');
      const plugins = join(dorkHome, 'plugins');
      await chmod(plugins, 0o000);
      try {
        await expect(retention().sweep()).rejects.toThrow(UnreadableInstallsError);
      } finally {
        await chmod(plugins, 0o755);
      }
      await expect(access(recorded)).resolves.toBeUndefined();
    });

    it('removes nothing while the project install record does not parse', async () => {
      // Purpose: a truncated record must stop the sweep, never read as "no
      // project installs" and delete what they recorded.
      const recorded = await cached('flow', sha('a'), '');
      await mkdir(join(dorkHome, 'marketplace'), { recursive: true });
      await writeFile(join(dorkHome, 'marketplace', 'project-installs.json'), '{"version":1,');

      await expect(retention().sweep()).rejects.toThrow(UnreadableInstallsError);
      await expect(access(recorded)).resolves.toBeUndefined();
    });

    it('reports a pause with its reason, logs it once, and clears it when a sweep completes', async () => {
      // Purpose: a paused cleanup is invisible otherwise; and a cache swept
      // after every download must not repeat the same warning each time.
      const logger = spyLogger();
      const missing = join(projectPath, 'unplugged');
      const agents = [{ projectPath: missing }];
      const owner = new PackageCacheRetention({
        cache,
        dorkHome,
        listAgentScopes: () => agents,
        logger,
      });
      expect(owner.status()).toEqual({ paused: false, reason: null, since: null });

      await expect(owner.sweep()).rejects.toThrow();
      const first = owner.status();
      expect(first.paused).toBe(true);
      expect(first.reason).toBe(`couldn't read ${missing} (the folder is missing)`);
      expect(Number.isNaN(Date.parse(first.since!))).toBe(false);

      await expect(owner.sweep()).rejects.toThrow();
      expect(owner.status()).toEqual(first);
      expect(logger.warn.mock.calls.filter(([m]) => String(m).includes('paused'))).toHaveLength(1);

      agents.length = 0;
      await owner.sweep();
      expect(owner.status()).toEqual({ paused: false, reason: null, since: null });
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('resumed'));
    });

    it('drops the record of an uninstalled project install', async () => {
      // Purpose: records must not pin trees for ever after an uninstall.
      const installRoot = join(projectPath, '.dork', 'plugins', 'lint');
      await recordProjectInstall(dorkHome, { projectPath, installRoot, name: 'lint' });

      await retention().sweep();

      expect(await readProjectInstalls(dorkHome)).toEqual([]);
    });

    it('removes nothing when it cannot list installations', async () => {
      // Purpose: failing to read installs must not look like "nothing is installed".
      const path = await cached('flow', sha('a'), '');
      const broken = new PackageCacheRetention({
        cache,
        dorkHome,
        listAgentScopes: () => {
          throw new Error('mesh is not ready');
        },
        logger: spyLogger(),
      });

      await expect(broken.sweep()).rejects.toThrow(/mesh is not ready/);
      await expect(access(path)).resolves.toBeUndefined();
    });

    it('sweeps once when started, and logs what it removed', async () => {
      // Purpose: whatever piled up while the server was down goes at startup,
      // and the log says so.
      const logger = spyLogger();
      const stale = await cached('stranger', sha('a'), '');

      retention(logger).start();

      await vi.waitFor(async () => {
        await expect(access(stale)).rejects.toThrow();
      });
      await vi.waitFor(() =>
        expect(logger.info).toHaveBeenCalledWith(
          expect.stringContaining('Removed 1 unused package'),
          expect.anything()
        )
      );
    });

    it('sweeps after a fetch lands a new entry, once started', async () => {
      // Purpose: the write path is the owner's trigger; without it nothing
      // prunes between restarts however often a poll writes.
      const removeUnused = vi.spyOn(cache, 'removeUnused');
      retention().start();
      await vi.waitFor(() => expect(removeUnused).toHaveBeenCalledTimes(1));

      await cached('other', sha('b'), '');

      await vi.waitFor(() => expect(removeUnused).toHaveBeenCalledTimes(2));
    });

    it('logs a failed background sweep instead of throwing', async () => {
      // Purpose: a sweep triggered by a fetch must never fail that fetch or
      // surface as an unhandled rejection.
      const logger = spyLogger();
      const owner = new PackageCacheRetention({
        cache,
        dorkHome,
        listAgentScopes: () => {
          throw new Error('mesh is not ready');
        },
        logger,
      });

      owner.start();

      await vi.waitFor(() =>
        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining('cleanup is paused'),
          expect.objectContaining({ error: 'mesh is not ready' })
        )
      );
    });

    it('coalesces requests made while a sweep runs into one more sweep', async () => {
      // Purpose: a 20-package check lands 20 entries; that must cost one or
      // two sweeps, not twenty.
      let scans = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const owner = new PackageCacheRetention({
        cache,
        dorkHome,
        listAgentScopes: () => {
          scans += 1;
          return [];
        },
        logger: spyLogger(),
      });
      const removeUnused = vi.spyOn(cache, 'removeUnused');
      removeUnused.mockImplementationOnce(async () => {
        await gate;
        return { removed: [], freedBytes: 0, failed: [] };
      });

      const first = owner.sweep();
      await vi.waitFor(() => expect(scans).toBe(1));
      const second = owner.sweep();
      const third = owner.sweep();
      expect(second).toBe(third);
      release();
      await Promise.all([first, second, third]);

      expect(scans).toBe(2);
    });
  });
});
