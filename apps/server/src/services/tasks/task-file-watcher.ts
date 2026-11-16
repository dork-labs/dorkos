/**
 * Watches the roots where scheduled work can live and syncs what it finds to
 * the DB cache and the running scheduler.
 *
 * ## The watch is the fast path, never the guarantee
 *
 * The first three holes below were measured on macOS with chokidar 5 and
 * Node 24 (DOR-1850 found them under `services/harness/skills-watcher.ts`;
 * DOR-1908 reproduced them here). The fourth was reproduced with Node 22.
 *
 * 1. **A root that does not exist when the watch opens is deaf — 100%, and for
 *    the life of the process.** chokidar watches the nearest EXISTING ancestor
 *    instead, and never picks the directory up when it appears: measured here,
 *    `getWatched()` still held no entry for it ten seconds after the `mkdir`,
 *    and not one event of any kind arrived. {@link armWatch} refuses to pretend,
 *    and {@link TASK_WATCH_REARM_MS} is what comes back for it.
 * 2. **A file written in the moments after `ready` is dropped 13-40% of the
 *    time.** The same watcher given {@link TASK_WATCH_SETTLE_MS} to settle first
 *    missed 0 of 40. It is a startup artefact rather than an ongoing loss rate —
 *    a server's watchers live for hours and are past the window before anything
 *    happens — but "the moments after a watch opens" is exactly when a re-armed
 *    root's first schedule lands.
 * 3. **A watch that has died reports nothing, for ever, and says so once.**
 *    Kernel watch descriptors are shared and finite, and this repo is routinely
 *    several agents plus the operator's own two servers on one machine. Measured
 *    here while building DOR-1908: `fs.watch` raised
 *    `EMFILE: too many open files, watch` on 80 of 80 trial watches, after which
 *    the `add` for a file written into the watched directory never arrived. The
 *    initial scan still works; only live notification dies.
 *
 * 4. **A directory burst can name only one new child.** A real root rename
 *    reached chokidar for a backup sibling while the adjacent task directory
 *    never entered its watch set. Directory cues now coalesce a follow-up scan;
 *    complete native silence still belongs to the periodic reconciler.
 *
 * So nothing here treats a chokidar event as the mechanism that keeps the
 * promise. Three things do:
 *
 * - **The catch-up scan.** Every time a watch is armed, the root is scanned once
 *   the watch has settled ({@link scanTaskWatchRoot}). That is what builds the row set
 *   at boot, what discovers the schedules already sitting in a directory that
 *   has just appeared, and what closes hole 2 — it runs *after* the unreliable
 *   window, and it does not depend on chokidar delivering anything.
 * - **The re-arm.** Every {@link TASK_WATCH_REARM_MS} a root with no watch is
 *   checked for its directory, and armed the moment it exists. This is the whole
 *   latency of a project's FIRST schedule.
 * - **The reconciler.** {@link TaskFileWatcher} reports which roots have no live
 *   watch ({@link TaskFileWatcher.rootsWithoutLiveWatch}), and `TaskReconciler`
 *   covers exactly those on a ten-second cadence instead of five minutes. A
 *   deaf or dead root is the case the five-minute pass was silently five minutes
 *   late for.
 *
 * ## Why a DEAD root is never re-armed
 *
 * {@link rearm} deliberately only looks at roots that are `deaf`. A dead one
 * stays dead for the life of the process, and that is a decision rather than an
 * omission — retrying it on the ten-second tick was measured and is worse on
 * three counts:
 *
 * - **Every successful re-arm runs a full catch-up scan** — ~295 ms on the root
 *   measured. On a ten-second tick that is a scan of the same directory six
 *   times a minute, for ever, for a watch that has no way of telling us it is
 *   working again.
 * - **The `seenCodes` latch lives in the per-arm closure**, so each re-arm gets
 *   a fresh one. A root that flaps would therefore log its `EMFILE` line every
 *   ten seconds — the exact log storm the latch exists to prevent.
 * - **It adds pressure to the thing that failed.** `EMFILE` means the machine is
 *   out of watch descriptors; asking for another one on a timer is not a
 *   recovery strategy.
 *
 * The cost of leaving it dead is bounded and known: one `readdir` plus one
 * `stat` per entry per tick, for that root only. If recovery is ever worth
 * building, it needs all three of: ride the five-minute pass rather than the
 * ten-second one, hoist the latch from the closure onto {@link WatchedRoot} so
 * repeats stay suppressed across arms, and gate the post-arm scan on the
 * recorded shape so a re-arm that finds nothing changed costs nothing.
 *
 * @module services/tasks/task-file-watcher
 */
