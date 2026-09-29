/**
 * The timezone is part of what a person approves (DOR-2307), and every approval
 * given before that is carried over without widening or breaking.
 *
 * A schedule's approval used to be keyed on `[prompt, cron]`, so an agent could
 * move a schedule to another timezone — shifting its real run time by up to a
 * day — and keep it approved. The key is `[prompt, cron, timezone]` now. The
 * cases below pin both halves: a timezone change is new work, and a grant
 * recorded under the old key keeps exactly the schedule it already covered
 * running, no more.
 *
 * @module services/tasks/__tests__/task-store-timezone-approval
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '@dorkos/test-utils/db';
import { pulseSchedules, type Db } from '@dorkos/db';
import { SKILL_FILENAME } from '@dorkos/skills/constants';
import { TaskStore } from '../task-store.js';
import type { TaskFileSync } from '../../../services/tasks/sync/task-file-sync.js';
import { scheduleContentKey, upgradeLegacyContentKey } from '../schedule-permission-clamp.js';

/** The fixture's settings, which are part of every approval key (DOR-2323). */
const SETTINGS = {
  name: 'digest',
  runtime: null,
  model: null,
  effort: null,
  maxRuntime: null,
  sticky: false,
  account: null,
};

const FILE_PATH = `/home/u/.dork/skills/digest/${SKILL_FILENAME}`;
const PROMPT = 'Post the overnight digest.';
const CRON = '0 7 * * *';

/** A parsed SKILL.md for an ordinary schedule. */
function definition(overrides: { timezone?: string; body?: string; permissions?: string } = {}) {
  return {
    name: 'digest',
    meta: {
      name: 'digest',
      description: 'Post the overnight digest',
      schedule: {
        cron: CRON,
        timezone: overrides.timezone ?? 'Europe/Berlin',
        enabled: true,
        permissions: overrides.permissions ?? 'acceptEdits',
      },
    },
    body: overrides.body ?? PROMPT,
    filePath: FILE_PATH,
    dirPath: FILE_PATH.replace(`/${SKILL_FILENAME}`, ''),
    scope: 'global',
  } as Parameters<TaskFileSync['upsertFromFile']>[0];
}

const DISCOVERY = { source: 'discovery' } as const;

/** The key shape every build before DOR-2307 wrote. */
const legacyKey = (prompt: string, cron: string) => JSON.stringify([prompt, cron]);

describe('upgradeLegacyContentKey', () => {
  it('extends a two-part grant with the timezone the schedule runs in', () => {
    // Purpose: the old grant was only ever checked against the running zone.
    expect(
      upgradeLegacyContentKey(legacyKey(PROMPT, CRON), { ...SETTINGS, timezone: 'Europe/Berlin' })
    ).toBe(
      scheduleContentKey({ ...SETTINGS, prompt: PROMPT, cron: CRON, timezone: 'Europe/Berlin' })
    );
  });

  it('leaves a current key, and anything it did not write, alone', () => {
    // Purpose: idempotent across boots, and never guesses at a key it cannot read.
    const current = scheduleContentKey({
      ...SETTINGS,
      prompt: PROMPT,
      cron: CRON,
      timezone: 'UTC',
    });
    expect(upgradeLegacyContentKey(current, { ...SETTINGS, timezone: 'Asia/Tokyo' })).toBeNull();
    expect(upgradeLegacyContentKey('not json', { ...SETTINGS, timezone: 'UTC' })).toBeNull();
    expect(
      upgradeLegacyContentKey(JSON.stringify([PROMPT, 7]), { ...SETTINGS, timezone: 'UTC' })
    ).toBeNull();
    expect(
      upgradeLegacyContentKey(JSON.stringify({ prompt: PROMPT }), { ...SETTINGS, timezone: 'UTC' })
    ).toBeNull();
  });
});

