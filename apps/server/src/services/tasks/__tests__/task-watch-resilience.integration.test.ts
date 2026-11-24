/**
 * What the scheduler promises when chokidar is not delivering (DOR-1908).
 *
 * Real filesystem, store, registrar and reconciler — and a chokidar that
 * reports NOTHING, because all three of the watcher's holes end in "no event
 * ever arrives". The fake watcher is the condition under test; the live path
 * is asserted against real chokidar in `task-file-watcher.integration.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TaskFileWatcher } from '../task-file-watcher.js';
import { TaskReconciler, UNWATCHED_ROOT_SWEEP_MS } from '../task-reconciler.js';
import { ScheduleIdentityRegistry } from '../schedule-identity.js';
import { skillsRoot } from './task-root-fixtures.js';
import { TaskRegistrar } from '../task-registrar.js';
import { FakeScheduler } from './fake-scheduler.js';
import { TaskStore } from '../task-store.js';
import { createTestDb } from '@dorkos/test-utils/db';
import { logger } from '../../../lib/logger.js';
import type { Db } from '@dorkos/db';

/**
 * A chokidar that opens, can be told to say `ready` or to fail, and never
 * reports a file change — the shape every one of the three holes leaves behind.
 */
const { fakeWatchers, mockChokidar } = vi.hoisted(() => {
  interface Fake {
    path: string;
    closed: boolean;
    handlers: Map<string, ((arg: unknown) => void)[]>;
    on(event: string, fn: (arg: unknown) => void): Fake;
    close(): Promise<void>;
    emit(event: string, arg?: unknown): void;
  }
  const watchers: Fake[] = [];
  const watch = (target: string): Fake => {
    const handlers = new Map<string, ((arg: unknown) => void)[]>();
    const fake: Fake = {
      path: target,
      closed: false,
      handlers,
      on(event, fn) {
        handlers.set(event, [...(handlers.get(event) ?? []), fn]);
        return fake;
      },
      async close() {
        fake.closed = true;
      },
      emit(event, arg) {
        for (const fn of handlers.get(event) ?? []) fn(arg);
      },
    };
    watchers.push(fake);
    return fake;
  };
  // A spy around the factory, so a case can make ONE arm throw.
  return { fakeWatchers: watchers, mockChokidar: { watch: vi.fn(watch) } };
});
vi.mock('chokidar', () => ({ default: mockChokidar }));

/** A skill with no `schedule:` block at all — an ordinary skill. */
function plainSkillFile(name: string): string {
  return `---\nname: ${name}\ndescription: A skill named ${name}\n---\nJust a skill.`;
}

/** Frontmatter + body for a minimal, schema-valid scheduled SKILL.md. */
function skillFile(name: string, cron = '0 9 * * *'): string {
  return `---\nname: ${name}\ndescription: A task named ${name}\nschedule:\n  cron: '${cron}'\n---\nDo the thing.`;
}

