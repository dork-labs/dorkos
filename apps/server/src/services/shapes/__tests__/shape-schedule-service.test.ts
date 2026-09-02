/**
 * Integration tests for {@link ShapeScheduleService} against a real in-memory
 * TaskStore + a real tmpdir on disk (fakes only for the scheduler + mesh).
 *
 * The load-bearing behavior is `rebindSchedule`: a global/disabled schedule must
 * physically move from the global `tasks/` dir into the agent's `.dork/tasks/`,
 * flip enabled, register with the scheduler, and leave exactly one schedule
 * (no orphaned global duplicate). This is what turns a Shape's tick on when its
 * agent is finally created.
 */
import { describe, expect, it, vi, beforeEach, afterEach, type Mock } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { MeshCore } from '@dorkos/mesh';
import type { Logger } from '@dorkos/shared/logger';
import type { CreateTaskRequest } from '@dorkos/shared/schemas';
import { SCHEDULE_PERMISSION_MODES } from '@dorkos/marketplace/manifest-schema';
import { parseSkillFile } from '@dorkos/skills/parser';
import { SkillFrontmatterSchema } from '@dorkos/skills/schema';
import { hasSchedule } from '@dorkos/skills';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import { TaskStore } from '../../tasks/task-store.js';
import { TaskRegistrar, type SchedulerRegistrationTarget } from '../../tasks/task-registrar.js';
import { readRawFrontmatter } from '@dorkos/skills/parser';
import { ShapeScheduleService } from '../shape-schedule-service.js';
import {
  SCHEDULE_RECEIPT_FILENAME,
  resetShapeScheduleReceipts,
} from '../schedule-write-receipt.js';
import { removeScheduledTaskFile } from '../../tasks/lifecycle/delete-task.js';

// Wraps the real parser so every existing test in this file keeps exercising
// the genuine read-your-own-write round trip; only the fallback-path test
// below overrides a single call with `mockReturnValueOnce` to force the
// branch `parseSkillFile` failing on the file `createSchedule` just wrote
// takes (DOR-823).
vi.mock('@dorkos/skills/parser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dorkos/skills/parser')>();
  return { ...actual, parseSkillFile: vi.fn(actual.parseSkillFile) };
});

/** A global, disabled inbox-tick request (agent missing at apply time). */
function globalDisabledTick(): CreateTaskRequest {
  return {
    name: 'inbox-tick',
    description: 'poll the inbox',
    prompt: 'run one tick',
    cron: '*/15 * * * *',
    timezone: null,
    target: 'global',
    enabled: false,
    permissionMode: 'acceptEdits',
  };
}