import { outsideAuditScope, runOutsideAuditScope } from '../audit/audit-context.js';
import chokidar, { type FSWatcher } from 'chokidar';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { TaskStore } from './task-store.js';
import type { TaskRegistrar } from './task-registrar.js';
import type { ScheduleIdentityRegistry } from './schedule-identity.js';
import { SKILL_FILENAME } from '@dorkos/skills/constants';
import { isInstallSiblingName } from '@dorkos/shared/marketplace-schemas';
import { readTaskRootFile, type ReadOutcome } from './skills-root-discovery.js';
import { carrySwitchIntoReleasedFile, packageOwnershipInRoot } from './task-file-update.js';
import { fileAgentLevel } from './sync/file-agent-level.js';
import { reservedDirsFor, type TaskRoot } from './skills-roots.js';
import {
  dropProjectCopies,
  projectOnlyTargets,
  syncProjectCopies,
} from './sync/project-only-schedules.js';
import { logger } from '../../lib/logger.js';
import {
  TaskWatchCatchUp,
  scanTaskWatchRoot,
  drainTaskWatchWork,
} from './watch/task-watch-catch-up.js';

/**
 * How long a file must stop changing before chokidar reports it, and how often
 * that is checked.
 *
 * `services/harness/skills-watcher.ts` copies both numbers: the two watchers
 * read the same `.agents/skills` directory, and a file that is "finished" for
 * one and not the other would be a difference nobody could explain.
 */
const TASK_WRITE_STABILITY_MS = 50;

/** @see {@link TASK_WRITE_STABILITY_MS} */
const TASK_WRITE_POLL_MS = 25;

/**
 * How often a root whose directory did not exist is checked to see whether it
 * does now.
 *
 * One `existsSync` per such root per tick, and only for roots that have no watch
 * — a root that already exists never reaches it. Short, because this is the
 * whole latency of the FIRST schedule in a project, and because the alternative
 * measured on this code was "never".
 */
export const TASK_WATCH_REARM_MS = 1_000;

/**
 * How long after chokidar reports `ready` a watch is treated as live.
 *
 * Measured against chokidar 5 on macOS: a file written in the instant after
 * `ready` is never reported 13-40% of the time, while the same watcher given
 * this long to settle first missed 0 of 40. The catch-up scan runs at the END of
 * this window, so what the wait buys is that the scan sees a directory the watch
 * is already reporting on rather than one it is not.
 */
export const TASK_WATCH_SETTLE_MS = 100;

/**
 * The tightened cadence, in seconds, purely so the watcher's error line can say
 * what happens next.
 *
 * Declared here rather than imported from `task-reconciler.ts` because that
 * module imports this one; the reconciler's own constant is derived from this,
 * so the two cannot disagree.
 */
export const UNWATCHED_ROOT_SWEEP_SECONDS = 10;

/**
 * Which roots the reconciler has to cover itself, because their watch is not
 * delivering.
 *
 * The reconciler asks rather than being told, so a root that goes deaf or dies
 * between two passes is picked up by the next one without any signal having to
 * arrive intact.
 */
export interface TaskWatchHealth {
  /**
   * The directories of every registered root whose watch is absent or dead.
   *
   * Absent means the directory did not exist when the watch was last armed;
   * dead means chokidar reported an error on it, after which it reports nothing
   * at all. Both are total losses for that root rather than a loss rate, which
   * is why the answer is a set of roots and not a probability.
   */
  rootsWithoutLiveWatch(): readonly string[];
}

/** How a root's watch is doing. */
type WatchStatus =
  /** The directory does not exist, so there is nothing to watch yet. */
  | 'deaf'
  /** A watch is open and has reported no failure. */
  | 'live'
  /** chokidar reported an error; the watch reports nothing from here on. */
  | 'dead';

/** One registered root and the watch over it, if there is one. */
interface WatchedRoot {
  /** The root itself — what a scan needs to know about the directory. */
  root: TaskRoot;
  /** The open watch, absent while the directory does not exist. */
  watcher?: FSWatcher;
  /** {@link WatchStatus}. */
  status: WatchStatus;
  /** Resolves once the current watch has settled and its catch-up scan is done. */
  settled: Promise<void>;
  catchUp?: TaskWatchCatchUp;
}

