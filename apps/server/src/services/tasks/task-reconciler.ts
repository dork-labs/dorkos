/**
 * Safety-net reconciler for file→DB→scheduler sync.
 *
 * Runs every 5 minutes to catch changes missed by the file watcher
 * (e.g., during network filesystem hiccups or race conditions).
 *
 * ## Two cadences, because a watch does not fail a little
 *
 * Five minutes is the right price for a root whose watch is working: it is a
 * backstop against a dropped event, and a dropped event is rare. It is the
 * wrong price for a root that has no watch at all — a directory that did not
 * exist when the watch was armed, or one whose chokidar watch reported an error
 * and has therefore stopped reporting anything. Those are total losses rather
 * than loss rates (`task-file-watcher.ts` measures all three), so for that root
 * the five-minute pass IS the discovery path, and a schedule dropped into it was
 * silently up to five minutes late.
 *
 * So the watcher says which roots have no live watch, and those get
 * {@link UNWATCHED_ROOT_SWEEP_MS} instead — behind a cheap per-root comparison
 * ({@link taskRootShape}) so an unchanged root costs one `readdir` rather than a
 * full scan. Every other root keeps the five minutes.
 *
 * A safety net that only repaired the DB was half a net: the pass it exists to
 * be a backstop for is the one the watcher missed, so the running cron job was
 * exactly as stale as the row had been. Every write here now goes on through
 * {@link TaskRegistrar}.
 *
 * @module services/tasks/task-reconciler
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { TaskStore } from './task-store.js';
import type { TaskRegistrar } from './task-registrar.js';
import type { ScheduleIdentityRegistry } from './schedule-identity.js';
import {
  linkedSkillDirs,
  resolveThroughAncestors,
  scanTaskRoot,
  taskRootShape,
} from './skills-root-discovery.js';
import { pluginsRootFor, type TaskRoot } from './skills-roots.js';
import { carrySwitchIntoReleasedFile, packageOwnershipInRoot } from './task-file-update.js';
import { SKILL_FILENAME } from '@dorkos/skills/constants';
import { UNWATCHED_ROOT_SWEEP_SECONDS, type TaskWatchHealth } from './task-file-watcher.js';
import { resolveParkedScheduleRemoved } from '../notifications/emitters/schedule-park.js';
import { logger, logError } from '../../lib/logger.js';

/** 5-minute reconciliation interval. */
const RECONCILE_INTERVAL_MS = 300_000;

/**
 * How often a root with no live watch is compared against what it looked like
 * last, and reconciled when that has changed.
 *
 * The same ten seconds the harness's skills watcher uses for the same two holes,
 * and the number is the honest bound on "a schedule you add is picked up within
 * seconds" when the fast path is not working. Derived from the watcher's own
 * constant so the sentence it logs when a watch dies cannot promise a cadence
 * this module does not keep.
 */
export const UNWATCHED_ROOT_SWEEP_MS = UNWATCHED_ROOT_SWEEP_SECONDS * 1000;

/** 24-hour grace period before removing orphan DB entries. */
const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * How long one distinct fault stays quiet after it has been reported.
 *
 * A pass runs every 5 minutes, so a fault that does not clear on its own — an
 * unreadable directory, a task file with a typo in it — used to write twelve
 * byte-identical lines an hour, forever. Twelve copies say nothing the first
 * one did not, and they bury the failures an operator actually needs to see.
 * One line an hour keeps a standing fault visible at a volume that reads.
 */
const FAILURE_LOG_WINDOW_MS = 60 * 60 * 1000;

/** What is remembered about one distinct fault already written to the log. */
interface ReportedFailure {
  /** `Date.now()` when this fault was last logged. Drives the damping window. */
  lastLoggedAt: number;
  /**
   * `Date.now()` when this fault last occurred, logged or suppressed.
   *
   * Distinct from {@link lastLoggedAt} because only this answers "has this
   * fault gone quiet?", which is the question eviction is allowed to act on. A
   * fault mid-suppression is an hour past its last log by design, and evicting
   * it there would throw away the count it is holding.
   */
  lastSeenAt: number;
  /** Byte-identical recurrences swallowed since the last log. */
  suppressed: number;
}

