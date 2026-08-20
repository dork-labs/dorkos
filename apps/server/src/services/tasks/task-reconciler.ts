/**
 * Safety-net reconciler for file→DB sync.
 *
 * Runs every 5 minutes to catch changes missed by the file watcher
 * (e.g., during network filesystem hiccups or race conditions).
 *
 * @module services/tasks/task-reconciler
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { TaskStore } from './task-store.js';
import { scanSkillDirectory } from '@dorkos/skills/scanner';
import { TaskFrontmatterSchema } from '@dorkos/skills/task-schema';
import { RESERVED_TASK_DIRNAMES } from './task-templates.js';
import { resolveParkedScheduleRemoved } from '../notifications/emitters/schedule-park.js';
import { logger, logError } from '../../lib/logger.js';

/** 5-minute reconciliation interval. */
const RECONCILE_INTERVAL_MS = 300_000;

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

interface TaskDirectory {
  tasksDir: string;
  scope: 'project' | 'global';
  projectPath?: string;
  agentId?: string;
}

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
 * Periodically reconciles task files on disk with the DB cache.
 *
 * Follows the agent reconciler pattern from packages/mesh.
 */
export class TaskReconciler {
  private interval: ReturnType<typeof setInterval> | null = null;
  private directories: TaskDirectory[] = [];
  /** One entry per distinct fault currently being damped. See {@link report}. */
  private reportedFailures = new Map<string, ReportedFailure>();

  constructor(private store: TaskStore) {}

  /** Register a directory to reconcile. */
  addDirectory(
    tasksDir: string,
    scope: 'project' | 'global',
    projectPath?: string,
    agentId?: string
  ): void {
    this.directories.push({ tasksDir, scope, projectPath, agentId });
  }

  /** Remove a directory from reconciliation (e.g., on agent unregister). */
  removeDirectory(tasksDir: string): void {
    this.directories = this.directories.filter((d) => d.tasksDir !== tasksDir);
  }

  /** Start periodic reconciliation. */
  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => {
      this.reconcile().catch((err) => {
        this.report('error', '[TaskReconciler] Reconciliation failed', err);
      });
    }, RECONCILE_INTERVAL_MS);
    logger.info('[TaskReconciler] Started (interval: 5m)');
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

  /** Stop periodic reconciliation. */
  stop(): void {
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
    let upserted = 0;
    let orphaned = 0;
    const seenFilePaths = new Set<string>();
    // Directories this pass actually enumerated. ONLY these may testify that a
    // file is gone — see the retirement loop below.
    const scannedDirs = new Set<string>();

    for (const dir of this.directories) {
      let results;
      try {
        // `templates/` and friends are containers the tasks system owns, not
        // tasks — scanning them as tasks reports a permanent bogus "invalid
        // file" every pass.
        results = await scanSkillDirectory(dir.tasksDir, TaskFrontmatterSchema, {
          ignoreDirs: RESERVED_TASK_DIRNAMES,
        });
      } catch (err) {
        // A directory that does not exist is already an empty scan, so reaching
        // here means the directory is there and we could not read it — EACCES,
        // or EMFILE under file-descriptor pressure. Treating that as "empty"
        // would pause every task inside it.
        this.report('error', `[TaskReconciler] Failed to scan ${dir.tasksDir}`, err);
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
        await fs.access(dir.tasksDir);
      } catch {
        continue;
      }
      scannedDirs.add(dir.tasksDir);

      for (const result of results) {
        if (!result.ok) {
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
        // Record the file as seen BEFORE attempting the write: the file is on
        // disk either way, and a task missing from this set is treated as
        // deleted below. A failed write must never look like a deletion.
        seenFilePaths.add(result.definition.filePath);
        const def = {
          ...result.definition,
          scope: dir.scope as 'project' | 'global',
          projectPath: dir.projectPath,
        };
        try {
          this.store.upsertFromFile(def, dir.agentId);
          upserted++;
        } catch (err) {
          this.report(
            'error',
            `[TaskReconciler] Failed to sync ${result.definition.filePath}`,
            err
          );
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
      if (!scannedDirs.has(path.dirname(path.dirname(task.filePath)))) continue;

      // Gate 2. One stat per candidate — rows already believed missing — so
      // this costs nothing in the common case of nothing being wrong.
      try {
        await fs.access(task.filePath);
        continue; // The file is right there; the scan just skipped its slot.
      } catch (err) {
        // ENOENT is the only answer that means "deleted". EACCES or EMFILE
        // means we could not look, which is never evidence of absence.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') continue;
      }

      try {
        const updatedAt = new Date(task.updatedAt).getTime();
        if (now - updatedAt > ORPHAN_GRACE_MS) {
          this.store.deleteTask(task.id);
          // A schedule whose file went away can still have been waiting on the
          // operator. Ending the standing condition here is what stops an armed
          // escalation buzzing a phone about a schedule that no longer exists
          // (DOR-1387 review).
          resolveParkedScheduleRemoved(task);
          orphaned++;
        } else if (task.status !== 'paused') {
          this.store.markRemovedByFilePath(task.filePath);
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