/** Options only tests set. */
export interface TaskFileWatcherOptions {
  /** Override {@link TASK_WATCH_REARM_MS}; `0` switches re-arming off. @internal For tests. */
  rearmMs?: number;
  /** Override {@link TASK_WATCH_SETTLE_MS}. @internal For tests. */
  settleMs?: number;
}

/**
 * Watches skills roots for file changes and syncs them to the DB cache and the
 * scheduler.
 *
 * One kind of root since DOR-1486: `{dorkHome}/skills/` and every registered
 * agent's `{projectPath}/.agents/skills/`. Files are read with the unified skill
 * schema, and only those carrying a `schedule:` block become schedules.
 *
 * The scheduler half runs through {@link TaskRegistrar}, which is what makes an
 * edit on disk take effect now rather than at the next restart. This class used
 * to take a `(taskSlug: string) => void` callback for that, and the one caller
 * in `index.ts` passed `() => {}` — so every on-disk change updated the row and
 * nothing else.
 */
export class TaskFileWatcher implements TaskWatchHealth {
  /** Every root handed to {@link watch}, keyed on its directory. */
  private watched = new Map<string, WatchedRoot>();
  /** The re-arm timer, started with the first root and stopped with the last. */
  private rearmTimer?: ReturnType<typeof setInterval>;
  private readonly rearmMs: number;
  private readonly settleMs: number;
  private stopped = false;
  private stopping?: Promise<void>;
  private readonly closing = new Set<Promise<void>>();

  constructor(
    private store: TaskStore,
    private registrar: TaskRegistrar,
    private identities: ScheduleIdentityRegistry,
    opts: TaskFileWatcherOptions = {}
  ) {
    this.rearmMs = opts.rearmMs ?? TASK_WATCH_REARM_MS;
    this.settleMs = opts.settleMs ?? TASK_WATCH_SETTLE_MS;
  }

  /**
   * Watch one root for SKILL.md changes.
   *
   * Safe to call for a directory that does not exist: the root is taken on all
   * the same, and a watch is opened the moment the directory appears. Before
   * DOR-1908 this pointed chokidar at the path regardless, which watches an
   * ancestor and never reports anything about the root — so a project whose
   * `.agents/skills` had not been created yet was deaf for the whole life of the
   * process, and the only thing that ever noticed its first schedule was the
   * five-minute reconciler.
   *
   * @param root - The directory to watch and how to read what is in it.
   */
  watch(root: TaskRoot): void {
    if (this.stopped) return;
    if (this.watched.has(root.dir)) {
      logger.warn(`[TaskFileWatcher] Already watching ${root.dir} — skipping duplicate`);
      return;
    }
    const state: WatchedRoot = { root, status: 'deaf', settled: Promise.resolve() };
    this.watched.set(root.dir, state);
    this.armWatch(state);
    this.startRearming();
  }

  /**
   * Stop watching one root (e.g. on agent unregister).
   *
   * The root's identity claims go with it: a root nobody watches must not keep
   * owning files another root can still see (see {@link ScheduleIdentityRegistry}).
   *
   * The root is dropped from the watched set rather than merely closed, so the
   * re-arm never brings it back — an unregistered agent's directory reappearing
   * on disk must not silently resume discovery.
   *
   * @param tasksDir - The root's directory.
   */
  async stopWatching(tasksDir: string): Promise<void> {
    const state = this.watched.get(tasksDir);
    if (!state) return;
    this.watched.delete(tasksDir);
    if (this.watched.size === 0) this.stopRearming();
    this.identities.releaseRoot(tasksDir);
    const closing = drainTaskWatchWork([
      state.catchUp?.stop(),
      Promise.resolve().then(() => state.watcher?.close()),
    ]);
    this.closing.add(closing);
    try {
      await closing;
    } finally {
      this.closing.delete(closing);
    }
    logger.info(`[TaskFileWatcher] Stopped watching ${tasksDir}`);
  }

  /** Stop all watchers (server shutdown). */
  async stopAll(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    this.stopRearming();
    const roots = [...this.watched.values()];
    this.watched.clear();
    this.stopping = drainTaskWatchWork([
      ...this.closing,
      ...roots.flatMap((state) => [
        state.catchUp?.stop(),
        Promise.resolve().then(() => state.watcher?.close()),
      ]),
    ]);
    return this.stopping;
  }