/**
 * Whether `filePath` sits inside any of `roots`, judged one path segment at a
 * time.
 *
 * `startsWith` alone answers `true` for `<dorkHome>/plugins-of-someone-else`
 * against `<dorkHome>/plugins`, which is a neighbouring directory this pass has
 * no claim over whatever it is called — and the claim here ends in a deleted
 * row with its whole run history.
 *
 * @param filePath - The absolute path a row is keyed on.
 * @param roots - Resolved packages directories this pass read the links of.
 * @returns Whether the file is under one of them.
 */
function isInsideAny(filePath: string, roots: ReadonlySet<string>): boolean {
  for (const root of roots) {
    if (filePath === root || filePath.startsWith(root + path.sep)) return true;
  }
  return false;
}

/**
 * Periodically reconciles task files on disk with the DB cache.
 *
 * Follows the agent reconciler pattern from packages/mesh.
 */
export class TaskReconciler {
  private interval: ReturnType<typeof setInterval> | null = null;
  /** The tightened pass over roots with no live watch. See {@link sweepUnwatchedRoots}. */
  private sweepInterval: ReturnType<typeof setInterval> | null = null;
  private roots: TaskRoot[] = [];
  /** One entry per distinct fault currently being damped. See {@link report}. */
  private reportedFailures = new Map<string, ReportedFailure>();
  /** What each unwatched root looked like when it was last reconciled. */
  private shapes = new Map<string, string>();
  /** True while a tightened pass is running, so ticks cannot stack on a slow disk. */
  private sweeping = false;

  /**
   * Build a reconciler over a row cache, a scheduler and — optionally — a
   * watcher whose health decides which roots get the tightened cadence.
   *
   * @param store - The row cache to reconcile onto.
   * @param registrar - Carries every repair through to the running scheduler.
   * @param identities - Shared with the watcher; one claim per real file.
   * @param watchHealth - Which roots have no live watch, so those can be covered
   *   on {@link UNWATCHED_ROOT_SWEEP_MS} instead of five minutes. Optional
   *   because a caller with no watcher at all — every test that drives this
   *   class directly — has no roots to tighten for, and the honest default is
   *   that nothing is tightened rather than that everything is.
   */
  constructor(
    private store: TaskStore,
    private registrar: TaskRegistrar,
    private identities: ScheduleIdentityRegistry,
    private watchHealth?: TaskWatchHealth
  ) {}

  /**
   * Register a root to reconcile.
   *
   * Ignores a root it already holds. That guard is new with DOR-1485 and it is
   * load-bearing now that roots are added when an agent REGISTERS rather than
   * only at boot: an agent that registers twice used to double the directory
   * list, and every pass would then scan and upsert the same files twice.
   *
   * @param root - The directory to scan and how to read what is in it.
   */
  addRoot(root: TaskRoot): void {
    if (this.roots.some((r) => r.dir === root.dir)) return;
    this.roots.push(root);
  }

  /**
   * Stop reconciling a root (e.g. on agent unregister), and release the
   * identity claims it was holding.
   *
   * @param tasksDir - The root's directory.
   */
  removeDirectory(tasksDir: string): void {
    this.roots = this.roots.filter((r) => r.dir !== tasksDir);
    this.shapes.delete(tasksDir);
    this.identities.releaseRoot(tasksDir);
  }

