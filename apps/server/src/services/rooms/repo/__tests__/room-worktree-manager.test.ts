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
 * - Returning early on sight of the block's marker — what the write did before
 *   its list could change — reddens "brings a stale exclude block up to date":
 *   a repo whose first worktree predates an addition keeps the old block, and
 *   whatever the new line hides makes every worktree dirty again.
 * - Matching the block on its current FIRST LINE rather than on the version-free
 *   sentinel reddens the same test the other way: the previous release's block
 *   is not found, a second one is appended, and the file carries two.
 * - Dropping the digest from `slugFor` reddens "two agents with one name get
 *   two worktrees".
 * - Branching unconditionally (`-b` always) reddens "re-attaches a branch the
 *   reap left behind".
 * - Dropping the directory stamp reddens "refreshes the idle clock".
 * - Dropping the busy gate reddens "SPARES AN ANCIENT WORKTREE ITS AGENT IS
 *   WORKING IN".
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
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, promises as nodeFsPromises } from 'node:fs';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createTestDb } from '@dorkos/test-utils/db';
import { rooms, type Db } from '@dorkos/db';
import type { Room } from '@dorkos/shared/room-schemas';
import { ROOM_REPO_CAP_DEFAULTS } from '@dorkos/shared/room-repo';
import { RoomError } from '../../room-errors.js';
import { RoomRepoStore } from '../room-repo-store.js';
import { RoomRepoService } from '../room-repo-service.js';
import { RoomRepoMutex } from '../room-repo-mutex.js';
import { RoomRepoReconciler } from '../room-repo-reconciler.js';
import { RoomWorktreeManager } from '../room-worktree-manager.js';
import { PROJECTED_ATTACHMENTS_ROOT } from '../../attachments/attachment-paths.js';
import {
  commitAll,
  commonGitDir,
  hasLocalBranch,
  removeWorktree,
  runGit,
} from '../room-repo-git.js';
import { removeFixtureTree, silenceGitAutoMaintenance } from './fixture-git.js';

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
  /** The manager's injected clock (epoch ms). Advance it to age a worktree. */
  let nowMs: number;
  /**
   * How the sweep reads that list — replaceable, so a test can make the answer
   * CHANGE between reads.
   *
   * The claim map is live in production: the sweep snapshots it once and then
   * spends real time removing trees, and a turn can claim anywhere in there.
   * Defaults to simply reporting {@link busyAgentPaths}, which is what every
   * test but the race one wants.
   */
  let busyAgentPathsReader: () => string[];
  /**
   * Something that happens DURING the sweep, hung off the stranded-list read.
   *
   * That read is the sweep's own mid-flight moment: it runs after every gate has
   * been snapshotted and before the first removal, which is precisely the window
   * a turn can claim in. A no-op for every test but the two race ones.
   */
  let strandedDuringSweep: () => Promise<void>;

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

  /** Milliseconds in a day. */
  const DAY_MS = 24 * 60 * 60 * 1000;

  /**
   * Make everything already on disk look idle, by moving the reap's clock
   * forward `days` — never by touching a single mtime.
   *
   * The advance dwarfs the seconds a test actually takes, so every real mtime
   * (all `<= real now`) sits far below the cutoff (`injected now - reapDays`).
   * That is the whole point: nothing the sweep does to a timestamp can pull a
   * worktree back across the line, because the line is days away.
   */
  function makeAncient(days = 40): void {
    nowMs = Date.now() + days * DAY_MS;
  }

  /**
   * Give `name` a worktree and then make it look ancient.
   *
   * The shape the reap is supposed to tidy away — and the shape every gate
   * above the idle clock has to survive.
   */
  async function ancientWorktree(name: string, days = 40): Promise<string> {
    const dir = await worktreeFor(name);
    makeAncient(days);
    return dir;
  }

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
    reapAfterDays = 14;
    busyAgentPaths = [];
    nowMs = Date.now();
    busyAgentPathsReader = () => busyAgentPaths;
    strandedDuringSweep = () => Promise.resolve();
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
      caps: () => ({ ...ROOM_REPO_CAP_DEFAULTS }),
      maxRoomMdBytes: () => ROOM_REPO_CAP_DEFAULTS.maxRoomMdBytes,
    });
    manager = new RoomWorktreeManager({
      store,
      hasRepo: (roomId) => service.hasRepo(roomId),
      listStrandedWorktrees: async (roomId) => {
        const answer = await service.listStrandedWorktrees(roomId);
        await strandedDuringSweep();
        return answer;
      },
      reapAfterDays: () => reapAfterDays,
      busyAgentPaths: () => busyAgentPathsReader(),
      now: () => nowMs,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await removeFixtureTree(scratch);
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

    it('brings a stale exclude block up to date, found by its version-free sentinel', async () => {
      // Two bugs in one fixture, and the fixture is the point: this writes the
      // block EXACTLY as the shipped version before DOR-1597 wrote it, prose and
      // all. An earlier version of this test invented a marker line that no
      // release ever produced, so it pinned a state nothing could reach and
      // stayed green through the very defect it was written for.
      //
      // Matching on the current first line cannot find that block, so the writer
      // appends a second one and the file is left with an orphaned old block
      // nothing will ever update or remove — while `/.dork/.temp/` sits only in
      // the new one and the old one goes on hiding nothing. Hence a sentinel
      // that survives the prose being reworded.
      await service.enable(ROOM_ID, OPERATOR);
      const repoDir = store.repoPath(ROOM_ID);
      const infoDir = path.join(await commonGitDir(repoDir, store.homeDir(ROOM_ID)), 'info');
      await mkdir(infoDir, { recursive: true });
      await writeFile(
        path.join(infoDir, 'exclude'),
        [
          '# somebody’s own line, above',
          '/scratch/',
          // The REAL marker the previous release shipped — verbatim.
          '# --- DorkOS: harness projection output, not anybody’s work (room-worktree-manager.ts) ---',
          '/.claude/skills/',
          '/.agents/harness.manifest.json',
          '# --- end DorkOS ---',
          '# somebody’s own line, below',
          '/notes.local.md',
          '',
        ].join('\n'),
        'utf-8'
      );

      const handle = await manager.ensureWorktree(ROOM_ID, agentPath('ana'), 'Ana');

      const exclude = await readFile(path.join(infoDir, 'exclude'), 'utf-8');
      // Exactly ONE block — the old one was replaced, not orphaned beside a new
      // one. This is the assertion the invented-marker fixture could not make.
      expect(exclude.match(/--- DorkOS:/g)).toHaveLength(1);
      // …it is the current one…
      expect(exclude).toContain('/.dork/.temp/');
      expect(exclude).not.toContain('harness projection output');
      // …and everything that was not ours survives, on both sides.
      expect(exclude).toContain('# somebody’s own line, above');
      expect(exclude).toContain('/scratch/');
      expect(exclude).toContain('# somebody’s own line, below');
      expect(exclude).toContain('/notes.local.md');

      // The point of all of it: an attachment projected into the tree leaves it
      // reading clean.
      await mkdir(path.join(handle.path, PROJECTED_ATTACHMENTS_ROOT, 'entry-1'), {
        recursive: true,
      });
      await writeFile(
        path.join(handle.path, PROJECTED_ATTACHMENTS_ROOT, 'entry-1', 'notes.txt'),
        'the notes',
        'utf-8'
      );
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
      // cwd rung landed this method IS how a turn learns where to run, and a
      // turn that only READS its worktree moves no timestamp of its own. The
      // sibling test 'removes a genuinely ancient working copy at the SHIPPED
      // default' is this one's control — same fixture, same setting, and it is
      // reaped when nothing hands the path out first. The only difference here
      // is the extra `ensureWorktree`, whose stamp writes `now()` onto the
      // directory and pulls it back inside the window.
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

  describe('turnFilesContext', () => {
    it('is null for a room with no files of its own', async () => {
      // No repo, no section: a conversation-only room renders a context
      // byte-identical to the one it rendered before this field existed.
      await expect(
        manager.turnFilesContext(ROOM_ID, agentPath('ana'), 'Ana', '/anywhere')
      ).resolves.toBeNull();
    });

    it('names both trees and measures the branch against main', async () => {
      await service.enable(ROOM_ID, OPERATOR);
      const handle = await manager.ensureWorktree(ROOM_ID, agentPath('ana'), 'Ana');

      const files = await manager.turnFilesContext(ROOM_ID, agentPath('ana'), 'Ana', handle.path);

      expect(files).toEqual({
        // The caller's directory verbatim: the section must describe the tree
        // the turn is standing in, never one rebuilt here.
        worktreePath: handle.path,
        branch: handle.branch,
        repoPath: store.repoPath(ROOM_ID),
        behind: 0,
        ahead: 0,
      });
    });

    it('counts the commits each side has that the other has not', async () => {
      await service.enable(ROOM_ID, OPERATOR);
      const handle = await manager.ensureWorktree(ROOM_ID, agentPath('ana'), 'Ana');
      await writeFile(path.join(handle.path, 'mine.md'), 'mine', 'utf-8');
      await commitAll(
        handle.path,
        'mine',
        { name: 'Ana', email: 'ana@dorkos.local' },
        store.homeDir(ROOM_ID)
      );
      // And the room moves on without her.
      const repoDir = store.repoPath(ROOM_ID);
      await writeFile(path.join(repoDir, 'theirs.md'), 'theirs', 'utf-8');
      await commitAll(
        repoDir,
        'theirs',
        { name: 'Bo', email: 'bo@dorkos.local' },
        store.homeDir(ROOM_ID)
      );

      await expect(
        manager.turnFilesContext(ROOM_ID, agentPath('ana'), 'Ana', handle.path)
      ).resolves.toMatchObject({ ahead: 1, behind: 1 });
    });

    it('still says where the agent works when git cannot answer', async () => {
      // DEGRADES rather than disappearing (DOR-1599 review). Here the branch does
      // not exist, so `rev-list main...room/<slug>` fails — but the paths and the
      // branch name are derived, not measured, so the one-writer prohibition the
      // block builds on them survives. Nulling the whole section would drop that
      // rule exactly when the repo is in a state nobody understands.
      await service.enable(ROOM_ID, OPERATOR);

      const files = await manager.turnFilesContext(
        ROOM_ID,
        agentPath('ana'),
        'Ana',
        '/where/the/turn/runs'
      );

      expect(files).toMatchObject({
        worktreePath: '/where/the/turn/runs',
        repoPath: store.repoPath(ROOM_ID),
        // Not zero. "Not measured" and "level with the room" must never collapse:
        // an agent told it is up to date when nothing checked edits without
        // syncing.
        behind: null,
        ahead: null,
      });
      expect(files?.branch).toMatch(/^room\//);
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
      makeAncient();

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
      // The control for the spare-because-busy and refresh-the-clock tests:
      // same fixture, same 14-day cap, and with nothing protecting it the idle
      // tree is reaped. This is also the regression guard for the load bug —
      // the reap's idle clock no longer reads any mtime the sweep can perturb,
      // so a genuinely idle tree is removed however slow the runner.
      await service.enable(ROOM_ID, OPERATOR);
      const dir = await ancientWorktree('ana');
      reapAfterDays = 14;

      const swept = await manager.reapRoom(ROOM_ID);

      expect(swept.reaped).toEqual([path.basename(dir)]);
      expect(existsSync(dir)).toBe(false);
    });

    it('never consults the git index for the idle decision', async () => {
      // The production fix — the reap's idle clock must not read the git index
      // mtime, so a sweep's `git status` (which rewrites that mtime to `now`)
      // cannot spare an idle tree. Proven DETERMINISTICALLY: earlier real-clock
      // versions of this guard aged the worktree's real mtimes and read them
      // back, and that coupling flaked on CI's loaded filesystem no matter how
      // the aging was ordered. So this asks the question a different way, with
      // no real mtime in the answer at all:
      //
      // - idle is driven by the injected clock (`makeAncient`), so the tree is
      //   reaped without a single backdated mtime;
      // - discrimination is a stat SPY. The index of a linked worktree lives at
      //   `<repo>/.git/worktrees/<slug>/index`. The dating path's only stats are
      //   `lstat`s on the worktree directory and its direct children — never
      //   anything under `.git`. Re-add the index as a source and the reap must
      //   `lstat` that path; the spy would catch it and this assertion reddens.
      await service.enable(ROOM_ID, OPERATOR);
      const handle = await manager.ensureWorktree(ROOM_ID, agentPath('ana'), 'Ana');
      // The hazard, made real: stamp the worktree index `now`, the way any sweep
      // git op does. Its mtime must simply never be looked at.
      await git(['status', '--porcelain=v1'], handle.path);
      makeAncient();
      reapAfterDays = 14;

      const statted: string[] = [];
      const realLstat = nodeFsPromises.lstat;
      vi.spyOn(nodeFsPromises, 'lstat').mockImplementation((async (target, opts) => {
        statted.push(String(target));
        return realLstat(target, opts);
      }) as typeof nodeFsPromises.lstat);

      const swept = await manager.reapRoom(ROOM_ID);
      vi.restoreAllMocks();

      // The idle decision still fires — the tree is gone.
      expect(swept.reaped).toEqual([handle.slug]);
      expect(existsSync(handle.path)).toBe(false);
      // The spy actually saw the dating pass (the worktree dir is statted by
      // the path ending in its slug) — without this, a production move off
      // `promises.lstat` would empty `statted` and fail the guard OPEN.
      expect(statted.some((p) => p.endsWith(handle.slug))).toBe(true);
      // And it never touched a git-index file to get there. The regex matches
      // an `index` file anywhere under a `.git` (the worktree's, at
      // `.git/worktrees/<slug>/index`, or a bare `.git/index`), and is immune to
      // the `/var` -> `/private/var` symlink that a literal prefix compare is not.
      const hits = statted.filter((p) => /[/\\]\.git[/\\](?:.*[/\\])?index$/.test(p));
      if (hits.length)
        console.error('INDEX-HITS', JSON.stringify(hits), 'TOTAL-STATS', statted.length);
      expect(hits).toEqual([]);
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

    it('spares a worktree whose agent claims a turn WHILE the sweep is running', async () => {
      // The snapshot race, reproduced. Every gate above the removal is decided
      // from one snapshot taken before the sweep's first `await`, and the sweep
      // then spans many of them — a `git status` per candidate, a stranded-list
      // walk, a `git log` per tree. A turn that claims inside that window was
      // not in `busyAgentPaths` when it was read and its `utimes` stamp was not
      // in `dated`, so the tree it is standing in was deleted underneath it —
      // and the attachment projector, which runs next, recreated the directory
      // as something that is not a checkout.
      //
      // Driven through the claim map's own reader: the sweep takes ONE snapshot
      // of it, and the turn arrives immediately afterwards. Every later read
      // sees the claim, so a sweep that only ever consults its snapshot deletes
      // a directory that is in use by the time it gets there.
      await service.enable(ROOM_ID, OPERATOR);
      const dir = await ancientWorktree('ana');
      reapAfterDays = 14;
      // Nobody is working when the sweep takes its snapshot; the turn claims
      // the instant it has.
      let reads = 0;
      busyAgentPathsReader = () => {
        reads += 1;
        return reads === 1 ? [] : [agentPath('ana')];
      };

      const swept = await manager.reapRoom(ROOM_ID);

      expect(swept.reaped).toEqual([]);
      expect(swept.spared).toEqual([path.basename(dir)]);
      // The whole point: the live turn's working directory is still a checkout.
      expect(existsSync(dir)).toBe(true);
      expect(existsSync(path.join(dir, '.git'))).toBe(true);
    });

    it('spares a worktree a READ-ONLY turn claimed mid-sweep, on the stamp alone', async () => {
      // The half the claim map cannot cover on its own, and the reason the
      // re-check re-stats the DIRECTORY rather than re-asking `lastTouchedAt`:
      // a turn that only thinks and reads writes nothing git can see, so
      // `ensureWorktree`'s stamp on the directory is the only trace it leaves.
      // Here the claim is already released by the time the removals run — the
      // turn was short — so that stamp is all there is left to save it.
      await service.enable(ROOM_ID, OPERATOR);
      const dir = await ancientWorktree('ana');
      reapAfterDays = 14;
      busyAgentPaths = [];
      let ran = false;
      strandedDuringSweep = async () => {
        if (ran) return;
        ran = true;
        // A whole turn: resolve the cwd, read nothing, release the claim.
        await manager.ensureWorktree(ROOM_ID, agentPath('ana'), 'ana');
      };

      const swept = await manager.reapRoom(ROOM_ID);

      expect(swept.spared).toEqual([path.basename(dir)]);
      expect(existsSync(path.join(dir, '.git'))).toBe(true);
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
      const dir = await worktreeFor('ana');
      const slug = path.basename(dir);
      // A commit main does not have — real "now", so it is genuinely ahead. The
      // idle clock is advanced past the cap AFTER the commit, so the tree still
      // reads ancient; this is simulating a commit the stranded list MISSED, not
      // one the idle clock should have caught.
      await writeFile(path.join(dir, 'late.md'), 'committed after the list', 'utf-8');
      await commitAll(
        dir,
        'late',
        { name: 'Ana', email: 'ana@dorkos.local' },
        store.homeDir(ROOM_ID)
      );
      makeAncient();
      const blind = new RoomWorktreeManager({
        store,
        hasRepo: (roomId) => service.hasRepo(roomId),
        listStrandedWorktrees: async () => [],
        reapAfterDays: () => 14,
        busyAgentPaths: () => [],
        now: () => nowMs,
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
      reapAfterDays = 14;
      makeAncient();

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