  /**
   * Resolve once every root taken on so far has settled and been scanned.
   *
   * A root whose directory does not exist has nothing to wait for and is already
   * settled; a root whose watch is armed is settled once the window in which
   * chokidar drops events has passed and the catch-up scan behind it has run.
   *
   * @internal Exported for testing only — nothing in the server waits on it.
   */
  async ready(): Promise<void> {
    // Re-read after each drain: arming a root can start a scan that arms
    // nothing else, but a re-arm firing during the wait adds a new promise, and
    // a barrier that let that through would not be a barrier.
    for (;;) {
      const settling = [...this.watched.values()].map((state) => state.settled);
      await Promise.all(settling);
      const now = [...this.watched.values()].map((state) => state.settled);
      if (now.every((promise, index) => promise === settling[index])) return;
    }
  }

  /** {@link TaskWatchHealth.rootsWithoutLiveWatch}. */
  rootsWithoutLiveWatch(): readonly string[] {
    const unwatched: string[] = [];
    for (const [dir, state] of this.watched) {
      if (state.status !== 'live') unwatched.push(dir);
    }
    return unwatched;
  }

  /**
   * Open a watch over one root's directory, if there is one to open.
   *
   * **A watch on a path that does not exist is not a watch.** chokidar watches
   * the nearest existing ancestor instead and never picks the directory up when
   * it appears (see the module docs for the measurement), so this answers
   * `false` rather than pretending, and {@link rearm} comes back for it.
   *
   * Creating the directory here would be a write into somebody's repository
   * because a server started, which is not this module's to do. The one
   * directory DorkOS does create is `<dorkHome>/skills/`, and boot creates it
   * (`ensureGlobalSkillsRoot`) for a reason that has nothing to do with
   * watching: it is where a person looks to put a global schedule.
   *
   * @param state - The root to arm.
   * @returns Whether a watch is now open.
   */
  private armWatch(state: WatchedRoot): boolean {
    const root = state.root;
    if (!existsSync(root.dir)) return false;

    // Watch the directory itself and filter to {slug}/SKILL.md in the handler.
    // NO glob: chokidar v4 removed glob support, so a `*/SKILL.md` pattern
    // watches a literal path that never exists and silently never fires.
    //
    // `ignoreInitial: true` since DOR-1908, and the catch-up scan is why. The
    // initial walk used to be how the row set got built, which meant boot
    // discovery rode on the same chokidar that has the three holes above — and
    // it could not cover a root armed later at all, because by then its own walk
    // was long finished. {@link scanTaskWatchRoot} does that job for every arm, with
    // one `readdir` instead of a walk, and it reads the root through the same
    // `scanTaskRoot` the reconciler uses, so the two doors cannot disagree.
    const watcher = runOutsideAuditScope(() =>
      chokidar.watch(root.dir, {
        persistent: true,
        ignoreInitial: true,
        depth: 1,
        awaitWriteFinish: {
          stabilityThreshold: TASK_WRITE_STABILITY_MS,
          pollInterval: TASK_WRITE_POLL_MS,
        },
      })
    );

    const active = () => !this.stopped && this.watched.get(root.dir) === state;
    const catchUp = new TaskWatchCatchUp(
      () => scanTaskWatchRoot(root, (outcome) => this.applyOutcome(outcome, root, active), active),
      active,
      this.settleMs,
      (error) => logger.error(`[TaskFileWatcher] Catch-up failed for ${root.dir}`, error)
    );
    state.catchUp = catchUp;
    state.settled = catchUp.ready;
    // Native directory notifications can describe only part of a creation burst.
    // Re-read through the shared scanner, including when the cue names an ignored sibling.
    watcher.on('addDir', (dir) => {
      if (path.dirname(dir) === root.dir) catchUp.request();
    });
    watcher.on('raw', (_event, _file, details: unknown) => {
      if (
        details &&
        typeof details === 'object' &&
        Reflect.get(details, 'watchedPath') === root.dir
      )
        catchUp.request();
    });

    // A task is `<root>/<slug>/SKILL.md`, and `<slug>` may not be a name the
    // tasks system reserves for a container. That last clause is not tidiness —
    // a row for `<root>/templates/SKILL.md` is genuinely dangerous:
    //
    // - It schedules and fires like any other task, but the reconciler skips
    //   reserved names, so it is the one row with no safety net behind it.
    // - `DELETE /api/tasks/:id` derives the directory to remove from the row's
    //   `filePath`, which for this row is the templates container itself — so
    //   deleting the task `fs.rm`s every template the user has, recursively.
    //
    // Refusing at the source means the row is never created. It does NOT clean
    // up a row an older build already made; that is deliberate. The slot has
    // only ever been reachable by hand-placing a file (the create route refuses
    // the name), so migration logic would be scaffolding for a case nobody is
    // in — and deleting rows to fix a bug about deleting rows is the wrong
    // trade. Such a row is now inert: never re-synced, never retired.
    //
    // A DOT-DIRECTORY is refused for exactly that reason, and DOR-1908 is what
    // made it visible. `scanSkillDirectory` skips one, so the reconciler and the
    // catch-up scan both do — and a live event was the one door that did not,
    // which put `.hidden/SKILL.md` in the same no-backstop slot the paragraph
    // above is about. Nothing else in the repo treats a dot-directory as a
    // skill: the shared scanner, the symlink walk and the harness's own filter
    // all skip it.
    //
    // A marketplace install's own sibling (`<slug>.dorkos-bak-…`, a crash-left
    // backup of a schedule skill) is the same no-backstop slot again: the
    // scanner skips it, a live event did not, and the copy would run as a
    // second schedule that nothing retires (DOR-2273).
    const isSkillFile = (filePath: string): boolean =>
      path.basename(filePath) === SKILL_FILENAME &&
      path.dirname(path.dirname(filePath)) === root.dir &&
      !path.basename(path.dirname(filePath)).startsWith('.') &&
      !isInstallSiblingName(path.basename(path.dirname(filePath))) &&
      !reservedDirsFor(root).includes(path.basename(path.dirname(filePath)));
    watcher.on('add', (filePath) => {
      if (active() && isSkillFile(filePath)) void this.handleFileChange(filePath, root, active);
    });
    watcher.on('change', (filePath) => {
      if (active() && isSkillFile(filePath)) void this.handleFileChange(filePath, root, active);
    });
    watcher.on('unlink', (filePath) => {
      if (active() && isSkillFile(filePath)) this.handleFileRemove(filePath, root);
    });

    // Without this handler a watcher failure (e.g. EMFILE when the machine runs
    // out of watch descriptors) has nowhere to go but the process-wide
    // unhandled-error path, which spams the log without ever naming the watcher
    // that died.
    //
    // A single fd-exhaustion episode can make chokidar fire 'error' once per
    // directory it fails to (re-)watch, so this latches per distinct error code
    // rather than a single boolean: a benign EACCES on one path must never
    // suppress the EMFILE storm that follows it. The Set lives in this per-arm
    // closure, so one root's latch cannot silence a sibling's.
    //
    // Logged at `error` rather than `warn`, matching the sibling watcher's
    // `[watcher-error]` convention: the reconciler now keeps the promise, but a
    // machine that has run out of watch descriptors is still something an
    // operator has to be able to find in the log.
    const seenCodes = new Set<string>();
    const reportFailure = (err: unknown): void => {
      // ANY error, not only the codes that are known to be terminal. chokidar
      // offers no "the watch recovered" signal, so the only safe reading of a
      // failure is that this root's events can no longer be relied on — and
      // being wrong that way costs one `readdir` per ten seconds, while being
      // wrong the other way costs a schedule nobody notices is missing.
      state.status = 'dead';
      const code = (err as NodeJS.ErrnoException)?.code ?? 'unknown';
      if (seenCodes.has(code)) return;
      seenCodes.add(code);
      // Keep root, scope, code and explicit message/stack fields together in the event.
      logger.error(
        `[watcher-error] TaskFileWatcher: ${root.dir} (${root.scope}) — further ${code} errors from this watcher are suppressed; the reconciler is covering this root every ${UNWATCHED_ROOT_SWEEP_SECONDS}s`,
        {
          tasksDir: root.dir,
          scope: root.scope,
          code,
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
          suppressingFurtherErrors: true,
          reconcilerCovering: true,
        }
      );
    };

    state.watcher = watcher;
    state.status = 'live';
    // Both native outcomes share the helper's cancellable startup scan.
    watcher.on('ready', () => catchUp.begin());
    watcher.on('error', (err) => {
      reportFailure(err);
      catchUp.begin();
    });
    logger.info(`[TaskFileWatcher] Watching ${root.dir} (${root.scope})`);
    return true;
  }

