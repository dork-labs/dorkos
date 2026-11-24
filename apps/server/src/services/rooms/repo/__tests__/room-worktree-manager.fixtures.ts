/**
 * One standing working copy per (room, agent), and the reap that must never
 * take one that holds work (spec `project-rooms` §3.4).
 *
 * Real git on a real temporary DorkOS home that sits
 * INSIDE another git repository — the dev layout, which is also the trap
 * layout: without a discovery ceiling every question asked in a room worktree
 * is answered by the enclosing checkout instead.
 *
 * Seeded defects, each run red before the code stood:
 *
 * - Dropping the `stranded` gate from `reapRoom` reddens BOTH "spares a dirty
 *   worktree" and "spares a clean worktree that main has not got" — the two
 *   tests `config.rooms.repo.worktreeReapDays`'s no-risk verdict rests on.
 *   Measured: the dirty tree is deleted along with its file, and the unmerged
 *   one is deleted along with its commit.
 * - Dropping the digest from `slugFor` reddens "two agents with one name get
 *   two worktrees".
 * - Branching unconditionally (`-b` always) reddens "re-attaches a branch the
 *   reap left behind".
 * - Dropping the directory stamp reddens "refreshes the idle clock".
 * - Dropping the busy gate reddens "SPARES AN ANCIENT WORKTREE ITS AGENT IS
 *   WORKING IN".
 * - Deleting a legacy file without the seeder's unmodified-stamp check reddens
 *   "keeps a modified skill"; removing the block without asking every worktree
 *   reddens "keeps the block while ANOTHER worktree still holds what it hides".
 *
 * **Idle is driven by an injected clock, never by aged mtimes.** An earlier
 * version of this suite made a worktree "ancient" by writing its file mtimes
 * forty days into the past, then read them back. That was doubly fragile: the
 * reap's own git reads could refresh a worktree's index mtime to "now" on a
 * slow runner (a real bug, since fixed by dropping the index as a source), and
 * the backdating itself raced a real `git`. Instead the manager's clock is
 * injectable, and {@link makeAncient} advances IT past the cap. No worktree's
 * real mtime is ever moved, so nothing the sweep does to a timestamp can change
 * the answer — which is the property the production fix guarantees too.
 *
 * @module server/services/rooms/repo/__tests__/room-worktree-manager.fixtures
 */

import { beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createTestDb } from '@dorkos/test-utils/db';
import { rooms, type Db } from '@dorkos/db';
import type { Room } from '@dorkos/shared/room-schemas';
import { ROOM_REPO_CAP_DEFAULTS } from '@dorkos/shared/room-repo';
import { RoomRepoStore } from '../room-repo-store.js';
import { RoomRepoService } from '../room-repo-service.js';
import { RoomRepoMutex } from '../room-repo-mutex.js';
import { RoomWorktreeManager } from '../room-worktree-manager.js';
import { runGit } from '../room-repo-git.js';
import { removeFixtureTree, silenceGitAutoMaintenance } from './fixture-git.js';

export const ROOM_ID = '01ROOMAAAAAAAAAAAAAAAAAAAA';
export const OPERATOR = 'author-operator';

export const ROOM: Room = {
  id: ROOM_ID,
  kind: 'channel',
  slug: 'release-train',
  title: 'Release train',
  topic: 'Shipping 0.70',
  archived: false,
  ambientMaxEntries: 20,
  createdAt: '2026-08-27T12:00:00.000Z',
  lastActivityAt: '2026-08-27T12:00:00.000Z',
};

/** What the manager reads on every call, which tests change between steps. */
export const knobs = {
  reapAfterDays: 14,
  busyAgentPaths: [] as string[],
  nowMs: 0,
  busyAgentPathsReader: (): string[] => [],
  strandedDuringSweep: (): Promise<void> => Promise.resolve(),
};
export let db: Db;
export let scratch: string;
export let store: RoomRepoStore;
export let service: RoomRepoService;
export let manager: RoomWorktreeManager;
/** `config.rooms.repo.worktreeReapDays`, per test. */
/** The agent workspace paths holding a live room claim, per test. */
/** The manager's injected clock (epoch ms). Advance it to age a worktree. */
/**
 * How the sweep reads that list — replaceable, so a test can make the answer
 * CHANGE between reads.
 *
 * The claim map is live in production: the sweep snapshots it once and then
 * spends real time removing trees, and a turn can claim anywhere in there.
 * Defaults to simply reporting {@link knobs.busyAgentPaths}, which is what every
 * test but the race one wants.
 */
/**
 * Something that happens DURING the sweep, hung off the stranded-list read.
 *
 * That read is the sweep's own mid-flight moment: it runs after every gate has
 * been snapshotted and before the first removal, which is precisely the window
 * a turn can claim in. A no-op for every test but the two race ones.
 */

