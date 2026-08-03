import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TaskStore } from '../task-store.js';

vi.mock('../../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock chokidar so we can drive the watcher's handlers synchronously, without
// touching the real filesystem. Hoisted so the objects exist when the
// (also-hoisted) vi.mock factory runs.
const { mockWatcher, mockChokidar } = vi.hoisted(() => {
  const watcher = { on: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
  return { mockWatcher: watcher, mockChokidar: { watch: vi.fn(() => watcher) } };
});
vi.mock('chokidar', () => ({ default: mockChokidar }));

import { TaskFileWatcher } from '../task-file-watcher.js';
import { logger } from '../../../lib/logger.js';

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

/** A TaskStore stub — only the two methods TaskFileWatcher actually calls. */
function makeStore(): TaskStore {
  return {
    upsertFromFile: vi.fn(),
    markRemovedBySlug: vi.fn(),
  } as unknown as TaskStore;
}

describe('TaskFileWatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWatcher.on.mockReturnValue(mockWatcher);
    mockWatcher.close.mockResolvedValue(undefined);
    mockChokidar.watch.mockReturnValue(mockWatcher);
  });

  // A dead watcher (e.g. EMFILE when the process runs out of file descriptors)
  // must be logged with enough context to identify which directory's watcher
  // died, never left to surface as unhandled-error spam.
  describe('watcher error handling', () => {
    it('logs a watcher error naming the tasks dir and scope (global)', () => {
      const watcher = new TaskFileWatcher(makeStore(), vi.fn(), '/dork-home');
      watcher.watch('/dork-home/tasks', 'global');

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

    it('logs a watcher error naming the tasks dir and scope (project)', () => {
      const watcher = new TaskFileWatcher(makeStore(), vi.fn(), '/dork-home');
      watcher.watch('/work/project/.dork/tasks', 'project', '/work/project', 'agent-1');

      handlerFor('error')(errnoError('EMFILE', 'EMFILE: too many open files'));

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining(
          '[watcher-error] TaskFileWatcher: /work/project/.dork/tasks (project)'
        ),
        expect.objectContaining({ tasksDir: '/work/project/.dork/tasks', scope: 'project' })
      );
    });

    it('does not throw when the watcher errors', () => {
      const watcher = new TaskFileWatcher(makeStore(), vi.fn(), '/dork-home');
      watcher.watch('/dork-home/tasks', 'global');

      expect(() => handlerFor('error')(new Error('EMFILE'))).not.toThrow();
    });

    it('stringifies a non-Error thrown as the watcher error, with no stack and code "unknown"', () => {
      const watcher = new TaskFileWatcher(makeStore(), vi.fn(), '/dork-home');
      watcher.watch('/dork-home/tasks', 'global');

      handlerFor('error')('disk went away');

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('further unknown errors from this watcher are suppressed'),
        expect.objectContaining({
          code: 'unknown',
          message: 'disk went away',
          stack: undefined,
        })
      );
    });

    // A single fd-exhaustion episode makes chokidar fire 'error' once per
    // directory it fails to (re-)watch — hundreds of times for a real tree. The
    // handler must latch: log the first, drop repeats of the same code.
    it('logs only the first of many errors carrying the same code', () => {
      const watcher = new TaskFileWatcher(makeStore(), vi.fn(), '/dork-home');
      watcher.watch('/dork-home/tasks', 'global');
      const onError = handlerFor('error');

      onError(errnoError('EMFILE', 'EMFILE 1'));
      onError(errnoError('EMFILE', 'EMFILE 2'));
      onError(errnoError('EMFILE', 'EMFILE 3'));

      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ code: 'EMFILE', message: 'EMFILE 1' })
      );
    });

    // The masking bug: a latch keyed on "any error at all" would let one benign
    // EACCES on a stale dir hide a real EMFILE storm that follows it. Keying on
    // `code` means a NEW code always gets its own line.
    it('logs a separate line for each distinct error code', () => {
      const watcher = new TaskFileWatcher(makeStore(), vi.fn(), '/dork-home');
      watcher.watch('/dork-home/tasks', 'global');
      const onError = handlerFor('error');

      onError(errnoError('EACCES', 'permission denied'));
      onError(errnoError('EMFILE', 'too many open files'));

      expect(logger.error).toHaveBeenCalledTimes(2);
      expect(logger.error).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ code: 'EACCES' })
      );
      expect(logger.error).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ code: 'EMFILE' })
      );
    });

    it('says further errors of that code are suppressed, so an operator knows the silence is by design', () => {
      const watcher = new TaskFileWatcher(makeStore(), vi.fn(), '/dork-home');
      watcher.watch('/dork-home/tasks', 'global');

      handlerFor('error')(errnoError('EMFILE', 'EMFILE'));

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('further EMFILE errors from this watcher are suppressed'),
        expect.objectContaining({ suppressingFurtherErrors: true })
      );
    });

    // Regression guard: if the latch were ever hoisted from a per-watch()
    // closure onto a shared instance field, one watcher's first error would
    // wrongly suppress another watcher's first error too. This site runs one
    // watcher per tasks dir — global plus one per registered project — so the
    // masking would be routine, not hypothetical.
    it('scopes the latch per watcher — two directories each log their own first error', () => {
      const watcher = new TaskFileWatcher(makeStore(), vi.fn(), '/dork-home');
      watcher.watch('/dork-home/tasks-a', 'global');
      watcher.watch('/dork-home/tasks-b', 'project', '/work/b', 'agent-b');
      const [onErrorA, onErrorB] = handlersFor('error');
      expect(onErrorA).toBeDefined();
      expect(onErrorB).toBeDefined();
      expect(onErrorA).not.toBe(onErrorB);

      onErrorA!(errnoError('EMFILE', 'EMFILE A'));
      onErrorB!(errnoError('EMFILE', 'EMFILE B'));

      expect(logger.error).toHaveBeenCalledTimes(2);
    });
  });
});