/** A named, enabled schedule request bound to `target` ('global' or an agent id). */
function tick(name: string, target: string): CreateTaskRequest {
  return {
    name,
    description: `poll for ${name}`,
    prompt: 'run one tick',
    cron: '*/15 * * * *',
    timezone: null,
    target,
    enabled: true,
    permissionMode: 'acceptEdits',
  };
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

describe('ShapeScheduleService.rebindSchedule (integration)', () => {
  let db: Db;
  let store: TaskStore;
  let dorkHome: string;
  let agentDir: string;
  let registerTask: Mock<SchedulerRegistrationTarget['registerTask']>;
  let unregisterTask: Mock<SchedulerRegistrationTarget['unregisterTask']>;
  let scheduler: SchedulerRegistrationTarget;
  let service: ShapeScheduleService;
  // Hoisted so the refusal cases can assert the warning: a Shape that declines
  // to write over somebody's skill has to SAY so, or the schedule is simply
  // missing and nobody knows why.
  let logger: Logger;

  beforeEach(async () => {
    db = createTestDb();
    store = new TaskStore(db);
    dorkHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dork-shape-sched-'));
    // The whole process shares one data directory in production, and the
    // shared delete seam (`removeScheduledTaskFile`) resolves it rather than
    // being handed one — so the receipt it drops entries from is the receipt
    // this service reads. Pointing DORK_HOME at the same tmpdir is what makes
    // that true here too.
    vi.stubEnv('DORK_HOME', dorkHome);
    agentDir = path.join(dorkHome, 'agents', 'linear-tender');
    await fs.mkdir(agentDir, { recursive: true });

    registerTask = vi.fn<SchedulerRegistrationTarget['registerTask']>(() => true);
    unregisterTask = vi.fn<SchedulerRegistrationTarget['unregisterTask']>();
    scheduler = { isStarted: true, registerTask, unregisterTask };

    const meshCore = {
      getProjectPath: (id: string) => (id === 'agent-tender' ? agentDir : undefined),
    } as unknown as MeshCore;

    logger = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    } as unknown as Logger;

    service = new ShapeScheduleService({
      taskStore: store,
      registrar: new TaskRegistrar({ store, scheduler }),
      meshCore,
      dorkHome,
      logger,
    });
  });

  afterEach(async () => {
    resetShapeScheduleReceipts();
    vi.unstubAllEnvs();
    await fs.rm(dorkHome, { recursive: true, force: true });
  });

  it('moves a global/disabled schedule to the agent, enables it, and removes the old copy', async () => {
    await service.createSchedule(globalDisabledTick(), { shape: 'linear-ops' });

    // Precondition: one global, disabled schedule, on disk at the global path,
    // stamped with the Shape provenance marker.
    expect(await service.listSchedules()).toEqual([
      { name: 'inbox-tick', agentId: null, enabled: false, shapeOrigin: 'linear-ops' },
    ]);
    const globalFile = path.join(dorkHome, 'skills', 'inbox-tick', 'SKILL.md');
    expect(await exists(globalFile)).toBe(true);
    const globalContent = await fs.readFile(globalFile, 'utf-8');
    expect(globalContent).toContain('origin: shape');
    expect(globalContent).toContain('shape: linear-ops');
    expect(registerTask).not.toHaveBeenCalled(); // disabled → never registered

    // The agent is created; re-bind the waiting schedule to it.
    await service.rebindSchedule('inbox-tick', { agentId: 'agent-tender', enabled: true });

    // Exactly one schedule remains — now agent-bound and enabled. The
    // provenance marker travels with it (agent-bound rows skip the file read,
    // so listSchedules reports null — assert on the moved file instead).
    const after = await service.listSchedules();
    expect(after).toEqual([
      { name: 'inbox-tick', agentId: 'agent-tender', enabled: true, shapeOrigin: null },
    ]);
    expect(store.getTasks()).toHaveLength(1);

    // The file physically moved into the agent's workspace; the global copy is gone.
    const agentFile = path.join(agentDir, '.agents', 'skills', 'inbox-tick', 'SKILL.md');
    expect(await exists(agentFile)).toBe(true);
    expect(await exists(globalFile)).toBe(false);
    const movedContent = await fs.readFile(agentFile, 'utf-8');
    expect(movedContent).toContain('origin: shape');
    expect(movedContent).toContain('shape: linear-ops');

    // NOTHING was registered, and that is the DOR-1486 change worth stating: a
    // re-bound Shape schedule lands as a file in the agent's skills root and is
    // synced as a discovery write, so it parks for approval like any other
    // schedule DorkOS finds on disk (ADR `260823-200726`). Applying a Shape is a
    // person's decision to install an arrangement; it is not their decision to
    // let a particular unattended job start running on a clock. `enabled: true`
    // above is the author's intent, which is not the same as permission.
    expect(registerTask).not.toHaveBeenCalled();
    expect(store.getTasks()[0].status).toBe('pending_approval');
  });

  it('writes the new format into the agent’s skills root, and it parks there', async () => {
    // The whole DOR-1486 shape of this service in one test: a Shape's schedule
    // is an ordinary skill file with a `schedule:` block, in the same root every
    // other skill lives in, discovered by the same watcher — and therefore
    // subject to the same never-auto-arm gate.
    await service.createSchedule(tick('inbox-tick', 'agent-tender'), { shape: 'linear-ops' });

    const filePath = path.join(agentDir, '.agents', 'skills', 'inbox-tick', 'SKILL.md');
    const raw = readRawFrontmatter(await fs.readFile(filePath, 'utf-8'));
    // A block, not top-level fields — and only what a person would have typed:
    // `enabled: true` and `permissions: acceptEdits` are the defaults, so they
    // are not written out.
    expect(raw?.data.schedule).toEqual({
      cron: '*/15 * * * *',
      origin: 'shape',
      shape: 'linear-ops',
    });
    expect(raw?.data.cron).toBeUndefined();

    // And it waits for a person before anything runs on a clock.
    const row = store.getTasks()[0];
    expect(row.status).toBe('pending_approval');
    expect(row.filePath).toBe(await fs.realpath(filePath));
  });

  it('is a no-op on a schedule that is already agent-bound (respects a user disable)', async () => {
    // Seed a schedule already living in the agent's workspace but disabled.
    await service.createSchedule(
      { ...globalDisabledTick(), target: 'agent-tender' },
      { shape: 'linear-ops' }
    );
    const seeded = await service.listSchedules();
    expect(seeded).toEqual([
      { name: 'inbox-tick', agentId: 'agent-tender', enabled: false, shapeOrigin: null },
    ]);

    await service.rebindSchedule('inbox-tick', { agentId: 'agent-tender', enabled: true });

    // Untouched — still bound, still disabled.
    expect(await service.listSchedules()).toEqual([
      { name: 'inbox-tick', agentId: 'agent-tender', enabled: false, shapeOrigin: null },
    ]);
    expect(store.getTasks()).toHaveLength(1);
    expect(registerTask).not.toHaveBeenCalled();
  });

  it('refuses to move a global schedule that has no Shape provenance marker', async () => {
    // THE ADVERSARIAL CASE, at the concrete layer: a user-created global
    // schedule (written like the tasks router writes it — no provenance
    // marker) shares its name with a Shape schedule. rebindSchedule must be a
    // no-op even when a caller asks: not re-homed, not enabled.
    await service.createSchedule(globalDisabledTick()); // no origin — user-created

    await service.rebindSchedule('inbox-tick', { agentId: 'agent-tender', enabled: true });

    // Unchanged: still global, still disabled, still at the global path.
    expect(await service.listSchedules()).toEqual([
      { name: 'inbox-tick', agentId: null, enabled: false, shapeOrigin: null },
    ]);
    expect(store.getTasks()).toHaveLength(1);
    expect(await exists(path.join(dorkHome, 'skills', 'inbox-tick', 'SKILL.md'))).toBe(true);
    expect(await exists(path.join(agentDir, '.agents', 'skills', 'inbox-tick', 'SKILL.md'))).toBe(
      false
    );
    expect(registerTask).not.toHaveBeenCalled();
  });

  it("refuses to write over a person's own skill of the same name, and says so", async () => {
    // The critical one. A skills root is where a PERSON's skills live, and most
    // of them have no schedule and therefore no row — so the apply flow's
    // by-name check over the task table cannot see them. Before the disk guard,
    // applying a Shape wrote its schedule straight over a hand-written skill,
    // with no warning anywhere, and the teardown that followed removed the
    // directory it was in.
    const skillDir = path.join(agentDir, '.agents', 'skills', 'inbox-tick');
    await fs.mkdir(skillDir, { recursive: true });
    const mine = '---\nname: inbox-tick\ndescription: my own tuned skill\n---\nMy words.';
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), mine, 'utf-8');
    await fs.writeFile(path.join(skillDir, 'reference.md'), 'notes I wrote', 'utf-8');

    const outcome = await service.createSchedule(tick('inbox-tick', 'agent-tender'), {
      shape: 'linear-ops',
    });

    expect(outcome).toEqual({ created: false, reason: 'occupied', targetDir: skillDir });
    // Untouched, both files.
    expect(await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf-8')).toBe(mine);
    expect(await fs.readFile(path.join(skillDir, 'reference.md'), 'utf-8')).toBe('notes I wrote');
    // No row either — a schedule that was never written must not appear to exist.
    expect(store.getTasks()).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('inbox-tick'));
  });

  it('refuses a target that is a symlink, whatever the file behind it says', async () => {
    // A `pkg__name` link is how Harness Sync projects an installed package's
    // skill. Writing through it edits the package's own checkout: shared by
    // every agent that installed it, invisible in the cockpit, gone at the next
    // update. Refused before the marker is even read.
    //
    // The link's target deliberately carries THIS Shape's own marker, which is
    // the only version of this case the marker check cannot answer: by
    // provenance the file is "ours" to overwrite, and it still must not be
    // written, because where it physically lives is a package's checkout. A
    // fixture without the marker would pass with the symlink branch deleted.
    const packageSkill = path.join(dorkHome, 'plugins', 'flow', 'skills', 'drain');
    await fs.mkdir(packageSkill, { recursive: true });
    const shipped = [
      '---',
      'name: drain',
      'description: shipped by a package',
      'schedule:',
      "  cron: '*/10 * * * *'",
      '  origin: shape',
      '  shape: linear-ops',
      '---',
      'Package words.',
    ].join('\n');
    await fs.writeFile(path.join(packageSkill, 'SKILL.md'), shipped, 'utf-8');
    await fs.mkdir(path.join(agentDir, '.agents', 'skills'), { recursive: true });
    await fs.symlink(packageSkill, path.join(agentDir, '.agents', 'skills', 'inbox-tick'));

    const outcome = await service.createSchedule(tick('inbox-tick', 'agent-tender'), {
      shape: 'linear-ops',
    });

    expect(outcome).toEqual({
      created: false,
      reason: 'symlink',
      targetDir: path.join(agentDir, '.agents', 'skills', 'inbox-tick'),
    });
    expect(await fs.readFile(path.join(packageSkill, 'SKILL.md'), 'utf-8')).toBe(shipped);
    expect(store.getTasks()).toHaveLength(0);
  });

  it('still writes over its OWN schedule, which is what a re-apply is', async () => {
    await service.createSchedule(tick('inbox-tick', 'agent-tender'), { shape: 'linear-ops' });

    const again = await service.createSchedule(
      { ...tick('inbox-tick', 'agent-tender'), prompt: 'run one tick, differently' },
      { shape: 'linear-ops' }
    );

    expect(again).toEqual({ created: true });
    expect(store.getTasks()).toHaveLength(1);
    expect(store.getTasks()[0].prompt).toBe('run one tick, differently');
  });

  it('refuses a schedule another Shape already owns by that name', async () => {
    await service.createSchedule(tick('inbox-tick', 'agent-tender'), { shape: 'other-shape' });

    const outcome = await service.createSchedule(tick('inbox-tick', 'agent-tender'), {
      shape: 'linear-ops',
    });

    expect(outcome).toEqual({
      created: false,
      reason: 'occupied',
      targetDir: path.join(agentDir, '.agents', 'skills', 'inbox-tick'),
    });
    expect(store.getTasks()).toHaveLength(1);
  });

  it('does not delete the global copy when the re-bind had nowhere to land', async () => {
    // The compound failure: a refused create followed by an unconditional
    // teardown deletes the only copy of the schedule there is.
    await service.createSchedule(globalDisabledTick(), { shape: 'linear-ops' });
    const skillDir = path.join(agentDir, '.agents', 'skills', 'inbox-tick');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: inbox-tick\ndescription: my own\n---\nMine.',
      'utf-8'
    );

    await service.rebindSchedule('inbox-tick', { agentId: 'agent-tender', enabled: true });

    // The global copy is still there, still the Shape's, still the only one.
    expect(await exists(path.join(dorkHome, 'skills', 'inbox-tick', 'SKILL.md'))).toBe(true);
    expect(store.getTasks()).toHaveLength(1);
    expect(store.getTasks()[0].agentId).toBeNull();
  });

  it('leaves the schedule global when the agent has no resolvable project path', async () => {
    await service.createSchedule(globalDisabledTick(), { shape: 'linear-ops' });

    // 'ghost' resolves to no project path → the fake meshCore returns undefined.
    await service.rebindSchedule('inbox-tick', { agentId: 'ghost', enabled: true });

    // Unchanged: still global, still disabled, no duplicate.
    expect(await service.listSchedules()).toEqual([
      { name: 'inbox-tick', agentId: null, enabled: false, shapeOrigin: 'linear-ops' },
    ]);
    expect(store.getTasks()).toHaveLength(1);
    expect(await exists(path.join(dorkHome, 'skills', 'inbox-tick', 'SKILL.md'))).toBe(true);
  });
});

