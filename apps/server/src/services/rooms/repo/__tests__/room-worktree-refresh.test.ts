/**
 * The turn-start refresh of an agent's copy of a room's files, and the "what
 * moved on main" heads-up (spec `agent-home-desk` §6, §11 "Refresh" and
 * "Heads-up"; ADR 260926-180308).
 *
 * Real git in a temporary room for every case, because every claim here is
 * about what git does to files on disk — including the two it does silently
 * with exit 0 (an ignored file `main` now tracks is overwritten; ignored files
 * under a folder `main` turns into a file are deleted). Each held reason was
 * seen red with its guard removed from `room-worktree-refresh.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createTestDb } from '@dorkos/test-utils/db';
import { rooms, type Db } from '@dorkos/db';
import type { Room } from '@dorkos/shared/room-schemas';
import type { RoomContextFiles } from '@dorkos/shared/additional-context';
import { ROOM_REPO_CAP_DEFAULTS } from '@dorkos/shared/room-repo';
import { RoomRepoStore } from '../room-repo-store.js';
import { RoomRepoService } from '../room-repo-service.js';
import { RoomRepoMutex } from '../room-repo-mutex.js';
import { RoomWorktreeManager } from '../room-worktree-manager.js';
import { resolveRoomTurnPlace, roomTurnLaunchStep } from '../room-turn-place.js';
import {
  afterFailedWrite,
  firstCollision,
  pathsCollide,
  refreshRoomWorktree,
  type RoomWorktreeRefreshDeps,
  type RoomWorktreeRefreshTarget,
} from '../room-worktree-refresh.js';
import { removeFixtureTree, silenceGitAutoMaintenance } from './fixture-git.js';

const ROOM_ID = '01ROOMREFRESHAAAAAAAAAAAAA';
const OPERATOR = 'author-operator';
const ROOM: Room = {
  id: ROOM_ID,
  kind: 'channel',
  slug: 'release-train',
  title: 'Release train',
  topic: null,
  archived: false,
  ambientMaxEntries: 20,
  createdAt: '2026-09-26T12:00:00.000Z',
  lastActivityAt: '2026-09-26T12:00:00.000Z',
};

/** Plain git, as a person's or an agent's own shell runs it. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'user.name=Hand', '-c', 'user.email=hand@example.com', ...args],
      {
        cwd,
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
        },
      },
      (err, stdout, stderr) => (err ? reject(new Error(`${stderr}`)) : resolve(stdout.trim()))
    );
  });
}

describe('the turn-start refresh', () => {
  let db: Db;
  let scratch: string;
  let store: RoomRepoStore;
  let service: RoomRepoService;
  let manager: RoomWorktreeManager;
  let ana: string;
  let repo: string;
  let copy: string;
  let target: RoomWorktreeRefreshTarget;
  let forgotten: string[];
  let named: Map<string, { kind: 'merge' | 'person'; who: string | null }>;

  function deps(overrides: Partial<RoomWorktreeRefreshDeps> = {}): RoomWorktreeRefreshDeps {
    return {
      stillIdle: () => Promise.resolve(true),
      describeCommits: (shas) => new Map([...named].filter(([sha]) => shas.includes(sha))),
      forgetMoved: (absPaths) => forgotten.push(...absPaths),
      ...overrides,
    };
  }

  /** Commit files on the room's `main`, as a hand commit would; answers the sha. */
  async function onMain(
    files: Record<string, string | null>,
    message: string,
    opts: { force?: boolean } = {}
  ): Promise<string> {
    for (const [name, content] of Object.entries(files)) {
      const abs = path.join(repo, name);
      if (content === null) {
        await git(repo, 'rm', '-q', '-r', '--', name);
        continue;
      }
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content, 'utf-8');
      await git(repo, 'add', ...(opts.force ? ['-f'] : []), '--', name);
    }
    await git(repo, 'commit', '-q', '-m', message);
    return git(repo, 'rev-parse', 'HEAD');
  }

  async function headOf(dir: string): Promise<string> {
    return git(dir, 'rev-parse', 'HEAD');
  }

  beforeEach(async () => {
    db = createTestDb();
    silenceGitAutoMaintenance();
    scratch = realpathSync(await mkdtemp(path.join(tmpdir(), 'dorkos-room-refresh-')));
    const dorkHome = path.join(scratch, '.dork');
    await mkdir(dorkHome, { recursive: true });
    ana = path.join(scratch, 'agents', 'ana');
    await mkdir(ana, { recursive: true });
    store = new RoomRepoStore(db, dorkHome);
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
      pinRoomMd: () => {},
      caps: () => ({ ...ROOM_REPO_CAP_DEFAULTS }),
      maxRoomMdBytes: () => ROOM_REPO_CAP_DEFAULTS.maxRoomMdBytes,
    });
    manager = new RoomWorktreeManager({
      store,
      hasRepo: (roomId) => service.hasRepo(roomId),
      listStrandedWorktrees: (roomId) => service.listStrandedWorktrees(roomId),
      reapAfterDays: () => 14,
      busyAgentPaths: () => [],
    });
    await service.enable(ROOM_ID, OPERATOR);
    repo = store.repoPath(ROOM_ID);
    const place = await resolveRoomTurnPlace(manager, ROOM_ID, ana, 'Ana');
    copy = place.worktree!;
    target = manager.refreshTarget(ROOM_ID, copy)!;
    forgotten = [];
    named = new Map();
  });

  afterEach(async () => {
    await removeFixtureTree(scratch);
  });

  describe('when nothing in the copy could be lost', () => {
    it('answers current when the copy is already at main`s tip', async () => {
      const { outcome } = await refreshRoomWorktree(target, deps());
      expect(outcome).toEqual({ kind: 'current' });
    });

    it('fast-forwards a clean copy to main and names the files that moved', async () => {
      const before = await headOf(copy);
      const tip = await onMain({ 'PLAN.md': '# plan\n', 'docs/a.md': 'a\n' }, 'Plan');

      const { outcome } = await refreshRoomWorktree(target, deps());

      expect(outcome).toEqual({
        kind: 'refreshed',
        from: before,
        to: tip,
        paths: ['PLAN.md', 'docs/a.md'],
      });
      expect(await headOf(copy)).toBe(tip);
      expect(await readFile(path.join(copy, 'PLAN.md'), 'utf-8')).toBe('# plan\n');
      expect(await git(copy, 'branch', '--show-current')).toBe(target.branch);
    });

    it('lands exactly on the tip it captured, even when main moves on mid-refresh', async () => {
      const captured = await onMain({ 'A.md': 'a\n' }, 'A');
      // `main` moves after step 1 read it: the last thing before the write.
      const { outcome } = await refreshRoomWorktree(
        target,
        deps({
          stillIdle: async () => {
            await onMain({ 'B.md': 'b\n' }, 'B');
            return true;
          },
        })
      );

      expect(outcome).toMatchObject({ kind: 'refreshed', to: captured });
      expect(await headOf(copy)).toBe(captured);
      expect(existsSync(path.join(copy, 'B.md'))).toBe(false);
    });

    it('forgets diff baselines for the moved files, and only those', async () => {
      await onMain({ 'PLAN.md': '# plan\n' }, 'Plan');

      await refreshRoomWorktree(target, deps());

      expect(forgotten).toContain(path.join(copy, 'PLAN.md'));
      expect(forgotten.every((p) => p.endsWith(`${path.sep}PLAN.md`))).toBe(true);
    });
  });

  describe('holds the copy, and leaves every byte alone, when', () => {
    it('it holds an untracked file', async () => {
      await onMain({ 'PLAN.md': '# plan\n' }, 'Plan');
      const before = await headOf(copy);
      await writeFile(path.join(copy, 'draft.md'), 'mine\n', 'utf-8');

      const { outcome } = await refreshRoomWorktree(target, deps());

      expect(outcome).toMatchObject({ kind: 'held', reason: 'changes' });
      expect(await headOf(copy)).toBe(before);
    });

    it('it holds a staged change', async () => {
      await onMain({ 'PLAN.md': '# plan\n' }, 'Plan');
      const before = await headOf(copy);
      await writeFile(path.join(copy, 'staged.md'), 'staged\n', 'utf-8');
      await git(copy, 'add', 'staged.md');

      const { outcome } = await refreshRoomWorktree(target, deps());

      expect(outcome).toMatchObject({ kind: 'held', reason: 'changes' });
      expect(await headOf(copy)).toBe(before);
    });

    it('it holds a commit main does not have', async () => {
      await onMain({ 'PLAN.md': '# plan\n' }, 'Plan');
      await writeFile(path.join(copy, 'mine.md'), 'mine\n', 'utf-8');
      await git(copy, 'add', 'mine.md');
      await git(copy, 'commit', '-q', '-m', 'mine');
      const before = await headOf(copy);

      const { outcome } = await refreshRoomWorktree(target, deps());

      expect(outcome).toMatchObject({ kind: 'held', reason: 'ahead' });
      expect(await headOf(copy)).toBe(before);
    });

    for (const flag of ['--assume-unchanged', '--skip-worktree']) {
      it(`it holds an edit to a file marked ${flag}, which status cannot see`, async () => {
        await onMain({ 'PLAN.md': 'v1\n' }, 'Plan v1');
        await refreshRoomWorktree(target, deps());
        await writeFile(path.join(copy, 'PLAN.md'), 'my hidden edit\n', 'utf-8');
        await git(copy, 'update-index', flag, 'PLAN.md');
        expect(await git(copy, 'status', '--porcelain')).toBe('');
        await onMain({ 'PLAN.md': 'v2\n' }, 'Plan v2');
        const before = await headOf(copy);

        const { outcome } = await refreshRoomWorktree(target, deps());

        expect(outcome).toMatchObject({ kind: 'held', reason: 'changes' });
        expect(await readFile(path.join(copy, 'PLAN.md'), 'utf-8')).toBe('my hidden edit\n');
        expect(await headOf(copy)).toBe(before);
      });
    }

    it('its HEAD is detached', async () => {
      await onMain({ 'PLAN.md': '# plan\n' }, 'Plan');
      const before = await headOf(copy);
      await git(copy, 'checkout', '-q', '--detach');

      const { outcome } = await refreshRoomWorktree(target, deps());

      expect(outcome).toMatchObject({ kind: 'held', reason: 'off-branch' });
      expect(await headOf(copy)).toBe(before);
    });

    it('another branch is checked out in it', async () => {
      await onMain({ 'PLAN.md': '# plan\n' }, 'Plan');
      await git(copy, 'checkout', '-q', '-b', 'room/experiment');
      const before = await headOf(copy);

      const { outcome } = await refreshRoomWorktree(target, deps());

      expect(outcome).toMatchObject({ kind: 'held', reason: 'off-branch' });
      expect(await headOf(copy)).toBe(before);
    });

    it('an ignored file sits at a path main now tracks (git would overwrite it, exit 0)', async () => {
      await onMain({ '.gitignore': '*.log\n' }, 'Ignore logs');
      expect((await refreshRoomWorktree(target, deps())).outcome.kind).toBe('refreshed');
      await writeFile(path.join(copy, 'notes.log'), 'my private notes\n', 'utf-8');
      await onMain({ 'notes.log': 'the room’s log\n' }, 'Track the log', { force: true });
      const before = await headOf(copy);

      const { outcome } = await refreshRoomWorktree(target, deps());

      expect(outcome).toMatchObject({ kind: 'held', reason: 'changes' });
      expect(await readFile(path.join(copy, 'notes.log'), 'utf-8')).toBe('my private notes\n');
      expect(await headOf(copy)).toBe(before);
    });

    it('an ignored file sits at a parent-folder path of one main adds', async () => {
      await onMain({ '.gitignore': 'scratch\n' }, 'Ignore scratch');
      expect((await refreshRoomWorktree(target, deps())).outcome.kind).toBe('refreshed');
      await writeFile(path.join(copy, 'scratch'), 'my scratch file\n', 'utf-8');
      await onMain(
        { '.gitignore': '\n', 'scratch/plan.md': '# plan\n' },
        'Scratch becomes a folder'
      );
      const before = await headOf(copy);

      const { outcome } = await refreshRoomWorktree(target, deps());

      expect(outcome).toMatchObject({ kind: 'held', reason: 'changes' });
      expect(await readFile(path.join(copy, 'scratch'), 'utf-8')).toBe('my scratch file\n');
      expect(await headOf(copy)).toBe(before);
    });

    it('ignored files sit under a folder main turns into a file (git would delete them, exit 0)', async () => {
      await onMain({ '.gitignore': 'build/\n' }, 'Ignore build');
      expect((await refreshRoomWorktree(target, deps())).outcome.kind).toBe('refreshed');
      await mkdir(path.join(copy, 'build'), { recursive: true });
      await writeFile(path.join(copy, 'build', 'keep.txt'), 'keep me\n', 'utf-8');
      await onMain({ '.gitignore': '\n', build: 'now a file\n' }, 'build is a file');
      const before = await headOf(copy);

      const { outcome } = await refreshRoomWorktree(target, deps());

      expect(outcome).toMatchObject({ kind: 'held', reason: 'changes' });
      expect(await readFile(path.join(copy, 'build', 'keep.txt'), 'utf-8')).toBe('keep me\n');
      expect(await headOf(copy)).toBe(before);
    });

    it('another turn started while the reads ran (asked again right before the write)', async () => {
      await onMain({ 'PLAN.md': '# plan\n' }, 'Plan');
      const before = await headOf(copy);

      const { outcome } = await refreshRoomWorktree(
        target,
        deps({ stillIdle: () => Promise.resolve(false) })
      );

      expect(outcome).toEqual({ kind: 'held', reason: 'busy', moved: null });
      expect(await headOf(copy)).toBe(before);
    });
  });

  describe('the room`s shared git settings name a program', () => {
    /**
     * What a shell in an agent's copy can do with plain git: define a smudge
     * filter in the room's shared config, and ask for it from `main`.
     */
    async function plantFilter(marker: string): Promise<void> {
      await git(
        repo,
        'config',
        '--file',
        path.join(repo, '.git', 'config'),
        'filter.x.smudge',
        `sh -c 'touch "${marker}"; cat'`
      );
    }

    it('holds the copy as unsafe-config and runs nothing', async () => {
      const marker = path.join(scratch, 'smudge-ran');
      await onMain({ '.gitattributes': '*.txt filter=x\n', 'a.txt': 'hello\n' }, 'Attrs');
      await plantFilter(marker);
      const before = await headOf(copy);

      const { outcome } = await refreshRoomWorktree(target, deps());

      expect(outcome).toEqual({ kind: 'held', reason: 'unsafe-config', moved: null });
      expect(existsSync(marker)).toBe(false);
      expect(await headOf(copy)).toBe(before);
    });

    it('stops the fast-forward itself when the settings change mid-refresh', async () => {
      const marker = path.join(scratch, 'smudge-ran');
      await onMain({ '.gitattributes': '*.txt filter=x\n', 'a.txt': 'hello\n' }, 'Attrs');
      const before = await headOf(copy);

      const { outcome } = await refreshRoomWorktree(
        target,
        deps({
          // Written after every read passed, right before the write.
          stillIdle: async () => {
            await plantFilter(marker);
            return true;
          },
        })
      );

      expect(outcome).toMatchObject({ kind: 'held', reason: 'unsafe-config' });
      expect(existsSync(marker)).toBe(false);
      expect(await headOf(copy)).toBe(before);
    });
  });

  describe('a fast-forward that is stopped partway', () => {
    it('is unreadable, not refreshed, when the write is killed by its timeout', async () => {
      await mkdir(path.join(repo, 'bulk'), { recursive: true });
      for (let i = 0; i < 300; i += 1) {
        await writeFile(path.join(repo, 'bulk', `f${i}.md`), `${i}\n`.repeat(200), 'utf-8');
      }
      await git(repo, 'add', 'bulk');
      await git(repo, 'commit', '-q', '-m', 'Bulk');
      const before = await headOf(copy);

      const { outcome } = await refreshRoomWorktree(target, deps({ writeTimeoutMs: 1 }));

      expect(outcome).toMatchObject({ kind: 'held', reason: 'unreadable' });
      expect(await headOf(copy)).toBe(before);
      // Whatever it left, no lock of its own stops the next git command.
      expect(existsSync(lockOf())).toBe(false);
      await expect(git(copy, 'status', '--porcelain')).resolves.toBeDefined();
    }, 30_000);

    /**
     * Run `body` with a `git` on PATH that, for the fast-forward only, takes the
     * copy's index lock first — then either hangs (so the write is KILLED by its
     * timeout while holding it) or hands over to the real git, which fails on
     * the lock exactly as it would if a person's shell or a git GUI had taken it
     * between the idle check and the write.
     */
    async function withWrappedGit(mode: 'hang' | 'foreign', body: () => Promise<void>) {
      const realGit = await whichGit();
      const bin = path.join(scratch, 'bin');
      await mkdir(bin, { recursive: true });
      await writeFile(
        path.join(bin, 'git'),
        [
          '#!/bin/sh',
          'for a in "$@"; do',
          '  if [ "$a" = "--ff-only" ]; then',
          '    : > "$GIT_DIR/index.lock"',
          `    ${mode === 'hang' ? 'exec sleep 30' : 'break'}`,
          '  fi',
          'done',
          `exec "${realGit}" "$@"`,
          '',
        ].join('\n'),
        { mode: 0o755 }
      );
      const original = process.env.PATH ?? '';
      vi.stubEnv('PATH', `${bin}${path.delimiter}${original}`);
      try {
        await body();
      } finally {
        vi.stubEnv('PATH', original);
      }
    }

    /** The real git binary, resolved before any wrapper is on PATH. */
    async function whichGit(): Promise<string> {
      const { execFile } = await import('node:child_process');
      return new Promise((resolve, reject) =>
        execFile('sh', ['-c', 'command -v git'], (err, out) =>
          err ? reject(err) : resolve(out.trim())
        )
      );
    }

    it('removes the lock a KILLED write left, through the real write path', async () => {
      await onMain({ 'PLAN.md': '# plan\n' }, 'Plan');
      const before = await headOf(copy);

      await withWrappedGit('hang', async () => {
        const { outcome } = await refreshRoomWorktree(target, deps({ writeTimeoutMs: 500 }));
        expect(outcome).toMatchObject({ kind: 'held', reason: 'unreadable' });
      });

      expect(existsSync(lockOf())).toBe(false);
      expect(await headOf(copy)).toBe(before);
      await expect(git(copy, 'status', '--porcelain')).resolves.toBeDefined();
    }, 30_000);

    it('never removes a lock another process took between the check and the write', async () => {
      await onMain({ 'PLAN.md': '# plan\n' }, 'Plan');
      const before = await headOf(copy);

      await withWrappedGit('foreign', async () => {
        const { outcome } = await refreshRoomWorktree(target, deps());
        expect(outcome).toMatchObject({ kind: 'held', reason: 'unreadable' });
      });

      // That process may still be running: its lock is its own.
      expect(existsSync(lockOf())).toBe(true);
      expect(await headOf(copy)).toBe(before);
    }, 30_000);

    it('never removes a lock that was there before the write, even after a kill', async () => {
      await writeFile(lockOf(), '', 'utf-8');
      afterFailedWrite(lockOf(), true, Object.assign(new Error('killed'), { killed: true }));
      expect(existsSync(lockOf())).toBe(true);
    });

    /** The copy's index lock, where git takes it for a linked worktree. */
    function lockOf(): string {
      return path.join(repo, '.git', 'worktrees', path.basename(copy), 'index.lock');
    }
  });

  it('refreshes past an ignored file main does not touch', async () => {
    await onMain({ '.gitignore': '*.log\n' }, 'Ignore logs');
    await refreshRoomWorktree(target, deps());
    await writeFile(path.join(copy, 'notes.log'), 'mine\n', 'utf-8');
    const tip = await onMain({ 'PLAN.md': '# plan\n' }, 'Plan');

    const { outcome } = await refreshRoomWorktree(target, deps());

    expect(outcome).toMatchObject({ kind: 'refreshed', to: tip });
    expect(await readFile(path.join(copy, 'notes.log'), 'utf-8')).toBe('mine\n');
  });

  describe('what moved on main (the heads-up)', () => {
    it('lists a merged 12-commit agent branch as one commit (first-parent)', async () => {
      // Another agent's branch, 12 commits, merged `--no-ff` as the merge service does.
      await git(repo, 'checkout', '-q', '-b', 'room/bo');
      for (let i = 1; i <= 12; i += 1) await onMain({ [`bo-${i}.md`]: `${i}\n` }, `bo ${i}`);
      await git(repo, 'checkout', '-q', 'main');
      await git(repo, 'merge', '--no-ff', '-q', '-m', 'Bo’s release notes', 'room/bo');
      const merge = await headOf(repo);
      named.set(merge, { kind: 'merge', who: 'Bo' });
      await writeFile(path.join(copy, 'draft.md'), 'mine\n', 'utf-8');

      const { outcome } = await refreshRoomWorktree(target, deps());

      expect(outcome).toMatchObject({ kind: 'held', reason: 'changes' });
      const moved = outcome.kind === 'held' ? outcome.moved : null;
      expect(moved?.commits).toEqual([
        {
          sha: merge,
          who: 'Bo',
          subject: 'Bo’s release notes',
          kind: 'merge',
          files: Array.from({ length: 8 }, (_, i) => `bo-${[1, 10, 11, 12, 2, 3, 4, 5][i]}.md`),
          fileCount: 12,
        },
      ]);
      expect(moved?.overflow).toBe(0);
    });

    it('names people from their room entries, tells two people apart, and a hand commit is other', async () => {
      const ana1 = await onMain({ 'ROOM.md': 'v2\n' }, 'Edit ROOM.md');
      const dee = await onMain({ 'notes/plan.md': 'p\n' }, 'Add notes/plan.md');
      await onMain({ 'fix.md': 'f\n' }, 'repair');
      named.set(ana1, { kind: 'person', who: 'Ana Person' });
      named.set(dee, { kind: 'person', who: 'Dee' });
      await writeFile(path.join(copy, 'draft.md'), 'mine\n', 'utf-8');

      const { outcome } = await refreshRoomWorktree(target, deps());
      const moved = outcome.kind === 'held' ? outcome.moved : null;

      expect(moved?.commits.map((c) => [c.subject, c.kind, c.who])).toEqual([
        ['repair', 'other', null],
        ['Add notes/plan.md', 'person', 'Dee'],
        ['Edit ROOM.md', 'person', 'Ana Person'],
      ]);
      // Never from git: every one of these was committed as "Hand".
      expect(JSON.stringify(moved)).not.toContain('Hand');
    });

    it('caps the list at eight and counts the rest', async () => {
      for (let i = 1; i <= 11; i += 1) await onMain({ [`f${i}.md`]: `${i}\n` }, `change ${i}`);
      await writeFile(path.join(copy, 'draft.md'), 'mine\n', 'utf-8');

      const { outcome } = await refreshRoomWorktree(target, deps());
      const moved = outcome.kind === 'held' ? outcome.moved : null;

      expect(moved?.commits).toHaveLength(8);
      expect(moved?.commits[0]!.subject).toBe('change 11');
      expect(moved?.overflow).toBe(3);
    });

    it('finds the overlap in committed-ahead work and in working-tree changes', async () => {
      await onMain({ 'shared.md': 'base\n', 'other.md': 'base\n', 'third.md': 'base\n' }, 'Base');
      await refreshRoomWorktree(target, deps());
      // Ana commits to shared.md, and has other.md changed in her tree.
      await writeFile(path.join(copy, 'shared.md'), 'ana\n', 'utf-8');
      await git(copy, 'commit', '-q', '-am', 'ana on shared');
      await writeFile(path.join(copy, 'other.md'), 'ana wip\n', 'utf-8');
      await onMain(
        { 'shared.md': 'main\n', 'other.md': 'main\n', 'untouched.md': 'x\n' },
        'Main moves'
      );

      const { outcome } = await refreshRoomWorktree(target, deps());

      expect(outcome).toMatchObject({ kind: 'held', reason: 'changes' });
      expect(outcome.kind === 'held' ? outcome.moved?.overlap : null).toEqual([
        'other.md',
        'shared.md',
      ]);
    });

    it('says nothing moved when main has not moved since the copy branched', async () => {
      await writeFile(path.join(copy, 'draft.md'), 'mine\n', 'utf-8');

      const { outcome } = await refreshRoomWorktree(target, deps());

      expect(outcome).toEqual({
        kind: 'held',
        reason: 'changes',
        moved: { commits: [], overflow: 0, overlap: [] },
      });
    });
  });

  describe('at launch (roomTurnLaunchStep)', () => {
    function launchStep(opts: {
      bound: string[];
      busy: Set<string>;
      files: RoomContextFiles | null;
      calls?: string[];
    }) {
      return roomTurnLaunchStep(
        {
          boundSessionIds: () => opts.bound,
          isTurnInFlight: (id) => Promise.resolve(opts.busy.has(id)),
          worktrees: {
            retireLegacyPlumbing: (...args) => {
              opts.calls?.push('retire');
              return manager.retireLegacyPlumbing(...args);
            },
            refreshTarget: (...args) => {
              opts.calls?.push('target');
              return manager.refreshTarget(...args);
            },
          },
          describeCommits: () => new Map(),
          forgetBaselines: (sessionIds, absPaths) =>
            forgotten.push(...sessionIds.flatMap((id) => absPaths.map((p) => `${id}:${p}`))),
        },
        { roomId: ROOM_ID, worktree: copy, agentPath: ana, files: opts.files }
      );
    }

    it('a turn placed while main was at A and launched after main moved to B lands on B', async () => {
      const a = await onMain({ 'A.md': 'a\n' }, 'A');
      const placed = await resolveRoomTurnPlace(manager, ROOM_ID, ana, 'Ana');
      expect(placed.files).toMatchObject({ behind: 1 });
      const b = await onMain({ 'B.md': 'b\n' }, 'B');
      expect(b).not.toBe(a);

      const launched = await launchStep({
        bound: ['s-room'],
        busy: new Set(),
        files: placed.files,
      })('s-room');

      expect(await headOf(copy)).toBe(b);
      expect(launched.files).toMatchObject({
        behind: 0,
        ahead: 0,
        refresh: { kind: 'refreshed', to: b, paths: ['A.md', 'B.md'] },
      });
    });

    it('answers busy with zero git calls while a second bound session runs, and refreshes once it settles', async () => {
      await onMain({ 'PLAN.md': '# plan\n' }, 'Plan');
      const placed = await resolveRoomTurnPlace(manager, ROOM_ID, ana, 'Ana');
      const before = await headOf(copy);
      const busy = new Set(['s-app-resumed']);
      const calls: string[] = [];
      const step = launchStep({
        bound: ['s-room', 's-app-resumed'],
        busy,
        files: placed.files,
        calls,
      });

      const held = await step('s-room');
      expect(held.files?.refresh).toEqual({ kind: 'held', reason: 'busy', moved: null });
      // Neither the clean-up nor the refresh target was reached: no git at all.
      expect(calls).toEqual([]);
      expect(await headOf(copy)).toBe(before);

      busy.delete('s-app-resumed');
      const ran = await step('s-room');
      expect(ran.files?.refresh).toMatchObject({ kind: 'refreshed' });
      expect(calls).toEqual(['retire', 'target']);
      // Baselines are forgotten in every bound session, the launching one included.
      expect(forgotten).toContain(`s-room:${path.join(copy, 'PLAN.md')}`);
      expect(forgotten).toContain(`s-app-resumed:${path.join(copy, 'PLAN.md')}`);
    });

    it('counts a bound session whose busy read throws as running', async () => {
      await onMain({ 'PLAN.md': '# plan\n' }, 'Plan');
      const placed = await resolveRoomTurnPlace(manager, ROOM_ID, ana, 'Ana');
      const before = await headOf(copy);
      const step = roomTurnLaunchStep(
        {
          boundSessionIds: () => ['s-room', 's-gone'],
          isTurnInFlight: (id) =>
            id === 's-gone' ? Promise.reject(new Error('no runtime')) : Promise.resolve(false),
          worktrees: manager,
          describeCommits: () => new Map(),
          forgetBaselines: () => {},
        },
        { roomId: ROOM_ID, worktree: copy, agentPath: ana, files: placed.files }
      );

      const launched = await step('s-room');

      expect(launched.files?.refresh).toMatchObject({ kind: 'held', reason: 'busy' });
      expect(await headOf(copy)).toBe(before);
    });

    it('re-measures the counts against the captured tip when the copy is held', async () => {
      const placed = await resolveRoomTurnPlace(manager, ROOM_ID, ana, 'Ana');
      await onMain({ 'A.md': 'a\n' }, 'A');
      await onMain({ 'B.md': 'b\n' }, 'B');
      await writeFile(path.join(copy, 'draft.md'), 'mine\n', 'utf-8');

      const launched = await launchStep({ bound: [], busy: new Set(), files: placed.files })(
        's-room'
      );

      expect(placed.files).toMatchObject({ behind: 0 });
      expect(launched.files).toMatchObject({
        behind: 2,
        ahead: 0,
        refresh: { kind: 'held', reason: 'changes' },
      });
    });
  });
});

