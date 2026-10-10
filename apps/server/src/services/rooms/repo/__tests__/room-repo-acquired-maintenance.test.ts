import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runMigrations } from '@dorkos/db';
import { openServerDatabase } from '@dorkos/db/internal-server';
import { initBoundary } from '../../../../lib/boundary.js';
import { initAuth, readOwnerAccount } from '../../../core/auth/index.js';
import { readOperatorDisplayName } from '../../../core/config/operator-display-name.js';
import { initConfigManager, configManager } from '../../../core/config-manager.js';
import { ROOM_REPO_CAP_DEFAULTS } from '@dorkos/shared/room-repo';
import { ApprovalService } from '../../../core/approvals/approval-service.js';
import { createRoomSubsystem, setRoomService, clearRoomService } from '../../index.js';
import { RoomRepoStore } from '../room-repo-store.js';
import { RoomRepoMutex } from '../room-repo-mutex.js';
import { RoomRepoReconciler } from '../room-repo-reconciler.js';
import { RoomRepoService } from '../room-repo-service.js';
import { RoomWorktreeManager, roomWorktreeBranch } from '../room-worktree-manager.js';
import { readRoomRepoConfig } from '../room-repo-config.js';
import { DocChannelStore } from '../../../canvas/doc-channel/store.js';
import { createDocChannelHttpComposition } from '../../../canvas/doc-channel/http-composition.js';
import {
  InstallationFileWrites,
  readInstallationFileRoomWrites,
  stopInstallationFileWrites,
  requireInstallationFileWriteAssembly,
  createInstallationOriginalCheckboxWriter,
  requireInstallationOriginalCheckboxWriter,
} from '../../../canvas/doc-channel/writes/installation-file-writes.js';
import { DocCheckboxAuthority } from '../../../canvas/doc-channel/writes/authority.js';
import {
  DocCheckboxWriteService,
  stopOriginalCheckboxWriter,
  recoverOriginalCheckboxWriter,
} from '../../../canvas/doc-channel/writes/checkbox-service.js';
import { DOC_INGEST_LIMITS } from '../../../canvas/doc-channel/current/accounting.js';
import { notifyServiceOriginalCheckboxCommitted } from '../../../canvas/doc-channel/service.js';

