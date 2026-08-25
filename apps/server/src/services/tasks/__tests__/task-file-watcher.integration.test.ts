import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

describe('TaskFileWatcher (real chokidar)', () => {
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