  /** Start periodic reconciliation, on both cadences. */
  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => {
      this.reconcile().catch((err) => {
        this.report('error', '[TaskReconciler] Reconciliation failed', err);
      });
    }, RECONCILE_INTERVAL_MS);
    this.interval.unref?.();
    this.sweepInterval = setInterval(() => {
      this.sweepUnwatchedRoots().catch((err) => {
        this.report('error', '[TaskReconciler] Unwatched-root sweep failed', err);
      });
    }, UNWATCHED_ROOT_SWEEP_MS);
    this.sweepInterval.unref?.();
    logger.info(
      `[TaskReconciler] Started (every 5m; every ${UNWATCHED_ROOT_SWEEP_SECONDS}s for a root with no live watch)`
    );
  }

  /**
   * Reconcile every root whose watch is deaf or dead, and only when something in
   * it has actually moved.
   *
   * This is the tightened half of the safety net. The watcher decides which
   * roots qualify — a directory that did not exist when the watch was armed, or
   * one chokidar has reported an error on — and for each of those the shape
   * comparison decides whether the full scan is worth doing. A root that has not
   * changed costs one `readdir` plus one `stat` per ENTRY — every skill in the
   * root, not only the scheduled ones, because whether an entry is a schedule is
   * the question the full scan answers and this runs in front of it (measured:
   * 50 stats on a 50-skill root holding 25 schedules). A root that has changed
   * costs the scan it would have cost five minutes later anyway.
   *
   * Never runs twice at once: on a busy machine — the same one whose descriptor
   * pressure killed the watch in the first place — a scan can outlast the tick
   * that started it, and passes stacking on each other would turn one slow root
   * into an unbounded queue.
   */
  async sweepUnwatchedRoots(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const unwatched = new Set(this.watchHealth?.rootsWithoutLiveWatch() ?? []);
      for (const root of this.roots) {
        if (!unwatched.has(root.dir)) {
          // Its watch is live again, or it never lacked one. Drop the record
          // rather than keeping it: if the root goes dark later, "no record" is
          // the honest starting point and reconciles once, where a stale record
          // could match a shape that has since changed and back.
          this.shapes.delete(root.dir);
          continue;
        }
        // Read BEFORE the pass and committed only after it, for the reason the
        // harness's equivalent gives: recorded at detection, a pass that fails
        // has already written the change off; recorded afterwards, a file that
        // lands DURING the pass is counted as seen by a scan that never saw it.
        const shape = await taskRootShape(root);
        if (this.shapes.get(root.dir) === shape) continue;
        await this.reconcilePass([root]);
        this.shapes.set(root.dir, shape);
      }
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Log a failure, at most once per {@link FAILURE_LOG_WINDOW_MS} per fault.
   *
   * The first occurrence of a fault always logs, in full and unchanged — a
   * failure a person has not seen yet is never withheld. Only byte-identical
   * repeats inside the window are swallowed, and when the window closes the
   * fault logs again carrying the count of what was swallowed, so a standing
   * problem reads as standing rather than as a fresh one-off. Any fault that
   * differs in any way — a different file, a different error code, a different
   * message — is a different fault and logs immediately.
   *
   * Damping is local to this class on purpose. It exists because this one
   * caller runs on a fixed timer forever, which is what turns a single fault
   * into a repeating one; nothing here belongs in the shared logger.
   *
   * @param level - `error` for a failure, `warn` for a file DorkOS cannot use
   * @param message - The line to log, already carrying its own identifying
   *   detail (a path, a task id); this doubles as the fault's identity
   * @param err - The underlying error, when there is one
   */
  private report(level: 'error' | 'warn', message: string, err?: unknown): void {
    // Identity is the message plus how the error failed. The message already
    // names the file or row it concerns, and the code distinguishes "same
    // operation, genuinely different failure" — which must never be hidden
    // behind a fault that happens to share a call site.
    const cause =
      err instanceof Error
        ? `${(err as NodeJS.ErrnoException).code ?? err.name}:${err.message}`
        : String(err ?? '');
    // JSON rather than a joined string: a delimiter is only unambiguous if it
    // cannot appear in the parts, and these parts are arbitrary text.
    const key = JSON.stringify([level, message, cause]);

    const now = Date.now();
    const seen = this.reportedFailures.get(key);
    if (seen) seen.lastSeenAt = now;
    if (seen && now - seen.lastLoggedAt < FAILURE_LOG_WINDOW_MS) {
      seen.suppressed++;
      return;
    }

    const repeats = seen?.suppressed ?? 0;
    const line =
      repeats > 0
        ? `${message} (still failing; ${repeats} identical ${repeats === 1 ? 'report' : 'reports'} suppressed in the last hour)`
        : message;
    // `logError` rather than the raw error: the NDJSON file reporter builds its
    // entry by SPREADING an object argument, and `message`/`stack` are
    // non-enumerable on an Error, so passing one writes `{}` and the detail is
    // lost in the very file an operator reads. Damping to one line an hour is
    // worth nothing if that line does not say what failed.
    const detail = err === undefined ? undefined : logError(err);
    if (level === 'error') {
      if (detail) logger.error(line, detail);
      else logger.error(line);
    } else {
      if (detail) logger.warn(line, detail);
      else logger.warn(line);
    }

    this.reportedFailures.set(key, { lastLoggedAt: now, lastSeenAt: now, suppressed: 0 });

    // Drop faults that have gone QUIET for a full window — measured from when
    // each was last seen, not last logged. A second standing fault on the same
    // cadence is always a full window past its last log at the moment the
    // first one's window closes, so evicting on `lastLoggedAt` would discard
    // its entry, and with it the count it was holding, every hour forever.
    // Once genuinely quiet, forgetting is right: a fault returning after an
    // hour of silence deserves to log in full.
    for (const [otherKey, other] of this.reportedFailures) {
      if (otherKey !== key && now - other.lastSeenAt >= FAILURE_LOG_WINDOW_MS) {
        this.reportedFailures.delete(otherKey);
      }
    }
  }

  /**
   * Note that this root was genuinely enumerated, under every name a row's
   * `filePath` could be recorded under.
   *
   * The retirement pass will only destroy a row whose file's parent directory
   * is in this set, and rows discovered in a skills root are keyed on the
   * file's REAL path. So the real path of the root has to be in the set too, or
   * a root reached through any symlinked ancestor — `/tmp` on macOS, a
   * symlinked home, a checkout under a symlinked parent — would never be able
   * to testify about its own files, and rows in it could never retire.
   *
   * A symlinked skill ENTRY (an installed plugin's `pkg__name`) resolves out of
   * the root entirely, into `.dork/plugins/`, so the directory a row's path sits
   * in is not the root that found it. Its real parent is therefore recorded too,
   * from the sighting itself — otherwise uninstalling a package would leave its
   * schedule as a row this pass could never speak about, still on the clock
   * (DOR-1485 review, I3). Being unable to retire is NOT the same as stopping:
   * an earlier version of this comment claimed such a row "stops firing when the
   * file cannot be read", and that was simply false — nothing reads a registered
   * cron job's file between ticks.
   */
  private async recordScanned(
    root: TaskRoot,
    scannedDirs: Set<string>,
    seenIn: readonly string[]
  ): Promise<void> {
    scannedDirs.add(root.dir);
    try {
      scannedDirs.add(await fs.realpath(root.dir));
    } catch {
      // The root was there a moment ago (`fs.access` just said so). If it is
      // not resolvable now, testifying under one name only is the conservative
      // outcome: fewer rows eligible for deletion, never more.
    }
    // Every directory this pass actually read a file out of, including the ones
    // a symlink led it to outside the root. This pass looked in them, so it may
    // speak about what is missing from them.
    for (const dir of seenIn) scannedDirs.add(dir);
  }

  /**
   * Pause the row at this path because its file is no longer a schedule.
   *
   * The file is still there — it is a plain skill now — so this is a pause and
   * never a delete: removing a `schedule:` block turns a scheduled task back
   * into an ordinary skill, and the run history belongs to the person, not to
   * the block. The same ending the watcher gives a block removal it saw.
   *
   * @param filePath - The file that stopped carrying a schedule.
   * @returns Whether a row was actually retired.
   */
  private retireIfPresent(filePath: string): boolean {
    // Most files in a skills root are plain skills that never had a row, and
    // this runs for every one of them on every pass. The read is indexed and the
    // write is not free, so ask before writing.
    if (this.store.getByFilePath(filePath) === null) return false;
    if (this.store.markRemovedByFilePath(filePath) === 0) return false;
    this.registrar.syncTaskByFilePath(filePath);
    logger.info(`[TaskReconciler] Schedule block removed from ${filePath} — paused`);
    return true;
  }

  /** Stop periodic reconciliation on both cadences. */
  stop(): void {
    if (this.sweepInterval) {
      clearInterval(this.sweepInterval);
      this.sweepInterval = null;
    }
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      logger.info('[TaskReconciler] Stopped');
    }
  }

  /**
   * Run a single reconciliation pass.
   *
   * A pass does two things: sync every task file it can read into the DB, then
   * retire rows whose file is gone. The second half destroys data, so it acts
   * only on POSITIVE evidence of deletion, and the final word is a direct
   * `fs.access` on the file itself — the one check that answers the actual
   * question. Every other outcome leaves the row exactly as it is:
   *
   * - a directory that could not be listed (EACCES, EMFILE),
   * - a directory nobody registered, so it was never listed at all,
   * - a file that could not be read,
   * - a file whose frontmatter does not parse,
   * - a file the scan never considered.
   *
   * That last case is why absence from the scan cannot be the test.
   * `scanSkillDirectory` skips entries inside a directory it enumerated
   * perfectly well — reserved container names, dotfiles, and anything
   * `readdir` does not report as a directory, which includes a symlink to
   * one. `TaskFileWatcher` accepts all of those and creates rows for them, so
   * a skipped slot is indistinguishable from a deleted file unless somebody
   * looks.
   *
   * The distinction matters because a wrong answer here is unrecoverable: an
   * `ON DELETE CASCADE` takes the task's entire run history with it, and the
   * rebuilt row gets a new id. "Could not look" is not "not there", "nobody
   * was looking" is not either, and neither is "we did not think to look".
   *
   * Every step that can fail is contained to the one directory, file, or row it
   * concerns. Because the pass runs on a timer forever, letting one failure
   * escape does not retry the work — it permanently disables the safety net,
   * which is exactly how this ran broken for weeks.
   */
  async reconcile(): Promise<{ upserted: number; orphaned: number }> {
    return this.reconcilePass(this.roots);
  }

  /**
   * One pass, over the roots given rather than over all of them.
   *
   * Scoping is safe because the retirement gate already turns on which
   * directories THIS pass enumerated: a row whose file sits in a root the pass
   * did not read is skipped, exactly as it is for a root nobody registered. So
   * a single-root pass can repair that root and can never retire anything
   * outside it.
   *
   * The reachability gate needs a second answer for the same reason, and cannot
   * borrow the first one: "no link anywhere points at this file" is a statement
   * about EVERY root, and a partial pass has only read some of them. So it is
   * asked only when this pass covers every registered root, and a single-root
   * sweep repairs its root without judging what is reachable from the others.
   *
   * @param roots - The roots to read.
   */
  private async reconcilePass(
    roots: readonly TaskRoot[]
  ): Promise<{ upserted: number; orphaned: number }> {
    let upserted = 0;
    let orphaned = 0;
    const seenFilePaths = new Set<string>();
    // Directories this pass actually enumerated. ONLY these may testify that a
    // file is gone — see the retirement loop below.
    const scannedDirs = new Set<string>();
    // The packages directories feeding the roots this pass read, resolved. A row
    // whose file sits in one of these was reached through a link, and this pass
    // walked the only directory such a link can live in.
    const pluginRoots = new Set<string>();
    // Every file a link in one of those roots still resolves to. This is what
    // "still reachable" means for a packaged skill: not that the file is there,
    // but that something in a watched root still points at it (DOR-1934).
    const linkedFiles = new Set<string>();
    // Whether this pass read EVERY registered root, which is what it takes to
    // say a file is reachable from none of them. `sweepUnwatchedRoots` runs
    // single-root passes, and `linkedFiles` then holds one root's links — so a
    // partial pass that judged reachability would pause a row whose surviving
    // link is in a root it did not open, which is the same mistake as speaking
    // about a directory nobody enumerated. Compared by directory rather than by
    // count, because a caller may pass a copy of the list.
    const coversEveryRoot = this.roots.every((registered) =>
      roots.some((read) => read.dir === registered.dir)
    );

    for (const root of roots) {
      let results;
      try {
        results = await scanTaskRoot(root);
      } catch (err) {
        // A directory that does not exist is already an empty scan, so reaching
        // here means the directory is there and we could not read it — EACCES,
        // or EMFILE under file-descriptor pressure. Treating that as "empty"
        // would pause every task inside it.
        this.report('error', `[TaskReconciler] Failed to scan ${root.dir}`, err);
        continue;
      }

      // A registered directory that no longer exists was also never looked at.
      // `scanSkillDirectory` answers a missing directory with `[]`, which is
      // indistinguishable from "I enumerated it and it was empty" — so without
      // this check a deleted checkout or an unmounted volume reads as every
      // task in it having been deleted, and 24h later they are, run history
      // and all. Checked AFTER the scan on purpose: a directory that survived
      // the scan was there for it, whereas checking first would leave a window
      // in which it vanishes and the empty result still counts as testimony.
      try {
        await fs.access(root.dir);
      } catch {
        continue;
      }
      // The real directory of every file this scan read, which for a symlinked
      // plugin skill is outside the root entirely.
      const seenIn = results
        .filter((r) => r.kind === 'schedule')
        .map((r) => path.dirname(path.dirname(r.discovered.def.filePath)));
      // ...plus wherever this root's symlinks point, including links whose
      // target an uninstall has just removed. Looking through a link is looking
      // in the directory it names. `dirname` because a link points at the SKILL
      // directory, and what the retirement gate compares is the directory that
      // CONTAINS it — the same level as a root.
      const linkedDirs = await linkedSkillDirs(root);
      seenIn.push(...linkedDirs.map((d) => path.dirname(d)));
      for (const dir of linkedDirs) linkedFiles.add(path.join(dir, SKILL_FILENAME));
      // Where this root's packaged skills are installed, resolved the same way
      // the links are, so a `/var` -> `/private/var` machine compares like with
      // like and an uninstalled package's directory still has a name.
      const pluginsRoot = pluginsRootFor(root);
      if (pluginsRoot !== undefined) pluginRoots.add(await resolveThroughAncestors(pluginsRoot));
      await this.recordScanned(root, scannedDirs, seenIn);

      for (const result of results) {
        if (result.kind === 'invalid') {
          this.report('warn', `[TaskReconciler] Invalid file ${result.filePath}: ${result.error}`);
          // A file that is on disk but unusable — unreadable, or frontmatter
          // that does not parse — is NOT a deleted task. Count it as seen so
          // the retirement pass leaves its row alone; a typo in a cron
          // expression must never cost a task its id and run history. This
          // matches TaskFileWatcher, which also leaves the row untouched when
          // an edit fails to parse.
          if (!result.fileMissing) seenFilePaths.add(result.filePath);
          continue;
        }

        // A plain skill in a skills root: not a task. Counted as seen so a row
        // whose file merely lost its `schedule:` block is never mistaken for a
        // deleted file and destroyed with its run history.
        //
        // And if a row DOES exist for it, the schedule is over and this pass
        // has to end it. Skipping here was a hole in the safety net rather than
        // a tidy no-op: the watcher pauses a block removal it sees, and the
        // reconciler exists precisely for the changes the watcher did not see —
        // so an approved schedule whose block was deleted while the watcher was
        // blind would have gone on firing forever (DOR-1485 review, B3).
        if (result.kind === 'ignored') {
          seenFilePaths.add(result.filePath);
          try {
            // By the identity a row would hold, which is the resolved path.
            if (this.retireIfPresent(result.resolvedPath ?? result.filePath)) orphaned++;
          } catch (err) {
            this.report(
              'error',
              `[TaskReconciler] Failed to retire un-scheduled ${result.filePath}`,
              err
            );
          }
          continue;
        }

        // Record the file as seen BEFORE attempting the write: the file is on
        // disk either way, and a task missing from this set is treated as
        // deleted below. A failed write must never look like a deletion.
        const { discovered } = result;
        seenFilePaths.add(discovered.def.filePath);
        if (!this.identities.claim(discovered.def.filePath, root.dir, result.filePath)) continue;
        try {
          const packageOwned = await packageOwnershipInRoot(discovered.def.filePath, root);
          const task = this.store.upsertFromFile(discovered.def, root.agentId, {
            source: 'discovery',
            problem: discovered.problem,
            // See the watcher's call: the same rule, on the pass that catches
            // what the watcher missed (FB-26, DOR-2272).
            packageOwned,
          });
          // Carry the repair through to the clock. This pass exists to catch
          // what the watcher missed, and what the watcher missed was never only
          // the row.
          this.registrar.syncTask(task.id);
          upserted++;
          // A file that just stopped being a package's gets the switch the row
          // kept for it (DOR-2272). After the clock sync so a failed write does
          // not skip it; the row keeps its ownership until the file agrees, so a
          // write that fails here is retried by the next pass.
          await carrySwitchIntoReleasedFile(task, discovered.def, root);
        } catch (err) {
          this.report('error', `[TaskReconciler] Failed to sync ${discovered.def.filePath}`, err);
        }
      }
    }

    // Retire rows whose file is gone: pause first, delete after a 24h grace.
    //
    // A row reaches the destructive part only after clearing two gates.
    //
    // 1. This pass ENUMERATED the directory the file lives in. A directory
    //    nobody registered was never looked at, and a row is not garbage just
    //    because no one is watching its folder. Two such directories arise in
    //    normal operation, because `addDirectory` runs once at boot: a project
    //    whose agent registered after startup, and one whose agent was
    //    unregistered (its directory is dropped, its rows are not).
    // 1b. …or the row's file sits in a packages directory feeding a root this
    //    pass read, and no link in ANY registered root resolves to it any more.
    //    A packaged skill's row is keyed inside `plugins/`, which is not a root
    //    and which nothing enumerates, so gate 1 alone could never speak about
    //    one after its link was swept — and it went on firing for a package
    //    that had been uninstalled (DOR-1934). Such a row PAUSES while its file
    //    is still there and follows the ordinary ladder when it is not. Two
    //    limits keep it inside what this pass looked at: it is asked only on a
    //    pass that read every registered root, and containment is a
    //    path-segment test, so `<dorkHome>/plugins-backup` is somebody's own
    //    folder whatever it is called.
    // 2. The file is genuinely not on disk. Being absent from `seenFilePaths`
    //    only means the scan did not return it, and the scan skips slots it
    //    enumerated fine (reserved names, dotfiles, symlinked directories) —
    //    all of which the watcher happily creates rows for.
    // Contained for the same reason every other step here is: an uncaught throw
    // from this one read would abort the pass and, on a fixed timer, abort
    // every future pass the same way — which is precisely the original bug,
    // just moved one line up.
    let allTasks;
    try {
      allTasks = this.store.getTasks();
    } catch (err) {
      this.report('error', '[TaskReconciler] Failed to read tasks for retirement', err);
      return { upserted, orphaned };
    }

    const now = Date.now();
    for (const task of allTasks) {
      if (!task.filePath || seenFilePaths.has(task.filePath)) continue;
      const enumerated = scannedDirs.has(path.dirname(path.dirname(task.filePath)));
      // Gate 1b. A packaged skill's row is keyed on a path inside a `plugins/`
      // directory, which is not a root and which no scan enumerates — so once
      // the `<pkg>__<name>` link that made it discoverable is swept, gate 1
      // never passes again and the row runs forever for a skill nothing can
      // reach (DOR-1934). This pass DID walk the only directories such a link
      // can live in, so it may speak: a row in a packages directory it read,
      // that no link in any of those roots resolves to any more, is
      // unreachable.
      //
      // **Asked independently of gate 1, never behind it.** `scannedDirs` holds
      // the PARENT of every directory a link points into — `<pkg>/skills` — so
      // one surviving sibling link makes gate 1 true for every row in the
      // package, and a skill whose own link was swept read as one the scan had
      // merely skipped. Uninstalling one skill from a two-skill package left it
      // armed for as long as its sibling existed. Nothing is lost by asking
      // both: a row that is genuinely still reachable was added to
      // `seenFilePaths` by the scan above and never reaches this line.
      const unreachable =
        coversEveryRoot &&
        isInsideAny(task.filePath, pluginRoots) &&
        !linkedFiles.has(task.filePath);
      if (!enumerated && !unreachable) continue;

      // Gate 2. One stat per candidate — rows already believed missing — so
      // this costs nothing in the common case of nothing being wrong.
      let fileGone = false;
      try {
        await fs.access(task.filePath);
        // The file is right there. For an enumerated directory that means the
        // scan skipped its slot and the row stands. For an unreachable one it
        // changes nothing: what made the skill a schedule was being reachable
        // from a watched root, and it is not — so it pauses below, and never
        // deletes, because the file and its history are both still real.
        if (!unreachable) continue;
      } catch (err) {
        // ENOENT is the only answer that means "deleted". EACCES or EMFILE
        // means we could not look, which is never evidence of absence.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') continue;
        fileGone = true;
      }

      try {
        const updatedAt = new Date(task.updatedAt).getTime();
        if (fileGone && now - updatedAt > ORPHAN_GRACE_MS) {
          this.store.deleteTask(task.id);
          // A deleted row with a live job is worse than a stale schedule: the
          // job still fires, and the run it tries to record belongs to a
          // schedule that no longer exists.
          this.registrar.syncTask(task.id);
          // A schedule whose file went away can still have been waiting on the
          // operator. Ending the standing condition here is what stops an armed
          // escalation buzzing a phone about a schedule that no longer exists
          // (DOR-1387 review).
          resolveParkedScheduleRemoved(task);
          orphaned++;
        } else if (task.status !== 'paused') {
          this.store.markRemovedByFilePath(task.filePath);
          // Pausing a row the operator can see, while its job keeps firing, is
          // the same lie the watcher told before the registrar existed.
          this.registrar.syncTask(task.id);
          if (unreachable && !fileGone) {
            logger.info(
              `[TaskReconciler] ${task.filePath} is no longer linked into a folder DorkOS watches — paused`
            );
          }
        }
      } catch (err) {
        this.report('error', `[TaskReconciler] Failed to retire removed task ${task.id}`, err);
      }
    }

    if (upserted > 0 || orphaned > 0) {
      logger.info(
        `[TaskReconciler] Reconciled: ${upserted} upserted, ${orphaned} orphaned removed`
      );
    }

    return { upserted, orphaned };
  }
}