describe('pathsCollide / firstCollision', () => {
  it('relates equal paths, a path inside another, and a parent — and nothing else', () => {
    expect(pathsCollide('notes.log', 'notes.log')).toBe(true);
    expect(pathsCollide('build/keep.txt', 'build')).toBe(true);
    expect(pathsCollide('scratch', 'scratch/plan.md')).toBe(true);
    expect(pathsCollide('sub/', 'sub/file')).toBe(true);
    expect(pathsCollide('build/keep.txt', 'build/other.txt')).toBe(false);
    expect(pathsCollide('builder', 'build')).toBe(false);
    expect(pathsCollide('build', 'builder/x')).toBe(false);
  });

  it('folds case and normalization, so it can only hold more copies, never fewer', () => {
    expect(pathsCollide('Notes.log', 'notes.log')).toBe(true);
    expect(pathsCollide('café.md', 'café.md')).toBe(true);
  });

  it('answers the first collision or null', () => {
    expect(firstCollision(['a.log', 'build/keep.txt'], ['README.md', 'build'])).toEqual({
      onDisk: 'build/keep.txt',
      moved: 'build',
    });
    expect(firstCollision(['a.log'], ['README.md'])).toBeNull();
  });
});

describe('firstCollision agrees with pathsCollide on every pair', () => {
  it('finds exactly the pairs the pairwise rule finds', () => {
    const onDisk = ['a', 'a/b', 'a/b/c.txt', 'A/B', 'x.log', 'deep/er/still/file', 'sub/', 'ab'];
    const moved = ['a/b', 'x.log', 'deep', 'sub/inner.md', 'abc', 'q/r'];
    for (const u of onDisk) {
      for (const p of moved) {
        expect(firstCollision([u], [p]) !== null).toBe(pathsCollide(u, p));
      }
    }
  });
});
