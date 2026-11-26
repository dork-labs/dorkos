/**
 * Shared setup for `room-merge-service.test.ts`: a real room repo, real agent
 * worktrees and a real merge service on a temporary DorkOS home that sits
 * inside another git repository, with only the room's own service stood in.
 * The suite's rationale is on the test file.
 *
 * The world is rebuilt per test; read it through these live bindings, and move
 * what a test changes through {@link knobs}.
 *
 * @module server/services/rooms/repo/__tests__/room-merge-service.fixtures
 */
import { beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createTestDb } from '@dorkos/test-utils/db';
import { rooms, type Db } from '@dorkos/db';
import type { Room, RoomEntry } from '@dorkos/shared/room-schemas';
import { ROOM_REPO_CAP_DEFAULTS, type RoomRepoCaps } from '@dorkos/shared/room-repo';
import { RoomError } from '../../room-errors.js';
import { RoomRepoStore } from '../room-repo-store.js';
import { RoomRepoService } from '../room-repo-service.js';
import { RoomRepoMutex } from '../room-repo-mutex.js';
import { RoomWorktreeManager } from '../room-worktree-manager.js';
import { roomWorktreeSlug } from '../../../core/room-worktree-name/room-worktree-name.js';
import { RoomMergeService } from '../room-merge-service.js';
import { runGit } from '../room-repo-git.js';
import { removeFixtureTree, silenceGitAutoMaintenance } from './fixture-git.js';

/** The one room every test works in. */
export const ROOM_ID = '01ROOMAAAAAAAAAAAAAAAAAAAA';
/** The install owner, a person. */
export const OPERATOR = 'author-operator';
/** Agent Ana's author id. */
export const ANA = 'author-ana';
/** Agent Ben's author id. */
export const BEN = 'author-ben';

