/**
 * Where a room turn stands, which folders it is granted, and why the `.git`
 * grant is narrow (spec `agent-home-desk` §5.1, the T2 security review).
 *
 * Real git throughout, because the claims are about what git writes:
 *
 * - The grant set is exactly the six folders, realpath-resolved, and a room with
 *   no files gets none.
 * - **A commit and a `git merge main` in the agent's copy need nothing outside
 *   the grants.** Measured by making everything else in `repo/.git` read-only —
 *   what a sandboxed shell sees — and committing anyway.
 * - **Nothing one agent may write can make code run elsewhere.** The grants
 *   exclude the room's shared `hooks/`, `config` and `info/`, so under the same
 *   sandbox a planted hook is refused; and a hook planted by an UNsandboxed
 *   writer, a hostile `core.hooksPath` in the room's config, and a rewritten
 *   `.git` pointer in the agent's copy all fail to run anything in the
 *   server's own git (the merge, and the status reads the reap and the merge
 *   gate make).
 *
 * Seeded defects, each run red before the code stood: granting all of
 * `repo/.git` reddens "never grants the shared hooks, config or info"; dropping
 * the worktree pin from `room-repo-git.ts` reddens "the server's status read of
 * a copy ignores a rewritten .git pointer".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createTestDb } from '@dorkos/test-utils/db';
import { rooms, type Db } from '@dorkos/db';
import type { Room } from '@dorkos/shared/room-schemas';
import { ROOM_REPO_CAP_DEFAULTS } from '@dorkos/shared/room-repo';
import { assertValidDirectoryGrants } from '@dorkos/shared/directory-grants';
import { RoomRepoStore } from '../room-repo-store.js';
import { RoomRepoService } from '../room-repo-service.js';
import { RoomRepoMutex } from '../room-repo-mutex.js';
import { RoomWorktreeManager } from '../room-worktree-manager.js';
import {
  assertRoomRepoConfigSafe,
  commitsAheadOfMain,
  hasUncommittedChanges,
  mergeNoFf,
  runGit,
} from '../room-repo-git.js';
import {
  resolveRoomTurnPlace,
  roomSessionPlace,
  roomTurnGrants,
  roomTurnLaunchStep,
} from '../room-turn-place.js';
import type { AuthorRecord } from '../../author-registry.js';
import { removeFixtureTree, silenceGitAutoMaintenance } from './fixture-git.js';

const ROOM_ID = '01ROOMAAAAAAAAAAAAAAAAAAAA';
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

/** Plain git as an agent's own shell runs it: the machine's git, no DorkOS hardening. */
async function agentGit(cwd: string, ...args: string[]): Promise<string> {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [
        '-c',
        'user.name=Agent',
        '-c',
        'user.email=agent@example.com',
        // No background maintenance: a detached `gc`/`maintenance` writing into
        // `repo/.git` raced the sandbox's tree walk (`maintenance.lock`
        // vanishing mid-`lstat`) and its cleanup.
        '-c',
        'maintenance.auto=false',
        '-c',
        'gc.auto=0',
        ...args,
      ],
      {
        cwd,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
        },
      },
      (err, stdout, stderr) => (err ? reject(new Error(`${stderr}`)) : resolve(stdout.trim()))
    );
  });
}

/** A hook that leaves a mark when it runs. */
function markingHook(marker: string): string {
  return `#!/bin/sh\necho ran >> "${marker}"\n`;
}