/** Run git in `dir` with the room's home as the discovery ceiling. */
export function git(args: string[], dir: string): Promise<string> {
  return runGit(args, dir, store.homeDir(ROOM_ID));
}

/**
 * A manager over this test's store and service.
 *
 * A function rather than an inline literal in `beforeEach` because a SECOND
 * one is how a restart is expressed: everything the manager remembers between
 * turns — the in-flight map, the set of worktrees whose skill pack it has
 * already checked — lives in the instance, so a fresh instance over the same
 * disk is exactly the state a restarted server wakes up in.
 */
export function makeManager(): RoomWorktreeManager {
  return new RoomWorktreeManager({
    store,
    hasRepo: (roomId) => service.hasRepo(roomId),
    listStrandedWorktrees: async (roomId) => {
      const answer = await service.listStrandedWorktrees(roomId);
      await knobs.strandedDuringSweep();
      return answer;
    },
    reapAfterDays: () => knobs.reapAfterDays,
    busyAgentPaths: () => knobs.busyAgentPathsReader(),
    now: () => knobs.nowMs,
  });
}

/** Where agent `name` keeps its work — the workspace path is its identity. */
export function agentPath(name: string): string {
  return path.join(scratch, 'agents', name);
}

/** Give `name` its worktree and answer where it is. */
export async function worktreeFor(name: string): Promise<string> {
  const handle = await manager.ensureWorktree(ROOM_ID, agentPath(name), name);
  return handle.path;
}

/** Milliseconds in a day. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Make everything already on disk look idle, by moving the reap's clock
 * forward `days` — never by touching a single mtime.
 *
 * The advance dwarfs the seconds a test actually takes, so every real mtime
 * (all `<= real now`) sits far below the cutoff (`injected now - reapDays`).
 * That is the whole point: nothing the sweep does to a timestamp can pull a
 * worktree back across the line, because the line is days away.
 */
export function makeAncient(days = 40): void {
  knobs.nowMs = Date.now() + days * DAY_MS;
}

/**
 * Give `name` a worktree and then make it look ancient.
 *
 * The shape the reap is supposed to tidy away — and the shape every gate
 * above the idle clock has to survive.
 */
export async function ancientWorktree(name: string, days = 40): Promise<string> {
  const dir = await worktreeFor(name);
  makeAncient(days);
  return dir;
}

/**
 * Build a fresh DorkOS home inside an enclosing git repository before each
 * test, and tear it down after. Call once inside each suite's `describe`.
 */
export function useWorktreeWorld(): void {
  beforeEach(async () => {
    db = createTestDb();
    // Before anything makes a repo: keep git's detached maintenance child from
    // racing this suite's teardown into the directory. See `fixture-git.ts`.
    silenceGitAutoMaintenance();
    // The DorkOS home sits inside a git repository on purpose — see the header.
    scratch = await mkdtemp(path.join(tmpdir(), 'dorkos-room-worktree-'));
    await runGit(['init', '-b', 'main', '--quiet', '.'], scratch, scratch);
    await writeFile(path.join(scratch, '.gitignore'), '*\n', 'utf-8');
    await runGit(['add', '-f', '.gitignore'], scratch, scratch);
    await runGit(
      [
        '-c',
        'user.name=Enclosing',
        '-c',
        'user.email=e@dorkos.local',
        'commit',
        '-q',
        '-m',
        'base',
      ],
      scratch,
      scratch
    );
    const dorkHome = path.join(scratch, '.dork');
    await mkdir(dorkHome, { recursive: true });
    store = new RoomRepoStore(db, dorkHome);
    knobs.reapAfterDays = 14;
    knobs.busyAgentPaths = [];
    knobs.nowMs = Date.now();
    knobs.busyAgentPathsReader = () => knobs.busyAgentPaths;
    knobs.strandedDuringSweep = () => Promise.resolve();
    db.insert(rooms)
      .values({
        id: ROOM_ID,
        kind: 'channel',
        title: ROOM.title,
        topic: ROOM.topic,
        createdAt: ROOM.createdAt,
        lastActivityAt: ROOM.lastActivityAt,
      })
      .run();
    service = new RoomRepoService({
      store,
      mutex: new RoomRepoMutex(),
      queueWaitMs: () => 5000,
      enabled: () => true,
      getRoom: () => ROOM,
      isOwnerAuthor: (authorId) => authorId === OPERATOR,
      operatorGitName: () => 'Dorian',
      getAuthor: () => null,
      pinRoomMd: () => {},
      caps: () => ({ ...ROOM_REPO_CAP_DEFAULTS }),
      maxRoomMdBytes: () => ROOM_REPO_CAP_DEFAULTS.maxRoomMdBytes,
    });
    manager = makeManager();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await removeFixtureTree(scratch);
  });
}