const ROOM: Room = {
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

/** What the fake room log recorded. */
export interface Announcement {
  text: string;
  merge: { branch: string; commit: string; files: number; insertions: number; deletions: number };
  subjectAuthorId: string;
}

/** What the room's stand-in answers, which tests change between steps. Reset per test. */
export const knobs = {
  /** Who may see the room; anybody else is answered as "no such room". */
  members: [] as string[],
  /** `config.rooms.repo.enabled`, per test. */
  enabled: true,
  /** The room, so a test can archive it. */
  room: { ...ROOM },
  /** The caps a NEW binding is created under, per test. */
  caps: { ...ROOM_REPO_CAP_DEFAULTS } as RoomRepoCaps,
};

/** The test's database. */
export let db: Db;
/** The enclosing git repository the DorkOS home sits in. */
export let scratch: string;
/** The room repo store. */
export let store: RoomRepoStore;
/** The room repo service (enable, stranded worktrees). */
export let repos: RoomRepoService;
/** The agents' working copies. */
export let worktrees: RoomWorktreeManager;
/** The service under test. */
export let merges: RoomMergeService;
/** The per-room queue merges and enables share. */
export let mutex: RoomRepoMutex;
/** Everything the room was told, oldest first. */
export let announced: Announcement[];
/** The next `seq` the fake room log hands out. */
let nextSeq: number;

/** Run git in `dir` with the room's home as the discovery ceiling. */
export function git(args: string[], dir: string): Promise<string> {
  return runGit(args, dir, store.homeDir(ROOM_ID));
}

/** Where agent `name` keeps its work — the workspace path is its identity. */
export function agentPath(name: string): string {
  return path.join(scratch, 'agents', name);
}

/** The agents on the room's roster, by author id. */
const roster: Record<string, { name: string; displayName: string }> = {
  [ANA]: { name: 'ana', displayName: 'Ana' },
  [BEN]: { name: 'ben', displayName: 'Ben' },
};

/** The worktree slug one agent takes. */
export function slugOf(authorId: string): string {
  const agent = roster[authorId];
  if (!agent) throw new Error(`no such agent ${authorId}`);
  return roomWorktreeSlug(agent.displayName, agentPath(agent.name));
}

/** Give an agent its working copy and answer where it is. */
export async function worktreeFor(authorId: string): Promise<string> {
  const agent = roster[authorId];
  if (!agent) throw new Error(`no such agent ${authorId}`);
  const handle = await worktrees.ensureWorktree(ROOM_ID, agentPath(agent.name), agent.displayName);
  return handle.path;
}

/** Write a file in an agent's working copy and commit it there. */
export async function commitIn(
  authorId: string,
  file: string,
  contents: string,
  message = 'work'
): Promise<string> {
  const dir = await worktreeFor(authorId);
  await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
  await writeFile(path.join(dir, file), contents, 'utf-8');
  await git(['add', '--all'], dir);
  await git(
    ['-c', 'user.name=Agent', '-c', 'user.email=a@dorkos.local', 'commit', '-q', '-m', message],
    dir
  );
  return dir;
}

/** The refusal a call made, or a failure saying it made none. */
export async function refusalOf(call: Promise<unknown>): Promise<RoomError> {
  try {
    await call;
  } catch (err) {
    if (err instanceof RoomError) return err;
    throw err;
  }
  throw new Error('expected a refusal, and the call succeeded');
}

/** Give the room files, as the operator would. */
export async function enableRepo(): Promise<void> {
  await repos.enable(ROOM_ID, OPERATOR);
}

/**
 * Build a fresh DorkOS home inside an enclosing git repository before each
 * test, and tear it down after. Call once inside the suite's `describe`.
 */
export function useMergeWorld(): void {
  beforeEach(async () => {
    db = createTestDb();
    // Before anything makes a repo: keep git's detached maintenance child from
    // racing this suite's teardown into the directory. See `fixture-git.ts`.
    silenceGitAutoMaintenance();
    // The DorkOS home sits inside a git repository on purpose — see the test's header.
    scratch = await mkdtemp(path.join(tmpdir(), 'dorkos-room-merge-'));
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
    mutex = new RoomRepoMutex();
    announced = [];
    knobs.members = [OPERATOR, ANA, BEN];
    knobs.enabled = true;
    knobs.room = { ...ROOM };
    knobs.caps = { ...ROOM_REPO_CAP_DEFAULTS };
    nextSeq = 1;

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

    repos = new RoomRepoService({
      store,
      mutex,
      queueWaitMs: () => 5000,
      enabled: () => knobs.enabled,
      getRoom: () => knobs.room,
      isOwnerAuthor: (authorId) => authorId === OPERATOR,
      operatorGitName: () => 'Dorian',
      getAuthor: () => null,
      pinRoomMd: () => {},
      caps: () => knobs.caps,
      maxRoomMdBytes: () => ROOM_REPO_CAP_DEFAULTS.maxRoomMdBytes,
    });
    worktrees = new RoomWorktreeManager({
      store,
      hasRepo: (roomId) => repos.hasRepo(roomId),
      listStrandedWorktrees: (roomId) => repos.listStrandedWorktrees(roomId),
      reapAfterDays: () => 14,
      busyAgentPaths: () => [],
    });
    merges = new RoomMergeService({
      store,
      mutex,
      enabled: () => knobs.enabled,
      mergeQueueWaitMs: () => 5000,
      requireMembership: (_roomId, authorId) => {
        // The real service answers "not a member" exactly as "no such room".
        if (!knobs.members.includes(authorId)) {
          throw new RoomError('ROOM_NOT_FOUND', 'No such room');
        }
        return knobs.room;
      },
      listAgentMembers: (_roomId) =>
        knobs.members
          .filter((authorId) => roster[authorId])
          .map((authorId) => ({
            authorId,
            agentPath: agentPath(roster[authorId]!.name),
            displayName: roster[authorId]!.displayName,
          })),
      listStrandedWorktrees: (roomId) => repos.listStrandedWorktrees(roomId),
      announce: (_roomId, input) => {
        announced.push(input);
        return { seq: nextSeq++ } as RoomEntry;
      },
      isOwnerAuthor: (authorId) => authorId === OPERATOR,
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await removeFixtureTree(scratch);
  });
}
