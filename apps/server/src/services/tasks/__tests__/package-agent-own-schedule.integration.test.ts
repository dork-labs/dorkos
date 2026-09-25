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
/** The agent's watched skills root. */
let taskRoot: ReturnType<typeof skillsRoot>;

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

  it("keeps the person's OFF switch, and writes it into the file that is now theirs", async () => {
    // Reviewer repro (DOR-2272): the switch lived on the row only while the
    // file was the package's. The moment ownership lapsed, the sync copied the
    // file's `enabled` (the package's default, on) back over a schedule the
    // person had switched off, and it started running.
    const approved = await approvedShipped();
    await fs.writeFile(
      shippedFile,
      (await fs.readFile(shippedFile, 'utf-8')).replace('  enabled: false\n', ''),
      'utf-8'
    );
    const onByFile = await sweep(shippedFile);
    expect(onByFile.enabled).toBe(true);
    await patch(approved, { enabled: false });
    expect((await sweep(shippedFile)).enabled).toBe(false);

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

  it('keeps an approved ON switch the person set on a schedule the package shipped off', async () => {
    // The other direction: the person approved the package's off-by-default
    // schedule, which switched it on on the row. Releasing the file must not
    // switch it back off, and the file must now say what runs.
    await approvedShipped();

    await releaseShippedFile();
    const after = await sweep(shippedFile);

    expect(after.enabled).toBe(true);
    await vi.waitFor(async () =>
      expect(await fs.readFile(shippedFile, 'utf-8')).not.toContain('enabled: false')
    );
  });

  it('keeps an OFF switch even when the same sync finds new work to approve', async () => {
    // A later version can stop listing the file AND change what it does in one
    // update. The schedule parks for approval, and it must park switched off,
    // as the person left it, not switched on by the package's default.
    const approved = await approvedShipped();
    await patch(approved, { enabled: false });
    expect((await sweep(shippedFile)).enabled).toBe(false);
    await fs.writeFile(
      shippedFile,
      (await fs.readFile(shippedFile, 'utf-8'))
        .replace('  enabled: false\n', '')
        .replace(/The package sweeps\.$/, 'The package sweeps harder.'),
      'utf-8'
    );

    await releaseShippedFile();
    const after = await sweep(shippedFile);

    expect(after.status).toBe('pending_approval');
    expect(after.enabled).toBe(false);
  });

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

  it("settles an old row of the person's own with no write at all", async () => {
    // The row and its file already agree, so the release has nothing to carry:
    // it is recorded as the person's on the first sync, and the file is untouched.
    const own = await sweep(ownFile);
    db.run(sql`UPDATE pulse_schedules SET package_owned = 'unknown' WHERE id = ${own.id}`);
    // `unknown` is the sync's bookkeeping; the app is never told about it.
    expect(store.getByFilePath(ownFile)!.packageOwned).toBeNull();
    const before = await fs.readFile(ownFile, 'utf-8');

    await sweep(ownFile);

    expect(ownershipColumn(own.id)).toBeNull();
    expect(await fs.readFile(ownFile, 'utf-8')).toBe(before);
  });

  it("lets an old row follow the person's own OFF in its file (T4)", async () => {
    // `unknown` only protects an OFF row. A person's approved, running schedule
    // whose file they switched off while DorkOS was down must go off: an ON row
    // under a standing approval is not a reason to overrule their file.
    const approved = await sweep(ownFile);
    await patch(approved, { status: 'active', enabled: true });
    expect((await sweep(ownFile)).enabled).toBe(true);
    db.run(sql`UPDATE pulse_schedules SET package_owned = 'unknown' WHERE id = ${approved.id}`);
    const text = await fs.readFile(ownFile, 'utf-8');
    await fs.writeFile(
      ownFile,
      text.replace('schedule:\n', 'schedule:\n  enabled: false\n'),
      'utf-8'
    );

    expect((await sweep(ownFile)).enabled).toBe(false);
    expect((await sweep(ownFile)).enabled).toBe(false);
    expect(ownershipColumn(approved.id)).toBeNull();
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

  it('keeps the switch when two syncs land before the file is written', async () => {
    // The watcher and the reconciler interleaving: two discovery syncs see the
    // release before either write happens. The second must still see a release.
    const off = await switchedOff();
    await releaseShippedFile();
    const parsed = await readTaskRootFile(
      shippedFile,
      await fs.readFile(shippedFile, 'utf-8'),
      taskRoot
    );
    if (parsed.kind !== 'schedule') throw new Error('expected a schedule');
    const syncOnce = () =>
      store.upsertFromFile(parsed.discovered.def, AGENT_ID, {
        source: 'discovery',
        problem: parsed.discovered.problem,
        packageOwned: null,
      });

    syncOnce();
    const second = syncOnce();

    expect(second.enabled).toBe(false);
    expect(ownershipColumn(off.id)).toBe('record');
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

  it('records ownership on the row as discovery finds it', async () => {
    // The app shows ownership before an edit, so the row must carry it.
    expect((await sweep(shippedFile)).packageOwned).toBe('record');
    expect((await sweep(ownFile)).packageOwned).toBeNull();
  });
});