describe('room turn placement and grants', () => {
  let db: Db;
  let scratch: string;
  let store: RoomRepoStore;
  let service: RoomRepoService;
  let manager: RoomWorktreeManager;
  let ana: string;
  let bo: string;
  /** Folders made read-only by a test, restored in `afterEach` so cleanup works. */
  let locked: string[];

  beforeEach(async () => {
    db = createTestDb();
    silenceGitAutoMaintenance();
    scratch = realpathSync(await mkdtemp(path.join(tmpdir(), 'dorkos-room-place-')));
    const dorkHome = path.join(scratch, '.dork');
    await mkdir(dorkHome, { recursive: true });
    ana = path.join(scratch, 'agents', 'ana');
    bo = path.join(scratch, 'agents', 'bo');
    await mkdir(ana, { recursive: true });
    await mkdir(bo, { recursive: true });
    locked = [];
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
  });

  afterEach(async () => {
    // Every locked tree is made writable again even if one of them cannot be,
    // so the scratch folder is always removable whatever the test body did.
    for (const dir of locked.splice(0)) {
      try {
        chmodTree(dir, true);
      } catch {
        // Best effort: the removal below reports anything still stuck.
      }
    }
    await removeFixtureTree(scratch);
  });

  /** Whether an error is a path that vanished while the tree was being walked. */
  function vanished(err: unknown): boolean {
    return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
  }

  /**
   * Make everything under `dir` read-only (or writable again), folders and
   * files. A path that disappears mid-walk (a lock file git just released) is
   * skipped rather than failing the walk.
   */
  function chmodTree(dir: string, writable: boolean): void {
    try {
      const stat = lstatSync(dir);
      if (stat.isSymbolicLink()) return;
      if (stat.isDirectory()) {
        if (writable) chmodSync(dir, 0o755);
        for (const name of readdirSync(dir)) chmodTree(path.join(dir, name), writable);
        if (!writable) chmodSync(dir, 0o555);
      } else {
        chmodSync(dir, writable ? 0o644 : 0o444);
      }
    } catch (err) {
      if (!vanished(err)) throw err;
    }
  }

  /**
   * What a sandboxed shell in Ana's turn can write: her home, and exactly the
   * `write` grants. Everything else in the room's tree is made read-only.
   */
  function sandboxTo(grants: readonly { path: string; access: string }[]): void {
    const home = store.homeDir(ROOM_ID);
    chmodTree(home, false);
    locked.push(home);
    for (const grant of grants) {
      if (grant.access !== 'write') continue;
      // Writable, and its parent chain traversable (read-only folders are).
      chmodTree(grant.path, true);
    }
  }

  it('stands the turn at home with no grants in a room without files', async () => {
    const place = await resolveRoomTurnPlace(manager, ROOM_ID, ana, 'Ana');

    expect(place).toEqual({ cwd: ana, additionalDirectories: [], worktree: null, files: null });
  });

  it('stands the turn at home and grants exactly the six folders in a room with files', async () => {
    await service.enable(ROOM_ID, OPERATOR);

    const place = await resolveRoomTurnPlace(manager, ROOM_ID, ana, 'Ana');

    const worktree = path.join(
      store.worktreesPath(ROOM_ID),
      RoomWorktreeManager.slugFor('Ana', ana)
    );
    const repo = store.repoPath(ROOM_ID);
    const git = path.join(repo, '.git');
    expect(place.cwd).toBe(ana);
    expect(place.worktree).toBe(worktree);
    expect(place.additionalDirectories).toEqual([
      { path: worktree, access: 'write' },
      { path: repo, access: 'read' },
      { path: path.join(git, 'objects'), access: 'write' },
      { path: path.join(git, 'refs', 'heads', 'room'), access: 'write' },
      { path: path.join(git, 'logs', 'refs', 'heads', 'room'), access: 'write' },
      { path: path.join(git, 'worktrees', path.basename(worktree)), access: 'write' },
    ]);
    // Every granted folder exists, so a commit never has to create one.
    for (const grant of place.additionalDirectories) expect(existsSync(grant.path)).toBe(true);
    // And the set passes the one validator every runtime runs before launch.
    expect(() =>
      assertValidDirectoryGrants(place.additionalDirectories, ana, '/nonexistent-home')
    ).not.toThrow();
    expect(place.files).toMatchObject({
      worktreePath: worktree,
      repoPath: repo,
      ahead: 0,
      behind: 0,
    });
  });

  it('never grants the shared hooks, config or info — nor all of .git', async () => {
    await service.enable(ROOM_ID, OPERATOR);
    const { additionalDirectories: grants } = await resolveRoomTurnPlace(
      manager,
      ROOM_ID,
      ana,
      'Ana'
    );
    const git = path.join(store.repoPath(ROOM_ID), '.git');

    const writable = grants.filter((g) => g.access === 'write').map((g) => g.path);
    for (const shared of ['hooks', 'config', 'info', 'packed-refs', 'HEAD']) {
      const target = path.join(git, shared);
      expect(writable.some((w) => target === w || target.startsWith(`${w}${path.sep}`))).toBe(
        false
      );
    }
    expect(writable).not.toContain(git);
  });

  it('drops a grant inside the turn`s own folder (a dev checkout keeps its data folder there)', () => {
    const home = scratch;
    const grants = roomTurnGrants(
      path.join(scratch, '.dork', 'rooms', ROOM_ID, 'worktrees', 'ana-1'),
      path.join(scratch, '.dork', 'rooms', ROOM_ID, 'repo'),
      home
    );
    expect(grants).toEqual([]);
  });

  it('lets a sandboxed shell commit and sync in its copy with nothing but the grants', async () => {
    await service.enable(ROOM_ID, OPERATOR);
    const place = await resolveRoomTurnPlace(manager, ROOM_ID, ana, 'Ana');
    const copy = place.worktree!;
    // Main moves on first, so `git merge main` has something to bring in.
    const repo = store.repoPath(ROOM_ID);
    await writeFile(path.join(repo, 'NOTES.md'), '# notes\n', 'utf-8');
    await agentGit(repo, 'add', 'NOTES.md');
    await agentGit(repo, 'commit', '-q', '-m', 'notes');

    sandboxTo(place.additionalDirectories);

    await writeFile(path.join(copy, 'PLAN.md'), '# plan\n', 'utf-8');
    await agentGit(copy, 'add', 'PLAN.md');
    await agentGit(copy, 'commit', '-q', '-m', 'Add the plan');
    await agentGit(copy, 'merge', '-q', '--no-edit', 'main');

    expect(await agentGit(copy, 'log', '--format=%s', '-3')).toContain('Add the plan');
    expect(existsSync(path.join(copy, 'NOTES.md'))).toBe(true);
    expect(await agentGit(copy, 'status', '--porcelain')).toBe('');
  });

  it('runs git`s automatic housekeeping in the foreground, never detached, in the server`s git', async () => {
    // A detached `gc`/maintenance keeps writing `repo/.git` after the server's
    // call has returned, racing the next command and the turn-start refresh.
    // Asked of the server's own git, so it is the effective setting a commit or
    // merge runs with. Seeded: dropping either setting reddens this.
    await service.enable(ROOM_ID, OPERATOR);
    const repo = store.repoPath(ROOM_ID);
    const home = store.homeDir(ROOM_ID);

    expect(await runGit(['config', '--get', 'maintenance.autoDetach'], repo, home)).toBe('false');
    expect(await runGit(['config', '--get', 'gc.autoDetach'], repo, home)).toBe('false');
  });

  it('refuses a sandboxed shell a hook or a config edit in the room`s shared git', async () => {
    await service.enable(ROOM_ID, OPERATOR);
    const place = await resolveRoomTurnPlace(manager, ROOM_ID, ana, 'Ana');
    const git = path.join(store.repoPath(ROOM_ID), '.git');
    sandboxTo(place.additionalDirectories);

    await expect(
      mkdir(path.join(git, 'hooks'), { recursive: true }).then(() =>
        writeFile(path.join(git, 'hooks', 'post-commit'), markingHook('/dev/null'))
      )
    ).rejects.toMatchObject({ code: expect.stringMatching(/EACCES|EPERM/) });
    await expect(writeFile(path.join(git, 'config'), '[core]\n')).rejects.toMatchObject({
      code: expect.stringMatching(/EACCES|EPERM/),
    });
    await expect(
      writeFile(path.join(git, 'info', 'attributes'), '* filter=x\n')
    ).rejects.toMatchObject({ code: expect.stringMatching(/EACCES|EPERM|ENOENT/) });
  });

  it('runs no hook planted in the room`s shared hooks folder, in the server`s merge', async () => {
    // What an UNsandboxed shell could plant (spec §5.2). A config pointing hook
    // lookup elsewhere is refused outright — see the config cases below.
    await service.enable(ROOM_ID, OPERATOR);
    const place = await resolveRoomTurnPlace(manager, ROOM_ID, ana, 'Ana');
    const repo = store.repoPath(ROOM_ID);
    const git = path.join(repo, '.git');
    const marker = path.join(scratch, 'hook-ran');
    await mkdir(path.join(git, 'hooks'), { recursive: true });
    for (const dir of [path.join(git, 'hooks')]) {
      for (const hook of [
        'pre-merge-commit',
        'post-merge',
        'post-commit',
        'reference-transaction',
        'commit-msg',
      ]) {
        await writeFile(path.join(dir, hook), markingHook(marker), { mode: 0o755 });
      }
    }
    await writeFile(path.join(place.worktree!, 'PLAN.md'), '# plan\n', 'utf-8');
    await agentGit(place.worktree!, 'add', 'PLAN.md');
    await agentGit(place.worktree!, 'commit', '-q', '--no-verify', '-m', 'plan');
    // The fixture is live: plain git in the room DOES run the planted hook.
    await agentGit(repo, 'commit', '-q', '--allow-empty', '-m', 'control');
    expect(existsSync(marker)).toBe(true);
    await writeFile(marker, '');

    await mergeNoFf(
      repo,
      `room/${RoomWorktreeManager.slugFor('Ana', ana)}`,
      'Merge the plan',
      { name: 'Dorian', email: 'operator@dorkos.local' },
      store.homeDir(ROOM_ID)
    );

    expect(await readFile(marker, 'utf-8')).toBe('');
    expect(existsSync(path.join(repo, 'PLAN.md'))).toBe(true);
  });

  describe('a room whose shared git config names a program', () => {
    // No agent is GRANTED `repo/.git/config`, but an unsandboxed shell can write
    // it: a plain `git config` in an agent's copy lands there. Every server git
    // command in the room then refuses `ROOM_REPO_CONFIG_UNSAFE` rather than run
    // what the config defines. Seeded: skipping the audit in `runGitRaw` reddens
    // the filter-on-merge case (the smudge runs as the server).
    async function armed(key: string, value: string) {
      await service.enable(ROOM_ID, OPERATOR);
      const place = await resolveRoomTurnPlace(manager, ROOM_ID, ana, 'Ana');
      const copy = place.worktree!;
      const marker = path.join(scratch, `ran-${key.replace(/\W/g, '-')}`);
      const program = path.join(scratch, `prog-${key.replace(/\W/g, '-')}.sh`);
      await writeFile(program, `#!/bin/sh\necho ran >> "${marker}"\ncat\n`, { mode: 0o755 });
      // Written from the COPY, as an agent's plain shell would.
      await agentGit(copy, 'config', key, value.replace('PROGRAM', program));
      return { copy, marker, program };
    }

    it('lands a `git config` run in an agent`s copy in the room`s shared config', async () => {
      await armed('core.ignoreStat', 'true');
      const shared = await readFile(path.join(store.repoPath(ROOM_ID), '.git', 'config'), 'utf-8');
      expect(shared).toContain('ignoreStat = true');
    });

    it('refuses the server`s merge instead of running a filter smudge a member`s attributes name', async () => {
      const { copy, marker } = await armed('filter.x.smudge', 'PROGRAM');
      await agentGit(copy, 'config', 'filter.x.clean', 'cat');
      await writeFile(path.join(copy, '.gitattributes'), '*.md filter=x\n');
      await writeFile(path.join(copy, 'PLAN.md'), '# plan\n');
      await agentGit(copy, 'add', '-A');
      await agentGit(copy, 'commit', '-q', '-m', 'attributes');
      // The fixture is live: plain git checking the file out runs the smudge.
      await agentGit(copy, 'rm', '-q', '--cached', 'PLAN.md');
      await agentGit(copy, 'checkout', '--', 'PLAN.md').catch(() => undefined);
      await agentGit(copy, 'reset', '-q', '--hard');
      expect(existsSync(marker)).toBe(true);
      await writeFile(marker, '');

      await expect(
        mergeNoFf(
          store.repoPath(ROOM_ID),
          `room/${RoomWorktreeManager.slugFor('Ana', ana)}`,
          'Merge the plan',
          { name: 'Dorian', email: 'operator@dorkos.local' },
          store.homeDir(ROOM_ID)
        )
      ).rejects.toMatchObject({ code: 'ROOM_REPO_CONFIG_UNSAFE' });
      expect(await readFile(marker, 'utf-8')).toBe('');
      expect(existsSync(path.join(store.repoPath(ROOM_ID), 'PLAN.md'))).toBe(false);
    });

    it('refuses a diff whose textconv the config defines, and a status under an fsmonitor', async () => {
      const { copy, marker } = await armed('diff.x.textconv', 'PROGRAM');
      await writeFile(path.join(copy, '.gitattributes'), '*.md diff=x\n');
      await writeFile(path.join(copy, 'A.md'), 'a\n');
      await agentGit(copy, 'add', '-A');
      await agentGit(copy, 'commit', '-q', '-m', 'a');
      await writeFile(path.join(copy, 'A.md'), 'b\n');

      await expect(runGit(['diff'], copy, store.homeDir(ROOM_ID))).rejects.toMatchObject({
        code: 'ROOM_REPO_CONFIG_UNSAFE',
      });
      expect(existsSync(marker)).toBe(false);

      await agentGit(copy, 'config', '--unset', 'diff.x.textconv');
      await agentGit(copy, 'config', 'core.fsmonitor', marker);
      await expect(hasUncommittedChanges(copy, store.homeDir(ROOM_ID))).rejects.toMatchObject({
        code: 'ROOM_REPO_CONFIG_UNSAFE',
      });
    });

    it('refuses an include, and works again once a person removes the keys', async () => {
      const { copy } = await armed('include.path', '/nowhere/evil.config');
      await expect(hasUncommittedChanges(copy, store.homeDir(ROOM_ID))).rejects.toMatchObject({
        code: 'ROOM_REPO_CONFIG_UNSAFE',
        message: expect.stringContaining('include.path'),
      });

      await agentGit(copy, 'config', '--unset', 'include.path');
      await expect(hasUncommittedChanges(copy, store.homeDir(ROOM_ID))).resolves.toBe(false);
      await expect(assertRoomRepoConfigSafe(store.homeDir(ROOM_ID))).resolves.toBeUndefined();
    });

    it('refuses a conditional include, whatever it would read', async () => {
      await armed('includeIf.gitdir:/.path', '/nowhere/evil.config');
      await expect(assertRoomRepoConfigSafe(store.homeDir(ROOM_ID))).rejects.toMatchObject({
        code: 'ROOM_REPO_CONFIG_UNSAFE',
        message: expect.stringContaining('includeif.gitdir:/.path'),
      });
    });

    it('refuses turning on per-copy settings, so a copy`s own settings file is never read', async () => {
      // An agent is granted its copy's folder under `repo/.git/worktrees/`, so
      // it can write `config.worktree` there. Git reads that file only once
      // `extensions.worktreeConfig` is on — refused here — so the file stays
      // inert (the merge case below proves nothing it defines runs).
      await armed('extensions.worktreeConfig', 'true');
      await expect(assertRoomRepoConfigSafe(store.homeDir(ROOM_ID))).rejects.toMatchObject({
        code: 'ROOM_REPO_CONFIG_UNSAFE',
        message: expect.stringContaining('extensions.worktreeconfig'),
      });
    });
  });

  it('the server`s status read of a copy ignores a rewritten .git pointer', async () => {
    // The agent may write its whole copy, including its `.git` file. Pointed at
    // a git folder it controls, whose config names a filter program, an
    // ordinary `git status` would run that program as the server — unless the
    // server's git is pinned to the room's own storage.
    await service.enable(ROOM_ID, OPERATOR);
    const place = await resolveRoomTurnPlace(manager, ROOM_ID, ana, 'Ana');
    const copy = place.worktree!;
    const marker = path.join(scratch, 'filter-ran');
    const fake = path.join(copy, '.evil-git');
    await mkdir(path.join(fake, 'refs', 'heads'), { recursive: true });
    await mkdir(path.join(fake, 'objects'), { recursive: true });
    await writeFile(path.join(fake, 'HEAD'), 'ref: refs/heads/main\n');
    // A program, as a script file: a `;` in a config value starts a comment.
    const program = path.join(scratch, 'evil-filter.sh');
    await writeFile(program, `#!/bin/sh\necho ran >> "${marker}"\ncat\n`, { mode: 0o755 });
    await writeFile(
      path.join(fake, 'config'),
      `[core]\n\trepositoryformatversion = 0\n\tbare = false\n[filter "x"]\n\tclean = ${program}\n`
    );
    await writeFile(path.join(copy, '.gitattributes'), '* filter=x\n');
    await writeFile(path.join(copy, 'PLAN.md'), '# plan\n');
    await writeFile(path.join(copy, '.git'), `gitdir: ${fake}\n`);
    // The fixture is live: plain git in the copy follows the pointer and runs it.
    await agentGit(copy, 'add', 'PLAN.md').catch(() => undefined);
    expect(existsSync(marker)).toBe(true);
    await writeFile(marker, '');
    // A tracked file touched but the same size: `git status` cannot tell from
    // the stat alone, so it hashes it — which is where a clean filter runs.
    const later = new Date(Date.now() + 60_000);
    await utimes(path.join(copy, 'PLAN.md'), later, later);

    await hasUncommittedChanges(copy, store.homeDir(ROOM_ID)).catch(() => undefined);

    expect(await readFile(marker, 'utf-8')).toBe('');
  });

  it('the server`s git never walks into a submodule the agent committed into its copy', async () => {
    // A gitlink plus a `sub/` holding its own `.git/config` with a filter
    // program and a `.gitattributes` naming it: a plain `git status` in the
    // copy recurses into the submodule and runs that program as the server.
    // The worktree pin does not help — the submodule's git folder is its own.
    await service.enable(ROOM_ID, OPERATOR);
    const place = await resolveRoomTurnPlace(manager, ROOM_ID, ana, 'Ana');
    const copy = place.worktree!;
    const marker = path.join(scratch, 'submodule-filter-ran');
    const program = path.join(scratch, 'evil-sub-filter.sh');
    await writeFile(program, `#!/bin/sh\necho ran >> "${marker}"\ncat\n`, { mode: 0o755 });
    const sub = path.join(copy, 'sub');
    await mkdir(sub, { recursive: true });
    await agentGit(sub, 'init', '-q', '-b', 'main');
    await writeFile(path.join(sub, 'x.txt'), 'x\n');
    await agentGit(sub, 'add', 'x.txt');
    await agentGit(sub, 'commit', '-q', '-m', 'sub');
    const subHead = await agentGit(sub, 'rev-parse', 'HEAD');
    await agentGit(sub, 'config', 'filter.x.clean', program);
    await writeFile(path.join(sub, '.gitattributes'), '* filter=x\n');
    await agentGit(copy, 'update-index', '--add', '--cacheinfo', `160000,${subHead},sub`);
    await agentGit(copy, 'commit', '-q', '-m', 'add a submodule');
    // The fixture is live: plain git status in the copy runs the program.
    const later = new Date(Date.now() + 60_000);
    await utimes(path.join(sub, 'x.txt'), later, later);
    await agentGit(copy, 'status', '--porcelain');
    expect(existsSync(marker)).toBe(true);
    await writeFile(marker, '');
    const later2 = new Date(Date.now() + 120_000);
    await utimes(path.join(sub, 'x.txt'), later2, later2);

    await hasUncommittedChanges(copy, store.homeDir(ROOM_ID)).catch(() => undefined);
    await commitsAheadOfMain(copy, store.homeDir(ROOM_ID)).catch(() => undefined);

    expect(await readFile(marker, 'utf-8')).toBe('');
  });

  it('runs no filter, diff or merge driver a committed .gitattributes names, in the server`s merge', async () => {
    // `.gitattributes` is committed content an agent writes. A driver it names
    // is only a program when a config the SERVER reads defines it — and the
    // only such config is `repo/.git/config`, which no agent is granted. So a
    // merge of a branch carrying such attributes runs nothing.
    await service.enable(ROOM_ID, OPERATOR);
    const place = await resolveRoomTurnPlace(manager, ROOM_ID, ana, 'Ana');
    const copy = place.worktree!;
    const marker = path.join(scratch, 'driver-ran');
    const program = path.join(scratch, 'evil-driver.sh');
    await writeFile(program, `#!/bin/sh\necho ran >> "${marker}"\ncat\n`, { mode: 0o755 });
    // Drivers defined where an agent CAN write: its copy's own admin folder
    // (read only if worktree config were enabled) and a config file an
    // `include.path` could name. Neither may reach the server.
    const admin = path.join(store.repoPath(ROOM_ID), '.git', 'worktrees', path.basename(copy));
    await writeFile(
      path.join(admin, 'config.worktree'),
      `[filter "x"]\n\tclean = ${program}\n\tsmudge = ${program}\n[merge "x"]\n\tdriver = ${program}\n[diff "x"]\n\ttextconv = ${program}\n`
    );
    await writeFile(path.join(copy, '.gitattributes'), '* filter=x merge=x diff=x\n');
    await writeFile(path.join(copy, 'PLAN.md'), '# plan\n');
    await agentGit(copy, 'add', '-A');
    await agentGit(copy, 'commit', '-q', '-m', 'attributes');

    await mergeNoFf(
      store.repoPath(ROOM_ID),
      `room/${RoomWorktreeManager.slugFor('Ana', ana)}`,
      'Merge the plan',
      { name: 'Dorian', email: 'operator@dorkos.local' },
      store.homeDir(ROOM_ID)
    );
    await hasUncommittedChanges(store.repoPath(ROOM_ID), store.homeDir(ROOM_ID));

    expect(existsSync(marker)).toBe(false);
    expect(existsSync(path.join(store.repoPath(ROOM_ID), 'PLAN.md'))).toBe(true);
  });
});

