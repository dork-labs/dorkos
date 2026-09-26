/**
 * A schedule's Claude account is part of what a person approves (DOR-2384),
 * and every approval recorded before the account joined the key is carried
 * over without widening or breaking.
 *
 * The account decides which subscription pays for an unattended run, so it
 * joins `ScheduleSettings` the way the model did in DOR-2323: an agent's change
 * to it re-parks an approved schedule, a file's change to it re-parks too, and a
 * nine-part key written before this change upgrades in place and stays
 * approved.
 *
 * @module services/tasks/__tests__/task-store-account-approval
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '@dorkos/test-utils/db';
import { pulseSchedules, type Db } from '@dorkos/db';
import { SKILL_FILENAME } from '@dorkos/skills/constants';
import { TaskStore } from '../task-store.js';
import type { TaskFileSync } from '../../../services/tasks/sync/task-file-sync.js';
import {
  parseContentKey,
  scheduleContentKey,
  taskWorkOf,
  upgradeLegacyContentKey,
} from '../schedule-permission-clamp.js';
import { AGENT_SETTINGS_CHANGE_REASON } from '../timing/effective-timing.js';
import { STICKY_ACCOUNT_LOCKED_MESSAGE } from '../session/sticky-session.js';

const FILE_PATH = `/home/u/.dork/skills/digest/${SKILL_FILENAME}`;
const PROMPT = 'Post the overnight digest.';
const CRON = '0 7 * * *';

/** A parsed SKILL.md for an ordinary schedule, optionally naming an account. */
function definition(opts: { account?: string; model?: string; sticky?: boolean } = {}) {
  return {
    name: 'digest',
    meta: {
      name: 'digest',
      description: 'Post the overnight digest',
      schedule: {
        cron: CRON,
        timezone: 'UTC',
        enabled: true,
        sticky: opts.sticky ?? false,
        permissions: 'acceptEdits',
        ...(opts.model && { model: opts.model }),
        ...(opts.account && { account: opts.account }),
      },
    },
    body: PROMPT,
    filePath: FILE_PATH,
    dirPath: FILE_PATH.replace(`/${SKILL_FILENAME}`, ''),
    scope: 'global',
  } as Parameters<TaskFileSync['upsertFromFile']>[0];
}

/** The key an older build wrote for {@link definition}: nine parts, no account. */
function ninePartKey(model: string | null = null): string {
  return JSON.stringify([PROMPT, CRON, 'UTC', 'digest', null, model, null, null, false]);
}

const DISCOVERY = { source: 'discovery' } as const;

describe('the content key carries the account', () => {
  const work = {
    prompt: PROMPT,
    cron: CRON,
    timezone: 'UTC',
    name: 'digest',
    runtime: null,
    model: null,
    effort: null,
    maxRuntime: null,
    sticky: false,
  };

  it('is ten parts, and differs by account', () => {
    const key = scheduleContentKey({ ...work, account: 'work' });
    expect(JSON.parse(key)).toHaveLength(10);
    expect(key).not.toBe(scheduleContentKey({ ...work, account: null }));
  });

  it('reads a ten-part key back, account included', () => {
    const key = scheduleContentKey({ ...work, account: 'work' });
    expect(parseContentKey(key)).toEqual({ ...work, account: 'work' });
  });

  it('reads a nine-part key as one with no account', () => {
    // Purpose: a withdrawn approval is kept exactly as written, so the card's
    // "what changed" must still read one recorded before the account existed.
    expect(parseContentKey(ninePartKey())).toEqual({ ...work, account: null });
  });

  it('reads nothing from a key whose account part is not text', () => {
    const bad = JSON.stringify([PROMPT, CRON, 'UTC', 'digest', null, null, null, null, false, 7]);
    expect(parseContentKey(bad)).toBeNull();
  });

  it('upgrades a nine-part key by adding the account the row runs with now', () => {
    const current = { ...work, timezone: 'UTC', account: 'work' };
    expect(upgradeLegacyContentKey(ninePartKey(), current)).toBe(
      scheduleContentKey({ ...work, account: 'work' })
    );
  });

  it('keeps every part a nine-part key recorded, even one the row no longer matches', () => {
    // Purpose: the upgrade adds the account and nothing else; a grant that no
    // longer covers the row must not start covering it.
    const current = { ...work, model: 'claude-opus-4', account: null };
    expect(upgradeLegacyContentKey(ninePartKey('claude-sonnet-4'), current)).toBe(
      scheduleContentKey({ ...work, model: 'claude-sonnet-4', account: null })
    );
  });

  it('leaves a current key alone', () => {
    const current = { ...work, account: 'work' };
    expect(upgradeLegacyContentKey(scheduleContentKey(current), current)).toBeNull();
  });
});