describe('ShapeScheduleService.createSchedule — every declarable permission mode', () => {
  let db: Db;
  let store: TaskStore;
  let dorkHome: string;
  let service: ShapeScheduleService;

  beforeEach(async () => {
    db = createTestDb();
    store = new TaskStore(db);
    dorkHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dork-shape-mode-'));
    // The whole process shares one data directory in production, and the
    // shared delete seam (`removeScheduledTaskFile`) resolves it rather than
    // being handed one — so the receipt it drops entries from is the receipt
    // this service reads. Pointing DORK_HOME at the same tmpdir is what makes
    // that true here too.
    vi.stubEnv('DORK_HOME', dorkHome);
    service = new ShapeScheduleService({
      taskStore: store,
      registrar: new TaskRegistrar({
        store,
        scheduler: { isStarted: true, registerTask: vi.fn(() => true), unregisterTask: vi.fn() },
      }),
      meshCore: undefined,
      dorkHome,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      } as unknown as Logger,
    });
  });

  afterEach(async () => {
    resetShapeScheduleReceipts();
    vi.unstubAllEnvs();
    await fs.rm(dorkHome, { recursive: true, force: true });
  });

  // THE DRIFT CASE. `createSchedule` writes the requested mode into the
  // SKILL.md's `schedule.permissions` and immediately parses the file back with
  // `SkillFrontmatterSchema` — the same schema the file watcher and the
  // reconciler use. If the frontmatter schema accepts fewer modes than a
  // Shape manifest may declare, the file it just wrote is unreadable: the parse
  // fails, `createSchedule` silently falls through to the `createTask` branch,
  // and disk and DB disagree forever while the watcher re-rejects the file on
  // every touch. Driving the whole declarable set through the real writer +
  // real parser is what catches that; a hardcoded list of modes would not.
  it.each(SCHEDULE_PERMISSION_MODES)(
    'writes a file that parses back, and a matching DB row, for %s',
    async (mode) => {
      const request: CreateTaskRequest = {
        name: `tick-${mode.toLowerCase()}`,
        description: `poll under ${mode}`,
        prompt: 'run one tick',
        cron: '*/15 * * * *',
        timezone: null,
        target: 'global',
        enabled: true,
        permissionMode: mode,
      };
      await service.createSchedule(request, { shape: 'linear-ops' });

      const filePath = path.join(dorkHome, 'skills', request.name, 'SKILL.md');
      const parsed = parseSkillFile(
        filePath,
        await fs.readFile(filePath, 'utf-8'),
        SkillFrontmatterSchema
      );
      expect(parsed.ok, parsed.ok ? '' : parsed.error).toBe(true);
      // Readable is not enough: an unreadable block parses to a complaint
      // object rather than failing the file, so a schedule that quietly became
      // on-demand would pass a bare `ok` assertion.
      expect(parsed.ok && hasSchedule(parsed.definition.meta)).toBe(true);

      // The row matches the file for every mode a package may declare, EXCEPT
      // the one the store refuses to take from a file: `upsertFromFile` clamps
      // `bypassPermissions` back, because a SKILL.md on disk is nobody's
      // approval (`tasks/schedule-permission-clamp.ts`). `apply-shape.ts` has
      // already applied the same rule before it ever gets here, so in
      // production this second refusal is belt and braces — this test calls the
      // service directly, which is exactly the path that skips the first one.
      // Spelled out rather than computed with the function under test: deriving
      // the expectation from `clampSchedulePermissionMode` would move both sides
      // together if the clamp were ever widened to refuse more modes, and this
      // assertion would keep passing while saying nothing.
      const row = store.getTasks().find((t) => t.name === request.name);
      expect(row?.permissionMode).toBe(mode === 'bypassPermissions' ? 'acceptEdits' : mode);
    }
  );
});