describe('roomTurnLaunchStep', () => {
  function steps() {
    const retired: string[] = [];
    const busy = new Set<string>();
    const step = roomTurnLaunchStep(
      {
        boundSessionIds: () => ['s-room', 's-other'],
        isTurnInFlight: (id) => Promise.resolve(busy.has(id)),
        worktrees: {
          retireLegacyPlumbing: (roomId, worktree) => {
            retired.push(`${roomId}:${worktree}`);
            return Promise.resolve({ removed: 0, blockRemoved: false });
          },
          // No room files section to refresh in these cases; the refresh itself
          // is pinned over real git in `room-worktree-refresh.test.ts`.
          refreshTarget: () => null,
        },
        describeCommits: () => new Map(),
        forgetBaselines: () => {},
      },
      { roomId: 'r1', worktree: '/w/ana', agentPath: '/agents/ana', files: null }
    );
    return { step, retired, busy };
  }

  it('retires legacy plumbing at launch when no other bound session is running', async () => {
    const { step, retired } = steps();

    await expect(step('s-room')).resolves.toEqual({});
    expect(retired).toEqual(['r1:/w/ana']);
  });

  it('skips it while another session bound to the (room, agent) has a turn in flight', async () => {
    const { step, retired, busy } = steps();
    busy.add('s-other');

    await step('s-room');
    expect(retired).toEqual([]);

    busy.delete('s-other');
    await step('s-room');
    expect(retired).toEqual(['r1:/w/ana']);
  });

  it('does not count the launching session itself as busy (it holds its own lock)', async () => {
    const { step, retired, busy } = steps();
    busy.add('s-room');

    await step('s-room');
    expect(retired).toEqual(['r1:/w/ana']);
  });
});

