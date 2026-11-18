import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import chokidar from 'chokidar';
import { TASK_DIRECTORY_CATCH_UP_MS } from '../watch/task-watch-catch-up.js';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TaskFileWatcher } from '../task-file-watcher.js';
import { ScheduleIdentityRegistry } from '../schedule-identity.js';
import { skillsRoot } from './task-root-fixtures.js';
import { TaskRegistrar } from '../task-registrar.js';
import { FakeScheduler } from './fake-scheduler.js';
import { TaskStore } from '../task-store.js';
import { createTestDb } from '@dorkos/test-utils/db';
import { logger } from '../../../lib/logger.js';
import type { Db } from '@dorkos/db';

/**
 * REAL chokidar + real filesystem, because the claim under test is precisely
 * "what does the watcher do when it sees this file". A test that seeded rows
 * with `store.createTask` would assert nothing about the watcher.
 */

/** Frontmatter + body for a minimal, schema-valid task SKILL.md. */
function skillFile(name: string): string {
  return `---\nname: ${name}\ndescription: A task named ${name}\nschedule:\n  cron: '0 9 * * *'\n---\nDo the thing.`;
}

/** Poll `check` until it is true or the deadline passes. */
async function waitUntil(check: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Assert `check` stays true for `windowMs` — a bounded "and it stays that way". */
async function holdsFor(check: () => boolean, label: string, windowMs = 300): Promise<void> {
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    if (!check()) throw new Error(`${label} stopped holding`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Observe the production cue union before the real filesystem stimulus. */
async function directoryCue(
  native: ReturnType<typeof chokidar.watch>,
  root: string,
  child: string,
  stimulate: () => Promise<unknown>,
  subjectSettled: () => boolean = () => true
): Promise<void> {
  let added = 0;
  let rawRoot = 0;
  let phase = 'attached';
  const onDirectory = (directory: string) => {
    if (directory === child && path.dirname(directory) === root) added++;
  };
  const onRaw = (_event: string, _file: unknown, details: unknown) => {
    if (details && typeof details === 'object' && Reflect.get(details, 'watchedPath') === root)
      rawRoot++;
  };
  native.on('addDir', onDirectory);
  native.on('raw', onRaw);
  try {
    phase = 'filesystem-stimulus';
    await stimulate();
    phase = 'eligible-cue-and-subject';
    await waitUntil(
      () => (added > 0 || rawRoot > 0) && subjectSettled(),
      'the actual directory cue and its subject',
      2000
    );
  } catch (error) {
    console.error(
      '[TASK_DIRECTORY_CUE_FAILURE]',
      JSON.stringify({ phase, added, rawRoot, fakeTimers: vi.isFakeTimers() })
    );
    throw error;
  } finally {
    native.off('addDir', onDirectory);
    native.off('raw', onRaw);
  }
}

describe('TaskFileWatcher (native delivery)', () => {
  const errorLogs = (): string[] =>
    vi.mocked(logger.error).mock.calls.map((call) => String(call[0]));

  let dorkHome: string;

  let skillsDir: string;

  let db: Db;

  let store: TaskStore;

  let watcher: TaskFileWatcher;

  let scheduler: FakeScheduler;

  beforeEach(async () => {
    vi.spyOn(logger, 'error');
    // Resolved up front: a row discovered in a skills root is keyed on the
    // file's REAL path, and every macOS temp directory sits under a symlinked
    // `/var` — so a test that built its paths from the unresolved root would
    // look up rows that exist under a different name and time out.
    dorkHome = await realpath(await mkdtemp(path.join(tmpdir(), 'task-watcher-')));
    skillsDir = path.join(dorkHome, 'skills');
    await mkdir(skillsDir, { recursive: true });
    db = createTestDb();
    store = new TaskStore(db);
    scheduler = new FakeScheduler();
    watcher = new TaskFileWatcher(
      store,
      new TaskRegistrar({ store, scheduler }),
      new ScheduleIdentityRegistry()
    );
    vi.mocked(logger.error).mockClear();
  });

  afterEach(async () => {
    // A failed native wait must not leave a constructor spy in the next test.
    vi.restoreAllMocks();
    await watcher.stopAll();
    await rm(dorkHome, { recursive: true, force: true });
  });

  describe('recovery after a genuine sibling cue', () => {
    let file: string;
    let sibling: string;
    let restoreEmit = () => {};
    let restoreFactory = () => {};
    beforeEach(async () => {
      restoreEmit = () => {};
      restoreFactory = () => {};
      const normalDir = path.join(skillsDir, 'real-task');
      // Register the normal directory without a task before imposing file loss.
      await mkdir(normalDir);
      const readinessProbe = path.join(normalDir, 'watch-readiness.txt');
      await writeFile(readinessProbe, 'before-watch');
      let directoryHandleReady = false;
      let awaitingDirectoryHandle = false;
      file = path.join(normalDir, 'SKILL.md');
      let droppedFileEvent: 'add' | 'change' | undefined;
      const originalWatch = chokidar.watch.bind(chokidar);
      let native: ReturnType<typeof chokidar.watch> | undefined;
      const watch = vi.spyOn(chokidar, 'watch').mockImplementation((...args) => {
        const actual = originalWatch(...args);
        native = actual;
        const emit = actual.emit;
        const normal = (value: unknown) =>
          typeof value === 'string' &&
          (value === normalDir || value.startsWith(normalDir + path.sep));
        // Impose normal-file loss at the actual emission edge. Root raw notifications
        // cannot identify which creation caused them, so drop them in this case;
        // recovery must use the backup's identifiable addDir. Other cases retain
        // coverage of the production addDir-or-root-raw union.
        Reflect.defineProperty(actual, 'emit', {
          configurable: true,
          value(event: string | symbol, ...values: unknown[]) {
            const details = values[2];
            const watchedPath =
              details && typeof details === 'object'
                ? Reflect.get(details, 'watchedPath')
                : undefined;
            // Only this directory handle's actual probe notification acknowledges
            // readiness; the probe's own file handle cannot satisfy it.
            if (
              awaitingDirectoryHandle &&
              event === 'raw' &&
              watchedPath === normalDir &&
              typeof values[1] === 'string' &&
              path.resolve(normalDir, values[1]) === readinessProbe
            )
              directoryHandleReady = true;
            const lost =
              event === 'raw'
                ? normal(values[1]) || normal(watchedPath) || watchedPath === skillsDir
                : normal(event === 'all' ? values[1] : values[0]);
            if (lost && (event === 'add' || event === 'change') && values[0] === file)
              droppedFileEvent = event;
            return lost ? false : Reflect.apply(emit, actual, [event, ...values]);
          },
        });
        restoreEmit = () => Reflect.defineProperty(actual, 'emit', { value: emit });
        return actual;
      });
      restoreFactory = () => watch.mockRestore();
      watcher.watch(skillsRoot(skillsDir, 'global'));
      await watcher.ready();
      if (!native) throw new Error('The real watcher did not open.');
      expect(store.getTasks()).toEqual([]);
      // Chokidar ready is not an acknowledgement from the underlying directory
      // handle. Recreate only this non-task entry until that handle reports it.
      awaitingDirectoryHandle = true;
      const readinessDeadline = Date.now() + 2000;
      for (let pulse = 0; pulse < 41 && !directoryHandleReady; pulse++) {
        if (Date.now() >= readinessDeadline) break;
        await rm(readinessProbe);
        await writeFile(readinessProbe, `after-ready-${pulse}`, { flag: 'wx' });
        if (!directoryHandleReady)
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(50, Math.max(0, readinessDeadline - Date.now())))
          );
      }
      if (!directoryHandleReady)
        throw new Error('timed out waiting for the actual normal-directory handle probe');
      const siblingDir = path.join(
        skillsDir,
        `real-task.dorkos-bak-${Date.now()}-9f1c2d3e-0000-4000-8000-000000000000`
      );
      await writeFile(file, skillFile('real-task'));
      await waitUntil(
        () => droppedFileEvent !== undefined,
        'the actual normal-file notification to be dropped',
        2000
      );
      expect(store.fileSync.getByFilePath(file)).toBeNull();
      let backupAdded = false;
      const onDirectory = (directory: string) => {
        if (directory === siblingDir) backupAdded = true;
      };
      native.on('addDir', onDirectory);
      try {
        await mkdir(siblingDir);
        await waitUntil(() => backupAdded, 'the actual backup directory cue', 2000);
      } finally {
        native.off('addDir', onDirectory);
      }
      sibling = path.join(siblingDir, 'SKILL.md');
      await writeFile(sibling, skillFile('real-task'));
    });
    afterEach(async () => {
      try {
        await watcher.stopAll();
      } finally {
        restoreEmit();
        restoreFactory();
      }
    });
    it('discovers a task whose native delivery is lost beside a real directory cue', async () => {
      await waitUntil(
        () => store.fileSync.getByFilePath(file) !== null,
        'the lost live task',
        3500
      );
      await holdsFor(() => store.fileSync.getByFilePath(sibling) === null, 'the rejected sibling');
      expect(store.getTasks().map((task) => task.filePath)).toEqual([file]);
      const recovered = store.fileSync.getByFilePath(file)!;
      expect(recovered).toMatchObject({ cron: '0 9 * * *', status: 'pending_approval' });
      expect(scheduler.hasJob(recovered.id)).toBe(false);
      expect(watcher.rootsWithoutLiveWatch(), errorLogs().join('\n')).toEqual([]);
    });
  });

  describe('approved clocks reached through real directory cues', () => {
    async function approvedClock() {
      const file = path.join(skillsDir, 'clock', 'SKILL.md');
      await mkdir(path.dirname(file));
      await writeFile(file, skillFile('clock'));
      const opened = vi.spyOn(chokidar, 'watch');
      watcher.watch(skillsRoot(skillsDir, 'global'));
      await watcher.ready();
      const actual = opened.mock.results[0];
      if (actual?.type !== 'return') throw new Error('The real watcher did not open.');
      const task = store.fileSync.getByFilePath(file)!;
      store.updateTask(task.id, { status: 'active' });
      new TaskRegistrar({ store, scheduler }).syncTask(task.id);
      expect(scheduler.hasJob(task.id)).toBe(true);
      const reads = vi.spyOn(store.fileSync, 'upsertFromFile');
      const cue = async (suffix: string) => {
        reads.mockClear();
        const dir = path.join(skillsDir, `clock.dorkos-bak-${suffix}`);
        const started = performance.now();
        let firstSubjectReadObservedAt: number | undefined;
        try {
          await directoryCue(
            actual.value,
            skillsDir,
            dir,
            () => mkdir(dir),
            () => {
              const subjectRead = reads.mock.calls.some(([def]) => def.filePath === file);
              if (subjectRead && firstSubjectReadObservedAt === undefined)
                firstSubjectReadObservedAt = performance.now();
              return subjectRead;
            }
          );
        } catch (error) {
          console.error(
            '[TASK_WATCH_CUE_FAILURE]',
            JSON.stringify({
              suffix,
              started,
              failedAt: performance.now(),
              fakeTimers: vi.isFakeTimers(),
              subjectReads: reads.mock.calls.filter(([def]) => def.filePath === file).length,
              allReads: reads.mock.calls.length,
              firstSubjectReadObservedAt,
              watcherErrors: errorLogs()
                .slice(-8)
                .map((message) => message.slice(0, 500)),
            })
          );
          throw error;
        }
      };
      // Readiness includes settling the old discovery explanation after approval.
      await cue('settle');
      return {
        file,
        task,
        cue,
        approved: store.getTask(task.id),
        registrations: scheduler.registered.length,
      };
    }
    let clock: Awaited<ReturnType<typeof approvedClock>>;
    beforeEach(async () => {
      clock = await approvedClock();
    });

    it('keeps an unchanged live job and its row through a directory rescan', async () => {
      const { task, cue, approved, registrations } = clock;
      await cue('unchanged');
      expect(store.getTask(task.id)).toEqual(approved);
      await holdsFor(() => scheduler.registered.length === registrations, 'the original clock');
      expect(store.getTask(task.id)?.status).toBe('active');
    });

    it('repairs a missing clock then requires approval of its changed cron', async () => {
      const { file, task, cue, registrations } = clock;
      scheduler.jobs.delete(task.id);
      await cue('missing');
      await waitUntil(() => scheduler.hasJob(task.id), 'the missing clock to be repaired', 1000);
      expect(scheduler.registered).toHaveLength(registrations + 1);
      await writeFile(file, skillFile('clock').replace("'0 9 * * *'", "'0 10 * * *'"));
      await waitUntil(
        () => store.getTask(task.id)?.cron === '0 10 * * *' && !scheduler.hasJob(task.id),
        'the changed task to await approval',
        1000
      );
      store.updateTask(task.id, { status: 'active' });
      new TaskRegistrar({ store, scheduler }).syncTask(task.id);
      expect(scheduler.cronFor(task.id)).toBe('0 10 * * *');
      expect(scheduler.registered).toHaveLength(registrations + 2);
    });
  });

  it('cancels a removed root’s queued scan and permits a fresh watch of that path', async () => {
    const opened = vi.spyOn(chokidar, 'watch');
    const root = skillsRoot(skillsDir, 'global');
    let phase = 'initial-watch';
    let succeeded = false;
    try {
      watcher.watch(root);
      await watcher.ready();
      const first = opened.mock.results[0];
      if (first?.type !== 'return') throw new Error('The real watcher did not open.');
      const child = path.join(skillsDir, 'later');
      phase = 'native-directory-cue';
      await directoryCue(first.value, skillsDir, child, () => mkdir(child));
      phase = 'stop-root';
      await watcher.stopWatching(skillsDir);
      const file = path.join(child, 'SKILL.md');
      await writeFile(file, skillFile('later'));
      phase = 'stopped-root-absence';
      await holdsFor(
        () => store.fileSync.getByFilePath(file) === null,
        'the stopped root to stay unsynced',
        TASK_DIRECTORY_CATCH_UP_MS * 2
      );
      expect(store.fileSync.getByFilePath(file)).toBeNull();

      phase = 'replacement-ready';
      watcher.watch(root);
      const second = opened.mock.results[1];
      if (second?.type !== 'return') throw new Error('The replacement watcher did not open.');
      await watcher.ready();
      expect(store.getTasks().map((task) => task.filePath)).toEqual([file]);
      await watcher.stopAll();
      watcher.watch(root);
      expect(opened).toHaveBeenCalledTimes(2);
      succeeded = true;
    } finally {
      if (!succeeded)
        console.error(
          '[TASK_WATCH_CANCEL_FAILURE]',
          JSON.stringify({ phase, fakeTimers: vi.isFakeTimers() })
        );
      await watcher.stopAll();
      opened.mockRestore();
    }
  });

  it('is the WATCH that delivers an edit once the root is settled', async () => {
    const live = new TaskFileWatcher(
      store,
      new TaskRegistrar({ store, scheduler }),
      new ScheduleIdentityRegistry(),
      { rearmMs: 0, settleMs: 50 }
    );
    try {
      await mkdir(path.join(skillsDir, 'edited'), { recursive: true });
      const file = path.join(skillsDir, 'edited', 'SKILL.md');
      await writeFile(file, skillFile('edited'), 'utf-8');
      live.watch(skillsRoot(skillsDir, 'global'));
      await live.ready();
      expect(store.fileSync.getByFilePath(file)).not.toBeNull();

      // An edit after startup must reach the store through the real native watch.
      await writeFile(file, skillFile('edited').replace("'0 9 * * *'", "'0 10 * * *'"), 'utf-8');
      await waitUntil(
        () => {
          const row = store.fileSync.getByFilePath(file);
          return row !== null && row.cron === '0 10 * * *';
        },
        'the watch to deliver the edit',
        4000
      );
    } finally {
      await live.stopAll();
    }
  });
});