  /** Open a watch on every root whose directory has appeared since the last look. */
  private rearm(): void {
    if (this.stopped) return;
    for (const state of this.watched.values()) {
      if (state.status !== 'deaf') continue;
      try {
        this.armWatch(state);
      } catch (err) {
        // This runs from a bare `setInterval` callback, where a SYNCHRONOUS
        // throw does not merely get logged — it reaches `uncaughtException`,
        // which shuts the server down (`index.ts`). Arming touches the
        // filesystem and opens a watch, so a throw is not hypothetical, and
        // taking the whole process down because one directory could not be
        // watched is never the right trade. The root stays deaf, the reconciler
        // keeps covering it, and the next tick tries again.
        logger.error(`[TaskFileWatcher] Could not arm a watch on ${state.root.dir}`, err);
      }
    }
  }

  /** Start the re-arm timer, unless it is already running or switched off. */
  private startRearming(): void {
    if (this.rearmTimer || this.rearmMs <= 0) return;
    this.rearmTimer = setInterval(
      outsideAuditScope(() => this.rearm()),
      this.rearmMs
    );
    this.rearmTimer.unref?.();
  }

  /** Stop the re-arm timer. */
  private stopRearming(): void {
    if (!this.rearmTimer) return;
    clearInterval(this.rearmTimer);
    this.rearmTimer = undefined;
  }

