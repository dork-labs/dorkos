/**
 * Bring an agent's copy of a room's files up to date when its room turn
 * launches — or leave it alone and say what moved (spec `agent-home-desk` §6,
 * ADR 260926-180308).
 *
 * **This is the one place the server writes into an agent's worktree** (the
 * exception invariant I6 names), so it is built as a list of reasons NOT to,
 * each one a git read made at launch, and one write at the end that can only
 * fast-forward. Every precondition has a negative test over real git in
 * `__tests__/room-worktree-refresh.test.ts`.
 *
 * The steps, in order, each a git query under `--no-optional-locks` except the
 * one write. Every command goes through `room-repo-git.ts`, which pins a command
 * run in a room worktree to the room's own git storage, with hooks off and no
 * config an agent can write:
 *
 * 1. Capture `main`'s tip ONCE. Everything after uses that sha, never `main` by
 *    name, so a merge landing mid-refresh cannot move the target.
 * 2. `HEAD` must be the copy's own branch, `room/<slug>` — otherwise
 *    `off-branch`. A detached `HEAD` is off-branch too.
 * 3. No tracked or untracked change (`status --untracked-files=all`), and no
 *    file marked assume-unchanged or skip-worktree, whose edits `status` cannot
 *    see (`ls-files -v`) — otherwise `changes`.
 * 4. No commit `main` lacks — otherwise `ahead`.
 * 5. Already at the tip — `current`.
 * 6. **Nothing on disk in the way, in either direction.** No untracked or
 *    ignored file may sit at, inside, or above any path the fast-forward would
 *    touch — otherwise `changes`. Git's fast-forward silently overwrites an
 *    ignored file `main` now tracks, and silently deletes ignored files under a
 *    folder `main` turns into a file, both exiting 0. This step is the only
 *    thing that stops either.
 * 7. `merge --ff-only <tip>` (the only write). A failure is `unreadable`, logged,
 *    and nothing else is attempted.
 *
 * Whether another turn of this agent in this room is running is asked by the
 * caller BEFORE any of this (no git call at all when one is), and again here
 * immediately before the write, because the reads above take time.
 *
 * A copy that is held is told what moved on `main` since it branched ({@link
 * whatMoved}), named from the room log rather than from git.
 *
 * @module server/services/rooms/repo/room-worktree-refresh
 */
import { existsSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import type {
  MainMoved,
  MainMovedCommit,
  RoomContextFiles,
  WorktreeRefreshOutcome,
} from '@dorkos/shared/additional-context';
import { logger } from '../../../lib/logger.js';
import { RoomError } from '../room-errors.js';
import { aheadBehind, assertRoomRepoConfigSafe, runGit, runGitRaw } from './room-repo-git.js';

/** How many of `main`'s commits the heads-up lists before "and N more". */
const MAIN_MOVED_MAX_COMMITS = 8;

/** How many files each listed commit names. */
const MAIN_MOVED_MAX_FILES = 8;

/** The agent's copy being refreshed, and where its room keeps its git. */
export interface RoomWorktreeRefreshTarget {
  /** The copy, `<room home>/worktrees/<slug>`, as the worktree manager named it. */
  worktree: string;
  /** The room's shared checkout, `<room home>/repo`. */
  repo: string;
  /** The room's home — git's discovery ceiling, and the root of the pin. */
  ceiling: string;
  /** The copy's own branch, `room/<slug>`. */
  branch: string;
}

/** What {@link refreshRoomWorktree} asks the rest of the server. */
export interface RoomWorktreeRefreshDeps {
  /**
   * Whether every OTHER session bound to this (room, agent) is still idle —
   * asked again immediately before the write. `false` holds the copy `busy`.
   */
  stillIdle(): Promise<boolean>;
  /**
   * The room entries that announced these commits: `merge` (an agent's work
   * merged) or `person` (a person's file change), with the display name of the
   * member each entry is about. A sha missing from the answer is `other`.
   */
  describeCommits(
    shas: readonly string[]
  ): Map<string, { kind: 'merge' | 'person'; who: string | null }>;
  /** Forget diff baselines for files the refresh moved, by absolute path. */
  forgetMoved(absPaths: readonly string[]): void;
  /** How long the fast-forward may run; {@link FAST_FORWARD_TIMEOUT_MS} when absent. */
  writeTimeoutMs?: number;
}

/**
 * How long the one write may run before it is killed — four times a read's
 * budget. A fast-forward writes every file `main` changed, and the room's caps
 * bound that, but a slow disk under a large merge is the case a 30-second
 * ceiling would cut in half.
 */
const FAST_FORWARD_TIMEOUT_MS = 120_000;

/**
 * The index lock git takes in a linked worktree's own admin folder, from the
 * room's layout (the same pin every command here runs under).
 *
 * @param target - The copy.
 */
function indexLockOf(target: RoomWorktreeRefreshTarget): string {
  return path.join(target.repo, '.git', 'worktrees', path.basename(target.worktree), 'index.lock');
}

/**
 * Whether a git call ended because it was KILLED — its timeout fired, or a
 * signal stopped it — rather than because git exited with an error.
 *
 * @param err - What `execFile` rejected with.
 */
function wasKilled(err: unknown): boolean {
  const e = err as { killed?: unknown; signal?: unknown } | null;
  return e !== null && typeof e === 'object' && (e.killed === true || typeof e.signal === 'string');
}

/**
 * Clean up after a fast-forward that failed.
 *
 * **The lock is removed only when the write was KILLED.** A git process killed
 * mid-checkout leaves the `index.lock` it held, and every later git command in
 * the copy — the agent's own included — then refuses to run. A git that merely
 * FAILED left nothing: git removes its own lock on every exit it controls. The
 * common failure is the lock itself — a person's shell, a git GUI or a leftover
 * process took it between the idle check and the write, and the merge refused
 * with "index.lock: File exists" — and that lock belongs to a process that may
 * still be running, so it is never touched. A lock that was there before the
 * write started is never touched either. The residual, stated: another process
 * taking the lock in the instant after ours was killed and before this runs.
 *
 * **What is NOT restored:** files the checkout had already written. Nothing is
 * reset, because a reset is a second write on a tree in an unknown state. The
 * cost, stated plainly: the copy then holds files `main` wrote that its branch
 * does not have, so it reads as changed, every later launch holds it as
 * `changes`, and `git merge main` in it refuses until those files are
 * discarded by hand. Nothing is lost; the warning below names the copy.
 *
 * @param lock - The copy's index lock.
 * @param lockedBefore - Whether it existed before the write started.
 * @param err - What the write threw.
 */
export function afterFailedWrite(lock: string, lockedBefore: boolean, err: unknown): void {
  if (lockedBefore || !wasKilled(err) || !existsSync(lock)) return;
  try {
    rmSync(lock, { force: true });
    logger.warn(
      '[rooms] a fast-forward of an agent’s copy stopped partway; removed its lock. The copy may ' +
        'hold half-written files from main, which must be discarded before it can sync again',
      { worktree: path.basename(path.dirname(lock)) }
    );
  } catch (err) {
    logger.warn('[rooms] could not remove the lock a stopped fast-forward left', {
      worktree: path.basename(path.dirname(lock)),
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** A git failure that means "not this copy's own branch", not "unreadable". */
const SYMBOLIC_REF_DETACHED_EXIT = 1;

/**
 * Run one read-only query in the copy, without taking optional locks (a status
 * read would otherwise rewrite the index the agent's own git is using).
 *
 * @param target - The copy.
 * @param args - The git arguments after `--no-optional-locks`.
 */
function query(target: RoomWorktreeRefreshTarget, args: string[]): Promise<string> {
  return runGit(['--no-optional-locks', ...args], target.worktree, target.ceiling);
}

/**
 * Run one read-only `-z` query and answer its entries, untrimmed — a path may
 * begin or end with a space, and a porcelain status line begins with one.
 *
 * @param target - The copy.
 * @param args - The git arguments after `--no-optional-locks`; include `-z`.
 */
async function queryList(target: RoomWorktreeRefreshTarget, args: string[]): Promise<string[]> {
  const out = await runGitRaw(['--no-optional-locks', ...args], target.worktree, target.ceiling);
  return nulList(out.toString('utf-8'));
}

/**
 * Split NUL-separated git output into its entries.
 *
 * @param out - The output of a `-z` command.
 */
function nulList(out: string): string[] {
  return out.split('\0').filter((entry) => entry.length > 0);
}

/**
 * Every path a porcelain v1 `-z` status names, both sides of a rename included.
 *
 * @param records - `status --porcelain=v1 -z` entries.
 */
function statusPaths(records: readonly string[]): string[] {
  const paths: string[] = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i]!;
    const xy = record.slice(0, 2);
    paths.push(record.slice(3));
    // A rename or copy is followed by one more record: the path it came from.
    if (xy.includes('R') || xy.includes('C')) {
      i += 1;
      if (records[i] !== undefined) paths.push(records[i]!);
    }
  }
  return paths;
}

/**
 * A path as the relation check compares it: no trailing slash (git names a
 * nested repository `sub/`), NFC, and lower case. Folding case and
 * normalization can only make more paths related — more copies held, never
 * fewer — which is the safe direction on a case-insensitive disk, where
 * `Notes.log` on disk and `notes.log` on `main` are the same file.
 *
 * @param p - A repo-relative path.
 */
function comparable(p: string): string {
  return p.replace(/\/+$/, '').normalize('NFC').toLowerCase();
}

/**
 * Whether an untracked or ignored path `u` is in the way of a path `p` the
 * fast-forward touches: the same path, inside it, or a parent of it.
 *
 * @param u - A path on disk git does not track.
 * @param p - A path the fast-forward adds, changes or removes.
 */
export function pathsCollide(u: string, p: string): boolean {
  const a = comparable(u);
  const b = comparable(p);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * The first untracked-or-ignored path that sits in the way of the fast-forward,
 * or `null` when none does.
 *
 * @param onDisk - Every file git does not track, listed file by file.
 * @param moved - Every path the fast-forward adds, changes or removes.
 */
export function firstCollision(
  onDisk: readonly string[],
  moved: readonly string[]
): { onDisk: string; moved: string } | null {
  // Indexed rather than compared pairwise: an ignored `node_modules` lists every
  // file in it, and pairs of those with each moved path would be millions of
  // comparisons. A moved path and each folder above it are looked up instead,
  // which answers the same three relations (see {@link pathsCollide}).
  const movedAt = new Map<string, string>();
  const aboveMoved = new Map<string, string>();
  for (const p of moved) {
    const key = comparable(p);
    movedAt.set(key, p);
    for (const parent of ancestors(key)) if (!aboveMoved.has(parent)) aboveMoved.set(parent, p);
  }
  for (const u of onDisk) {
    const key = comparable(u);
    // `u` is a moved path, or a folder above one.
    const hit = movedAt.get(key) ?? aboveMoved.get(key);
    if (hit !== undefined) return { onDisk: u, moved: hit };
    // `u` is inside a moved path.
    for (const parent of ancestors(key)) {
      const inside = movedAt.get(parent);
      if (inside !== undefined) return { onDisk: u, moved: inside };
    }
  }
  return null;
}

/**
 * Every folder above a path: `a/b/c` → `a/b`, `a`.
 *
 * @param p - A comparable path.
 */
function ancestors(p: string): string[] {
  const out: string[] = [];
  for (let cut = p.lastIndexOf('/'); cut > 0; cut = p.lastIndexOf('/', cut - 1)) {
    out.push(p.slice(0, cut));
  }
  return out;
}

/**
 * Whether a git call was refused because the room's shared settings name a
 * program (`assertRoomRepoConfigSafe` in `room-repo-git.ts`).
 *
 * @param err - What the call threw.
 */
function isUnsafeConfig(err: unknown): boolean {
  return err instanceof RoomError && err.code === 'ROOM_REPO_CONFIG_UNSAFE';
}

/**
 * The copy held because the room's settings are unsafe. The refusal's message —
 * the file, the offending entries and how to remove each — goes to the log,
 * where the operator reads it; the agent is told the fact and who fixes it.
 *
 * @param err - The refusal.
 * @param mainTip - The captured tip, when step 1 had run.
 */
function unsafeConfig(
  err: unknown,
  mainTip: string | null
): { outcome: WorktreeRefreshOutcome; mainTip: string | null } {
  logger.warn('[rooms] left an agent’s copy of the room’s files alone: unsafe git settings', {
    error: err instanceof Error ? err.message : String(err),
  });
  return { outcome: { kind: 'held', reason: 'unsafe-config', moved: null }, mainTip };
}

/**
 * Fast-forward an agent's copy of a room's files to `main`, when — and only
 * when — nothing in it could be lost (module doc, steps 1-7).
 *
 * Never throws: every git failure is `held: unreadable` and a log line.
 *
 * @param target - The copy and its room's git.
 * @param deps - The reads above.
 * @returns What was done, and for a held copy what moved on `main`.
 */
export async function refreshRoomWorktree(
  target: RoomWorktreeRefreshTarget,
  deps: RoomWorktreeRefreshDeps
): Promise<{ outcome: WorktreeRefreshOutcome; mainTip: string | null }> {
  const log = { worktree: path.basename(target.worktree) };
  const unreadable = (
    step: string,
    err: unknown,
    mainTip: string | null,
    moved: MainMoved | null
  ) => {
    if (isUnsafeConfig(err)) return unsafeConfig(err, mainTip);
    logger.warn('[rooms] could not read an agent’s copy of the room’s files; left it as it was', {
      ...log,
      step,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      outcome: { kind: 'held', reason: 'unreadable', moved } as WorktreeRefreshOutcome,
      mainTip,
    };
  };

  // 0. The room's shared git settings name no program git would run. Every
  //    command below re-asks (the audit sits in `runGitRaw`, cached by the
  //    file's stamp), so settings written mid-refresh stop it too — including
  //    the fast-forward, whose checkout is what would run a smudge filter.
  try {
    await assertRoomRepoConfigSafe(target.ceiling);
  } catch (err) {
    if (isUnsafeConfig(err)) return unsafeConfig(err, null);
    return unreadable('settings', err, null, null);
  }

  // 1. The target, captured once.
  let mainTip: string;
  try {
    mainTip = await query(target, ['rev-parse', '--verify', '--quiet', 'refs/heads/main^{commit}']);
    if (!/^[0-9a-f]{40,64}$/.test(mainTip)) throw new Error(`not a commit: ${mainTip}`);
  } catch (err) {
    return unreadable('main', err, null, null);
  }
  const held = async (
    reason: 'changes' | 'ahead' | 'off-branch'
  ): Promise<{ outcome: WorktreeRefreshOutcome; mainTip: string }> => ({
    outcome: { kind: 'held', reason, moved: await whatMoved(target, mainTip, deps) },
    mainTip,
  });

  try {
    // 2. On its own branch.
    let head: string;
    try {
      head = await query(target, ['symbolic-ref', '--quiet', 'HEAD']);
    } catch (err) {
      if ((err as { code?: unknown }).code === SYMBOLIC_REF_DETACHED_EXIT) {
        return await held('off-branch');
      }
      throw err;
    }
    if (head !== `refs/heads/${target.branch}`) return await held('off-branch');

    // 3. No tracked or untracked change.
    const status = await queryList(target, [
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      '--ignore-submodules=none',
      '-z',
    ]);
    if (status.length > 0) return await held('changes');
    // `status` cannot see an edit to a file marked assume-unchanged or
    // skip-worktree — git has been told not to look — and a fast-forward
    // overwrites it. `ls-files -v` tags such a file with a lower-case letter
    // (assume-unchanged) or `S` (skip-worktree); either is work in progress
    // nobody can prove is not there.
    const tagged = await queryList(target, ['ls-files', '-v', '-z']);
    if (tagged.some((entry) => /^[a-zS]/.test(entry))) return await held('changes');

    // 4. Nothing `main` lacks.
    const ahead = Number.parseInt(
      await query(target, ['rev-list', '--count', `${mainTip}..HEAD`]),
      10
    );
    if (!Number.isFinite(ahead)) throw new Error('could not count commits ahead of main');
    if (ahead > 0) return await held('ahead');

    // 5. Already there.
    const from = await query(target, ['rev-parse', '--verify', 'HEAD^{commit}']);
    if (from === mainTip) return { outcome: { kind: 'current' }, mainTip };

    // 6. Nothing on disk in the way, in either direction. `--no-renames`, or a
    //    rename would name only its new path and the old one would go unchecked.
    //    `ls-files --others` with no exclude rules is every file git does not
    //    track — the ignored ones and the untracked ones together — listed file
    //    by file.
    const moved = await queryList(target, [
      'diff',
      '--name-only',
      '--no-renames',
      '-z',
      from,
      mainTip,
    ]);
    const onDisk = await queryList(target, ['ls-files', '--others', '-z']);
    const collision = firstCollision(onDisk, moved);
    if (collision) {
      logger.info('[rooms] a file in an agent’s copy is in the way of main; not updating it', {
        ...log,
      });
      return await held('changes');
    }

    // Another turn of this agent in this room may have started while the reads
    // above ran. Asked last, right before the write.
    if (!(await deps.stillIdle())) {
      return { outcome: { kind: 'held', reason: 'busy', moved: null }, mainTip };
    }

    // 7. The only write, with a longer leash than a read: killing a checkout
    //    halfway leaves the tree halfway (see `afterFailedWrite`).
    const lock = indexLockOf(target);
    const lockedBefore = existsSync(lock);
    try {
      await runGit(
        ['-c', 'merge.autoStash=false', 'merge', '--ff-only', '--quiet', '--no-stat', mainTip],
        target.worktree,
        target.ceiling,
        { timeoutMs: deps.writeTimeoutMs ?? FAST_FORWARD_TIMEOUT_MS }
      );
      const landed = await query(target, ['rev-parse', '--verify', 'HEAD^{commit}']);
      if (landed !== mainTip) throw new Error(`landed on ${landed}, not ${mainTip}`);
    } catch (err) {
      afterFailedWrite(lock, lockedBefore, err);
      // Some of the moved files may have been written before it stopped.
      deps.forgetMoved(movedAbsPaths(target.worktree, moved));
      return unreadable('fast-forward', err, mainTip, null);
    }

    deps.forgetMoved(movedAbsPaths(target.worktree, moved));
    logger.info('[rooms] brought an agent’s copy of the room’s files up to date', {
      ...log,
      files: moved.length,
    });
    return { outcome: { kind: 'refreshed', from, to: mainTip, paths: moved }, mainTip };
  } catch (err) {
    return unreadable('read', err, mainTip, await whatMoved(target, mainTip, deps));
  }
}

/**
 * Absolute spellings of the moved files — through the copy's path as named, and
 * through its real path when that differs — so a baseline captured under either
 * is forgotten.
 *
 * @param worktree - The copy.
 * @param moved - Repo-relative paths.
 */
function movedAbsPaths(worktree: string, moved: readonly string[]): string[] {
  const roots = new Set([worktree]);
  try {
    roots.add(realpathSync(worktree));
  } catch {
    // The named spelling is the one captured; the real one is a courtesy.
  }
  const out: string[] = [];
  for (const root of roots) for (const rel of moved) out.push(path.join(root, rel));
  return out;
}

/**
 * What moved on `main` since the copy branched (spec §6.2): `main`'s own
 * first-parent history from the branch point to the captured tip, newest
 * first, each commit named from the room entry that announced it, plus the
 * files this agent has also changed.
 *
 * **`--first-parent`, because merges are `--no-ff`.** Without it every commit an
 * agent made on its branch is listed and eats the cap; with it, `main`'s history
 * is exactly one commit per merge and one per person change.
 *
 * Never throws: a copy whose history cannot be read is told nothing about it.
 *
 * @param target - The copy.
 * @param mainTip - The captured tip.
 * @param deps - Where commit names come from.
 * @returns What moved, or `null` when git could not say.
 */
async function whatMoved(
  target: RoomWorktreeRefreshTarget,
  mainTip: string,
  deps: Pick<RoomWorktreeRefreshDeps, 'describeCommits'>
): Promise<MainMoved | null> {
  try {
    const base = await query(target, ['merge-base', 'HEAD', mainTip]);
    const range = `${base}..${mainTip}`;
    const total = Number.parseInt(
      await query(target, ['rev-list', '--first-parent', '--count', range]),
      10
    );
    if (!Number.isFinite(total) || total === 0) return { commits: [], overflow: 0, overlap: [] };
    const log = await queryList(target, [
      'log',
      '--first-parent',
      `--max-count=${MAIN_MOVED_MAX_COMMITS}`,
      '-z',
      '--format=%H%x1f%s',
      range,
    ]);
    const listed = log.map((record) => {
      const cut = record.indexOf('\x1f');
      return { sha: record.slice(0, cut), subject: record.slice(cut + 1) };
    });
    const named = deps.describeCommits(listed.map((c) => c.sha));
    const commits: MainMovedCommit[] = [];
    for (const { sha, subject } of listed) {
      let files: string[] = [];
      try {
        files = await queryList(target, [
          'diff',
          '--name-only',
          '--no-renames',
          '-z',
          `${sha}^1`,
          sha,
        ]);
      } catch {
        // A commit with no parent on `main`'s side — nothing to name.
      }
      const note = named.get(sha);
      commits.push({
        sha,
        who: note?.who ?? null,
        subject,
        kind: note?.kind ?? 'other',
        files: files.slice(0, MAIN_MOVED_MAX_FILES),
        fileCount: files.length,
      });
    }
    const onMain = await queryList(target, [
      'diff',
      '--name-only',
      '--no-renames',
      '-z',
      base,
      mainTip,
    ]);
    const mine = new Set([
      ...(await queryList(target, ['diff', '--name-only', '--no-renames', '-z', base, 'HEAD'])),
      ...statusPaths(
        await queryList(target, ['status', '--porcelain=v1', '--untracked-files=all', '-z'])
      ),
    ]);
    const overlap = onMain.filter((file) => mine.has(file)).sort();
    return { commits, overflow: Math.max(0, total - commits.length), overlap };
  } catch (err) {
    logger.debug('[rooms] could not read what moved on a room’s main', {
      worktree: path.basename(target.worktree),
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * The files section as the turn launches: the refresh's outcome, and the
 * ahead/behind counts measured again against the tip it captured — so the
 * section tells the model about the files as they are on disk when it starts
 * (invariant I8).
 *
 * @param target - The copy.
 * @param placed - The section as placement measured it.
 * @param deps - The reads the refresh needs.
 */
export async function launchFiles(
  target: RoomWorktreeRefreshTarget,
  placed: RoomContextFiles,
  deps: RoomWorktreeRefreshDeps
): Promise<RoomContextFiles> {
  const { outcome, mainTip } = await refreshRoomWorktree(target, deps);
  if (outcome.kind === 'refreshed' || outcome.kind === 'current') {
    return { ...placed, ahead: 0, behind: 0, refresh: outcome };
  }
  if (outcome.reason === 'busy' || outcome.reason === 'unsafe-config' || mainTip === null) {
    return { ...placed, refresh: outcome };
  }
  try {
    const { ahead, behind } = await aheadBehind(
      target.repo,
      mainTip,
      `refs/heads/${target.branch}`,
      target.ceiling
    );
    return { ...placed, ahead, behind, refresh: outcome };
  } catch {
    return { ...placed, ahead: null, behind: null, refresh: outcome };
  }
}