describe('the timezone is part of the approval', () => {
  let db: Db;
  let store: TaskStore;

  beforeEach(() => {
    db = createTestDb();
    store = new TaskStore(db);
  });

  const row = (id: string) =>
    db.select().from(pulseSchedules).where(eq(pulseSchedules.id, id)).get()!;

  /** A schedule a person approved (an operator write arrives with a grant). */
  const approvedSchedule = () => store.fileSync.upsertFromFile(definition()).id;

  /** Put a row back to the grant an older build would have written for it. */
  function withLegacyGrant(id: string, prompt = PROMPT, cron = CRON): void {
    db.update(pulseSchedules)
      .set({ approvedContentKey: legacyKey(prompt, cron) })
      .where(eq(pulseSchedules.id, id))
      .run();
  }

  it('records the timezone in a person’s approval', () => {
    // Purpose: the grant must name the zone, or a zone change could not be seen.
    const id = approvedSchedule();

    expect(row(id).approvedContentKey).toBe(
      scheduleContentKey({ ...SETTINGS, prompt: PROMPT, cron: CRON, timezone: 'Europe/Berlin' })
    );
  });

  it('asks again when a schedule’s file moves it to another timezone', () => {
    // Purpose: an agent writing only `timezone:` into the file used to keep the
    // schedule approved while its real run time moved.
    approvedSchedule();

    const synced = store.fileSync.upsertFromFile(
      definition({ timezone: 'Pacific/Kiritimati' }),
      undefined,
      DISCOVERY
    );

    expect(synced.status).toBe('pending_approval');
  });

  it('drops an approved bypass when the file moves the timezone', () => {
    // Purpose: the bypass keep-grant compares the same key the arm gate does,
    // so the two cannot disagree about whether this is still the approved work.
    const id = store.fileSync.upsertFromFile(definition({ permissions: 'bypassPermissions' })).id;
    store.updateTask(id, { permissionMode: 'bypassPermissions' });

    const synced = store.fileSync.upsertFromFile(
      definition({ permissions: 'bypassPermissions', timezone: 'Pacific/Kiritimati' }),
      undefined,
      DISCOVERY
    );

    expect(synced.permissionMode).toBe('acceptEdits');
  });

  describe('carrying an approval from before the timezone was in the key', () => {
    it('keeps an approved schedule approved through the next sync (never silently breaks)', () => {
      // Purpose: without the upgrade every approved schedule's stored key stops
      // matching, and the first sync parks it.
      const id = approvedSchedule();
      withLegacyGrant(id);

      expect(store.approvals.upgradeLegacyApprovalKeys()).toBe(1);

      expect(store.fileSync.upsertFromFile(definition(), undefined, DISCOVERY).status).toBe(
        'active'
      );
    });

    it('covers only the timezone it runs in now (never silently widens)', () => {
      // Purpose: the upgrade must not turn "approved in Berlin" into "approved
      // anywhere": moving the zone after it asks again.
      const id = approvedSchedule();
      withLegacyGrant(id);
      store.approvals.upgradeLegacyApprovalKeys();

      const synced = store.fileSync.upsertFromFile(
        definition({ timezone: 'Pacific/Kiritimati' }),
        undefined,
        DISCOVERY
      );

      expect(synced.status).toBe('pending_approval');
    });

    it('uses the timezone a person set on the row, when they set one', () => {
      // Purpose: a package's schedule on the person's own timezone runs there,
      // so that is the zone the old grant covered.
      const id = approvedSchedule();
      db.update(pulseSchedules)
        .set({ timezoneOverride: 'Asia/Tokyo' })
        .where(eq(pulseSchedules.id, id))
        .run();
      withLegacyGrant(id);

      store.approvals.upgradeLegacyApprovalKeys();

      expect(row(id).approvedContentKey).toBe(
        scheduleContentKey({ ...SETTINGS, prompt: PROMPT, cron: CRON, timezone: 'Asia/Tokyo' })
      );
    });

    it('withdraws a stale grant exactly as it would have been withdrawn before', () => {
      // Purpose: a grant for content the row no longer runs stays unmatched.
      const id = approvedSchedule();
      withLegacyGrant(id, 'an older prompt');

      store.approvals.upgradeLegacyApprovalKeys();

      expect(store.fileSync.upsertFromFile(definition(), undefined, DISCOVERY).status).toBe(
        'pending_approval'
      );
    });

    it('carries the grant of a schedule that is not running, too', () => {
      // Purpose: a paused schedule a person approved is still approved when its
      // file comes back.
      const id = approvedSchedule();
      withLegacyGrant(id);
      store.fileSync.markRemovedByFilePath(FILE_PATH);

      store.approvals.upgradeLegacyApprovalKeys();

      expect(store.fileSync.upsertFromFile(definition(), undefined, DISCOVERY).status).toBe(
        'active'
      );
    });

    it('does nothing the second time, and nothing to a row with no approval', () => {
      // Purpose: runs on every boot; it must be a no-op once done.
      const id = approvedSchedule();
      withLegacyGrant(id);
      const parked = store.fileSync.upsertFromFile(
        { ...definition(), filePath: '/elsewhere/SKILL.md' },
        undefined,
        DISCOVERY
      );

      expect(store.approvals.upgradeLegacyApprovalKeys()).toBe(1);
      expect(store.approvals.upgradeLegacyApprovalKeys()).toBe(0);
      expect(row(parked.id).approvedContentKey).toBeNull();
    });
  });
});
