import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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
import { applyTaskFileUpdate } from '../lifecycle/update-task-file.js';
import {
  computeInstalledFiles,
  readInstalledFiles,
  writeInstalledFiles,
} from '../../marketplace/lib/installed-files.js';

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

describe('TaskFileWatcher (real chokidar)', () => {
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

  beforeEach(async () => {
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
    await rm(dorkHome, { recursive: true, force: true });
  });

  it('never creates a row for a SKILL.md dropped in the reserved templates slot', async () => {
    // A hand-placed file directly in the templates container. A row for it
    // would schedule and fire with no reconciler backstop, and deleting that
    // task would `fs.rm` the whole templates directory.
    await mkdir(path.join(skillsDir, TASK_TEMPLATES_DIRNAME), { recursive: true });
    const reservedSlot = path.join(skillsDir, TASK_TEMPLATES_DIRNAME, 'SKILL.md');
    await writeFile(reservedSlot, skillFile(TASK_TEMPLATES_DIRNAME), 'utf-8');

    // A normal task alongside it, as the barrier: once ITS row exists, the
    // watcher has walked this directory and delivered its initial adds.
    await mkdir(path.join(skillsDir, 'real-task'), { recursive: true });
    const realTask = path.join(skillsDir, 'real-task', 'SKILL.md');
    await writeFile(realTask, skillFile('real-task'), 'utf-8');

    watcher.watch(skillsRoot(skillsDir, 'global'));

    await waitUntil(() => store.getByFilePath(realTask) !== null, 'real-task to sync');
    await holdsFor(
      () => store.getByFilePath(reservedSlot) === null,
      'reserved slot to stay unsynced'
    );

    expect(store.getTasks().map((t) => t.filePath)).toEqual([realTask]);
  });

  it('never arms a schedule from a marketplace install sibling (DOR-2273)', async () => {
    // A crash-left backup of a schedule skill is a full copy. A live event for
    // it never passes the shared scanner, so the watcher itself must refuse it,
    // or the same schedule runs twice with no reconciler to retire the copy.
    watcher.watch(skillsRoot(skillsDir, 'global'));
    await mkdir(path.join(skillsDir, 'probe'), { recursive: true });
    const probe = path.join(skillsDir, 'probe', 'SKILL.md');
    await writeFile(probe, skillFile('probe'), 'utf-8');
    await waitUntil(() => store.getByFilePath(probe) !== null, 'the watch to be live');

    // The sibling arrives as a live event, then a normal task as the barrier.
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

    await waitUntil(() => store.getByFilePath(realTask) !== null, 'real-task to sync');
    await holdsFor(() => store.getByFilePath(sibling) === null, 'sibling to stay unsynced');
    expect(store.getByFilePath(sibling)).toBeNull();
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
        () => store.getByFilePath(file) !== null,
        'the schedule in the newly created root',
        2000
      );
    } finally {
      await armed.stopAll();
    }
    // Reported for the record the ticket asks for; the 2s bound is the wait above.
    console.log(`[DOR-1908] absent root -> schedule discovered in ${Date.now() - started}ms`);
    expect(armed.rootsWithoutLiveWatch()).toEqual([]);
  });

  // The live path, asserted separately from the promise. Everything else in
  // this suite holds whether or not chokidar delivers, which is deliberate —
  // but a suite that only ever proved the catch-up scan would be green on a
  // build whose event wiring did nothing at all.
  it('is the WATCH that delivers an edit once the root is settled', async (ctx) => {
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
    await live.ready();
    expect(store.getByFilePath(file)).not.toBeNull();

    // An edit AFTER the catch-up scan has run: only a live event can carry it.
    await writeFile(file, skillFile('edited').replace("'0 9 * * *'", "'0 10 * * *'"), 'utf-8');
    let delivered = false;
    try {
      await waitUntil(
        () => {
          const row = store.getByFilePath(file);
          return row !== null && row.cron === '0 10 * * *';
        },
        'the watch to deliver the edit',
        4000
      );
      delivered = true;
    } catch {
      // fall through to the skip decision below
    }
    const codes = errorLogs()
      .filter((line) => line.includes('[watcher-error] TaskFileWatcher'))
      .join(' ');
    await live.stopAll();

    if (delivered) return;
    // The one failure that means the watch has stopped listening for good. On a
    // machine already running several agents and two dev servers this is the
    // ORDINARY state, not an exotic one — 80 of 80 trial watches hit it while
    // DOR-1908 was being built. It is the condition the reconciler now covers,
    // and its own cases assert that. Anything else here is a real red.
    expect(
      codes,
      'the watch delivered nothing and reported no descriptor failure — that is a fault in the wiring, not machine load'
    ).toMatch(/EMFILE|ENOSPC/);
    ctx.skip('watch descriptors exhausted (EMFILE/ENOSPC); the reconciler is what covers this');
  });

  it("writes a kept OFF switch into a file that has just stopped being a package's (DOR-2272)", async () => {
    // The watcher's half of the lapse rule the reconciler test pins: a change
    // event on a file whose install no longer lists it must not switch the
    // person's schedule back on, and must leave the file saying it is off.
    const agentDir = path.join(dorkHome, 'repo', '.dork', 'agents', 'helper');
    const agentSkills = path.join(agentDir, '.agents', 'skills');
    const shipped = path.join(agentSkills, 'nightly', 'SKILL.md');
    await mkdir(path.dirname(shipped), { recursive: true });
    await writeFile(shipped, skillFile('nightly'), 'utf-8');
    await mkdir(path.join(agentDir, '.dork'), { recursive: true });
    await writeFile(path.join(agentDir, '.dork', 'manifest.json'), '{}', 'utf-8');
    await writeInstalledFiles(
      agentDir,
      await computeInstalledFiles(agentDir, {
        identity: { name: 'helper', type: 'agent' },
        userEditable: [],
        npmRan: false,
      })
    );
    watcher.watch(skillsRoot(agentSkills, 'project', agentDir, 'agent-helper'));
    await waitUntil(() => store.getByFilePath(shipped)?.packageOwned === 'record', 'discovery');
    const meshCore = { getProjectPath: () => agentDir };
    const edit = async (data: Record<string, unknown>) => {
      const existing = store.getByFilePath(shipped)!;
      const outcome = await applyTaskFileUpdate({ dorkHome, meshCore } as never, {
        existing,
        data: data as never,
      });
      if (!outcome.ok) throw new Error(outcome.error);
      store.updateTask(existing.id, data as never, { timingLandsOn: outcome.timingLandsOn });
    };
    await edit({ status: 'active' });
    await edit({ enabled: false });

    const record = (await readInstalledFiles(agentDir))!;
    const { ['.agents/skills/nightly/SKILL.md']: _released, ...files } = record.files;
    await writeInstalledFiles(agentDir, { ...record, files });
    // A change the approval does not cover, so only the ownership lapse is new.
    await writeFile(
      shipped,
      skillFile('nightly').replace('A task named', 'The task named'),
      'utf-8'
    );

    await waitUntil(() => store.getByFilePath(shipped)?.packageOwned === null, 'the lapse');
    expect(store.getByFilePath(shipped)!.enabled).toBe(false);
    await vi.waitFor(
      async () => expect(await readFile(shipped, 'utf-8')).toContain('enabled: false'),
      {
        timeout: 5000,
      }
    );
    expect(store.getByFilePath(shipped)!.enabled).toBe(false);
  });

  it('still syncs the templates the container legitimately holds, as templates', async () => {
    // `templates/{slug}/SKILL.md` is a template, not a task: it is two levels
    // down, so it was already out of scope, and must stay that way.
    const templateDir = path.join(skillsDir, TASK_TEMPLATES_DIRNAME, 'daily-health-check');
    await mkdir(templateDir, { recursive: true });
    await writeFile(path.join(templateDir, 'SKILL.md'), skillFile('daily-health-check'), 'utf-8');

    await mkdir(path.join(skillsDir, 'real-task'), { recursive: true });
    const realTask = path.join(skillsDir, 'real-task', 'SKILL.md');
    await writeFile(realTask, skillFile('real-task'), 'utf-8');

    watcher.watch(skillsRoot(skillsDir, 'global'));

    await waitUntil(() => store.getByFilePath(realTask) !== null, 'real-task to sync');
    await holdsFor(() => store.getTasks().length === 1, 'only the real task to be synced');
  });
});
