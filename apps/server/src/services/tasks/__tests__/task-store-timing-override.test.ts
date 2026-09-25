/**
 * The store's half of a person's own timing for a package's schedule
 * (DOR-2302): where the timing is written, what every raw-row reader sees, and
 * how the approval grant follows it.
 *
 * Every case drives the store the way production does — `upsertFromFile` for a
 * sync, `updateTask` + `settleApprovedWorkChange` for an edit — and then asks the
 * question that would come out differently if one reader looked at the
 * package's cron instead of the one that runs: does the next sync of the
 * unchanged file leave the schedule approved?
 *
 * @module services/tasks/__tests__/task-store-timing-override
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '@dorkos/test-utils/db';
import { pulseSchedules, type Db } from '@dorkos/db';
import { SKILL_FILENAME } from '@dorkos/skills/constants';
import { TaskStore } from '../task-store.js';
import { mapTaskRow } from '../task-row-mappers.js';
import { scheduleContentKey } from '../schedule-permission-clamp.js';

/** The fixture's settings, which are part of every approval key (DOR-2323). */
const SETTINGS = {
  name: 'flow-drain',
  runtime: null,
  model: null,
  effort: null,
  maxRuntime: null,
  sticky: false,
};
import { AGENT_TIMING_CHANGE_REASON } from '../timing/effective-timing.js';

const FILE_PATH = `/home/u/.dork/plugins/flow/skills/flow-drain/${SKILL_FILENAME}`;
const PROMPT = 'Drain the queue.';
const PACKAGE_CRON = '0 * * * *';
const MY_CRON = '*/15 * * * *';

/** A parsed SKILL.md for the package's schedule. */
function definition(
  overrides: { cron?: string; body?: string; permissions?: string; timezone?: string } = {}
) {
  return {
    name: 'flow-drain',
    meta: {
      name: 'flow-drain',
      description: 'Drain the queue on a timer',
      schedule: {
        cron: overrides.cron ?? PACKAGE_CRON,
        timezone: overrides.timezone ?? 'UTC',
        enabled: true,
        permissions: overrides.permissions ?? 'acceptEdits',
      },
    },
    body: overrides.body ?? PROMPT,
    filePath: FILE_PATH,
    dirPath: FILE_PATH.replace(`/${SKILL_FILENAME}`, ''),
    scope: 'global',
  } as Parameters<TaskStore['upsertFromFile']>[0];
}

/** The sync a package's file gets every five minutes. */
const DISCOVERY = { source: 'discovery', packageOwned: 'record' } as const;