describe('ShapeScheduleService.createSchedule — the fallback path (DOR-823)', () => {
  let db: Db;
  let store: TaskStore;
  let dorkHome: string;
  let service: ShapeScheduleService;

  beforeEach(async () => {
    db = createTestDb();
    store = new TaskStore(db);
    dorkHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dork-shape-fallback-'));
    // The whole process shares one data directory in production, and the
    // shared delete seam (`removeScheduledTaskFile`) resolves it rather than
    // being handed one — so the receipt it drops entries from is the receipt
    // this service reads. Pointing DORK_HOME at the same tmpdir is what makes
    // that true here too.
    vi.stubEnv('DORK_HOME', dorkHome);
    service = new ShapeScheduleService({
      taskStore: store,
      registrar: new TaskRegistrar({
        store,
        scheduler: { isStarted: true, registerTask: vi.fn(() => true), unregisterTask: vi.fn() },
      }),
      meshCore: undefined,
      dorkHome,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      } as unknown as Logger,
    });
  });

  afterEach(async () => {
    resetShapeScheduleReceipts();
    vi.unstubAllEnvs();
    vi.mocked(parseSkillFile).mockClear();
    await fs.rm(dorkHome, { recursive: true, force: true });
  });

  it('clamps bypassPermissions in the row even when parseSkillFile fails on the file it just wrote', async () => {
    // Force exactly the branch the clamp gap lives in: the write succeeds, but
    // reading the file straight back fails, so `createSchedule` falls through
    // to `taskStore.createTask` — the raw row writer with no clamp of its own.
    vi.mocked(parseSkillFile).mockReturnValueOnce({
      ok: false,
      error: 'forced parse failure (DOR-823 fixture)',
      filePath: '(fixture)',
    });

    const request: CreateTaskRequest = {
      name: 'inbox-tick',
      description: 'poll the inbox',
      prompt: 'run one tick',
      cron: '*/15 * * * *',
      timezone: null,
      target: 'global',
      enabled: true,
      permissionMode: 'bypassPermissions',
    };
    const created = await service.createSchedule(request, { shape: 'linear-ops' });

    expect(created).toEqual({ created: true });
    const row = store.getTasks().find((t) => t.name === request.name);
    // Not 'bypassPermissions': a package-declared schedule cannot self-elevate,
    // and a parse failure on the fallback path is not an exemption from that.
    expect(row?.permissionMode).toBe('acceptEdits');
  });
});

