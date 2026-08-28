/**
 * One standing working copy per (room, agent), and the reap that must never
 * take one that holds work (spec `project-rooms` §3.4).
 *
 * Real git, real harness projection, on a real temporary DorkOS home that sits
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
 * - Dropping the `info/exclude` write reddens "a projected worktree still reads
 *   clean": the generated `.claude/skills/` link and harness manifest make
 *   every worktree permanently dirty, hence permanently un-reapable.
 * - Dropping the digest from `slugFor` reddens "two agents with one name get
 *   two worktrees".
 * - Branching unconditionally (`-b` always) reddens "re-attaches a branch the
 *   reap left behind".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createTestDb } from '@dorkos/test-utils/db';
import { rooms, type Db } from '@dorkos/db';
import type { Room } from '@dorkos/shared/room-schemas';
import { ROOM_REPO_CAP_DEFAULTS } from '@dorkos/shared/room-repo';
import { RoomError } from '../../room-errors.js';
import { RoomRepoStore } from '../room-repo-store.js';
import { RoomRepoService } from '../room-repo-service.js';
import { RoomRepoReconciler } from '../room-repo-reconciler.js';
import { RoomWorktreeManager } from '../room-worktree-manager.js';
import {
  absoluteGitDir,
  commitAll,
  hasLocalBranch,
  removeWorktree,
  runGit,
} from '../room-repo-git.js';

const ROOM_ID = '01ROOMAAAAAAAAAAAAAAAAAAAA';
const OPERATOR = 'author-operator';

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

describe('RoomWorktreeManager', () => {
  let db: Db;
  let scratch: string;
  let store: RoomRepoStore;
  let service: RoomRepoService;
  let manager: RoomWorktreeManager;
  /** `config.rooms.repo.worktreeReapDays`, per test. */
  let reapAfterDays: number;
  /** The agent workspace paths holding a live room claim, per test. */
  let busyAgentPaths: string[];

  /** Run git in `dir` with the room's home as the discovery ceiling. */
  function git(args: string[], dir: string): Promise<string> {
    return runGit(args, dir, store.homeDir(ROOM_ID));
  }

  /** Where agent `name` keeps its work — the workspace path is its identity. */
  function agentPath(name: string): string {
    return path.join(scratch, 'agents', name);
  }

  /** Give `name` its worktree and answer where it is. */
  async function worktreeFor(name: string): Promise<string> {
    const handle = await manager.ensureWorktree(ROOM_ID, agentPath(name), name);
    return handle.path;
  }

  /** Milliseconds in a day, for the ageing helpers. */
  const DAY_MS = 24 * 60 * 60 * 1000;

  /**
   * Push main's tip commit date into the past.
   *
   * `lastTouchedAt` reads HEAD's committer date, and a worktree branched from a
   * repo created seconds ago can never look idle. Amending on MAIN rather than
   * in the worktree matters: amending in the worktree would leave it holding a
   * commit main has not got, which the stranded gate catches first and would
   * make every ageing test pass for the wrong reason.
   */
  async function ageRepoMain(days: number): Promise<void> {
    const when = new Date(Date.now() - days * DAY_MS).toISOString();
    vi.stubEnv('GIT_COMMITTER_DATE', when);
    vi.stubEnv('GIT_AUTHOR_DATE', when);
    try {
      await git(['commit', '--amend', '--no-edit', '--quiet'], store.repoPath(ROOM_ID));
    } finally {
      vi.unstubAllEnvs();
    }
  }

  /** Backdate every mtime `lastTouchedAt` reads in one worktree. */
  async function ageWorktree(dir: string, days: number): Promise<void> {
    const when = new Date(Date.now() - days * DAY_MS);
    const gitDir = await absoluteGitDir(dir, store.homeDir(ROOM_ID));
    for (const name of await readdir(dir)) {
      await utimes(path.join(dir, name), when, when).catch(() => undefined);
    }
    await utimes(path.join(gitDir, 'index'), when, when).catch(() => undefined);
    await utimes(dir, when, when);
  }

  /**
   * A worktree that every date source says has sat untouched for `days`.
   *
   * The shape the reap is supposed to tidy away — and the shape every gate
   * above the date has to survive.
   */
  async function ancientWorktree(name: string, days = 40): Promise<string> {
    await ageRepoMain(days);
    const dir = await worktreeFor(name);
    await ageWorktree(dir, days);
    return dir;
  }

  beforeEach(async () => {
    db = createTestDb();
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
    reapAfterDays = 14;
    busyAgentPaths = [];
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
      enabled: () => true,
      getRoom: () => ROOM,
      isOwnerAuthor: (authorId) => authorId === OPERATOR,
      operatorGitName: () => 'Dorian',
      caps: () => ({ ...ROOM_REPO_CAP_DEFAULTS }),
      maxRoomMdBytes: () => ROOM_REPO_CAP_DEFAULTS.maxRoomMdBytes,
    });
    manager = new RoomWorktreeManager({
      store,
      hasRepo: (roomId) => service.hasRepo(roomId),
      listStrandedWorktrees: (roomId) => service.listStrandedWorktrees(roomId),
      reapAfterDays: () => reapAfterDays,
      busyAgentPaths: () => busyAgentPaths,
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(scratch, { recursive: true, force: true });
  });

  describe('slugFor', () => {
    it('is filesystem-safe whatever the agent is called', () => {
      const slug = RoomWorktreeManager.slugFor('../../etc/passwd', '/tmp/a');
      expect(slug).toMatch(/^[a-z][a-z0-9-]*-[0-9a-f]{8}$/);
      expect(path.basename(slug)).toBe(slug);
    });

    it('keeps a name that is nothing but punctuation from becoming an empty path', () => {
      expect(RoomWorktreeManager.slugFor('...', '/tmp/a')).toMatch(/^agent-[0-9a-f]{8}$/);
    });

    it('gives two agents with one name two different worktrees', () => {
      // The collision case, and why the digest is unconditional: a suffix added
      // only on collision would depend on who arrived first, and would change
      // under the survivor when the other agent was deleted.
      const ana = RoomWorktreeManager.slugFor('Ana', '/agents/ana');
      const other = RoomWorktreeManager.slugFor('ana', '/agents/ana-the-second');
      expect(ana).not.toBe(other);
      expect(ana.startsWith('ana-')).toBe(true);
      expect(other.startsWith('ana-')).toBe(true);
    });

    it('is the same answer every time for the same agent, however its path is spelled', () => {
      expect(RoomWorktreeManager.slugFor('Ana', '/agents/ana')).toBe(
        RoomWorktreeManager.slugFor('Ana', '/agents/./ana/')
      );
    });
  });

  describe('ensureWorktree', () => {
    it('refuses a room that has no files of its own', async () => {
      await expect(worktreeFor('ana')).rejects.toThrow(RoomError);
      await expect(worktreeFor('ana')).rejects.toMatchObject({ code: 'NOT_A_PROJECT_ROOM' });
    });

    it('branches room/<slug> off main and checks it out under worktrees/', async () => {
      await service.enable(ROOM_ID, OPERATOR);

      const handle = await manager.ensureWorktree(ROOM_ID, agentPath('ana'), 'Ana');

      expect(handle.created).toBe(true);
      expect(handle.path).toBe(path.join(store.worktreesPath(ROOM_ID), handle.slug));
      expect(handle.branch).toBe(`room/${handle.slug}`);
      expect(await git(['rev-parse', '--abbrev-ref', 'HEAD'], handle.path)).toBe(handle.branch);
      // It starts from main's tip, so ROOM.md is there and nothing is unmerged.
      expect(existsSync(path.join(handle.path, 'ROOM.md'))).toBe(true);
      expect(await git(['rev-list', '--count', 'main..HEAD'], handle.path)).toBe('0');
    });

    it('is idempotent: the second call answers the same tree and creates nothing', async () => {
      await service.enable(ROOM_ID, OPERATOR);
      const first = await manager.ensureWorktree(ROOM_ID, agentPath('ana'), 'Ana');
      await writeFile(path.join(first.path, 'wip.md'), 'half an idea', 'utf-8');

      const second = await manager.ensureWorktree(ROOM_ID, agentPath('ana'), 'Ana');

      expect(second.created).toBe(false);
      expect(second.path).toBe(first.path);
      // Uncommitted work survives — that is the whole point of a STANDING tree.
      expect(await readFile(path.join(second.path, 'wip.md'), 'utf-8')).toBe('half an idea');
    });

    it('creates one tree when two turns ask at the same moment', async () => {
      await service.enable(ROOM_ID, OPERATOR);

      const [a, b] = await Promise.all([
        manager.ensureWorktree(ROOM_ID, agentPath('ana'), 'Ana'),
        manager.ensureWorktree(ROOM_ID, agentPath('ana'), 'Ana'),
      ]);

      expect(a.path).toBe(b.path);
      expect(existsSync(a.path)).toBe(true);
    });

    it('gives two agents in one room two trees on two branches', async () => {
      await service.enable(ROOM_ID, OPERATOR);
      const ana = await manager.ensureWorktree(ROOM_ID, agentPath('ana'), 'Ana');
      const bo = await manager.ensureWorktree(ROOM_ID, agentPath('bo'), 'Bo');

      expect(ana.path).not.toBe(bo.path);
      expect(await git(['rev-parse', '--abbrev-ref', 'HEAD'], ana.path)).toBe(ana.branch);
      expect(await git(['rev-parse', '--abbrev-ref', 'HEAD'], bo.path)).toBe(bo.branch);
    });

    it('re-attaches a branch the reap left behind rather than failing forever', async () => {
      // `git worktree remove` takes the directory and leaves the branch, and a
      // `git branch -d` can refuse or never run. `-b` would then fail on every
      // later turn for that agent, permanently.
      await service.enable(ROOM_ID, OPERATOR);
      const first = await manager.ensureWorktree(ROOM_ID, agentPath('ana'), 'Ana');
      await git(['worktree', 'remove', first.path], store.repoPath(ROOM_ID));
      expect(await hasLocalBranch(store.repoPath(ROOM_ID), first.branch, store.homeDir(ROOM_ID)));

      const again = await manager.ensureWorktree(ROOM_ID, agentPath('ana'), 'Ana');

      expect(again.created).toBe(true);
      expect(again.branch).toBe(first.branch);
      expect(await git(['rev-parse', '--abbrev-ref', 'HEAD'], again.path)).toBe(first.branch);
    });

    it('projects the room’s own skills where Claude Code reads them, without dirtying the tree', async () => {
      // Spec §3.8: a room repo carries `.agents/skills/` like any project, and
      // claude-code — the default runtime — only sees `.claude/skills/`.
      await service.enable(ROOM_ID, OPERATOR);
      const repoDir = store.repoPath(ROOM_ID);
      await mkdir(path.join(repoDir, '.agents', 'skills', 'house-style'), { recursive: true });
      await writeFile(
        path.join(repoDir, '.agents', 'skills', 'house-style', 'SKILL.md'),
        '# house style\n',
        'utf-8'
      );
      await commitAll(repoDir, 'add a skill', { name: 'D', email: 'd@dorkos.local' }, scratch);

      const handle = await manager.ensureWorktree(ROOM_ID, agentPath('ana'), 'Ana');

      expect(handle.projection?.status).toBe('projected');
      expect(
        existsSync(path.join(handle.path, '.claude', 'skills', 'house-style', 'SKILL.md'))
      ).toBe(true);
      // And the tree the agent works in still reads clean, so the reap can tell
      // "nothing here" from "somebody's unsaved work" and §3.6's merge gate is
      // not blocked by DorkOS's own output.
      expect(await git(['status', '--porcelain=v1'], handle.path)).toBe('');
    });

    it('heals a directory that is not a checkout instead of handing it back forever', async () => {
      // The wedge: a creation that died part-way leaves a directory with no
      // `.git` in it. Returning it as valid was permanent — the reap lists an
      // unreadable directory as stranded work and never removes it, so nothing
      // could ever repair the thing this method kept answering with.
      await service.enable(ROOM_ID, OPERATOR);
      const slug = RoomWorktreeManager.slugFor('Ana', agentPath('ana'));
      const corpse = path.join(store.worktreesPath(ROOM_ID), slug);
      await mkdir(corpse, { recursive: true });
      await writeFile(path.join(corpse, 'half-written.md'), 'from the crash', 'utf-8');

      const handle = await manager.ensureWorktree(ROOM_ID, agentPath('ana'), 'Ana');

      expect(handle.created).toBe(true);
      expect(handle.path).toBe(corpse);
      expect(existsSync(path.join(corpse, '.git'))).toBe(true);
      expect(await git(['rev-parse', '--abbrev-ref', 'HEAD'], corpse)).toBe(handle.branch);
      // And the contents were moved aside, never deleted: nothing here knows
      // why that directory had files in it.
      const aside = (await readdir(store.worktreesPath(ROOM_ID))).find((n) =>
        n.startsWith(`${slug}.orphaned-`)
      );
      expect(aside).toBeDefined();
      expect(
        await readFile(path.join(store.worktreesPath(ROOM_ID), aside!, 'half-written.md'), 'utf-8')
      ).toBe('from the crash');
    });

    it('gives two callers racing on a half-made directory one real checkout each', async () => {
      // PROBE-B, made deterministic: the directory is already there and is NOT
      // a checkout, which is exactly what the second caller of a creation still
      // in flight would see. With the existence check ahead of the in-flight
      // map, that caller took the early return and handed a turn a path with no
      // `.git` in it.
      await service.enable(ROOM_ID, OPERATOR);
      const slug = RoomWorktreeManager.slugFor('Ana', agentPath('ana'));
      await mkdir(path.join(store.worktreesPath(ROOM_ID), slug), { recursive: true });

      const [a, b] = await Promise.all([
        manager.ensureWorktree(ROOM_ID, agentPath('ana'), 'Ana'),
        manager.ensureWorktree(ROOM_ID, agentPath('ana'), 'Ana'),
      ]);

      expect(a.path).toBe(b.path);
      for (const handle of [a, b]) {
        expect(handle.created).toBe(true);
        expect(existsSync(path.join(handle.path, '.git'))).toBe(true);
      }
      expect(await git(['rev-parse', '--abbrev-ref', 'HEAD'], a.path)).toBe(a.branch);
    });

    it('refreshes the idle clock every time it hands the path out', async () => {
      // The reap's first line of defence, and the reason it is needed: once the
      // cwd rung lands this method IS how a turn learns where to run, and a
      // turn that only READS its worktree moves no timestamp of its own. The
      // sibling test 'removes a genuinely ancient working copy at the SHIPPED
      // default' is this one's control — same fixture, same setting, and it is
      // reaped when nothing hands the path out first.
      //
      // Asserted through the REAP rather than through `worktreeStatus`,
      // deliberately: reading the status runs `git status`, which refreshes the
      // index and would refresh the clock all by itself. The observable that
      // matters is whether the directory survives.
      await service.enable(ROOM_ID, OPERATOR);
      const dir = await ancientWorktree('ana');
      reapAfterDays = 14;

      await manager.ensureWorktree(ROOM_ID, agentPath('ana'), 'Ana');
      const swept = await manager.reapRoom(ROOM_ID);

      expect(swept.reaped).toEqual([]);
      expect(swept.spared).toEqual([path.basename(dir)]);
      expect(existsSync(dir)).toBe(true);
    });
  });

  describe('worktreeStatus', () => {
    it('is null for a worktree that was never made', async () => {
      await service.enable(ROOM_ID, OPERATOR);
      await expect(manager.worktreeStatus(ROOM_ID, 'nobody-00000000')).resolves.toBeNull();
    });

    it('reports a fresh tree as clean, merged and touched just now', async () => {
      await service.enable(ROOM_ID, OPERATOR);
      const handle = await manager.ensureWorktree(ROOM_ID, agentPath('ana'), 'Ana');

      const status = await manager.worktreeStatus(ROOM_ID, handle.slug);

      expect(status).toMatchObject({ slug: handle.slug, dirty: false, aheadOfMain: 0 });
      expect(Date.now() - new Date(status!.lastTouchedAt).getTime()).toBeLessThan(60_000);
    });

    it('reports uncommitted edits and unmerged commits', async () => {
      await service.enable(ROOM_ID, OPERATOR);
      const handle = await manager.ensureWorktree(ROOM_ID, agentPath('ana'), 'Ana');
      await writeFile(path.join(handle.path, 'done.md'), 'finished', 'utf-8');
      await commitAll(
        handle.path,
        'work',
        { name: 'Ana', email: 'ana@dorkos.local' },
        store.homeDir(ROOM_ID)
      );
      await writeFile(path.join(handle.path, 'wip.md'), 'half an idea', 'utf-8');

      await expect(manager.worktreeStatus(ROOM_ID, handle.slug)).resolves.toMatchObject({
        dirty: true,
        aheadOfMain: 1,
      });
    });
  });

  describe('the reap', () => {
    it('SPARES A DIRTY WORKTREE, at any setting of worktreeReapDays', async () => {
      // The claim `config.rooms.repo.worktreeReapDays`'s no-risk verdict rests
      // on. Zero idle days is the most aggressive setting the code can be
      // given — more aggressive than the schema's minimum of 1 — so a tree that
      // survives THIS survives every real configuration.
      await service.enable(ROOM_ID, OPERATOR);
      const dir = await worktreeFor('ana');
      await writeFile(path.join(dir, 'wip.md'), 'half an idea', 'utf-8');
      reapAfterDays = 0;

      const swept = await manager.reapRoom(ROOM_ID);

      expect(swept.reaped).toEqual([]);
      expect(swept.stranded).toEqual([path.basename(dir)]);
      expect(existsSync(path.join(dir, 'wip.md'))).toBe(true);
      expect(await readFile(path.join(dir, 'wip.md'), 'utf-8')).toBe('half an idea');
    });

    it('SPARES A CLEAN WORKTREE MAIN HAS NOT GOT, at any setting of worktreeReapDays', async () => {
      // The other half of the same claim: `git status` says nothing is wrong
      // here, and the tree still holds a commit that would be lost.
      await service.enable(ROOM_ID, OPERATOR);
      const dir = await worktreeFor('bo');
      await writeFile(path.join(dir, 'done.md'), 'finished, unmerged', 'utf-8');
      const sha = await commitAll(
        dir,
        'work',
        { name: 'Bo', email: 'bo@dorkos.local' },
        store.homeDir(ROOM_ID)
      );
      expect(await git(['status', '--porcelain=v1'], dir)).toBe('');
      reapAfterDays = 0;

      const swept = await manager.reapRoom(ROOM_ID);

      expect(swept.reaped).toEqual([]);
      expect(swept.stranded).toEqual([path.basename(dir)]);
      expect(existsSync(dir)).toBe(true);
      expect(await git(['rev-parse', 'HEAD'], dir)).toBe(sha);
    });

    it('would be refused by git even if the stranded gate were wrong about a dirty tree', async () => {
      // The third gate, asked directly. `reapRoom` never reaches it for a dirty
      // worktree — the stranded list catches that first — so it is pinned here
      // instead: `git worktree remove` WITHOUT `--force` refuses a tree holding
      // work, at a later moment than DorkOS's own check. That is what protects
      // an agent that started typing between the two.
      await service.enable(ROOM_ID, OPERATOR);
      const dir = await worktreeFor('ana');
      await writeFile(path.join(dir, 'wip.md'), 'half an idea', 'utf-8');

      await expect(
        removeWorktree(store.repoPath(ROOM_ID), dir, store.homeDir(ROOM_ID))
      ).rejects.toThrow(/contains modified or untracked files/);
      expect(existsSync(path.join(dir, 'wip.md'))).toBe(true);
    });

    it('spares a directory git cannot read at all', async () => {
      await service.enable(ROOM_ID, OPERATOR);
      const junk = path.join(store.worktreesPath(ROOM_ID), 'mystery');
      await mkdir(junk, { recursive: true });
      await writeFile(path.join(junk, 'notes.md'), 'not a checkout', 'utf-8');
      reapAfterDays = 0;

      const swept = await manager.reapRoom(ROOM_ID);

      expect(swept.reaped).toEqual([]);
      expect(swept.stranded).toContain('mystery');
      expect(existsSync(path.join(junk, 'notes.md'))).toBe(true);
    });

    it('removes a clean, merged, idle working copy and retires its branch', async () => {
      await service.enable(ROOM_ID, OPERATOR);
      const handle = await manager.ensureWorktree(ROOM_ID, agentPath('ana'), 'Ana');
      reapAfterDays = 0;

      const swept = await manager.reapRoom(ROOM_ID);

      expect(swept.reaped).toEqual([handle.slug]);
      expect(existsSync(handle.path)).toBe(false);
      // The branch goes with it — `git branch -d`, so a branch main did not
      // contain would have survived regardless.
      await expect(
        hasLocalBranch(store.repoPath(ROOM_ID), handle.branch, store.homeDir(ROOM_ID))
      ).resolves.toBe(false);
      // And git's own bookkeeping matches the disk again.
      expect(await git(['worktree', 'list', '--porcelain'], store.repoPath(ROOM_ID))).not.toContain(
        handle.slug
      );
    });

    it('keeps a working copy that was touched inside the idle window', async () => {
      await service.enable(ROOM_ID, OPERATOR);
      const handle = await manager.ensureWorktree(ROOM_ID, agentPath('ana'), 'Ana');

      const swept = await manager.reapRoom(ROOM_ID);

      expect(swept.reaped).toEqual([]);
      expect(swept.spared).toEqual([handle.slug]);
      expect(existsSync(handle.path)).toBe(true);
    });

    it('removes nothing while room files are switched off', async () => {
      await service.enable(ROOM_ID, OPERATOR);
      const handle = await manager.ensureWorktree(ROOM_ID, agentPath('ana'), 'Ana');
      reapAfterDays = 0;
      const offManager = new RoomWorktreeManager({
        store,
        hasRepo: () => false,
        listStrandedWorktrees: (roomId) => service.listStrandedWorktrees(roomId),
        reapAfterDays: () => 0,
        busyAgentPaths: () => [],
      });

      await expect(offManager.reapRoom(ROOM_ID)).resolves.toEqual({
        reaped: [],
        reapedTreeKeptBranch: [],
        spared: [],
        stranded: [],
      });
      expect(existsSync(handle.path)).toBe(true);
    });

    it('removes a genuinely ancient working copy at the SHIPPED default', async () => {
      // The control for everything below, and the test the M5 ordering fix is
      // for: `listStrandedWorktrees` runs `git status` in every candidate, and
      // a status refresh rewrites that worktree's index — one of the four
      // sources the idle clock reads. Dated afterwards, this tree looks touched
      // seconds ago and is spared forever.
      await service.enable(ROOM_ID, OPERATOR);
      const dir = await ancientWorktree('ana');
      reapAfterDays = 14;

      const swept = await manager.reapRoom(ROOM_ID);

      expect(swept.reaped).toEqual([path.basename(dir)]);
      expect(existsSync(dir)).toBe(false);
    });

    it('SPARES AN ANCIENT WORKTREE ITS AGENT IS WORKING IN RIGHT NOW', async () => {
      // Forty days idle, clean, merged, and the cwd of a live turn. Nothing the
      // filesystem can say distinguishes this from the test above — a turn that
      // reads its worktree and has not written yet moves no timestamp — so the
      // claim map is the only thing standing between the sweep and a running
      // turn's working directory.
      await service.enable(ROOM_ID, OPERATOR);
      const dir = await ancientWorktree('ana');
      reapAfterDays = 14;
      busyAgentPaths = [agentPath('ana')];

      const swept = await manager.reapRoom(ROOM_ID);

      expect(swept.reaped).toEqual([]);
      expect(swept.spared).toEqual([path.basename(dir)]);
      expect(existsSync(dir)).toBe(true);
    });

    it('is not fooled by another agent being busy', async () => {
      // The busy gate matches on the digest half of the worktree name, which is
      // the only join available between a directory and an agent path. A
      // different agent's claim must not spare this one.
      await service.enable(ROOM_ID, OPERATOR);
      const dir = await ancientWorktree('ana');
      reapAfterDays = 14;
      busyAgentPaths = [agentPath('somebody-else')];

      await expect(manager.reapRoom(ROOM_ID)).resolves.toMatchObject({
        reaped: [path.basename(dir)],
      });
    });

    it('reports a removal whose branch survived as its own outcome, not as reaped', async () => {
      // The commit-between-list-and-removal window, forced open by a stranded
      // list that lies. It cannot happen for real — the idle clock reads HEAD's
      // committer date AFTER the stranded list, and `worktreeReapDays` is
      // .min(1) — but if it ever did, "tidied away" would be a false summary of
      // a branch that is still sitting there.
      await service.enable(ROOM_ID, OPERATOR);
      const dir = await ancientWorktree('ana');
      const slug = path.basename(dir);
      await writeFile(path.join(dir, 'late.md'), 'committed after the list', 'utf-8');
      // Backdated so the tree still reads idle: this is simulating a commit the
      // stranded list MISSED, not one the idle clock should have caught. A
      // commit made at the real "now" is spared by gate 3, which is precisely
      // the by-design closure the module doc describes.
      vi.stubEnv('GIT_COMMITTER_DATE', new Date(Date.now() - 40 * DAY_MS).toISOString());
      await commitAll(
        dir,
        'late',
        { name: 'Ana', email: 'ana@dorkos.local' },
        store.homeDir(ROOM_ID)
      );
      vi.unstubAllEnvs();
      await ageWorktree(dir, 40);
      const blind = new RoomWorktreeManager({
        store,
        hasRepo: (roomId) => service.hasRepo(roomId),
        listStrandedWorktrees: async () => [],
        reapAfterDays: () => 14,
        busyAgentPaths: () => [],
      });

      const swept = await blind.reapRoom(ROOM_ID);

      expect(swept.reaped).toEqual([]);
      expect(swept.reapedTreeKeptBranch).toEqual([slug]);
      // Nothing was lost: the commits are still on the branch.
      await expect(
        hasLocalBranch(store.repoPath(ROOM_ID), `room/${slug}`, store.homeDir(ROOM_ID))
      ).resolves.toBe(true);
    });

    it('is nothing at all for a room that never had files', async () => {
      await expect(manager.reapRoom(ROOM_ID)).resolves.toEqual({
        reaped: [],
        reapedTreeKeptBranch: [],
        spared: [],
        stranded: [],
      });
    });
  });

  describe('the sweep that runs it', () => {
    it('reaps through the reconciler, so the install has one pass and one guard', async () => {
      await service.enable(ROOM_ID, OPERATOR);
      const idle = await manager.ensureWorktree(ROOM_ID, agentPath('ana'), 'Ana');
      const busy = await manager.ensureWorktree(ROOM_ID, agentPath('bo'), 'Bo');
      await writeFile(path.join(busy.path, 'wip.md'), 'half an idea', 'utf-8');
      reapAfterDays = 0;

      const result = await new RoomRepoReconciler(store, undefined, manager).reconcile();

      expect(result.worktrees).toEqual({
        reaped: 1,
        reapedTreeKeptBranch: 0,
        spared: 0,
        stranded: 1,
      });
      expect(existsSync(idle.path)).toBe(false);
      expect(existsSync(busy.path)).toBe(true);
    });

    it('leaves the worktrees of a room whose binding has gone alone', async () => {
      // An orphaned home is reported and left standing (the reconciler's own
      // rule); its working copies are not the sweep's to reclaim either.
      await service.enable(ROOM_ID, OPERATOR);
      const handle = await manager.ensureWorktree(ROOM_ID, agentPath('ana'), 'Ana');
      await rm(store.sidecarPath(ROOM_ID), { force: true });
      reapAfterDays = 0;

      const result = await new RoomRepoReconciler(store, undefined, manager).reconcile();

      expect(result.worktrees).toEqual({
        reaped: 0,
        reapedTreeKeptBranch: 0,
        spared: 0,
        stranded: 0,
      });
      expect(existsSync(handle.path)).toBe(true);
    });
  });
});
