import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TaskStore } from '../task-store.js';
import { ScheduleIdentityRegistry } from '../schedule-identity.js';
import { skillsRoot } from './task-root-fixtures.js';
import type { Task } from '@dorkos/shared/types';

vi.mock('../../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  // The registrar (constructed by these suites) builds a tagged child logger at
  // import time; without this the module mock has no `createTaggedLogger` to
  // give it and the whole suite fails to load.
  createTaggedLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// Mock chokidar so we can drive the watcher's handlers synchronously, without
// touching the real filesystem. Hoisted so the objects exist when the
// (also-hoisted) vi.mock factory runs.
const { mockWatcher, mockChokidar } = vi.hoisted(() => {
  const watcher = { on: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
  return { mockWatcher: watcher, mockChokidar: { watch: vi.fn(() => watcher) } };
});
vi.mock('chokidar', () => ({ default: mockChokidar }));

// `TaskFileWatcher` refuses to arm a watch on a directory that does not exist
// (DOR-1908: chokidar silently watches an ancestor instead and never reports on
// the directory at all). These cases drive the handlers over paths that are not
// on disk, so the existence check is answered here — the same shape as mocking
// chokidar itself. The absent-root behaviour has its own real-filesystem suite,
// where the answer is not mocked.
const { mockExistsSync } = vi.hoisted(() => ({ mockExistsSync: vi.fn(() => true) }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: mockExistsSync };
});

import { TaskFileWatcher } from '../task-file-watcher.js';
import { TaskRegistrar } from '../task-registrar.js';
import { FakeScheduler } from './fake-scheduler.js';
import { logger } from '../../../lib/logger.js';

/** Every watcher this file made, so `afterEach` can stop its re-arm timer. */
const started: TaskFileWatcher[] = [];

/** A watcher wired to a registrar whose scheduler only records. */
function makeWatcher(store: TaskStore = makeStore()): {
  watcher: TaskFileWatcher;
  scheduler: FakeScheduler;
} {
  const scheduler = new FakeScheduler();
  const watcher = new TaskFileWatcher(
    store,
    new TaskRegistrar({ store, scheduler }),
    new ScheduleIdentityRegistry()
  );
  started.push(watcher);
  return { watcher, scheduler };
}

/** Resolve the watcher's FIRST handler for a chokidar event name. */
function handlerFor(event: 'add' | 'change' | 'unlink' | 'error'): (arg: unknown) => void {
  const call = mockWatcher.on.mock.calls.find(([e]) => e === event);
  if (!call) throw new Error(`no ${event} handler registered`);
  return call[1] as (arg: unknown) => void;
}

/** Resolve ALL of the watcher's registered handlers for an event — one per watch() call. */
function handlersFor(event: 'add' | 'change' | 'unlink' | 'error'): Array<(arg: unknown) => void> {
  return mockWatcher.on.mock.calls
    .filter(([e]) => e === event)
    .map(([, fn]) => fn as (arg: unknown) => void);
}

/** An Error carrying a NodeJS.ErrnoException-style `code`. */
function errnoError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

/** A TaskStore stub — only the methods TaskFileWatcher actually calls. */
function makeStore(): TaskStore {
  return {
    fileSync: {
      upsertFromFile: vi.fn(),
      markRemovedByFilePath: vi.fn(),
      getByFilePath: vi.fn().mockReturnValue(null),
    },
    getTask: vi.fn().mockReturnValue(null),
  } as unknown as TaskStore;
}

describe('TaskFileWatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWatcher.on.mockReturnValue(mockWatcher);
    mockWatcher.close.mockResolvedValue(undefined);
    mockChokidar.watch.mockReturnValue(mockWatcher);
    mockExistsSync.mockReturnValue(true);
  });

  afterEach(async () => {
    while (started.length > 0) await started.pop()?.stopAll();
  });

  // A dead watcher (e.g. EMFILE when the process runs out of file descriptors)
  // must be logged with enough context to identify which directory's watcher
  // died, never left to surface as unhandled-error spam.
  describe('watcher error handling', () => {
    it('logs a watcher error naming the tasks dir and scope (global)', () => {
      const { watcher } = makeWatcher();
      watcher.watch(skillsRoot('/dork-home/tasks', 'global'));

      const err = errnoError('EMFILE', 'EMFILE: too many open files');
      handlerFor('error')(err);

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('[watcher-error] TaskFileWatcher: /dork-home/tasks (global)'),
        expect.objectContaining({
          tasksDir: '/dork-home/tasks',
          scope: 'global',
          code: 'EMFILE',
          message: 'EMFILE: too many open files',
          stack: err.stack,
          suppressingFurtherErrors: true,
        })
      );
    });

    // One fd-exhaustion episode fires 'error' once per directory: log the
    // first of each code, never let one benign code hide a different one.
    it('logs the first error of each code once, and per watcher', () => {
      const { watcher } = makeWatcher();
      watcher.watch(skillsRoot('/dork-home/tasks-a', 'global'));
      watcher.watch(skillsRoot('/dork-home/tasks-b', 'project', '/work/b', 'agent-b'));
      const [onErrorA, onErrorB] = handlersFor('error');

      onErrorA!(errnoError('EACCES', 'permission denied'));
      onErrorA!(errnoError('EMFILE', 'EMFILE 1'));
      onErrorA!(errnoError('EMFILE', 'EMFILE 2'));
      onErrorB!(errnoError('EMFILE', 'EMFILE B'));

      expect(
        vi.mocked(logger.error).mock.calls.map(([, meta]) => (meta as { message: string }).message)
      ).toEqual(['permission denied', 'EMFILE 1', 'EMFILE B']);
    });
  });
  // The removal half of the seam. A row paused in the database while its cron
  // job keeps firing is the same lie the watcher told about every other edit
  // before the registrar existed.
  describe('a removed file', () => {
    const FILE = '/dork-home/tasks/gone/SKILL.md';

    it('pauses the row and stops the job that ran from it', () => {
      const store = makeStore();
      const row = { id: 'task-1', filePath: FILE } as unknown as Task;
      vi.mocked(store.fileSync.getByFilePath).mockReturnValue(row);
      vi.mocked(store.getTask).mockReturnValue({
        ...row,
        enabled: false,
        status: 'paused',
      } as Task);
      const { watcher, scheduler } = makeWatcher(store);
      watcher.watch(skillsRoot('/dork-home/tasks', 'global'));

      handlerFor('unlink')(FILE);

      expect(store.fileSync.markRemovedByFilePath).toHaveBeenCalledWith(FILE);
      expect(scheduler.unregistered).toEqual(['task-1']);
    });

    it('does not throw when the store fails mid-retirement', () => {
      const store = makeStore();
      vi.mocked(store.fileSync.markRemovedByFilePath).mockImplementation(() => {
        throw new Error('database is locked');
      });
      const { watcher } = makeWatcher(store);
      watcher.watch(skillsRoot('/dork-home/tasks', 'global'));

      expect(() => handlerFor('unlink')(FILE)).not.toThrow();
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to retire'),
        expect.anything()
      );
    });
  });
});