// Real FILE database and exact owning HTTP composition. FS observations below
// retain the originally acquired handle; they do not manufacture a room lease.
async function fixture() {
  const dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'room-acquired-maintenance-')));
  let cleanupDb: import('@dorkos/db').Db | undefined;
  let cleanupRooms: ReturnType<typeof createRoomSubsystem> | undefined;
  let cleanupHttp: ReturnType<typeof createDocChannelHttpComposition> | undefined;
  let cleanupReconciler: RoomRepoReconciler | undefined;
  let cleanupOwner: InstallationFileWrites | undefined;
  let cleanupChannels: DocChannelStore | undefined;
  try {
    const opened = openServerDatabase(join(dir, 'db.sqlite'));
    const db = opened.db;
    cleanupDb = db;
    await initBoundary(dir);
    runMigrations(db);
    initConfigManager(dir);
    configManager.set('auth', { ...configManager.get('auth'), enabled: false });
    configManager.set('rooms', {
      ...configManager.get('rooms'),
      repo: { ...configManager.get('rooms').repo, enabled: false },
    });
    initAuth(db, dir);
    const rooms = createRoomSubsystem({ db });
    cleanupRooms = rooms;
    setRoomService(rooms.service);
    const human = rooms.authors.localHuman();
    const room = rooms.service.createRoom(
      { kind: 'channel', agentPaths: [], slug: 'acquired-maintenance', members: [] },
      human.id
    );
    const repos = new RoomRepoStore(db, dir),
      mutex = new RoomRepoMutex(),
      channels = new DocChannelStore(db);
    const owner = new InstallationFileWrites({
      db,
      store: channels,
      roomRepos: repos,
      roomMutex: mutex,
    });
    cleanupOwner = owner;
    cleanupChannels = channels;
    const writer = readInstallationFileRoomWrites(owner, db, channels, repos);
    const binding = {
      owner,
      writer,
      db,
      channels,
      repos,
      mutex,
      rooms: rooms.service,
      roomStore: rooms.store,
    };
    const repoService = new RoomRepoService(
      {
        store: repos,
        mutex,
        queueWaitMs: () => readRoomRepoConfig().mergeQueueWaitMs,
        enabled: () => readRoomRepoConfig().enabled,
        getRoom: (roomId, authorId) => rooms.service.getRoom(roomId, authorId),
        isOwnerAuthor: (authorId) =>
          rooms.authors.isOwner(authorId, readOwnerAccount()?.id ?? null),
        operatorGitName: readOperatorDisplayName,
        caps: () => {
          const config = readRoomRepoConfig();
          return {
            maxFileBytes: config.maxFileBytes,
            maxRepoBytes: config.maxRepoBytes,
            maxRoomMdBytes: config.maxRoomMdBytes,
          };
        },
        maxRoomMdBytes: () => readRoomRepoConfig().maxRoomMdBytes,
        pinRoomMd: (roomId, authorId) => {
          rooms.canvas.open(
            roomId,
            authorId,
            { type: 'file', sourcePath: 'ROOM.md' },
            { pinned: true }
          );
        },
      },
      binding
    );
    const worktrees = new RoomWorktreeManager(
      {
        store: repos,
        hasRepo: (roomId) => repoService.hasRepo(roomId),
        listStrandedWorktrees: (roomId) => repoService.listStrandedWorktrees(roomId),
        reapAfterDays: () => readRoomRepoConfig().worktreeReapDays,
        busyAgentPaths: () => rooms.service.listBusyAgentPaths(),
        now: () => Date.now() + 365 * 24 * 60 * 60 * 1000,
      },
      binding
    );
    const reconciler = new RoomRepoReconciler(repos, 300000, worktrees, binding);
    cleanupReconciler = reconciler;
    const http = createDocChannelHttpComposition({
      db,
      documents: rooms.canvasDocuments,
      rooms: rooms.service,
      roomStore: rooms.store,
      roomRepos: repos,
      approvals: new ApprovalService(db),
      installationId: 'maintenance-fixture',
      roomConstruction: opened.serverNativeRoomConstruction,
      roomRepoReconciler: reconciler,
      roomWorktreeManager: worktrees,
      roomRepoService: repoService,
      owningFileWrites: { channels, fileWrites: owner },
    });
    cleanupHttp = http;
    const metadata = {
      roomId: room.id,
      mode: 'owned' as const,
      createdAt: '2026-10-04T00:00:00.000Z',
      createdBy: human.id,
      defaultBranch: 'main' as const,
      caps: { ...ROOM_REPO_CAP_DEFAULTS },
      lastMergeSeq: null,
    };
    await repos.write(metadata); // Legacy DATA seed, not an original maintenance operation.
    return {
      dir,
      db,
      rooms,
      repos,
      roomId: room.id,
      metadata,
      reconciler,
      binding,
      http,
      worktrees,
    };
  } catch (cause) {
    const drains = await Promise.allSettled(
      [
        () => cleanupReconciler?.stop(),
        () =>
          cleanupHttp
            ? cleanupHttp.stopFileWrites()
            : cleanupOwner && cleanupDb && cleanupChannels
              ? stopInstallationFileWrites(cleanupOwner, cleanupDb, cleanupChannels)
              : undefined,
      ].map((stop) => {
        try {
          return Promise.resolve(stop());
        } catch (error) {
          return Promise.reject(error);
        }
      })
    );
    try {
      cleanupRooms?.service.canvas.dispose();
    } catch {
      /* Preserve the actual setup cause. */
    }
    if (cleanupRooms) clearRoomService(cleanupRooms.service);
    if (drains.every((result) => result.status === 'fulfilled')) {
      let closed = true;
      try {
        cleanupDb?.$client.close();
      } catch {
        closed = false; /* Preserve setup cause and native database directory. */
      }
      if (closed) {
        try {
          await fs.rm(dir, { recursive: true, force: true });
        } catch {
          /* Preserve the actual setup cause. */
        }
      }
    }
    throw cause;
  }
}