/** Poll `check` until it is true or the deadline passes. */
async function waitUntil(check: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** An Error carrying a NodeJS.ErrnoException-style `code`. */
function errnoError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

describe('the scheduler keeps its promise with the watch dead (DOR-1908)', () => {
  let dorkHome: string;
  let skillsDir: string;
  let db: Db;
  let store: TaskStore;
  let identities: ScheduleIdentityRegistry;
  let registrar: TaskRegistrar;
  let watcher: TaskFileWatcher | undefined;
  let reconciler: TaskReconciler | undefined;

  /** Build a watcher over `skillsDir`, plus the reconciler that reads its health. */
  function build(opts: { settleMs?: number; rearmMs?: number } = {}): {
    watcher: TaskFileWatcher;
    reconciler: TaskReconciler;
  } {
    watcher = new TaskFileWatcher(store, registrar, identities, {
      settleMs: opts.settleMs ?? 10,
      rearmMs: opts.rearmMs ?? 0,
    });
    reconciler = new TaskReconciler(store, registrar, identities, watcher);
    return { watcher, reconciler };
  }

  /** Write `<skillsDir>/<name>/SKILL.md`. */
  async function writeSkill(name: string, cron?: string): Promise<string> {
    const dir = path.join(skillsDir, name);
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, 'SKILL.md');
    await writeFile(filePath, skillFile(name, cron), 'utf-8');
    return filePath;
  }

  /** The one and only fake watcher opened so far. */
  function onlyWatcher(): (typeof fakeWatchers)[number] {
    expect(fakeWatchers).toHaveLength(1);
    return fakeWatchers[0]!;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    // Every pass here logs the fault it contains; keep the run's output readable.
    for (const level of ['info', 'warn', 'error'] as const) {
      vi.spyOn(logger, level).mockImplementation(() => {});
    }
    fakeWatchers.length = 0;
    // Rows are keyed on the REAL path; macOS temp directories sit under a symlink.
    dorkHome = await realpath(await mkdtemp(path.join(tmpdir(), 'watch-resilience-')));
    skillsDir = path.join(dorkHome, 'skills');
    await mkdir(skillsDir, { recursive: true });
    db = createTestDb();
    store = new TaskStore(db);
    identities = new ScheduleIdentityRegistry();
    registrar = new TaskRegistrar({ store, scheduler: new FakeScheduler() });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    reconciler?.stop();
    await watcher?.stopAll();
    watcher = undefined;
    reconciler = undefined;
    await rm(dorkHome, { recursive: true, force: true });
  });

  describe('the settle after `ready`', () => {
    // Hole 2: chokidar drops a skill written just after `ready`, so the
    // catch-up scan runs at the END of a settle window.
    it('covers a schedule written in the window a fresh watch drops events in', async () => {
      const { watcher: w } = build({ settleMs: 300 });
      w.watch(skillsRoot(skillsDir, 'global'));
      onlyWatcher().emit('ready');

      await new Promise((r) => setTimeout(r, 100));
      const file = await writeSkill('written-in-the-window');

      await w.ready();
      expect(store.fileSync.getByFilePath(file)).not.toBeNull();
    });
  });

  describe('a watch that has died', () => {
    it('picks up an EDIT to a schedule that already existed, not only a new one', async () => {
      const file = await writeSkill('edited-while-blind');
      const { watcher: w, reconciler: r } = build();
      const root = skillsRoot(skillsDir, 'global');
      w.watch(root);
      r.addRoot(root);
      const fake = onlyWatcher();
      fake.emit('ready');
      await w.ready();
      expect(store.fileSync.getByFilePath(file)?.cron).toBe('0 9 * * *');
      fake.emit('error', errnoError('EMFILE', 'EMFILE: too many open files, watch'));

      await writeSkill('edited-while-blind', '30 6 * * *');
      await r.sweepUnwatchedRoots();

      // An edit in place moves neither the root's mtime nor its entry's.
      expect(store.fileSync.getByFilePath(file)?.cron).toBe('30 6 * * *');
    });

    it('leaves a root whose watch is live to the watch', async () => {
      const { watcher: w, reconciler: r } = build();
      const root = skillsRoot(skillsDir, 'global');
      w.watch(root);
      r.addRoot(root);
      onlyWatcher().emit('ready');
      await w.ready();

      const file = await writeSkill('the-watch-owns-this');
      await r.sweepUnwatchedRoots();

      // The tightened pass is only for roots nothing is listening to.
      expect(store.fileSync.getByFilePath(file)).toBeNull();
    });
  });

  // A slot the reconciler skips must never get a row from the watcher.
  it('treats a dot-directory as not a skill, from either door', async () => {
    const { watcher: w } = build();
    const hidden = path.join(skillsDir, '.hidden');
    await mkdir(hidden, { recursive: true });
    const file = path.join(hidden, 'SKILL.md');
    await writeFile(file, skillFile('hidden'), 'utf-8');

    w.watch(skillsRoot(skillsDir, 'global'));
    const fake = onlyWatcher();
    fake.emit('ready');
    await w.ready();
    expect(store.fileSync.getByFilePath(file)).toBeNull();

    // A live event naming the very same path.
    for (const handler of fake.handlers.get('add') ?? []) handler(file);
    await new Promise((r) => setTimeout(r, 50));
    expect(store.fileSync.getByFilePath(file)).toBeNull();
  });

  // Nothing awaits the catch-up scan, so a throw there reaches the process-wide
  // handler and abandons the loop.
  describe('a file that cannot be written to the database', () => {
    it('costs only itself — the rest of the root still syncs, and nothing escapes', async () => {
      const rejections: unknown[] = [];
      const onRejection = (reason: unknown): void => {
        rejections.push(reason);
      };
      process.on('unhandledRejection', onRejection);
      try {
        for (const name of ['a-first', 'b-second', 'c-third', 'd-fourth']) await writeSkill(name);

        const real = store.fileSync.upsertFromFile.bind(store.fileSync);
        let attempts = 0;
        const upsert = vi
          .spyOn(store.fileSync, 'upsertFromFile')
          .mockImplementation((def, id, opts) => {
            attempts++;
            if (attempts === 1)
              throw Object.assign(new Error('database is locked'), {
                code: 'SQLITE_BUSY',
              });
            return real(def, id, opts);
          });

        const { watcher: w } = build();
        w.watch(skillsRoot(skillsDir, 'global'));
        onlyWatcher().emit('ready');
        await w.ready();

        // Every file was attempted, and the three that could be written were.
        expect(attempts).toBe(4);
        expect(store.getTasks()).toHaveLength(3);
        upsert.mockRestore();

        await new Promise((r) => setTimeout(r, 50));
        expect(rejections).toEqual([]);
      } finally {
        process.off('unhandledRejection', onRejection);
      }
    });

    // Arming runs from a bare `setInterval`, where a synchronous throw exits the process.
    it('does not take the process down when arming a watch throws', async () => {
      const later = path.join(dorkHome, 'unarmable');
      const { watcher: w } = build({ rearmMs: 20 });
      w.watch(skillsRoot(later, 'project', dorkHome, 'agent-1'));

      mockChokidar.watch.mockImplementationOnce(() => {
        throw Object.assign(new Error('EMFILE: too many open files, watch'), { code: 'EMFILE' });
      });
      await mkdir(later, { recursive: true });
      await waitUntil(
        () =>
          vi.mocked(logger.error).mock.calls.some((c) => String(c[0]).includes('Could not arm')),
        'the failed arm to be reported'
      );

      expect(w.rootsWithoutLiveWatch()).toEqual([later]);
    });
  });

  // A plugin skill is reached through a `pkg__name` link but keyed on its REAL
  // path; pausing by the walked-in path matches nothing and it keeps firing.
  it('pauses a plugin schedule by its real path when the block is removed', async () => {
    const realDir = path.join(dorkHome, 'plugins', 'pack', 'skills', 'sweeper');
    await mkdir(realDir, { recursive: true });
    const realFile = path.join(realDir, 'SKILL.md');
    await writeFile(realFile, skillFile('sweeper'), 'utf-8');
    const link = path.join(skillsDir, 'pack__sweeper');
    await symlink(realDir, link);
    const walkedInPath = path.join(link, 'SKILL.md');

    const { watcher: w } = build();
    w.watch(skillsRoot(skillsDir, 'global'));
    onlyWatcher().emit('ready');
    await w.ready();

    expect(store.fileSync.getByFilePath(realFile)).not.toBeNull();
    expect(store.fileSync.getByFilePath(walkedInPath)).toBeNull();
    expect(store.fileSync.getByFilePath(realFile)?.status).not.toBe('paused');

    await writeFile(realFile, plainSkillFile('sweeper'), 'utf-8');
    for (const handler of onlyWatcher().handlers.get('change') ?? []) handler(walkedInPath);
    await waitUntil(
      () => store.fileSync.getByFilePath(realFile)?.status === 'paused',
      'the plugin schedule to be paused by its real path'
    );

    expect(store.fileSync.getByFilePath(realFile)?.status).toBe('paused');
  });

  describe('the cadences', () => {
    // End to end: a timer fires, a root nothing listens to is swept, and the
    // schedule dropped into it lands.
    it('a schedule dropped into a dead root is on the clock ten seconds later', async () => {
      const { watcher: w, reconciler: r } = build();
      const root = skillsRoot(skillsDir, 'global');
      w.watch(root);
      r.addRoot(root);
      const fake = onlyWatcher();
      fake.emit('ready');
      await w.ready();
      fake.emit('error', errnoError('EMFILE', 'EMFILE: too many open files, watch'));

      const file = await writeSkill('ten-seconds-later');
      expect(store.fileSync.getByFilePath(file)).toBeNull();

      // Fake timers to reach the tick; real ones to let its scan read the disk.
      vi.useFakeTimers();
      try {
        r.start();
        await vi.advanceTimersByTimeAsync(UNWATCHED_ROOT_SWEEP_MS);
      } finally {
        vi.useRealTimers();
      }
      await waitUntil(
        () => store.fileSync.getByFilePath(file) !== null,
        'the tightened pass to land it'
      );

      expect(store.fileSync.getByFilePath(file)).not.toBeNull();
    });
  });

  describe('shutting down', () => {
    it('closes every open watch and stops re-arming', async () => {
      const { watcher: w } = build({ rearmMs: 20 });
      const second = path.join(dorkHome, 'second');
      await mkdir(second, { recursive: true });
      w.watch(skillsRoot(skillsDir, 'global'));
      w.watch(skillsRoot(second, 'project', dorkHome, 'agent-1'));
      expect(fakeWatchers).toHaveLength(2);

      await w.stopAll();

      expect(fakeWatchers.every((fake) => fake.closed)).toBe(true);
      const opened = fakeWatchers.length;
      await new Promise((r) => setTimeout(r, 120));
      expect(fakeWatchers).toHaveLength(opened);
    });

    it('does not re-arm a root that was deliberately dropped', async () => {
      const later = path.join(dorkHome, 'later');
      const { watcher: w } = build({ rearmMs: 20 });
      w.watch(skillsRoot(later, 'project', dorkHome, 'agent-1'));
      expect(fakeWatchers).toHaveLength(0);

      await w.stopWatching(later);
      await mkdir(later, { recursive: true });
      await new Promise((r) => setTimeout(r, 120));

      expect(fakeWatchers).toHaveLength(0);
      expect(w.rootsWithoutLiveWatch()).toEqual([]);
    });

    it('re-arms a root whose directory appears later, and scans what is in it', async () => {
      const later = path.join(dorkHome, 'later');
      const { watcher: w } = build({ rearmMs: 20 });
      w.watch(skillsRoot(later, 'project', dorkHome, 'agent-1'));
      expect(w.rootsWithoutLiveWatch()).toEqual([later]);

      await mkdir(path.join(later, 'appeared'), { recursive: true });
      const file = path.join(later, 'appeared', 'SKILL.md');
      await writeFile(file, skillFile('appeared'), 'utf-8');

      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && fakeWatchers.length === 0) {
        await new Promise((r) => setTimeout(r, 10));
      }
      onlyWatcher().emit('ready');
      await w.ready();

      expect(store.fileSync.getByFilePath(file)).not.toBeNull();
      expect(w.rootsWithoutLiveWatch()).toEqual([]);
    });
  });
});
