import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FSWatcher } from 'chokidar';
import { loadCeilingMs, loadScaledMs } from '@dorkos/shared/test-budget';
import { watchWithPolling, type PollingWatch } from '../../../__tests__/watch-with-polling.js';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TaskFileWatcher } from '../task-file-watcher.js';
import { ScheduleIdentityRegistry } from '../schedule-identity.js';
import { skillsRoot } from './task-root-fixtures.js';
import { TaskRegistrar } from '../task-registrar.js';
import { FakeScheduler } from './fake-scheduler.js';
import { TaskStore } from '../task-store.js';
import { TASK_TEMPLATES_DIRNAME } from '../task-templates.js';
import { createTestDb } from '@dorkos/test-utils/db';
import { logger } from '../../../lib/logger.js';
import type { Db } from '@dorkos/db';

// Mocked wholesale rather than spied on, matching `task-file-watcher.test.ts`:
// one case here reads the watcher's own failure lines to tell a broken watch
// apart from a machine that has run out of watch descriptors, and nothing here
// wants the real reporter's output in the run log.
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createTaggedLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  logError: (err: unknown) => ({ message: String(err) }),
}));

/**
 * REAL chokidar + real filesystem, because the claim under test is precisely
 * "what does the watcher do when it sees this file". A test that seeded rows
 * with `store.createTask` would assert nothing about the watcher.
 *
 * Every watch here POLLS (`watchWithPolling`): macOS drops native events
 * outright under load, and these cases failed on healthy code at a load of
 * 7-8 because of it (DOR-2021). The production options, handlers and catch-up
 * scan are all still the real ones; only how chokidar notices a change differs.
 */

/** How often the polling watch re-stats. */
const POLL_MS = 50;

/**
 * Each case's own timeout: the worst its scaled waits can grow to, capped so a
 * wait that cannot finish reports its own message rather than a bare timeout.
 */
const CASE_TIMEOUT_MS = Math.min(loadCeilingMs(15_000), 60_000);

/**
 * Drop everything a real watcher reports at or under `dir`, so the platform's
 * delivery of that one folder is lost while the folder itself is real on disk.
 * A `raw` or `all` event names its path second; every other event first.
 */
function loseDeliveryUnder(actual: FSWatcher, dir: string): void {
  const emit = actual.emit;
  const under = (value: unknown) =>
    typeof value === 'string' && (value === dir || value.startsWith(dir + path.sep));
  Reflect.defineProperty(actual, 'emit', {
    configurable: true,
    value(event: string | symbol, ...values: unknown[]) {
      const subject = event === 'raw' || event === 'all' ? values[1] : values[0];
      return under(subject) ? false : Reflect.apply(emit, actual, [event, ...values]);
    },
  });
}

/** Frontmatter + body for a minimal, schema-valid task SKILL.md. */
function skillFile(name: string): string {
  return `---\nname: ${name}\ndescription: A task named ${name}\nschedule:\n  cron: '0 9 * * *'\n---\nDo the thing.`;
}

/**
 * Poll `check` until it is true or the deadline passes. The budget is widened by
 * the machine's load as the wait STARTS, never at module load.
 */