describe('ShapeScheduleService.deleteSchedulesForShape (integration)', () => {
  let db: Db;
  let store: TaskStore;
  let dorkHome: string;
  let agentDir: string;
  let registerTask: Mock<SchedulerRegistrationTarget['registerTask']>;
  let unregisterTask: Mock<SchedulerRegistrationTarget['unregisterTask']>;
  let scheduler: SchedulerRegistrationTarget;
  let service: ShapeScheduleService;

  beforeEach(async () => {
    db = createTestDb();
    store = new TaskStore(db);
    dorkHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dork-shape-del-'));
    // The whole process shares one data directory in production, and the
    // shared delete seam (`removeScheduledTaskFile`) resolves it rather than
    // being handed one — so the receipt it drops entries from is the receipt
    // this service reads. Pointing DORK_HOME at the same tmpdir is what makes
    // that true here too.
    vi.stubEnv('DORK_HOME', dorkHome);
    agentDir = path.join(dorkHome, 'agents', 'linear-tender');
    await fs.mkdir(agentDir, { recursive: true });

    registerTask = vi.fn<SchedulerRegistrationTarget['registerTask']>(() => true);
    unregisterTask = vi.fn<SchedulerRegistrationTarget['unregisterTask']>();
    scheduler = { isStarted: true, registerTask, unregisterTask };

    const meshCore = {
      getProjectPath: (id: string) => (id === 'agent-tender' ? agentDir : undefined),
    } as unknown as MeshCore;

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    } as unknown as Logger;

    service = new ShapeScheduleService({
      taskStore: store,
      registrar: new TaskRegistrar({ store, scheduler }),
      meshCore,
      dorkHome,
      logger,
    });
  });

  afterEach(async () => {
    resetShapeScheduleReceipts();
    vi.unstubAllEnvs();
    await fs.rm(dorkHome, { recursive: true, force: true });
  });

  it("deletes this Shape's schedules across global + agent-bound scopes, fail-closed on collisions", async () => {
    // A — global, marked linear-ops → DELETED.
    await service.createSchedule(tick('inbox-tick', 'global'), { shape: 'linear-ops' });
    // B — agent-bound, NO marker, SAME name as A (a user's colliding schedule)
    //     → SURVIVES: provenance gates deletion, not the name.
    await service.createSchedule(tick('inbox-tick', 'agent-tender'));
    // C — agent-bound, marked linear-ops → DELETED (agent-bound scope is swept too).
    await service.createSchedule(tick('bound-tick', 'agent-tender'), { shape: 'linear-ops' });
    // D — global, marked a DIFFERENT Shape → SURVIVES.
    await service.createSchedule(tick('other-tick', 'global'), { shape: 'other-shape' });

    expect(store.getTasks()).toHaveLength(4);
    // Captured BEFORE the delete: the rows are gone afterwards, and the ids are
    // what proves the right two registrations were torn down.
    const removedIds = new Map(
      store
        .getTasks()
        .filter((t) => (t.name === 'inbox-tick' && !t.agentId) || t.name === 'bound-tick')
        .map((t) => [t.name, t.id])
    );

    const removed = await service.deleteSchedulesForShape('linear-ops');

    // Exactly this Shape's two schedules were removed (order is discovery order).
    expect([...removed].sort()).toEqual(['bound-tick', 'inbox-tick']);
    // Their scheduler registrations were torn down (never left firing). Asserted
    // by the ids named rather than by a call count: every create asks the
    // registrar for the end state too — and since DOR-1486 a Shape's schedule
    // parks on create, so that ask is an unregister as well.
    const torn = new Set(unregisterTask.mock.calls.map(([id]) => id));
    for (const name of ['inbox-tick', 'bound-tick']) {
      expect(
        [...torn].some((id) => removedIds.get(name) === id),
        `${name} should have been unregistered`
      ).toBe(true);
    }

    // Only the unmarked collision + the other Shape's schedule remain.
    const survivors = store.getTasks();
    expect(survivors).toHaveLength(2);
    const inboxSurvivor = survivors.find((t) => t.name === 'inbox-tick');
    expect(inboxSurvivor?.agentId).toBe('agent-tender'); // the user's agent-bound copy
    expect(survivors.find((t) => t.name === 'other-tick')?.agentId).toBeNull();

    // Files: the two marked ones are gone; the two survivors stay on disk.
    expect(await exists(path.join(dorkHome, 'skills', 'inbox-tick', 'SKILL.md'))).toBe(false);
    expect(await exists(path.join(agentDir, '.agents', 'skills', 'bound-tick', 'SKILL.md'))).toBe(
      false
    );
    expect(await exists(path.join(agentDir, '.agents', 'skills', 'inbox-tick', 'SKILL.md'))).toBe(
      true
    );
    expect(await exists(path.join(dorkHome, 'skills', 'other-tick', 'SKILL.md'))).toBe(true);
  });

  it('spares names in keepNames — the apply reconciliation drops only renamed/removed schedules', async () => {
    await service.createSchedule(tick('keep-tick', 'global'), { shape: 'linear-ops' });
    await service.createSchedule(tick('drop-tick', 'global'), { shape: 'linear-ops' });

    const removed = await service.deleteSchedulesForShape('linear-ops', new Set(['keep-tick']));

    expect(removed).toEqual(['drop-tick']);
    expect(store.getTasks().map((t) => t.name)).toEqual(['keep-tick']);
    expect(await exists(path.join(dorkHome, 'skills', 'keep-tick', 'SKILL.md'))).toBe(true);
    expect(await exists(path.join(dorkHome, 'skills', 'drop-tick', 'SKILL.md'))).toBe(false);
  });

  it('matches keepNames against the stored slug, not the raw manifest name', async () => {
    // A manifest may declare "Inbox Tick"; the schedule is stored under its slug
    // "inbox-tick". The reconciliation spares it only when keepNames carries the
    // slug — which is exactly what apply-shape now passes, so the schedule it
    // just created is never swept away.
    await service.createSchedule(tick('Inbox Tick', 'global'), { shape: 'linear-ops' });
    expect(store.getTasks().map((t) => t.name)).toEqual(['inbox-tick']);

    const removed = await service.deleteSchedulesForShape('linear-ops', new Set(['inbox-tick']));

    expect(removed).toEqual([]);
    expect(store.getTasks().map((t) => t.name)).toEqual(['inbox-tick']);
    expect(await exists(path.join(dorkHome, 'skills', 'inbox-tick', 'SKILL.md'))).toBe(true);
  });
});