describe('the account is part of the approval', () => {
  let db: Db;
  let store: TaskStore;

  beforeEach(() => {
    db = createTestDb();
    store = new TaskStore(db);
  });

  const row = (id: string) =>
    db.select().from(pulseSchedules).where(eq(pulseSchedules.id, id)).get()!;

  /** A schedule a person approved (an operator write arrives with a grant). */
  const approvedSchedule = (opts: { account?: string } = {}) =>
    store.fileSync.upsertFromFile(definition(opts)).id;

  it('reads the account out of the file onto the task', () => {
    const id = approvedSchedule({ account: 'work' });
    expect(store.getTask(id)!.account).toBe('work');
    expect(row(id).account).toBe('work');
  });

  it('reports no account as null', () => {
    expect(store.getTask(approvedSchedule())!.account).toBeNull();
  });

  it('asks again when a file changes the account', () => {
    approvedSchedule();
    expect(
      store.fileSync.upsertFromFile(definition({ account: 'work' }), undefined, DISCOVERY).status
    ).toBe('pending_approval');
  });

  it('keeps an approved schedule approved through a sync of the same account', () => {
    approvedSchedule({ account: 'work' });
    expect(
      store.fileSync.upsertFromFile(definition({ account: 'work' }), undefined, DISCOVERY).status
    ).toBe('active');
  });

  it('parks an agent’s change of account and says what changed', () => {
    // Purpose: the DOR-2323 shape — an agent moving an approved schedule onto
    // another subscription is new work a person has to see.
    const id = approvedSchedule();
    const before = { ...taskWorkOf(store.getTask(id)!), status: 'active' };
    store.updateTask(id, { account: 'work' });

    expect(store.approvals.settleApprovedWorkChange(id, before, { trusted: false })).toBe('parked');
    const parked = store.getTask(id)!;
    expect(parked).toMatchObject({
      status: 'pending_approval',
      reason: AGENT_SETTINGS_CHANGE_REASON,
    });
    expect(parked.approvalChanges).toEqual([{ field: 'account', from: null, to: 'work' }]);
  });

  it('moves the approval with a person’s change of account', () => {
    const id = approvedSchedule();
    store.updateTask(id, { account: 'work' });
    store.approvals.recordApproval(id);

    expect(
      store.fileSync.upsertFromFile(definition({ account: 'work' }), undefined, DISCOVERY).status
    ).toBe('active');
  });

  describe('a grant recorded before the account joined the key', () => {
    const withGrant = (id: string, key: string) =>
      db
        .update(pulseSchedules)
        .set({ approvedContentKey: key })
        .where(eq(pulseSchedules.id, id))
        .run();

    it('upgrades and stays approved (never silently breaks)', () => {
      const id = approvedSchedule();
      withGrant(id, ninePartKey());

      expect(store.approvals.upgradeLegacyApprovalKeys()).toBe(1);
      expect(row(id).approvedContentKey).toBe(scheduleContentKey(taskWorkOf(store.getTask(id)!)));
      expect(store.fileSync.upsertFromFile(definition(), undefined, DISCOVERY).status).toBe(
        'active'
      );
    });

    it('does not start covering a model it never covered (never silently widens)', () => {
      const id = store.fileSync.upsertFromFile(definition({ model: 'claude-opus-4' })).id;
      withGrant(id, ninePartKey('claude-sonnet-4'));

      store.approvals.upgradeLegacyApprovalKeys();

      expect(
        store.fileSync.upsertFromFile(definition({ model: 'claude-opus-4' }), undefined, DISCOVERY)
          .status
      ).toBe('pending_approval');
    });

    it('does nothing the second time', () => {
      const id = approvedSchedule();
      withGrant(id, ninePartKey());

      expect(store.approvals.upgradeLegacyApprovalKeys()).toBe(1);
      expect(store.approvals.upgradeLegacyApprovalKeys()).toBe(0);
    });
  });

  describe('a file that moves a started sticky conversation to another account', () => {
    /** An approved sticky schedule whose conversation has started. */
    function startedSticky(): string {
      const id = store.fileSync.upsertFromFile(definition({ sticky: true })).id;
      const run = store.createRun(id, 'scheduled');
      store.updateRun(run.id, { sessionId: '0f6c1d7e-7d0e-4c55-9f55-000000000005' });
      return id;
    }

    it('parks with the sentence the API refuses with, and keeps the account it runs on', () => {
      // Purpose: a SKILL.md edit is the door the API lock does not cover; the
      // conversation stays on its account, so the file's new one must not be
      // stored as if a run would use it.
      const id = startedSticky();

      const synced = store.fileSync.upsertFromFile(
        definition({ sticky: true, account: 'work' }),
        undefined,
        DISCOVERY
      );

      expect(synced).toMatchObject({
        status: 'pending_approval',
        reason: STICKY_ACCOUNT_LOCKED_MESSAGE,
        account: null,
      });
      expect(row(id).account).toBeNull();
    });

    it('keeps refusing on every later sync of the same file', () => {
      const id = startedSticky();
      store.fileSync.upsertFromFile(
        definition({ sticky: true, account: 'work' }),
        undefined,
        DISCOVERY
      );
      store.approvals.recordApproval(id);

      expect(
        store.fileSync.upsertFromFile(
          definition({ sticky: true, account: 'work' }),
          undefined,
          DISCOVERY
        )
      ).toMatchObject({ status: 'pending_approval', reason: STICKY_ACCOUNT_LOCKED_MESSAGE });
    });

    it('takes the account once the file stops keeping one conversation', () => {
      const id = startedSticky();

      store.fileSync.upsertFromFile(
        definition({ sticky: false, account: 'work' }),
        undefined,
        DISCOVERY
      );

      expect(row(id).account).toBe('work');
      expect(store.getTask(id)!.reason).not.toBe(STICKY_ACCOUNT_LOCKED_MESSAGE);
    });

    it('lets a sticky schedule that has never run take the file’s account', () => {
      const id = store.fileSync.upsertFromFile(definition({ sticky: true })).id;

      store.fileSync.upsertFromFile(
        definition({ sticky: true, account: 'work' }),
        undefined,
        DISCOVERY
      );

      expect(row(id).account).toBe('work');
    });
  });
});
