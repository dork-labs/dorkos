/**
 * A schedule a person made for an agent that came from a marketplace package
 * syncs like any schedule of theirs, while the package's own schedule beside it
 * keeps the row-only switch (DOR-2272, FB-26).
 *
 * ## Why this drives discovery as well as the update door
 *
 * Ownership decides two things, in two places. The update door asks whether
 * DorkOS may write the file; discovery asks whether the row or the file holds
 * the schedule's switch (`file-sync-gates.ts`). Both now read the install's
 * installed-files record (DOR-2245). If they disagreed, a person's schedule
 * would be written by one and overruled by the other: approved into the file,
 * then held on the row against the person's own later edit of that file.
 *
 * So the fixture is an agent package as an install leaves it — its shipped
 * schedule listed in `.dork/installed-files.json` by `computeInstalledFiles` —
 * and every step goes through `TaskReconciler.reconcile` and
 * {@link applyTaskFileUpdate} + `TaskStore.updateTask`, in the order
 * `PATCH /api/tasks/:id` calls them.
 *
 * @module services/tasks/__tests__/package-agent-own-schedule.integration
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import type { Task, UpdateTaskRequest } from '@dorkos/shared/schemas';
import { TaskStore } from '../task-store.js';
import { TaskReconciler } from '../task-reconciler.js';
import { ScheduleIdentityRegistry } from '../schedule-identity.js';
import type { TaskRegistrar } from '../task-registrar.js';
import { agentSkillsRoot } from '../skills-roots.js';
import { skillsRoot } from './task-root-fixtures.js';
import { applyTaskFileUpdate } from '../lifecycle/update-task-file.js';
import {
  computeInstalledFiles,
  writeInstalledFiles,
} from '../../marketplace/lib/installed-files.js';

/** The id the package's agent is registered under. */
const AGENT_ID = 'agent-helper';

/** A schedule file, switched off the way both of these start. */
const skill = (name: string, prompt: string) =>
  [
    '---',
    `name: ${name}`,
    `description: ${prompt}`,
    'schedule:',
    "  cron: '0 * * * *'",
    '  enabled: false',
    '---',
    prompt,
  ].join('\n');

let db: Db;
let store: TaskStore;
let reconciler: TaskReconciler;
let root: string;
let dorkHome: string;
/** The agent package's install root, which is also the agent's own directory. */
let agentDir: string;
/** The schedule the package shipped, listed in its record. */
let shippedFile: string;
/** A schedule the person made after install, which no record lists. */
let ownFile: string;

/** A registrar that records the sync calls the reconciler makes and runs no cron. */
const registrar = {
  syncTask: vi.fn(),
  syncTaskByFilePath: vi.fn(),
} as unknown as TaskRegistrar;

beforeEach(async () => {
  db = createTestDb();
  store = new TaskStore(db);
  // Resolved: on macOS every temp directory is a symlink, and a schedule's
  // identity is its file's REAL path.
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dorkos-pkg-own-')));
  dorkHome = path.join(root, 'dork');
  await fs.mkdir(dorkHome, { recursive: true });

  // A project-scoped agent package, as an install leaves it: the record is
  // taken from the package's own files, and the person's file arrives later.
  agentDir = path.join(root, 'repo', '.dork', 'agents', 'helper');
  const skillsDir = agentSkillsRoot(agentDir);
  shippedFile = path.join(skillsDir, 'package-sweep', 'SKILL.md');
  await fs.mkdir(path.dirname(shippedFile), { recursive: true });
  await fs.writeFile(shippedFile, skill('package-sweep', 'The package sweeps.'), 'utf-8');
  await fs.mkdir(path.join(agentDir, '.dork'), { recursive: true });
  await fs.writeFile(
    path.join(agentDir, '.dork', 'manifest.json'),
    JSON.stringify({ name: 'helper', version: '1.0.0', type: 'agent' }),
    'utf-8'
  );
  await writeInstalledFiles(
    agentDir,
    await computeInstalledFiles(agentDir, {
      identity: { name: 'helper', type: 'agent' },
      userEditable: [],
      npmRan: false,
    })
  );
  ownFile = path.join(skillsDir, 'my-sweep', 'SKILL.md');
  await fs.mkdir(path.dirname(ownFile), { recursive: true });
  await fs.writeFile(ownFile, skill('my-sweep', 'I sweep my way.'), 'utf-8');

  reconciler = new TaskReconciler(store, registrar, new ScheduleIdentityRegistry());
  reconciler.addRoot(skillsRoot(skillsDir, 'project', agentDir, AGENT_ID));
});

afterEach(async () => {
  store.close();
  await fs.rm(root, { recursive: true, force: true });
});

/** Mesh, answering for the agent exactly as the registry does. */
const meshCore = { getProjectPath: () => agentDir };

/** Discover what is on disk, the way the five-minute pass does. */
async function sweep(filePath: string): Promise<Task> {
  await reconciler.reconcile();
  const task = store.getByFilePath(filePath);
  expect(task).not.toBeNull();
  return task!;
}

/**
 * PATCH a task the way `PATCH /api/tasks/:id` does: the file first, then the
 * row, and nothing at all to the row when the file half refuses.
 */
async function patch(existing: Task, data: UpdateTaskRequest) {
  const outcome = await applyTaskFileUpdate({ dorkHome, meshCore } as never, { existing, data });
  if (!outcome.ok) throw new Error(`refused: ${outcome.error}`);
  store.updateTask(existing.id, data, { timingLandsOn: outcome.timingLandsOn });
  return outcome;
}

describe("a person's own schedule under a package agent", () => {
  it('is approved into its own file, like any schedule of theirs', async () => {
    // Before DOR-2272 every file under a marked agent directory was the
    // package's, so this approval landed on the row alone and the file kept
    // saying `enabled: false`.
    const task = await sweep(ownFile);

    const outcome = await patch(task, { status: 'active', enabled: true });

    expect(outcome.changesFile).toBe(true);
    // Switched on is the block's default, so the writer drops the key.
    expect(await fs.readFile(ownFile, 'utf-8')).not.toContain('enabled: false');
    const after = await sweep(ownFile);
    expect(after.enabled).toBe(true);
    expect(after.status).toBe('active');
  });

  it("follows the person's own later edit of the file", async () => {
    // Discovery must also call the file the person's: were it the package's,
    // the row would keep its switch (FB-26) and overrule the edit.
    await patch(await sweep(ownFile), { status: 'active', enabled: true });
    const approved = await fs.readFile(ownFile, 'utf-8');
    expect(approved).not.toContain('enabled: false');
    await fs.writeFile(
      ownFile,
      approved.replace('schedule:\n', 'schedule:\n  enabled: false\n'),
      'utf-8'
    );

    const after = await sweep(ownFile);

    expect(after.enabled).toBe(false);
  });
});

describe('the schedule the package shipped, beside it', () => {
  it('is switched on on the row alone, and the row keeps it against the file', async () => {
    // The FB-26 behaviour, unchanged: DorkOS never writes a listed file, so the
    // person's switch lives on the row and the sweep must not undo it.
    const task = await sweep(shippedFile);

    const outcome = await patch(task, { status: 'active', enabled: true });

    expect(outcome.changesFile).toBe(false);
    expect(await fs.readFile(shippedFile, 'utf-8')).toContain('enabled: false');
    const after = await sweep(shippedFile);
    expect(after.enabled).toBe(true);
    expect(after.status).toBe('active');
  });
});