describe('ShapeScheduleService — ownership is the write receipt, not the marker (DOR-1524)', () => {
  let db: Db;
  let store: TaskStore;
  let dorkHome: string;
  let agentDir: string;
  let logger: Logger;
  let service: ShapeScheduleService;

  /** Where the receipt lives for a data directory (this test's by default). */
  function receiptPath(home = dorkHome): string {
    return path.join(home, SCHEDULE_RECEIPT_FILENAME);
  }

  /** The receipt's entries, or `[]` when no receipt has been written yet. */
  async function readReceipt(home = dorkHome): Promise<{ dir: string; shape: string }[]> {
    try {
      return JSON.parse(await fs.readFile(receiptPath(home), 'utf-8')).entries;
    } catch {
      return [];
    }
  }

  /**
   * A schedule file carrying a Shape's frontmatter marker, written by hand — a
   * copy a person made, or a schedule an older DorkOS left behind. Nothing about
   * writing it goes through the service, which is the point: no receipt entry.
   */
  async function writeMarkedSkill(skillsDir: string, slug: string, body: string): Promise<string> {
    const dir = path.join(skillsDir, slug);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'SKILL.md');
    await fs.writeFile(
      file,
      [
        '---',
        `name: ${slug}`,
        'description: a schedule with a Shape marker in it',
        'schedule:',
        "  cron: '*/15 * * * *'",
        '  origin: shape',
        '  shape: linear-ops',
        '---',
        body,
      ].join('\n'),
      'utf-8'
    );
    return fs.realpath(file);
  }

  /** Put a hand-written schedule file into the task store, the way a sync would. */
  function rowFor(filePath: string, name: string): void {
    store.createTask({
      name,
      description: 'a schedule with a Shape marker in it',
      prompt: 'run one tick',
      cron: '*/15 * * * *',
      timezone: null,
      agentId: null,
      enabled: false,
      maxRuntime: null,
      permissionMode: 'acceptEdits',
      filePath,
    });
  }

  /** A service over a data directory (this test's by default) — call it again for a restart. */
  function makeService(home = dorkHome): ShapeScheduleService {
    return new ShapeScheduleService({
      taskStore: store,
      registrar: new TaskRegistrar({
        store,
        scheduler: { isStarted: true, registerTask: vi.fn(() => true), unregisterTask: vi.fn() },
      }),
      meshCore: {
        getProjectPath: (id: string) => (id === 'agent-tender' ? agentDir : undefined),
      } as unknown as MeshCore,
      dorkHome: home,
      logger,
    });
  }

  beforeEach(async () => {
    db = createTestDb();
    store = new TaskStore(db);
    dorkHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dork-shape-receipt-'));
    // The whole process shares one data directory in production, and the
    // shared delete seam (`removeScheduledTaskFile`) resolves it rather than
    // being handed one — so the receipt it drops entries from is the receipt
    // this service reads. Pointing DORK_HOME at the same tmpdir is what makes
    // that true here too.
    vi.stubEnv('DORK_HOME', dorkHome);
    agentDir = path.join(dorkHome, 'agents', 'linear-tender');
    await fs.mkdir(agentDir, { recursive: true });
    logger = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    } as unknown as Logger;
    service = makeService();
  });

  afterEach(async () => {
    resetShapeScheduleReceipts();
    vi.mocked(parseSkillFile).mockClear();
    vi.unstubAllEnvs();
    await fs.rm(dorkHome, { recursive: true, force: true });
  });

  it('records the directory it wrote, and forgets it when the schedule is torn down', async () => {
    await service.createSchedule(tick('inbox-tick', 'global'), { shape: 'linear-ops' });

    const written = await fs.realpath(path.join(dorkHome, 'skills', 'inbox-tick'));
    expect(await readReceipt()).toEqual([
      expect.objectContaining({ dir: written, shape: 'linear-ops' }),
    ]);

    await service.deleteSchedulesForShape('linear-ops');

    // Forgotten, and that is load-bearing rather than tidy: the next thing at
    // this name belongs to whoever puts it there.
    expect(await readReceipt()).toEqual([]);
    await fs.mkdir(path.join(dorkHome, 'skills', 'inbox-tick'), { recursive: true });
    await fs.writeFile(
      path.join(dorkHome, 'skills', 'inbox-tick', 'SKILL.md'),
      '---\nname: inbox-tick\ndescription: mine now\n---\nMine.',
      'utf-8'
    );
    const again = await service.createSchedule(tick('inbox-tick', 'global'), {
      shape: 'linear-ops',
    });
    expect(again.created).toBe(false);
  });

  it('does not write over a copy of its own schedule that a person adapted', async () => {
    // THE CASE THE MARKER CANNOT ANSWER. A marker travels with the bytes, so a
    // person who copies a Shape's schedule as a starting point and keeps the
    // frontmatter has a file that SAYS it is the Shape's. It is not: no apply
    // ever wrote it, so no receipt names it, so the Shape keeps its hands off.
    // Under the old marker check this file was overwritten without a word.
    await service.listSchedules(); // the receipt exists; adoption is behind us
    const skillsDir = path.join(agentDir, '.agents', 'skills');
    const copied = await writeMarkedSkill(skillsDir, 'inbox-tick', 'My own words.');
    await fs.writeFile(path.join(skillsDir, 'inbox-tick', 'reference.md'), 'my notes', 'utf-8');
    const before = await fs.readFile(copied, 'utf-8');
    expect(before).toContain('shape: linear-ops');

    const outcome = await service.createSchedule(tick('inbox-tick', 'agent-tender'), {
      shape: 'linear-ops',
    });

    expect(outcome).toEqual({
      created: false,
      reason: 'occupied',
      targetDir: path.join(skillsDir, 'inbox-tick'),
    });
    expect(await fs.readFile(copied, 'utf-8')).toBe(before);
    expect(await fs.readFile(path.join(skillsDir, 'inbox-tick', 'reference.md'), 'utf-8')).toBe(
      'my notes'
    );
  });

  it("does not delete a person's adapted copy when the Shape is torn down", async () => {
    // The other half of the same case, and the worse one: teardown removes the
    // whole directory. The Shape's own schedule goes; the copy — same marker,
    // different path, no receipt entry — stays, reference files and all.
    await service.createSchedule(tick('inbox-tick', 'global'), { shape: 'linear-ops' });
    const skillsDir = path.join(agentDir, '.agents', 'skills');
    const copied = await writeMarkedSkill(skillsDir, 'my-own-tick', 'My own words.');
    await fs.writeFile(path.join(skillsDir, 'my-own-tick', 'reference.md'), 'my notes', 'utf-8');
    rowFor(copied, 'my-own-tick');

    const removed = await service.deleteSchedulesForShape('linear-ops');

    expect(removed).toEqual(['inbox-tick']);
    expect(await exists(path.join(dorkHome, 'skills', 'inbox-tick', 'SKILL.md'))).toBe(false);
    // Still there, still saying `shape: linear-ops` — which is exactly why the
    // marker could not have been what saved it.
    expect(await fs.readFile(copied, 'utf-8')).toContain('shape: linear-ops');
    expect(await fs.readFile(path.join(skillsDir, 'my-own-tick', 'reference.md'), 'utf-8')).toBe(
      'my notes'
    );
    expect(store.getTasks().map((t) => t.name)).toEqual(['my-own-tick']);
  });

  it('refuses an empty directory with a reason, and writes once it is cleared', async () => {
    // An empty directory has no SKILL.md, so it had no marker, so it read as
    // somebody else's forever — refused on every apply with nothing but a log
    // line to explain it. It is still refused (DorkOS did not put it there), but
    // now it says which folder is in the way, and clearing the folder is all it
    // takes.
    const targetDir = path.join(agentDir, '.agents', 'skills', 'inbox-tick');
    await fs.mkdir(targetDir, { recursive: true });

    const refused = await service.createSchedule(tick('inbox-tick', 'agent-tender'), {
      shape: 'linear-ops',
    });

    expect(refused).toEqual({ created: false, reason: 'empty-directory', targetDir });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('empty directory'));
    expect(store.getTasks()).toHaveLength(0);

    await fs.rmdir(targetDir);
    const created = await service.createSchedule(tick('inbox-tick', 'agent-tender'), {
      shape: 'linear-ops',
    });

    expect(created).toEqual({ created: true });
    expect(await exists(path.join(targetDir, 'SKILL.md'))).toBe(true);
  });

  it('adopts a marker-only install once, so an uninstall still tears its timers down', async () => {
    // An install that predates the receipt has Shape schedules on disk and
    // nothing written down about them. Their markers are the only evidence
    // there is — and the evidence the old code acted on — so the first
    // operation seeds the receipt from them and nothing changes for that user.
    const legacy = await writeMarkedSkill(path.join(dorkHome, 'skills'), 'legacy-tick', 'Tick.');
    rowFor(legacy, 'legacy-tick');
    expect(await exists(receiptPath())).toBe(false);

    const removed = await service.deleteSchedulesForShape('linear-ops');

    expect(removed).toEqual(['legacy-tick']);
    expect(await exists(legacy)).toBe(false);
    // The receipt now exists, which is what records that adoption already ran.
    expect(await exists(receiptPath())).toBe(true);
  });

  it('grants nothing to a marker written after the receipt exists', async () => {
    // The trust set closes at adoption. A file that appears afterwards claiming
    // to be a Shape's — a copy, or an outright forgery — is not the Shape's, and
    // no teardown touches it.
    await service.listSchedules(); // any operation adopts and writes the receipt
    expect(await exists(receiptPath())).toBe(true);

    const forged = await writeMarkedSkill(path.join(dorkHome, 'skills'), 'forged-tick', 'Mine.');
    rowFor(forged, 'forged-tick');

    expect(await service.deleteSchedulesForShape('linear-ops')).toEqual([]);
    expect(await exists(forged)).toBe(true);
    expect(store.getTasks().map((t) => t.name)).toEqual(['forged-tick']);
  });

  it('re-binds only what it wrote: a marked copy in the global root is left alone', async () => {
    // `rebindSchedule` moves a schedule out of the global root and into an
    // agent's — a write AND a delete. Gated on the receipt for the same reason
    // the other two are.
    await service.listSchedules(); // the receipt exists; adoption is behind us
    const copied = await writeMarkedSkill(path.join(dorkHome, 'skills'), 'copied-tick', 'Mine.');
    rowFor(copied, 'copied-tick');

    await service.rebindSchedule('copied-tick', { agentId: 'agent-tender', enabled: true });

    expect(await exists(copied)).toBe(true);
    expect(await exists(path.join(agentDir, '.agents', 'skills', 'copied-tick'))).toBe(false);
    expect(store.getTasks()[0].agentId).toBeNull();
  });

  it("a schedule deleted from the tasks UI stops being the Shape's", async () => {
    // THE ONE A REVIEWER REPRODUCED. `DELETE /api/tasks/:id` and the
    // `tasks_delete` MCP tool both remove a schedule directory through
    // `removeScheduledTaskFile` — the exact call made below. Before the receipt
    // was dropped there too, deleting a Shape's schedule from the tasks UI left
    // the claim behind: the person put their own skill at the freed name, and
    // the next re-apply wrote straight over it.
    await service.createSchedule(tick('inbox-tick', 'global'), { shape: 'linear-ops' });
    const row = store.getTasks()[0];

    // Exactly what the route does: the file half through the shared seam, then
    // the row.
    await removeScheduledTaskFile(row.filePath);
    store.deleteTask(row.id);

    // The person now uses that name for something of their own.
    const mine = path.join(dorkHome, 'skills', 'inbox-tick');
    await fs.mkdir(mine, { recursive: true });
    await fs.writeFile(
      path.join(mine, 'SKILL.md'),
      '---\nname: inbox-tick\ndescription: mine now\n---\nMy words.',
      'utf-8'
    );

    const outcome = await service.createSchedule(tick('inbox-tick', 'global'), {
      shape: 'linear-ops',
    });

    expect(outcome).toEqual({ created: false, reason: 'occupied', targetDir: mine });
    expect(await fs.readFile(path.join(mine, 'SKILL.md'), 'utf-8')).toContain('My words.');
  });

  it('keeps an adapted copy safe even after the receipt file is deleted', async () => {
    // The receipt is primary state, not a cache, and deleting it used to re-arm
    // the marker-based adoption — handing the Shape every marked file on the
    // machine again. Now it fails CLOSED in both directions: nothing is owned,
    // so nothing is torn down, and the person's copy is untouched.
    await service.createSchedule(tick('inbox-tick', 'global'), { shape: 'linear-ops' });
    const skillsDir = path.join(agentDir, '.agents', 'skills');
    const copied = await writeMarkedSkill(skillsDir, 'my-own-tick', 'My own words.');
    rowFor(copied, 'my-own-tick');

    await fs.rm(path.join(dorkHome, SCHEDULE_RECEIPT_FILENAME));
    resetShapeScheduleReceipts();
    const afterDeletion = makeService(); // a restart

    expect(await afterDeletion.deleteSchedulesForShape('linear-ops')).toEqual([]);
    expect(await fs.readFile(copied, 'utf-8')).toContain('shape: linear-ops');
    expect(await exists(path.join(dorkHome, 'skills', 'inbox-tick', 'SKILL.md'))).toBe(true);
  });

  it('drops the receipt entry before the directory, not after', async () => {
    // The receipt is keyed on the RESOLVED path, and a path that no longer
    // exists cannot be resolved — so a forget made after the delete falls back
    // to the unresolved spelling and misses. This fixture is the case where the
    // two spellings differ. Both halves are built rather than assumed:
    //
    //  - the data directory is reached through a symlink this test makes, so
    //    resolved and unresolved differ on EVERY platform. Relying on the OS for
    //    that is what reddened this test in CI: macOS resolves `/var` to
    //    `/private/var` so the two spellings differed locally, and Linux's `/tmp`
    //    is a real directory, so they were identical and the precondition below
    //    failed on a build that was otherwise fine.
    //  - forcing `parseSkillFile` to fail sends the create down the fallback
    //    branch, which stores the UNRESOLVED filePath on the row while the
    //    receipt holds the resolved one.
    //
    // Swap the two statements in `removeScheduledTaskFile` and this test goes
    // red; nothing else in the suite does.
    const realHome = path.join(dorkHome, 'real-home');
    const linkedHome = path.join(dorkHome, 'linked-home');
    await fs.mkdir(realHome, { recursive: true });
    await fs.symlink(realHome, linkedHome);
    vi.stubEnv('DORK_HOME', linkedHome);
    const linked = makeService(linkedHome);

    vi.mocked(parseSkillFile).mockReturnValueOnce({
      ok: false,
      error: 'forced parse failure (ordering fixture)',
      filePath: '(fixture)',
    });
    await linked.createSchedule(tick('inbox-tick', 'global'), { shape: 'linear-ops' });

    const row = store.getTasks()[0];
    const unresolved = path.join(linkedHome, 'skills', 'inbox-tick', 'SKILL.md');
    // The fixture is only meaningful while the row's path and the receipt's key
    // are different strings.
    expect(row.filePath).toBe(unresolved);
    // Fully resolved on both sides: the outer tmpdir may itself be a symlink
    // (it is on macOS), and the point of the assertion is the LINK this test
    // made, not whatever the platform did above it.
    expect((await readReceipt(linkedHome))[0].dir).toBe(
      path.join(await fs.realpath(realHome), 'skills', 'inbox-tick')
    );
    expect((await readReceipt(linkedHome))[0].dir).not.toBe(path.dirname(unresolved));

    await linked.deleteSchedulesForShape('linear-ops');

    expect(await readReceipt(linkedHome)).toEqual([]);
  });
});
