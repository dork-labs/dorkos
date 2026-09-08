/**
 * What the scheduler promises when chokidar is not delivering (DOR-1908).
 *
 * A real filesystem, a real `TaskStore`, a real `TaskRegistrar` and a real
 * `TaskReconciler` — and a chokidar that reports NOTHING. That combination is
 * the point: all three of the watcher's holes end in "no event ever arrives",
 * and a suite that used the real chokidar could only assert the outcome on a
 * machine that happened to have watch descriptors free. Measured while this was
 * being written, 80 of 80 trial watches on this machine raised
 * `EMFILE: too many open files, watch` and then reported nothing at all.
 *
 * So the fake watcher here is not a convenience. It is the condition under test.
 * The live path is asserted separately, against the real chokidar, in
 * `task-file-watcher.integration.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TaskFileWatcher, UNWATCHED_ROOT_SWEEP_SECONDS } from '../task-file-watcher.js';
import { TaskReconciler, UNWATCHED_ROOT_SWEEP_MS } from '../task-reconciler.js';
import { ScheduleIdentityRegistry } from '../schedule-identity.js';
import { skillsRoot } from './task-root-fixtures.js';
import { TaskRegistrar } from '../task-registrar.js';
import { FakeScheduler } from './fake-scheduler.js';
import { TaskStore } from '../task-store.js';
import { createTestDb } from '@dorkos/test-utils/db';
import { logger } from '../../../lib/logger.js';
import type { Db } from '@dorkos/db';

vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createTaggedLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  logError: (err: unknown) => ({ message: String(err) }),
}));

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
  // A spy around the factory rather than the bare function, so a case can make
  // ONE arm throw (`mockImplementationOnce`) without disturbing the rest.
  // `vi.clearAllMocks()` clears usage data, never the implementation, so the
  // fake survives `beforeEach`.
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
    fakeWatchers.length = 0;
    // Resolved up front: a row discovered in a skills root is keyed on the
    // file's REAL path, and every macOS temp directory sits under a symlinked
    // `/var`.
    dorkHome = await realpath(await mkdtemp(path.join(tmpdir(), 'watch-resilience-')));
    skillsDir = path.join(dorkHome, 'skills');
    await mkdir(skillsDir, { recursive: true });
    db = createTestDb();
    store = new TaskStore(db);
    identities = new ScheduleIdentityRegistry();
    registrar = new TaskRegistrar({ store, scheduler: new FakeScheduler() });
  });

  afterEach(async () => {
    reconciler?.stop();
    await watcher?.stopAll();
    watcher = undefined;
    reconciler = undefined;
    await rm(dorkHome, { recursive: true, force: true });
  });

  describe('the settle after `ready`', () => {
    // Hole 2, measured here against chokidar 5 on macOS: a skill written in the
    // instant after `ready` is dropped 3 times in 40, and 0 in 40 once the
    // watcher has been left to settle for 100ms first. The fix is not to make
    // chokidar reliable — nothing can — but to place the catch-up scan at the
    // END of that window, so the scan sees whatever the window swallowed.
    it('covers a schedule written in the window a fresh watch drops events in', async () => {
      const { watcher: w } = build({ settleMs: 300 });
      w.watch(skillsRoot(skillsDir, 'global'));
      onlyWatcher().emit('ready');

      // Inside the settle window, and the fake reports nothing about it — the
      // same silence a real watch gives during those first milliseconds.
      await new Promise((r) => setTimeout(r, 100));
      const file = await writeSkill('written-in-the-window');

      await w.ready();
      expect(store.getByFilePath(file)).not.toBeNull();
    });

    // The same sequence with the window closed to nothing: the catch-up scan
    // has already run when the file lands, and with no live event the row does
    // not exist. This is what the settle buys, stated as the failure it avoids.
    it('without the settle, the scan runs too early and the schedule is missed', async () => {
      const { watcher: w } = build({ settleMs: 0 });
      w.watch(skillsRoot(skillsDir, 'global'));
      onlyWatcher().emit('ready');
      await w.ready();

      const file = await writeSkill('written-after-the-scan');

      await w.ready();
      expect(store.getByFilePath(file)).toBeNull();
    });
  });

  describe('a watch that has died', () => {
    it('says so once, names the code, and says the reconciler is covering it', async () => {
      const { watcher: w } = build();
      w.watch(skillsRoot(skillsDir, 'global'));
      const fake = onlyWatcher();
      fake.emit('ready');
      await w.ready();

      fake.emit('error', errnoError('EMFILE', 'EMFILE: too many open files, watch'));
      fake.emit('error', errnoError('EMFILE', 'EMFILE: too many open files, watch'));
      fake.emit('error', errnoError('EMFILE', 'EMFILE: too many open files, watch'));

      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining(
          `the reconciler is covering this root every ${UNWATCHED_ROOT_SWEEP_SECONDS}s`
        ),
        expect.objectContaining({ code: 'EMFILE', reconcilerCovering: true })
      );
    });

    it('is reported to the reconciler as a root with no live watch', async () => {
      const { watcher: w } = build();
      w.watch(skillsRoot(skillsDir, 'global'));
      const fake = onlyWatcher();
      fake.emit('ready');
      await w.ready();
      expect(w.rootsWithoutLiveWatch()).toEqual([]);

      fake.emit('error', errnoError('EMFILE', 'EMFILE: too many open files, watch'));

      expect(w.rootsWithoutLiveWatch()).toEqual([skillsDir]);
    });

    // The whole point, end to end: the watch is dead, no event will ever
    // arrive, and the schedule still lands — on the tightened cadence rather
    // than the five-minute one.
    it('still discovers a schedule dropped into the root, on the tightened cadence', async () => {
      const { watcher: w, reconciler: r } = build();
      const root = skillsRoot(skillsDir, 'global');
      w.watch(root);
      r.addRoot(root);
      const fake = onlyWatcher();
      fake.emit('ready');
      await w.ready();
      fake.emit('error', errnoError('EMFILE', 'EMFILE: too many open files, watch'));

      const file = await writeSkill('lands-anyway');
      expect(store.getByFilePath(file)).toBeNull();

      await r.sweepUnwatchedRoots();

      expect(store.getByFilePath(file)).not.toBeNull();
      expect(store.getByFilePath(file)?.cron).toBe('0 9 * * *');
    });

    it('picks up an EDIT to a schedule that already existed, not only a new one', async () => {
      const file = await writeSkill('edited-while-blind');
      const { watcher: w, reconciler: r } = build();
      const root = skillsRoot(skillsDir, 'global');
      w.watch(root);
      r.addRoot(root);
      const fake = onlyWatcher();
      fake.emit('ready');
      await w.ready();
      expect(store.getByFilePath(file)?.cron).toBe('0 9 * * *');
      fake.emit('error', errnoError('EMFILE', 'EMFILE: too many open files, watch'));

      await writeSkill('edited-while-blind', '30 6 * * *');
      await r.sweepUnwatchedRoots();

      // The comparison stats the SKILL.md rather than its directory, because an
      // edit in place moves neither the root's mtime nor its entry's.
      expect(store.getByFilePath(file)?.cron).toBe('30 6 * * *');
    });

    it('costs nothing but a look when the root has not changed', async () => {
      const { watcher: w, reconciler: r } = build();
      const root = skillsRoot(skillsDir, 'global');
      await writeSkill('unchanged');
      w.watch(root);
      r.addRoot(root);
      const fake = onlyWatcher();
      fake.emit('ready');
      await w.ready();
      fake.emit('error', errnoError('EMFILE', 'EMFILE: too many open files, watch'));

      await r.sweepUnwatchedRoots();
      const upserts = vi.spyOn(store, 'upsertFromFile');
      await r.sweepUnwatchedRoots();
      await r.sweepUnwatchedRoots();

      expect(upserts).not.toHaveBeenCalled();
      upserts.mockRestore();
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

      // The tightened pass is for roots nothing is listening to. Sweeping a live
      // root every ten seconds would be a full scan of every project, forever.
      expect(store.getByFilePath(file)).toBeNull();
    });
  });

  // The two doors have to agree about what a schedule even is. A slot the
  // reconciler skips must never get a row from the watcher: nothing re-syncs it
  // and nothing retires it, which is the argument the file already makes about
  // the reserved `templates/` name.
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
    // The catch-up scan skipped it, because `scanSkillDirectory` does.
    expect(store.getByFilePath(file)).toBeNull();

    // And so does a live event naming the very same path.
    for (const handler of fake.handlers.get('add') ?? []) handler(file);
    await new Promise((r) => setTimeout(r, 50));
    expect(store.getByFilePath(file)).toBeNull();
  });

  // The catch-up scan is the third door into `applyOutcome`, and until DOR-1908's
  // review it was the only one with nothing around it. That matters more than it
  // looks: this call IS `state.settled`, and nothing awaits it, so a throw does
  // not fail a test or a request — it reaches the process-wide handler, which
  // logs a line naming neither the watcher nor the root and files a crash
  // report. And the loop is abandoned where it threw.
  describe('a file that cannot be written to the database', () => {
    it('costs only itself — the rest of the root still syncs, and nothing escapes', async () => {
      const rejections: unknown[] = [];
      const onRejection = (reason: unknown): void => {
        rejections.push(reason);
      };
      process.on('unhandledRejection', onRejection);
      try {
        for (const name of ['a-first', 'b-second', 'c-third', 'd-fourth']) await writeSkill(name);

        const real = store.upsertFromFile.bind(store);
        let attempts = 0;
        const upsert = vi.spyOn(store, 'upsertFromFile').mockImplementation((def, id, opts) => {
          attempts++;
          // The ordinary reason a write fails here: another writer holds the
          // database. It says nothing about the file in hand, which is exactly
          // why it must not cost the files behind it.
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
        expect(logger.error).toHaveBeenCalledWith(
          expect.stringContaining('Failed to process'),
          expect.anything()
        );
        upsert.mockRestore();

        // The barrier has resolved and the loop has finished, so anything that
        // escaped would already have been reported.
        await new Promise((r) => setTimeout(r, 50));
        expect(rejections).toEqual([]);
      } finally {
        process.off('unhandledRejection', onRejection);
      }
    });

    // Arming runs from a bare `setInterval` callback, where a SYNCHRONOUS throw
    // does not get logged — it reaches `uncaughtException`, which exits the
    // process. A directory that cannot be watched must never do that.
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

      // Still deaf, so the reconciler keeps covering it, and the next tick
      // tries again rather than the server being gone.
      expect(w.rootsWithoutLiveWatch()).toEqual([later]);
    });
  });

  // An installed plugin's skill reaches a root as a `pkg__name` SYMLINK into
  // `.dork/plugins/`, and the row is keyed on the file's REAL path. So the path
  // the watcher walks in on and the path the row is filed under are two
  // different strings, and pausing by the wrong one matches nothing — the
  // schedule goes on firing from a file that no longer claims it. The same rule
  // the reconciler's retirement already follows.
  it('pauses a plugin schedule by its real path when the block is removed', async () => {
    const realDir = path.join(dorkHome, 'plugins', 'pack', 'skills', 'sweeper');
    await mkdir(realDir, { recursive: true });
    const realFile = path.join(realDir, 'SKILL.md');
    await writeFile(realFile, skillFile('sweeper'), 'utf-8');
    // The shape an install leaves behind: a link in the root, not a directory.
    const link = path.join(skillsDir, 'pack__sweeper');
    await symlink(realDir, link);
    const walkedInPath = path.join(link, 'SKILL.md');

    const { watcher: w } = build();
    w.watch(skillsRoot(skillsDir, 'global'));
    onlyWatcher().emit('ready');
    await w.ready();

    // Filed under the real path, which is NOT the path the root reaches it by.
    expect(store.getByFilePath(realFile)).not.toBeNull();
    expect(store.getByFilePath(walkedInPath)).toBeNull();
    expect(store.getByFilePath(realFile)?.status).not.toBe('paused');

    // The person turns the scheduled skill back into an ordinary one.
    await writeFile(realFile, plainSkillFile('sweeper'), 'utf-8');
    for (const handler of onlyWatcher().handlers.get('change') ?? []) handler(walkedInPath);
    await waitUntil(
      () => store.getByFilePath(realFile)?.status === 'paused',
      'the plugin schedule to be paused by its real path'
    );

    expect(store.getByFilePath(realFile)?.status).toBe('paused');
  });

  describe('the cadences', () => {
    // The whole chain with no seam mocked out: a timer fires, a root nothing is
    // listening to is compared, and the schedule that was dropped into it is on
    // the clock. Asserted end to end because the two halves being individually
    // right is not the same claim — the tick could sweep a set the comparison
    // never reads, and both tests would still be green.
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
      expect(store.getByFilePath(file)).toBeNull();

      // Fake timers to reach the tick without waiting ten real seconds; real
      // ones to let the scan the tick started actually read the disk. Advancing
      // fake time does not advance a thread-pool `readdir`, and a test that
      // asserted the row the instant the callback was invoked would be asserting
      // that the pass is synchronous, which it is not.
      vi.useFakeTimers();
      try {
        r.start();
        await vi.advanceTimersByTimeAsync(UNWATCHED_ROOT_SWEEP_MS);
      } finally {
        vi.useRealTimers();
      }
      await waitUntil(() => store.getByFilePath(file) !== null, 'the tightened pass to land it');

      expect(store.getByFilePath(file)).not.toBeNull();
    });

    it('runs the tightened pass every ten seconds, and the full pass not at all in that time', async () => {
      vi.useFakeTimers();
      try {
        const { watcher: w, reconciler: r } = build();
        const root = skillsRoot(skillsDir, 'global');
        w.watch(root);
        r.addRoot(root);
        const sweep = vi.spyOn(r, 'sweepUnwatchedRoots').mockResolvedValue(undefined);
        const full = vi.spyOn(r, 'reconcile').mockResolvedValue({ upserted: 0, orphaned: 0 });
        r.start();

        expect(UNWATCHED_ROOT_SWEEP_MS).toBe(10_000);
        await vi.advanceTimersByTimeAsync(UNWATCHED_ROOT_SWEEP_MS * 3);

        expect(sweep).toHaveBeenCalledTimes(3);
        // Five minutes is still five minutes for a root whose watch works.
        expect(full).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
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
      // The re-arm timer is a handle too. Left running it would open watches on
      // a watcher the server has already shut down.
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

      // An unregistered agent's directory reappearing on disk must not silently
      // resume discovery for it.
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

      expect(store.getByFilePath(file)).not.toBeNull();
      expect(w.rootsWithoutLiveWatch()).toEqual([]);
    });
  });
});