describe('resolveRoomTurnPlace — what it never does', () => {
  const HOME = '/home/agents/api-bot';

  it('answers home with nothing granted when a real failure stops the copy', async () => {
    // A room turn must not fail over a folder: the agent answers from home and
    // is told nothing about files it cannot reach.
    const manager = {
      ensureWorktree: () => Promise.reject(new Error('git is not installed')),
    } as unknown as RoomWorktreeManager;

    await expect(resolveRoomTurnPlace(manager, 'room-1', HOME, 'API Bot')).resolves.toEqual({
      cwd: HOME,
      additionalDirectories: [],
      worktree: null,
      files: null,
    });
  });

  it('answers home on an install with no worktree manager', async () => {
    await expect(resolveRoomTurnPlace(null, 'room-1', HOME, 'API Bot')).resolves.toMatchObject({
      cwd: HOME,
      additionalDirectories: [],
    });
  });
});

describe('roomSessionPlace', () => {
  const AGENT = '/home/agents/api-bot';

  /** An author row of one kind, minus the render fields nothing here reads. */
  function author(kind: AuthorRecord['kind'], displayName: string): AuthorRecord {
    return {
      id: 'author-1',
      kind,
      naturalKey: AGENT,
      displayName,
      handle: null,
      emoji: null,
      color: null,
      imageUrl: null,
      mintedForManifestId: null,
      linkedOwnerKey: null,
      retiredAt: null,
    } as AuthorRecord;
  }

  const worktrees = () => null;

  it('names the room, the label the room shows, and the agent the room bound', () => {
    const place = roomSessionPlace({
      bindings: {
        bindingForSession: () => ({ roomId: 'room-1', authorId: 'author-1', sessionId: 's1' }),
      },
      authors: { getById: () => author('agent', 'Ana the Reviewer') },
      worktrees,
    });

    // The agent comes from the ROOM's binding, never from the message (DOR-2091).
    expect(place.roomFor('s1')).toEqual({
      roomId: 'room-1',
      agentName: 'Ana the Reviewer',
      agentPath: AGENT,
    });
  });

  it('answers nothing for a session no room is bound to, a non-agent, or a missing row', () => {
    const unbound = roomSessionPlace({
      bindings: { bindingForSession: () => undefined },
      authors: { getById: vi.fn(() => author('agent', 'API Bot')) },
      worktrees,
    });
    const human = roomSessionPlace({
      bindings: {
        bindingForSession: () => ({ roomId: 'room-1', authorId: 'author-1', sessionId: 's1' }),
      },
      authors: { getById: () => author('human', 'You') },
      worktrees,
    });
    const gone = roomSessionPlace({
      bindings: {
        bindingForSession: () => ({ roomId: 'room-1', authorId: 'gone', sessionId: 's1' }),
      },
      authors: { getById: () => null },
      worktrees,
    });

    expect(unbound.roomFor('s1')).toBeNull();
    expect(human.roomFor('s1')).toBeNull();
    expect(gone.roomFor('s1')).toBeNull();
  });

  it('keeps an OpenCode session created in the copy there — it cannot move home', async () => {
    const COPY = '/dork/rooms/r1/worktrees/api-bot-1a2b3c4d';
    const manager = {
      ensureWorktree: () => Promise.resolve({ path: COPY, repo: '/dork/rooms/r1/repo' }),
      turnFilesContext: () => Promise.resolve(null),
    } as unknown as RoomWorktreeManager;
    const opencodeIn = (dir: string) => () =>
      Promise.resolve({
        type: 'opencode',
        getSession: () => Promise.resolve({ cwd: dir } as never),
        getSessionCwd: () => undefined,
      });

    const stuck = await roomSessionPlace({
      bindings: { bindingForSession: () => undefined },
      authors: { getById: () => null },
      worktrees: () => manager,
      sessionRuntime: opencodeIn(COPY),
    }).placeTurn('r1', AGENT, 'API Bot', 'oc-old');
    const moved = await roomSessionPlace({
      bindings: { bindingForSession: () => undefined },
      authors: { getById: () => null },
      worktrees: () => manager,
      sessionRuntime: opencodeIn(AGENT),
    }).placeTurn('r1', AGENT, 'API Bot', 'oc-home');

    expect(stuck).toEqual({
      cwd: COPY,
      additionalDirectories: [],
      worktree: COPY,
      standsInCopy: true,
    });
    expect(moved.cwd).toBe(AGENT);
    expect(moved.standsInCopy).toBeUndefined();
  });

  it('places an app-resumed turn exactly as a room turn is placed: at home', async () => {
    const place = roomSessionPlace({
      bindings: { bindingForSession: () => undefined },
      authors: { getById: () => null },
      worktrees,
    });

    await expect(place.placeTurn('room-1', AGENT, 'API Bot')).resolves.toEqual({
      cwd: AGENT,
      additionalDirectories: [],
      worktree: null,
    });
  });
});