describe('a person’s own timing on a package’s schedule', () => {
  let db: Db;
  let store: TaskStore;

  beforeEach(() => {
    db = createTestDb();
    store = new TaskStore(db);
  });

  /** The raw row, for the columns the Task deliberately does not carry. */
  function row(id: string) {
    return db.select().from(pulseSchedules).where(eq(pulseSchedules.id, id)).get()!;
  }

  /** An approved, live package schedule, as an install leaves it. */
  function approvedSchedule(): string {
    return store.upsertFromFile(definition()).id;
  }

  /** A person setting their own cron from the Schedules page. */
  function personRetimes(id: string, cron: string): void {
    const before = store.getTask(id)!;
    store.updateTask(id, { cron }, { timingLandsOn: 'row' });
    store.approvals.settleApprovedWorkChange(
      id,
      {
        ...SETTINGS,
        prompt: before.prompt,
        cron: before.cron!,
        timezone: before.timezone!,
        status: 'active',
      },
      {
        trusted: true,
      }
    );
  }

  describe('where the timing is written', () => {
    it('lands on the override and leaves the file’s own timing as the default', () => {
      // Purpose: the sync keeps writing `cron`; a person's timing written there
      // would be overwritten within five minutes.
      const id = approvedSchedule();

      const task = store.updateTask(
        id,
        { cron: MY_CRON, timezone: 'Asia/Tokyo' },
        { timingLandsOn: 'row' }
      )!;

      expect(row(id)).toMatchObject({
        cron: PACKAGE_CRON,
        timezone: 'UTC',
        cronOverride: MY_CRON,
        timezoneOverride: 'Asia/Tokyo',
      });
      expect(task).toMatchObject({
        cron: MY_CRON,
        timezone: 'Asia/Tokyo',
        defaultCron: PACKAGE_CRON,
        defaultTimezone: 'UTC',
        timingOverridden: true,
      });
    });

    it('goes back to the package’s timing on a reset', () => {
      // Purpose: "Reset to the package's default" must clear both halves.
      const id = approvedSchedule();
      store.updateTask(id, { cron: MY_CRON, timezone: 'Asia/Tokyo' }, { timingLandsOn: 'row' });

      const task = store.updateTask(id, { resetTiming: true }, { timingLandsOn: 'row' })!;

      expect(task).toMatchObject({ cron: PACKAGE_CRON, timezone: 'UTC', timingOverridden: false });
    });

    it('writes a file-bound timing to the default columns, as it always has', () => {
      // Purpose: an ordinary schedule's timing still lives in its file; the
      // default `timingLandsOn` must stay `file`.
      const id = approvedSchedule();

      const task = store.updateTask(id, { cron: MY_CRON }, { timingLandsOn: 'file' })!;

      expect(row(id)).toMatchObject({ cron: MY_CRON, cronOverride: null });
      expect(task.timingOverridden).toBe(false);
    });
  });

  describe('the approval follows the timing that runs', () => {
    it('records an approval against the person’s cron, so the next sync keeps it live', () => {
      // Purpose: `recordApproval` keyed on the package's cron while the person's
      // runs would leave a grant the next sync finds does not match, and park it.
      const id = store.upsertFromFile(definition(), undefined, DISCOVERY).id;
      expect(store.getTask(id)!.status).toBe('pending_approval');
      store.updateTask(id, { cron: MY_CRON }, { timingLandsOn: 'row' });

      store.updateTask(id, { status: 'active' });
      expect(row(id).approvedContentKey).toBe(
        scheduleContentKey({ ...SETTINGS, prompt: PROMPT, cron: MY_CRON, timezone: 'UTC' })
      );

      expect(store.upsertFromFile(definition(), undefined, DISCOVERY).status).toBe('active');
    });

    it('keeps an overridden schedule approved when the package changes only its own timing', () => {
      // Purpose: the design's promise — a package update that moves the
      // default cron does not re-park a schedule whose timing is the person's.
      const id = approvedSchedule();
      personRetimes(id, MY_CRON);

      const synced = store.upsertFromFile(
        definition({ cron: '0 */6 * * *' }),
        undefined,
        DISCOVERY
      );

      expect(synced).toMatchObject({ status: 'active', cron: MY_CRON, defaultCron: '0 */6 * * *' });
    });

    it('still parks an overridden schedule whose package changed WHAT it does', () => {
      // Purpose: an override changes only when the approved prompt runs; it must
      // never carry an approval across to a prompt nobody read.
      const id = approvedSchedule();
      personRetimes(id, MY_CRON);

      const synced = store.upsertFromFile(
        definition({ body: 'Do something new.' }),
        undefined,
        DISCOVERY
      );

      expect(synced.status).toBe('pending_approval');
    });

    it('keeps an approved bypass across a sync of the same work at the person’s timing', () => {
      // Purpose: the bypass keep-grant compares the same content the arm gate
      // does. Read off the package's cron on one side and the person's on the
      // other, it would see changed work and drop a level a person granted.
      const id = store.upsertFromFile(definition({ permissions: 'bypassPermissions' })).id;
      store.updateTask(id, { permissionMode: 'bypassPermissions' });
      personRetimes(id, MY_CRON);

      const synced = store.upsertFromFile(
        definition({ permissions: 'bypassPermissions' }),
        undefined,
        DISCOVERY
      );

      expect(synced.permissionMode).toBe('bypassPermissions');
      expect(synced.status).toBe('active');
    });

    it('back-fills a missing grant for the timing that runs', () => {
      // Purpose: the boot-time back-fill writes down an old approval; keyed on
      // the package's cron it would park the schedule at the first sync.
      const id = approvedSchedule();
      store.updateTask(id, { cron: MY_CRON }, { timingLandsOn: 'row' });
      db.update(pulseSchedules)
        .set({ approvedContentKey: null })
        .where(eq(pulseSchedules.id, id))
        .run();

      expect(store.approvals.backfillApprovalGrants()).toBe(1);

      expect(store.upsertFromFile(definition(), undefined, DISCOVERY).status).toBe('active');
    });

    it('re-arms a returning package file with a grant for the timing that runs', () => {
      // Purpose: the operator un-pause writes a grant; for the package's cron
      // it would be a grant the very next discovery sync finds does not match.
      const id = approvedSchedule();
      personRetimes(id, MY_CRON);
      store.markRemovedByFilePath(FILE_PATH);

      expect(store.upsertFromFile(definition()).status).toBe('active');
      expect(store.upsertFromFile(definition(), undefined, DISCOVERY).status).toBe('active');
    });

    it('re-keys a migrated row onto its new path with the person’s timing intact', () => {
      // Purpose: the migration compares the row against the rewritten file; a
      // comparison that forgot the override would read the person's timing as
      // drift and re-park an approved schedule.
      const id = approvedSchedule();
      personRetimes(id, MY_CRON);

      const outcome = store.approvals.rekeyMigratedFile(FILE_PATH, '/moved/SKILL.md', {
        prompt: PROMPT,
        cron: PACKAGE_CRON,
        timezone: 'UTC',
      });

      expect(outcome).toBe('rekeyed');
      expect(row(id).approvedContentKey).toBe(
        scheduleContentKey({ ...SETTINGS, prompt: PROMPT, cron: MY_CRON, timezone: 'UTC' })
      );
    });
  });

  describe('when the file stops being a package’s', () => {
    // An uninstall can leave the file in place, where it becomes the person's
    // to edit. Discovery says so with `packageOwned: null`.
    const UNOWNED = { source: 'discovery', packageOwned: null } as const;

    it('drops the override, so the file’s own timing runs and a hand edit takes effect', () => {
      // Purpose: kept, the override would beat every edit of the file's cron and
      // the page would name a package that is gone.
      const id = approvedSchedule();
      personRetimes(id, MY_CRON);

      const synced = store.upsertFromFile(definition({ cron: '0 6 * * *' }), undefined, UNOWNED);

      expect(synced).toMatchObject({ cron: '0 6 * * *', timingOverridden: false });
      expect(row(id)).toMatchObject({ cronOverride: null, timezoneOverride: null });
    });

    it('stays approved when the file already says the person’s timing', () => {
      // Purpose: writing your own cron into the file you now own is the same
      // approved work, not new work to look at.
      const id = approvedSchedule();
      personRetimes(id, MY_CRON);

      expect(store.upsertFromFile(definition({ cron: MY_CRON }), undefined, UNOWNED).status).toBe(
        'active'
      );
    });

    it('asks again when the timing that runs changes with it', () => {
      // Purpose: the file's cron is not the one the person approved, and it is
      // about to be the one that runs.
      const id = approvedSchedule();
      personRetimes(id, MY_CRON);

      expect(store.upsertFromFile(definition(), undefined, UNOWNED).status).toBe(
        'pending_approval'
      );
    });

    it('keeps the override through a sync that does not say who owns the file', () => {
      // Purpose: only discovery knows; an operator write saying nothing is not
      // "no longer a package's".
      const id = approvedSchedule();
      personRetimes(id, MY_CRON);

      expect(store.upsertFromFile(definition()).cron).toBe(MY_CRON);
    });
  });

  it('refuses a timing update that does not say where it lands', () => {
    // Purpose: a silent `file` default would copy a person's timing over the
    // package's and drop their override.
    const id = approvedSchedule();
    const untyped = store.updateTask.bind(store) as (id: string, input: object) => unknown;

    expect(() => untyped(id, { cron: MY_CRON })).toThrow(/where it lands/);
  });

  describe('settleApprovedWorkChange', () => {
    it('moves a person’s approval to their new timing', () => {
      // Purpose: the design's "re-approves in the same act".
      const id = approvedSchedule();
      store.updateTask(id, { cron: MY_CRON }, { timingLandsOn: 'row' });

      const outcome = store.approvals.settleApprovedWorkChange(
        id,
        { ...SETTINGS, prompt: PROMPT, cron: PACKAGE_CRON, timezone: 'UTC', status: 'active' },
        { trusted: true }
      );

      expect(outcome).toBe('rekeyed');
      expect(store.getTask(id)!.status).toBe('active');
      expect(row(id).approvedContentKey).toBe(
        scheduleContentKey({ ...SETTINGS, prompt: PROMPT, cron: MY_CRON, timezone: 'UTC' })
      );
    });

    it('keeps a paused schedule the person approved approved, so it comes back live', () => {
      // Purpose: keyed on the grant, not on `active` — a paused schedule is
      // still one the person approved.
      const id = approvedSchedule();
      store.markRemovedByFilePath(FILE_PATH);
      store.updateTask(id, { cron: MY_CRON }, { timingLandsOn: 'row' });

      store.approvals.settleApprovedWorkChange(
        id,
        { ...SETTINGS, prompt: PROMPT, cron: PACKAGE_CRON, timezone: 'UTC', status: 'active' },
        {
          trusted: true,
        }
      );

      expect(store.upsertFromFile(definition(), undefined, DISCOVERY).status).toBe('active');
    });

    it('approves nothing a person had not approved before', () => {
      // Purpose: a timing edit on a parked schedule is not its approval.
      const id = store.upsertFromFile(definition(), undefined, DISCOVERY).id;
      store.updateTask(id, { cron: MY_CRON }, { timingLandsOn: 'row' });

      const outcome = store.approvals.settleApprovedWorkChange(
        id,
        { ...SETTINGS, prompt: PROMPT, cron: PACKAGE_CRON, timezone: 'UTC', status: 'active' },
        { trusted: true }
      );

      expect(outcome).toBe('unchanged');
      expect(row(id).approvedContentKey).toBeNull();
    });

    it('parks an approved schedule at once when an agent changes its timing', () => {
      // Purpose: no file was written, so no watcher will; left alone the row
      // would run the agent's timing, approved by nobody, until the next sweep.
      const id = approvedSchedule();
      store.updateTask(id, { cron: MY_CRON }, { timingLandsOn: 'row' });

      const outcome = store.approvals.settleApprovedWorkChange(
        id,
        { ...SETTINGS, prompt: PROMPT, cron: PACKAGE_CRON, timezone: 'UTC', status: 'active' },
        { trusted: false }
      );

      expect(outcome).toBe('parked');
      expect(store.getTask(id)).toMatchObject({
        status: 'pending_approval',
        reason: AGENT_TIMING_CHANGE_REASON,
        reasonSource: 'dorkos',
      });
      expect(row(id).approvedContentKey).toBeNull();
    });

    it('leaves a schedule that is not running where it is', () => {
      // Purpose: only an active schedule has anything to stop; the grant's
      // mismatch already keeps a paused one from arming without a person.
      const id = approvedSchedule();
      store.markRemovedByFilePath(FILE_PATH);
      store.updateTask(id, { cron: MY_CRON }, { timingLandsOn: 'row' });

      const outcome = store.approvals.settleApprovedWorkChange(
        id,
        { ...SETTINGS, prompt: PROMPT, cron: PACKAGE_CRON, timezone: 'UTC', status: 'paused' },
        { trusted: false }
      );

      expect(outcome).toBe('unchanged');
      expect(store.getTask(id)!.status).toBe('paused');
    });

    it('parks an approved schedule when an agent changes only its timezone (DOR-2307)', () => {
      // Purpose: the timezone moves the real run time, so it is part of what a
      // person approved — an agent changing it alone must not keep it live.
      const id = approvedSchedule();
      store.updateTask(id, { timezone: 'Pacific/Kiritimati' }, { timingLandsOn: 'row' });

      const outcome = store.approvals.settleApprovedWorkChange(
        id,
        { ...SETTINGS, prompt: PROMPT, cron: PACKAGE_CRON, timezone: 'UTC', status: 'active' },
        { trusted: false }
      );

      expect(outcome).toBe('parked');
      expect(store.getTask(id)!.status).toBe('pending_approval');
    });

    it('does nothing when the timing that runs did not change', () => {
      // Purpose: an update that leaves the prompt, cron and timezone as they
      // were changes no approved work.
      const id = approvedSchedule();
      store.updateTask(id, { enabled: false });

      const outcome = store.approvals.settleApprovedWorkChange(
        id,
        { ...SETTINGS, prompt: PROMPT, cron: PACKAGE_CRON, timezone: 'UTC', status: 'active' },
        { trusted: false }
      );

      expect(outcome).toBe('unchanged');
      expect(store.getTask(id)!.status).toBe('active');
    });
  });
});

describe('mapTaskRow', () => {
  it('reports the timing that runs, the file’s timing beside it, and whether they differ', () => {
    // Purpose: every Task reader — the scheduler, the preview, the API — reads
    // `cron`; resolving it here is what makes them all see the right one.
    const db = createTestDb();
    const store = new TaskStore(db);
    const id = store.upsertFromFile(definition()).id;
    db.update(pulseSchedules)
      .set({ cronOverride: '', timezoneOverride: null })
      .where(eq(pulseSchedules.id, id))
      .run();

    const mapped = mapTaskRow(
      db.select().from(pulseSchedules).where(eq(pulseSchedules.id, id)).get()!
    );

    // `''` is an override (on demand), not an absence of one.
    expect(mapped).toMatchObject({
      cron: '',
      timezone: 'UTC',
      defaultCron: PACKAGE_CRON,
      defaultTimezone: 'UTC',
      timingOverridden: true,
    });
  });
});
