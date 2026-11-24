/**
 * A schedule a person made for an agent that came from a marketplace package
 * syncs like any schedule of theirs, while the package's own schedule beside it
 * keeps the row-only switch (DOR-2272, FB-26).
 *
 * @module services/tasks/__tests__/package-agent-own-schedule.integration
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
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
import { carrySwitchIntoReleasedFile } from '../task-file-update.js';
import { taskWorkOf } from '../schedule-permission-clamp.js';
import { readTaskRootFile } from '../skills-root-discovery.js';
import {
  computeInstalledFiles,
  readInstalledFiles,
  writeInstalledFiles,
} from '../../marketplace/lib/records/installed-files.js';

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
/** The agent's watched skills root. */
let taskRoot: ReturnType<typeof skillsRoot>;

/** A registrar that records the sync calls the reconciler makes and runs no cron. */
const registrar = {
  syncTask: vi.fn(),
  syncTaskByFilePath: vi.fn(),
  repairTask: vi.fn(),
} as unknown as TaskRegistrar;

beforeEach(async () => {
  db = createTestDb();
  store = new TaskStore(db);
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dorkos-pkg-own-')));
  dorkHome = path.join(root, 'dork');
  await fs.mkdir(dorkHome, { recursive: true });

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
  taskRoot = skillsRoot(skillsDir, 'project', agentDir, AGENT_ID);
  reconciler.addRoot(taskRoot);
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
  const task = store.fileSync.getByFilePath(filePath);
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
  it("is approved into its own file, and follows the person's later edit of it (DOR-2272)", async () => {
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

describe('a package schedule the record stops listing', () => {
  /**
   * Rewrite the record without the shipped schedule: a later version that no
   * longer ships it, a rebuilt legacy record that could not prove it, or a
   * hand-edited record. The file is the person's from then on.
   */
  async function releaseShippedFile() {
    const record = (await readInstalledFiles(agentDir))!;
    const { ['.agents/skills/package-sweep/SKILL.md']: _released, ...files } = record.files;
    await writeInstalledFiles(agentDir, { ...record, files });
  }

  /** Discover, approve and switch on the shipped schedule, as a person does. */
  async function approvedShipped(): Promise<Task> {
    await patch(await sweep(shippedFile), { status: 'active', enabled: true });
    return sweep(shippedFile);
  }

  /**
   * A shipped schedule the package ships ON, approved, then switched off by the
   * person on the row: the one state where row and file disagree.
   */
  async function switchedOff(): Promise<Task> {
    await approvedShipped();
    await fs.writeFile(
      shippedFile,
      (await fs.readFile(shippedFile, 'utf-8')).replace('  enabled: false\n', ''),
      'utf-8'
    );
    const onByFile = await sweep(shippedFile);
    expect(onByFile.enabled).toBe(true);
    await patch(onByFile, { enabled: false });
    const off = await sweep(shippedFile);
    expect(off.enabled).toBe(false);
    return off;
  }

  it("keeps the person's OFF switch, and writes it into the file that is now theirs", async () => {
    // Reviewer repro: once ownership lapsed, the sync copied the file's ON back
    // over a schedule the person had switched off, and it started running.
    await switchedOff();

    await releaseShippedFile();
    const after = await sweep(shippedFile);

    expect(after.enabled).toBe(false);
    // Still the package's on the row until the file agrees (two-phase release).
    expect(after.packageOwned).toBe('record');
    await vi.waitFor(async () =>
      expect(await fs.readFile(shippedFile, 'utf-8')).toContain('enabled: false')
    );
    const settled = await sweep(shippedFile);
    expect(settled.enabled).toBe(false);
    expect(settled.packageOwned).toBeNull();
  });

  /** What the row records about ownership, `unknown` included (the wire hides it). */
  const ownershipColumn = (id: string) =>
    (
      db.get(sql`SELECT package_owned AS owned FROM pulse_schedules WHERE id = ${id}`) as {
        owned: string | null;
      }
    ).owned;

  it('keeps an OFF switch on a row older than the column (T2, DOR-2272 review)', async () => {
    // A row the upgrade marked `unknown` may have been a package's under the old
    // rule; its first sync must not read the file's ON over the person's OFF.
    const off = await switchedOff();
    db.run(sql`UPDATE pulse_schedules SET package_owned = 'unknown'`);
    await releaseShippedFile();

    const after = await sweep(shippedFile);

    expect(after.enabled).toBe(false);
    await vi.waitFor(async () =>
      expect(await fs.readFile(shippedFile, 'utf-8')).toContain('enabled: false')
    );
    expect(off.id).toBe(after.id);
  });

  it('keeps the switch through a failed write, and writes it on a later sweep (T3)', async () => {
    // One-shot protection lost the switch whenever the write failed. The row
    // now stays the package's until the file agrees, so every sweep keeps OFF
    // and tries again.
    const off = await switchedOff();
    await releaseShippedFile();
    await fs.chmod(shippedFile, 0o444);
    await fs.chmod(path.dirname(shippedFile), 0o555);
    try {
      expect((await sweep(shippedFile)).enabled).toBe(false);
      expect((await sweep(shippedFile)).enabled).toBe(false);
      expect(ownershipColumn(off.id)).toBe('record');
    } finally {
      await fs.chmod(path.dirname(shippedFile), 0o755);
      await fs.chmod(shippedFile, 0o644);
    }

    await sweep(shippedFile);
    expect(await fs.readFile(shippedFile, 'utf-8')).toContain('enabled: false');
    const settled = await sweep(shippedFile);

    expect(settled.enabled).toBe(false);
    expect(ownershipColumn(off.id)).toBeNull();
  });

  it('writes nothing into a file a package owns again, or that changed since it was read', async () => {
    // The write is checked at the moment it happens: a reinstall can take the
    // file back, and a person can edit it, between the sync and the write.
    await switchedOff();
    const readNow = async () => {
      const parsed = await readTaskRootFile(
        shippedFile,
        await fs.readFile(shippedFile, 'utf-8'),
        taskRoot
      );
      if (parsed.kind !== 'schedule') throw new Error('expected a schedule');
      return parsed.discovered.def;
    };
    const def = await readNow();
    const offRow = { enabled: false };
    expect(def.meta.schedule.enabled).toBe(true);

    // Still listed by the package.
    expect(await carrySwitchIntoReleasedFile(offRow, def, taskRoot)).toBe(false);

    // Released, but the person edited the file after it was read.
    await releaseShippedFile();
    const edited = (await fs.readFile(shippedFile, 'utf-8')).replace(
      'The package sweeps.\n',
      'My own words now.\n'
    );
    await fs.writeFile(shippedFile, edited, 'utf-8');
    expect(await carrySwitchIntoReleasedFile(offRow, def, taskRoot)).toBe(false);
    expect(await fs.readFile(shippedFile, 'utf-8')).toBe(edited);

    // Released and unchanged since it was read: written.
    expect(await carrySwitchIntoReleasedFile(offRow, await readNow(), taskRoot)).toBe(true);
    expect(await fs.readFile(shippedFile, 'utf-8')).toContain('enabled: false');
  });

  it('keeps an agent-parked schedule parked, and its switch, through a release (DOR-2313)', async () => {
    // An agent retimes the package's approved schedule: parked in the same
    // request, on the row alone. If the record then stops listing the file, the
    // release drops the agent's row-only timing, so what would run is new work;
    // it must stay parked, and nothing may switch it on.
    const approved = await approvedShipped();
    const before = { ...taskWorkOf(approved), status: approved.status };
    const outcome = await applyTaskFileUpdate({ dorkHome, meshCore } as never, {
      existing: approved,
      data: { cron: '*/5 * * * *' } as never,
    });
    if (!outcome.ok) throw new Error(outcome.error);
    store.updateTask(
      approved.id,
      { cron: '*/5 * * * *' },
      { timingLandsOn: outcome.timingLandsOn }
    );
    expect(store.approvals.settleApprovedWorkChange(approved.id, before, { trusted: false })).toBe(
      'parked'
    );
    const parked = store.getTask(approved.id)!;

    await releaseShippedFile();
    const first = await sweep(shippedFile);
    const second = await sweep(shippedFile);

    // The row's ON was the person's approval of the package's work; the park
    // withdrew it, so only an OFF is kept through the release and the file's
    // OFF stands. Nothing is switched on, and nothing runs.
    expect(parked.enabled).toBe(true);
    for (const row of [first, second]) {
      expect(row.status).toBe('pending_approval');
      expect(row.enabled).toBe(false);
    }
  });
});