async function waitUntil(check: () => boolean, label: string, baseMs = 5000): Promise<void> {
  const deadline = Date.now() + loadScaledMs(baseMs);
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

describe('TaskFileWatcher (real chokidar)', { timeout: CASE_TIMEOUT_MS }, () => {
  /**
   * The watcher's own failure lines, so a test can tell "the watch is broken"
   * from "this machine has run out of watch descriptors".
   */
  const errorLogs = (): string[] =>
    vi.mocked(logger.error).mock.calls.map((call) => String(call[0]));

  let dorkHome: string;
  let skillsDir: string;
  let db: Db;
  let store: TaskStore;
  let watcher: TaskFileWatcher;
  let scheduler: FakeScheduler;
  let polling: PollingWatch<FSWatcher>;
  /** What a case does to each real watcher before it can report anything. */
  let onOpen: ((watcher: FSWatcher) => void) | undefined;

  beforeEach(async () => {
    onOpen = undefined;
    polling = watchWithPolling(POLL_MS, (opened) => onOpen?.(opened));
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
    await watcher.stopAll();
    polling.restore();
    vi.restoreAllMocks();
    await rm(dorkHome, { recursive: true, force: true });
  });

  it('never creates a row for a SKILL.md dropped in the reserved templates slot', async () => {
    // A hand-placed file directly in the templates container. A row for it
    // would schedule and fire with no reconciler backstop, and deleting that
    // task would `fs.rm` the whole templates directory.
    await mkdir(path.join(skillsDir, TASK_TEMPLATES_DIRNAME), { recursive: true });
    const reservedSlot = path.join(skillsDir, TASK_TEMPLATES_DIRNAME, 'SKILL.md');
    await writeFile(reservedSlot, skillFile(TASK_TEMPLATES_DIRNAME), 'utf-8');
    // A real template two levels down is a template, not a task, either.
    const templateDir = path.join(skillsDir, TASK_TEMPLATES_DIRNAME, 'daily-health-check');
    await mkdir(templateDir, { recursive: true });
    await writeFile(path.join(templateDir, 'SKILL.md'), skillFile('daily-health-check'), 'utf-8');

    // A normal task alongside it, as the barrier: once ITS row exists, the
    // watcher has walked this directory and delivered its initial adds.
    await mkdir(path.join(skillsDir, 'real-task'), { recursive: true });
    const realTask = path.join(skillsDir, 'real-task', 'SKILL.md');
    await writeFile(realTask, skillFile('real-task'), 'utf-8');

    watcher.watch(skillsRoot(skillsDir, 'global'));

    await waitUntil(() => store.fileSync.getByFilePath(realTask) !== null, 'real-task to sync');
    await holdsFor(
      () => store.fileSync.getByFilePath(reservedSlot) === null,
      'reserved slot to stay unsynced'
    );

    expect(store.getTasks().map((t) => t.filePath)).toEqual([realTask]);
  });

  it('never arms a schedule from a marketplace install sibling (DOR-2273)', async () => {
    // A crash-left backup of a schedule skill is a full copy. A live event for
    // it never passes the shared scanner, so the watcher itself must refuse it,
    // or the same schedule runs twice with no reconciler to retire the copy.
    await mkdir(path.join(skillsDir, 'probe'), { recursive: true });
    const probe = path.join(skillsDir, 'probe', 'SKILL.md');
    await writeFile(probe, skillFile('probe'), 'utf-8');
    watcher.watch(skillsRoot(skillsDir, 'global'));
    await watcher.ready();
    expect(watcher.rootsWithoutLiveWatch(), errorLogs().join('\n')).toEqual([]);
    expect(store.fileSync.getByFilePath(probe)).not.toBeNull();

    // Post-startup directory cues must discover the normal task beside the sibling.
    // Recovery scans use the same rejection policy as individual live file events.
    const siblingDir = path.join(
      skillsDir,
      `real-task.dorkos-bak-${Date.now()}-9f1c2d3e-0000-4000-8000-000000000000`
    );
    await mkdir(siblingDir, { recursive: true });
    const sibling = path.join(siblingDir, 'SKILL.md');
    await writeFile(sibling, skillFile('real-task'), 'utf-8');
    await mkdir(path.join(skillsDir, 'real-task'), { recursive: true });
    const realTask = path.join(skillsDir, 'real-task', 'SKILL.md');
    await writeFile(realTask, skillFile('real-task'), 'utf-8');

    await waitUntil(() => store.fileSync.getByFilePath(realTask) !== null, 'real-task to sync');
    await holdsFor(
      () => store.fileSync.getByFilePath(sibling) === null,
      'sibling to stay unsynced'
    );
    expect(store.fileSync.getByFilePath(sibling)).toBeNull();
  });

  it('rescans on a native notification that names only the root', async () => {
    // FSEvents can report a creation burst as one `raw` event on the watched
    // root, with no `addDir` for the child. A polling watch never emits that
    // shape (its `raw` carries stats, not `watchedPath`), so it is delivered
    // here by hand, in exactly the shape chokidar's native handler emits it.
    const normalDir = path.join(skillsDir, 'real-task');
    onOpen = (actual) => loseDeliveryUnder(actual, normalDir);
    watcher.watch(skillsRoot(skillsDir, 'global'));
    await watcher.ready();
    const [native] = polling.opened;
    if (!native) throw new Error('The real watcher did not open.');
    await mkdir(normalDir);
    const file = path.join(normalDir, 'SKILL.md');
    await writeFile(file, skillFile('real-task'));
    // Without the cue nothing finds it: the delivery really is lost.
    await holdsFor(() => store.fileSync.getByFilePath(file) === null, 'the lost task', 1500);
    native.emit('raw', 'rename', 'real-task', { watchedPath: skillsDir });
    await waitUntil(() => store.fileSync.getByFilePath(file) !== null, 'the root cue rescan', 3500);
    expect(store.getTasks().map((task) => task.filePath)).toEqual([file]);
  });

  // DOR-1908, hole 1. Measured on this machine against chokidar 5 before the
  // fix: pointed at an absent directory, chokidar watches the nearest existing
  // ancestor, `getWatched()` still holds no entry for the directory ten seconds
  // after it is created, and not one event of any kind arrives. The root was
  // deaf for the life of the process, and the only thing that ever noticed a
  // schedule in it was the five-minute reconciler.
  it('discovers a schedule in a root that did not exist when the watch opened', async () => {
    const absentRoot = path.join(dorkHome, 'later', '.agents', 'skills');
    const armed = new TaskFileWatcher(
      store,
      new TaskRegistrar({ store, scheduler }),
      new ScheduleIdentityRegistry(),
      { rearmMs: 100, settleMs: 50 }
    );
    armed.watch(skillsRoot(absentRoot, 'project', path.join(dorkHome, 'later'), 'agent-1'));

    // Nothing to watch, and the watcher says so rather than pretending.
    expect(armed.rootsWithoutLiveWatch()).toEqual([absentRoot]);

    const started = Date.now();
    await mkdir(path.join(absentRoot, 'nightly'), { recursive: true });
    const file = path.join(absentRoot, 'nightly', 'SKILL.md');
    await writeFile(file, skillFile('nightly'), 'utf-8');

    try {
      await waitUntil(
        () => store.fileSync.getByFilePath(file) !== null,
        'the schedule in the newly created root',
        2000
      );
    } finally {
      await armed.stopAll();
    }
    // Reported for the record the ticket asks for; the bound is the wait above (2s on an idle machine).
    console.log(`[DOR-1908] absent root -> schedule discovered in ${Date.now() - started}ms`);
    expect(armed.rootsWithoutLiveWatch()).toEqual([]);
  });

  // The live path, asserted separately from the promise. Everything else in
  // this suite holds whether or not chokidar delivers, which is deliberate —
  // but a suite that only ever proved the catch-up scan would be green on a
  // build whose event wiring did nothing at all. The watch polls, so it cannot
  // drop the edit or run out of descriptors: nothing but the wiring can red it.
  it('is the WATCH that delivers an edit once the root is settled', async () => {
    const live = new TaskFileWatcher(
      store,
      new TaskRegistrar({ store, scheduler }),
      new ScheduleIdentityRegistry(),
      { rearmMs: 0, settleMs: 50 }
    );
    await mkdir(path.join(skillsDir, 'edited'), { recursive: true });
    const file = path.join(skillsDir, 'edited', 'SKILL.md');
    await writeFile(file, skillFile('edited'), 'utf-8');
    live.watch(skillsRoot(skillsDir, 'global'));
    try {
      await live.ready();
      expect(store.fileSync.getByFilePath(file)).not.toBeNull();

      // An edit AFTER the catch-up scan has run: only a live event can carry it.
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
