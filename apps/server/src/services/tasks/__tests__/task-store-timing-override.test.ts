/**
 * The store's half of a person's own timing for a package's schedule
 * (DOR-2302): where the timing is written, what every raw-row reader sees, and
 * how the approval grant follows it.
 *
 * Every case drives the store the way production does — `upsertFromFile` for a
 * sync, `updateTask` + `settleTimingChange` for an edit — and then asks the
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
const DISCOVERY = { source: 'discovery', packageOwned: true } as const;

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
    store.settleTimingChange(
      id,
      scheduleContentKey({ prompt: before.prompt, cron: before.cron! }),
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

      const task = store.updateTask(id, { resetTiming: true })!;

      expect(task).toMatchObject({ cron: PACKAGE_CRON, timezone: 'UTC', timingOverridden: false });
    });

    it('writes a file-bound timing to the default columns, as it always has', () => {
      // Purpose: an ordinary schedule's timing still lives in its file; the
      // default `timingLandsOn` must stay `file`.
      const id = approvedSchedule();

      const task = store.updateTask(id, { cron: MY_CRON })!;

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
        scheduleContentKey({ prompt: PROMPT, cron: MY_CRON })
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

      expect(store.backfillApprovalGrants()).toBe(1);

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

      const outcome = store.rekeyMigratedFile(FILE_PATH, '/moved/SKILL.md', {
        prompt: PROMPT,
        cron: PACKAGE_CRON,
      });

      expect(outcome).toBe('rekeyed');
      expect(row(id).approvedContentKey).toBe(
        scheduleContentKey({ prompt: PROMPT, cron: MY_CRON })
      );
    });
  });

  describe('settleTimingChange', () => {
    it('moves a person’s approval to their new timing', () => {
      // Purpose: the design's "re-approves in the same act".
      const id = approvedSchedule();
      store.updateTask(id, { cron: MY_CRON }, { timingLandsOn: 'row' });

      const outcome = store.settleTimingChange(
        id,
        scheduleContentKey({ prompt: PROMPT, cron: PACKAGE_CRON }),
        { trusted: true }
      );

      expect(outcome).toBe('rekeyed');
      expect(store.getTask(id)!.status).toBe('active');
      expect(row(id).approvedContentKey).toBe(
        scheduleContentKey({ prompt: PROMPT, cron: MY_CRON })
      );
    });

    it('keeps a paused schedule the person approved approved, so it comes back live', () => {
      // Purpose: keyed on the grant, not on `active` — a paused schedule is
      // still one the person approved.
      const id = approvedSchedule();
      store.markRemovedByFilePath(FILE_PATH);
      store.updateTask(id, { cron: MY_CRON }, { timingLandsOn: 'row' });

      store.settleTimingChange(id, scheduleContentKey({ prompt: PROMPT, cron: PACKAGE_CRON }), {
        trusted: true,
      });

      expect(store.upsertFromFile(definition(), undefined, DISCOVERY).status).toBe('active');
    });

    it('approves nothing a person had not approved before', () => {
      // Purpose: a timing edit on a parked schedule is not its approval.
      const id = store.upsertFromFile(definition(), undefined, DISCOVERY).id;
      store.updateTask(id, { cron: MY_CRON }, { timingLandsOn: 'row' });

      const outcome = store.settleTimingChange(
        id,
        scheduleContentKey({ prompt: PROMPT, cron: PACKAGE_CRON }),
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

      const outcome = store.settleTimingChange(
        id,
        scheduleContentKey({ prompt: PROMPT, cron: PACKAGE_CRON }),
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

      const outcome = store.settleTimingChange(
        id,
        scheduleContentKey({ prompt: PROMPT, cron: PACKAGE_CRON }),
        { trusted: false }
      );

      expect(outcome).toBe('unchanged');
      expect(store.getTask(id)!.status).toBe('paused');
    });

    it('does nothing when the timing that runs did not change', () => {
      // Purpose: a timezone is not in the approval key, so changing it alone
      // neither re-keys nor parks.
      const id = approvedSchedule();
      store.updateTask(id, { timezone: 'Asia/Tokyo' }, { timingLandsOn: 'row' });

      const outcome = store.settleTimingChange(
        id,
        scheduleContentKey({ prompt: PROMPT, cron: PACKAGE_CRON }),
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