  private async handleFileChange(
    filePath: string,
    root: TaskRoot,
    active: () => boolean
  ): Promise<void> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      await this.applyOutcome(await readTaskRootFile(filePath, content, root), root, active);
    } catch (err) {
      logger.error(`[TaskFileWatcher] Failed to process ${filePath}`, err);
    }
  }

  /**
   * Do what one file's reading says to do — the single place a sighting becomes
   * a row.
   *
   * Shared by the event handlers and the catch-up scan so the two cannot drift:
   * a file discovered because chokidar mentioned it and the same file discovered
   * because a scan walked past it have to end up as the same row.
   *
   * @param outcome - What the file turned out to be.
   * @param root - The root it was found in.
   */
  private async applyOutcome(
    outcome: ReadOutcome,
    root: TaskRoot,
    active: () => boolean
  ): Promise<void> {
    if (!active()) return;
    if (outcome.kind === 'invalid') {
      // The row, if there is one, is left exactly as it was: a typo in
      // frontmatter must never cost a schedule its id and run history.
      logger.warn(`[TaskFileWatcher] Invalid file ${outcome.filePath}: ${outcome.error}`);
      return;
    }

    if (outcome.kind === 'ignored') {
      // A file in a skills root with no `schedule:` block is not a schedule.
      // If it used to be one, the schedule is over: pause the row so it stops
      // firing content the file no longer claims. Removing the block is how a
      // person turns a scheduled task back into a plain skill (spec §2).
      //
      // By the identity a row is KEYED on, which is the resolved path — the same
      // rule the reconciler's retirement follows. Pausing by the path we walked
      // in on matched nothing whenever the two differ, which is every installed
      // plugin skill (a symlink) and every root under a symlinked ancestor.
      this.retireIfPresent(outcome.resolvedPath ?? outcome.filePath);
      return;
    }

    // The row first, then the job that runs from it. Both, or the app shows one
    // schedule while a different one fires — which is what a no-op
    // `onTaskChange` left this doing until the next restart.
    const { discovered } = outcome;
    if (!this.identities.claim(discovered.def.filePath, root.dir, outcome.filePath)) return;
    const packageOwned = await packageOwnershipInRoot(discovered.def.filePath, root);
    const options = {
      source: 'discovery' as const,
      problem: discovered.problem,
      // A schedule an installed package owns keeps the switch a person set on
      // the row, because its file is one DorkOS never writes (FB-26). The row
      // keeps the answer, so the sync sees ownership lapse (DOR-2272).
      packageOwned,
      // What a file asking for every prompt off gets (DOR-3425).
      agentLevel: await fileAgentLevel(root, discovered.def.meta.schedule.runtime),
    };
    // A global `scope: project` file is one copy per project, never a global
    // row, and its shared file is never written for any one of them (DOR-3376).
    const projects = await projectOnlyTargets(
      discovered.def,
      root,
      [...this.watched.values()].map((watched) => watched.root)
    );
    if (!active()) return;
    if (projects) {
      const before = new Map(
        this.store.fileSync
          .projectCopiesOf(discovered.def.filePath)
          .map((copy) => [copy.id, copy.updatedAt])
      );
      const synced = syncProjectCopies(this.store, discovered.def, projects, options);
      for (const id of synced.removedIds) this.registrar.syncTask(id);
      for (const copy of synced.copies) {
        if (before.get(copy.id) !== copy.updatedAt) this.registrar.syncTask(copy.id);
        else this.registrar.repairTask(copy.id);
      }
      return;
    }
    for (const id of dropProjectCopies(this.store, discovered.def.filePath)) {
      this.registrar.syncTask(id);
    }
    const before = this.store.fileSync.getByFilePath(discovered.def.filePath);
    const task = this.store.fileSync.upsertFromFile(discovered.def, root.agentId, options);
    // Directory cues revisit unchanged rows too. Preserve their running clock,
    // while retaining the reconciler's repair of a missing or unwanted job.
    if (before === null || before.updatedAt !== task.updatedAt) this.registrar.syncTask(task.id);
    else this.registrar.repairTask(task.id);
    // A file that just stopped being a package's gets the switch the row kept
    // for it. That write comes back through here, finds the file agreeing, and
    // records the release; a write that fails is retried by the next sync.
    try {
      if (this.store.fileSync.isReleasingSwitch(task.id)) {
        await carrySwitchIntoReleasedFile(task, discovered.def, root);
      }
    } catch (err) {
      logger.warn('[TaskFileWatcher] could not write the kept switch into its file', {
        filePath: discovered.def.filePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Pause the row at this path, if there is one, without complaining when there
   * is not — the ordinary case for a plain skill that was never scheduled.
   */
  private retireIfPresent(filePath: string): void {
    // Ask before writing. Most files in a skills root are plain skills that
    // never had a row, and since DOR-1908 the catch-up scan runs this for every
    // one of them on every arm rather than only for a file an event named. The
    // read is indexed and the write is not free — the same trade the
    // reconciler's own `retireIfPresent` makes, for the same reason.
    if (
      this.store.fileSync.getByFilePath(filePath) === null &&
      this.store.fileSync.projectCopiesOf(filePath).length === 0
    ) {
      return;
    }
    if (this.store.fileSync.markRemovedByFilePath(filePath) === 0) return;
    this.registrar.syncTaskByFilePath(filePath);
    logger.info(`[TaskFileWatcher] Schedule block removed from ${filePath} — paused`);
  }

  private handleFileRemove(filePath: string, root: TaskRoot): void {
    const dirName = path.basename(path.dirname(filePath));
    try {
      // Pause by exact path, not by slug: the same slug can exist in the global
      // root and in any number of project ones, and only this file was removed.
      //
      // **By the path the ROW is keyed on, which is the resolved one.** A row
      // discovered through a skills root holds its file's real path, and chokidar
      // reports the path it was watching — the symlink. Pausing by the link
      // therefore matched nothing, so uninstalling a package left its schedule
      // firing from a row whose file no longer existed (DOR-1485 review, I3).
      //
      // A deleted file cannot be `realpath`-ed, so the mapping recorded when the
      // file was last seen is what answers here; the raw path is the fallback
      // for a file this process never saw arrive.
      const identity = this.identities.resolvedFor(filePath) ?? filePath;
      this.identities.releasePath(filePath);
      this.store.fileSync.markRemovedByFilePath(identity);
      // Paused in the DB is not paused on the clock. Without this the job keeps
      // firing a task whose file — the source of truth for what it even does —
      // is gone. Keyed on the same identity the pause used, or it looks up a row
      // that is not the one just paused.
      this.registrar.syncTaskByFilePath(identity);
      logger.info(`[TaskFileWatcher] Task file removed: ${dirName} (${root.scope})`);
    } catch (err) {
      // Contained for the same reason the change handler is: this runs inside a
      // chokidar event, where a throw has nowhere to go but the process-wide
      // unhandled-error path.
      logger.error(`[TaskFileWatcher] Failed to retire ${filePath}`, err);
    }
  }
}