const executeFixtureGit = promisify(execFile);
async function fixtureGit(cwd: string, args: string[]) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
  );
  return executeFixtureGit(
    'git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@localhost',
      ...args,
    ],
    {
      cwd,
      env: {
        ...env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
      },
    }
  );
}

async function seedFixtureWorktree(h: Awaited<ReturnType<typeof fixture>>, label = 'idle') {
  const repo = h.repos.repoPath(h.roomId);
  await fs.mkdir(repo, { recursive: true });
  await fixtureGit(h.dir, ['init', '-b', 'main', repo]);
  await fs.writeFile(join(repo, 'kept.txt'), 'committed source\n');
  await fixtureGit(repo, ['add', '--', 'kept.txt']);
  await fixtureGit(repo, ['commit', '-m', 'fixture retained source']);
  const slug = RoomWorktreeManager.slugFor(label, join(h.dir, label));
  const target = join(h.repos.worktreesPath(h.roomId), slug);
  await fs.mkdir(h.repos.worktreesPath(h.roomId), { recursive: true });
  await fixtureGit(repo, ['worktree', 'add', '-b', roomWorktreeBranch(slug), target, 'main']);
  return { repo, slug, target, branch: roomWorktreeBranch(slug) };
}

describe('original owning Room maintenance acquired sidecar', () => {
  let h: Awaited<ReturnType<typeof fixture>>;
  let created = false;
  beforeEach(async () => {
    created = false;
    h = await fixture();
    created = true;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    if (!created) return; // Setup performs its own exact-owner cleanup before rethrowing.
    let failed = false,
      first: unknown;
    const attempt = async (fn: () => unknown) => {
      try {
        await fn();
      } catch (cause) {
        if (!failed) {
          failed = true;
          first = cause;
        }
      }
    };
    await attempt(() => h.reconciler.stop());
    await attempt(() => h.http.stopFileWrites());
    await attempt(() => h.rooms.service.canvas.dispose());
    await attempt(() => clearRoomService(h.rooms.service));
    if (!failed) {
      await attempt(() => h.db.$client.close());
      if (!failed) await attempt(() => fs.rm(h.dir, { recursive: true, force: true }));
    }
    if (failed) throw first;
  });

  function observeAcquired(install: (handle: FileHandle) => void) {
    const open = fs.open.bind(fs);
    const target = h.repos.sidecarPath(h.roomId);
    vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
      const handle = await open(file, flags, mode);
      if (String(file) === target) install(handle);
      return handle;
    });
  }

  function enableReap() {
    configManager.set('rooms', {
      ...configManager.get('rooms'),
      repo: {
        ...configManager.get('rooms').repo,
        enabled: true,
      },
    });
  }

  it('syncs with repo creation disabled using retained FD reads despite public store replacements', async () => {
    await fs.writeFile(
      h.repos.sidecarPath(h.roomId),
      JSON.stringify({ ...h.metadata, lastMergeSeq: 41 })
    );
    const readFile = vi.spyOn(fs, 'readFile');
    const publicRead = vi
      .spyOn(h.repos, 'readSidecar')
      .mockRejectedValue(new Error('public read reached'));
    const publicUpsert = vi.spyOn(h.repos, 'upsertRow').mockImplementation(() => {
      throw new Error('public upsert reached');
    });
    const result = await h.reconciler.reconcile();
    expect(result.synced).toBe(1);
    expect(result.worktrees.reaped).toBe(0);
    expect(publicRead).not.toHaveBeenCalled();
    expect(publicUpsert).not.toHaveBeenCalled();
    expect(
      readFile.mock.calls.some(([file]) => String(file) === h.repos.sidecarPath(h.roomId))
    ).toBe(false);
    expect(h.repos.getRow(h.roomId)?.mode).toBe('owned');
    expect(h.repos.getRow(h.roomId)?.lastMergeSeq).toBe(41);
  });

  it('refuses a second genuine reconciler and preserves unowned stale drafts', async () => {
    const draft = join(h.repos.homeDir(h.roomId), '.unowned.tmp');
    await fs.writeFile(draft, 'historical draft');
    await fs.utimes(draft, new Date(0), new Date(0));
    const second = new RoomRepoReconciler(h.repos, 300000, null, h.binding);
    await expect(second.reconcile()).rejects.toThrow();
    await second.stop();
    expect((await h.reconciler.reconcile()).draftsRemoved).toBe(0);
    expect(await fs.readFile(draft, 'utf8')).toBe('historical draft');
  });

  it('refuses an initially oversized historical sidecar without reading or deleting it', async () => {
    const bytes = Buffer.alloc(65537, 32);
    await fs.writeFile(h.repos.sidecarPath(h.roomId), bytes);
    let reads = 0,
      closes = 0;
    observeAcquired((handle) => {
      const read = handle.read.bind(handle),
        close = handle.close.bind(handle);
      Object.defineProperty(handle, 'read', {
        value: (buffer: Buffer, offset: number, length: number, position: number) => {
          reads++;
          return read(buffer, offset, length, position);
        },
      });
      Object.defineProperty(handle, 'close', {
        value: () => {
          closes++;
          return close();
        },
      });
    });
    await expect(h.reconciler.reconcile()).rejects.toThrow('persistence ceiling');
    expect(reads).toBe(0);
    expect(closes).toBe(1);
    expect(await fs.readFile(h.repos.sidecarPath(h.roomId))).toEqual(bytes);
    expect(h.repos.getRow(h.roomId)?.lastMergeSeq).toBeNull();
  });

  it('refuses growth during acquired reads after at most 64KiB plus one sentinel byte', async () => {
    let bytesRead = 0,
      grew = false;
    observeAcquired((handle) => {
      const read = handle.read.bind(handle);
      Object.defineProperty(handle, 'read', {
        value: async (buffer: Buffer, offset: number, length: number, position: number) => {
          if (!grew) {
            grew = true;
            await fs.appendFile(h.repos.sidecarPath(h.roomId), Buffer.alloc(65537, 32));
          }
          const result = await read(buffer, offset, length, position);
          bytesRead += result.bytesRead;
          return result;
        },
      });
    });
    await expect(h.reconciler.reconcile()).rejects.toThrow('grew beyond');
    expect(bytesRead).toBe(65537);
    expect((await fs.stat(h.repos.sidecarPath(h.roomId))).size).toBeGreaterThan(65536);
    expect(h.repos.getRow(h.roomId)?.lastMergeSeq).toBeNull();
  });

  it('refuses same-inode append observed after EOF before cache publication', async () => {
    let appended = false;
    observeAcquired((handle) => {
      const read = handle.read.bind(handle);
      Object.defineProperty(handle, 'read', {
        value: async (buffer: Buffer, offset: number, length: number, position: number) => {
          const result = await read(buffer, offset, length, position);
          if (result.bytesRead === 0 && !appended) {
            appended = true;
            await fs.appendFile(h.repos.sidecarPath(h.roomId), ' ');
          }
          return result;
        },
      });
    });
    await expect(h.reconciler.reconcile()).rejects.toThrow('changed its acquired file');
    expect(appended).toBe(true);
    expect(h.repos.getRow(h.roomId)?.lastMergeSeq).toBeNull();
  });

  it('refuses invalid UTF8 and retains the exact historical bytes', async () => {
    const bytes = Buffer.from([0x7b, 0xff, 0x7d]);
    await fs.writeFile(h.repos.sidecarPath(h.roomId), bytes);
    await expect(h.reconciler.reconcile()).rejects.toThrow('not valid UTF8');
    expect(await fs.readFile(h.repos.sidecarPath(h.roomId))).toEqual(bytes);
  });

  it('refuses a corrupt schema and a symlink without normalizing or deleting either', async () => {
    const target = h.repos.sidecarPath(h.roomId),
      source = join(h.dir, 'retained-source');
    await fs.writeFile(target, '{"roomId":"different-room"}');
    await expect(h.reconciler.reconcile()).rejects.toThrow();
    expect(await fs.readFile(target, 'utf8')).toBe('{"roomId":"different-room"}');
    await fs.writeFile(source, JSON.stringify(h.metadata));
    await fs.unlink(target);
    await fs.symlink(source, target);
    await expect(h.reconciler.reconcile()).rejects.toThrow();
    expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(source, 'utf8')).toBe(JSON.stringify(h.metadata));
  });

  it('refuses replacement of the acquired parent and preserves both old and replacement files', async () => {
    const home = h.repos.homeDir(h.roomId),
      retained = join(h.dir, 'retained-room-home');
    let changed = false;
    observeAcquired((handle) => {
      const read = handle.read.bind(handle);
      Object.defineProperty(handle, 'read', {
        value: async (buffer: Buffer, offset: number, length: number, position: number) => {
          const result = await read(buffer, offset, length, position);
          if (!changed) {
            changed = true;
            await fs.rename(home, retained);
            await fs.mkdir(home);
            await fs.writeFile(
              h.repos.sidecarPath(h.roomId),
              JSON.stringify({ ...h.metadata, lastMergeSeq: 99 })
            );
          }
          return result;
        },
      });
    });
    await expect(h.reconciler.reconcile()).rejects.toThrow();
    expect(changed).toBe(true);
    expect(JSON.parse(await fs.readFile(join(retained, 'room-repo.json'), 'utf8'))).toEqual(
      h.metadata
    );
    expect(JSON.parse(await fs.readFile(h.repos.sidecarPath(h.roomId), 'utf8')).lastMergeSeq).toBe(
      99
    );
    expect(h.repos.getRow(h.roomId)?.lastMergeSeq).toBeNull();
  });

  it('holds retirement until the actual acquired read closes and refuses new passes', async () => {
    let acquired!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let closed = false,
      stoppingFinished = false;
    observeAcquired((handle) => {
      const read = handle.read.bind(handle),
        close = handle.close.bind(handle);
      let first = true;
      Object.defineProperty(handle, 'read', {
        value: async (buffer: Buffer, offset: number, length: number, position: number) => {
          if (first) {
            first = false;
            acquired();
            await held;
          }
          return read(buffer, offset, length, position);
        },
      });
      Object.defineProperty(handle, 'close', {
        value: async () => {
          await close();
          closed = true;
        },
      });
    });
    const pass = h.reconciler.reconcile();
    let stop: Promise<void> | undefined;
    let failed = false,
      firstCause: unknown;
    try {
      await Promise.race([
        entered,
        pass.then(() => {
          throw new Error('Maintenance completed before acquired read');
        }),
      ]);
      stop = h.reconciler.stop();
      void stop.then(
        () => {
          stoppingFinished = true;
        },
        () => {
          stoppingFinished = true;
        }
      );
      await expect(h.reconciler.reconcile()).rejects.toThrow('stopped');
      expect(stoppingFinished).toBe(false);
      expect(closed).toBe(false);
      expect(h.db.$client.open).toBe(true);
    } catch (cause) {
      failed = true;
      firstCause = cause;
    } finally {
      release();
    }
    const outcomes = await Promise.allSettled([pass, stop ?? h.reconciler.stop()]);
    for (const outcome of outcomes)
      if (outcome.status === 'rejected' && !failed) {
        failed = true;
        firstCause = outcome.reason;
      }
    if (failed) throw firstCause;
    expect(outcomes[0]).toMatchObject({ status: 'fulfilled', value: { synced: 1 } });
    expect(closed).toBe(true);
    expect(h.db.$client.open).toBe(true);
  });

  it('preserves a raw undefined read rejection even when native close also rejects', async () => {
    let closed = false;
    observeAcquired((handle) => {
      const close = handle.close.bind(handle);
      Object.defineProperty(handle, 'read', { value: () => Promise.reject(undefined) });
      Object.defineProperty(handle, 'close', {
        value: async () => {
          await close();
          closed = true;
          throw new Error('later close failure');
        },
      });
    });
    const result = await Promise.allSettled([h.reconciler.reconcile()]);
    expect(result).toEqual([{ status: 'rejected', reason: undefined }]);
    expect(closed).toBe(true);
  });

  it('recognizes only the installation factory child despite a second genuine writer with identical dependencies', async () => {
    const { coordinator } = requireInstallationFileWriteAssembly(
      h.http.fileWrites,
      h.db,
      h.http.channels
    );
    const authority = new DocCheckboxAuthority({
      db: h.db,
      documents: h.rooms.canvasDocuments,
      roomRepos: h.repos,
      rooms: h.rooms.service,
      authorization: h.http.authorization,
      grants: h.http.grants,
      store: h.http.channels,
      installationId: 'maintenance-fixture',
      now: () => new Date(),
    });
    expect(
      requireInstallationOriginalCheckboxWriter(
        h.http.checkboxWriter,
        h.db,
        h.http.channels,
        coordinator
      )
    ).toBeUndefined();
    expect(() =>
      createInstallationOriginalCheckboxWriter(
        h.http.fileWrites,
        h.db,
        h.http.channels,
        authority,
        h.http.service
      )
    ).toThrow();
    const second = new DocCheckboxWriteService(h.db, h.http.channels, coordinator, authority, {
      policyLimits: DOC_INGEST_LIMITS,
      notifyCommitted: () => notifyServiceOriginalCheckboxCommitted(h.http.service),
      service: h.http.service,
    });
    try {
      expect(() =>
        requireInstallationOriginalCheckboxWriter(second, h.db, h.http.channels, coordinator)
      ).toThrow();
    } finally {
      await stopOriginalCheckboxWriter(second);
    }
    expect(h.db.$client.open).toBe(true);
  });

  it('retires the actual captured checkbox child despite public stop replacement and shares the installation drain memo', async () => {
    const publicStop = vi
      .spyOn(h.http.checkboxWriter, 'stop')
      .mockImplementation(() => h.http.stopFileWrites());
    const first = stopInstallationFileWrites(h.http.fileWrites, h.db, h.http.channels);
    const second = stopInstallationFileWrites(h.http.fileWrites, h.db, h.http.channels);
    expect(second).toBe(first);
    await first;
    expect(publicStop).not.toHaveBeenCalled();
    await expect(
      recoverOriginalCheckboxWriter(h.http.checkboxWriter, 'absent-intent')
    ).rejects.toThrow('stopped');
    expect(h.db.$client.open).toBe(true);
  });

  it('reaps a clean aged worktree only through its original HTTP manager and actual own-Git registration', async () => {
    const candidate = await seedFixtureWorktree(h);
    enableReap();
    const publicReap = vi
      .spyOn(h.worktrees, 'reapRoom')
      .mockRejectedValue(new Error('public reap reached'));
    const result = await h.reconciler.reconcile();
    expect(result.synced).toBe(1);
    expect(result.worktrees.reaped).toBe(1);
    expect(publicReap).not.toHaveBeenCalled();
    await expect(fs.lstat(candidate.target)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fixtureGit(candidate.repo, ['show-ref', '--verify', `refs/heads/${candidate.branch}`])
    ).rejects.toThrow();
    expect(await fs.readFile(join(candidate.repo, 'kept.txt'), 'utf8')).toBe('committed source\n');
  });

  it('preserves native dirty work even when its directory and committed HEAD are idle', async () => {
    const candidate = await seedFixtureWorktree(h);
    await fs.writeFile(join(candidate.target, 'kept.txt'), 'uncommitted work\n');
    enableReap();
    const result = await h.reconciler.reconcile();
    expect(result.worktrees.reaped).toBe(0);
    expect(result.worktrees.stranded).toBe(1);
    expect(await fs.readFile(join(candidate.target, 'kept.txt'), 'utf8')).toBe(
      'uncommitted work\n'
    );
    expect(
      (await fixtureGit(candidate.repo, ['show-ref', '--verify', `refs/heads/${candidate.branch}`]))
        .stdout
    ).not.toBe('');
  });

  it('preserves a native clean worktree whose committed work is ahead of main', async () => {
    const candidate = await seedFixtureWorktree(h);
    await fs.writeFile(join(candidate.target, 'kept.txt'), 'committed unmerged work\n');
    await fixtureGit(candidate.target, ['add', '--', 'kept.txt']);
    await fixtureGit(candidate.target, ['commit', '-m', 'fixture unmerged work']);
    enableReap();
    const result = await h.reconciler.reconcile();
    expect(result.worktrees.reaped).toBe(0);
    expect(result.worktrees.stranded).toBe(1);
    expect(await fs.readFile(join(candidate.target, 'kept.txt'), 'utf8')).toBe(
      'committed unmerged work\n'
    );
    expect(
      (await fixtureGit(candidate.repo, ['show-ref', '--verify', `refs/heads/${candidate.branch}`]))
        .stdout
    ).not.toBe('');
  });

  it('preserves a real foreign registered worktree placed under the Room worktree directory', async () => {
    const own = await seedFixtureWorktree(h);
    const foreignRepo = join(h.dir, 'foreign-repo');
    await fs.mkdir(foreignRepo);
    await fixtureGit(h.dir, ['init', '-b', 'main', foreignRepo]);
    await fs.writeFile(join(foreignRepo, 'foreign.txt'), 'foreign committed source\n');
    await fixtureGit(foreignRepo, ['add', '--', 'foreign.txt']);
    await fixtureGit(foreignRepo, ['commit', '-m', 'fixture foreign source']);
    const slug = RoomWorktreeManager.slugFor('foreign', join(h.dir, 'foreign'));
    const target = join(h.repos.worktreesPath(h.roomId), slug);
    await fixtureGit(foreignRepo, [
      'worktree',
      'add',
      '-b',
      roomWorktreeBranch(slug),
      target,
      'main',
    ]);
    enableReap();
    const result = await h.reconciler.reconcile();
    expect(result.worktrees.reaped).toBe(1); // Only the genuine own registration.
    expect(result.worktrees.stranded).toBe(1);
    await expect(fs.lstat(own.target)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(join(target, 'foreign.txt'), 'utf8')).toBe(
      'foreign committed source\n'
    );
    expect((await fixtureGit(foreignRepo, ['worktree', 'list', '--porcelain'])).stdout).toContain(
      target
    );
  });

  it('refreshes the cache with repo creation disabled without deleting an otherwise eligible native worktree', async () => {
    const candidate = await seedFixtureWorktree(h);
    await fs.writeFile(
      h.repos.sidecarPath(h.roomId),
      JSON.stringify({ ...h.metadata, lastMergeSeq: 41 })
    );
    const result = await h.reconciler.reconcile();
    expect(result.synced).toBe(1);
    expect(result.worktrees.reaped).toBe(0);
    expect(h.repos.getRow(h.roomId)?.lastMergeSeq).toBe(41);
    expect(await fs.readFile(join(candidate.target, 'kept.txt'), 'utf8')).toBe(
      'committed source\n'
    );
    expect(
      (await fixtureGit(candidate.repo, ['show-ref', '--verify', `refs/heads/${candidate.branch}`]))
        .stdout
    ).not.toBe('');
  });

  it('refuses a changed original native cache row before removal and preserves the changed row', async () => {
    const candidate = await seedFixtureWorktree(h);
    enableReap();
    let changed = false,
      acquisitions = 0;
    observeAcquired((handle) => {
      acquisitions++;
      if (acquisitions !== 2) return; // SAME-context private reap reread, after cache upsert.
      const read = handle.read.bind(handle);
      Object.defineProperty(handle, 'read', {
        value: async (buffer: Buffer, offset: number, length: number, position: number) => {
          const result = await read(buffer, offset, length, position);
          if (!changed) {
            changed = true;
            h.db.$client
              .prepare('UPDATE room_repos SET last_merge_seq=99 WHERE room_id=?')
              .run(h.roomId);
          }
          return result;
        },
      });
    });
    await expect(h.reconciler.reconcile()).rejects.toThrow();
    expect(changed).toBe(true);
    expect(h.repos.getRow(h.roomId)?.lastMergeSeq).toBe(99);
    expect(await fs.readFile(join(candidate.target, 'kept.txt'), 'utf8')).toBe(
      'committed source\n'
    );
    expect(
      (await fixtureGit(candidate.repo, ['show-ref', '--verify', `refs/heads/${candidate.branch}`]))
        .stdout
    ).not.toBe('');
  });
});
