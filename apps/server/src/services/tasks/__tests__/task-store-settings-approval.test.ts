/**
 * A schedule's name, runtime, model, effort, time limit and memory are part of
 * what a person approves (DOR-2323), and every approval given before that is
 * carried over without widening or breaking.
 *
 * The approval key was `[prompt, cron, timezone]`, so an agent could switch an
 * approved schedule to another runtime or a costlier model and keep it running.
 * The key carries `ScheduleSettings` now. The cases below pin both halves: a
 * settings change is new work, and a grant recorded under an older key keeps
 * exactly the schedule it already covered running, no more. They also pin what
 * the approval card is told changed.
 *
 * @module services/tasks/__tests__/task-store-settings-approval
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '@dorkos/test-utils/db';
import { pulseSchedules, type Db } from '@dorkos/db';
import { SKILL_FILENAME } from '@dorkos/skills/constants';
import { TaskStore } from '../task-store.js';
import type { TaskFileSync } from '../../../services/tasks/sync/task-file-sync.js';
import {
  scheduleContentKey,
  taskWorkOf,
  upgradeLegacyContentKey,
} from '../schedule-permission-clamp.js';
import {
  AGENT_CONTENT_CHANGE_REASON,
  AGENT_SETTINGS_CHANGE_REASON,
  AGENT_TIMING_CHANGE_REASON,
} from '../timing/effective-timing.js';

const FILE_PATH = `/home/u/.dork/skills/digest/${SKILL_FILENAME}`;
const PROMPT = 'Post the overnight digest.';
const CRON = '0 7 * * *';

/** The settings a schedule can carry, to override one at a time. */
interface Settings {
  runtime?: string;
  model?: string;
  effort?: string;
  maxRuntime?: string;
  sticky?: boolean;
  name?: string;
}

/** A parsed SKILL.md for an ordinary schedule. */
function definition(settings: Settings = {}, body = PROMPT) {
  const name = settings.name ?? 'digest';
  return {
    name,
    meta: {
      name,
      description: 'Post the overnight digest',
      schedule: {
        cron: CRON,
        timezone: 'UTC',
        enabled: true,
        sticky: settings.sticky ?? false,
        permissions: 'acceptEdits',
        ...(settings.runtime && { runtime: settings.runtime }),
        ...(settings.model && { model: settings.model }),
        ...(settings.effort && { effort: settings.effort }),
        ...(settings.maxRuntime && { 'max-runtime': settings.maxRuntime }),
      },
    },
    body,
    filePath: FILE_PATH,
    dirPath: FILE_PATH.replace(`/${SKILL_FILENAME}`, ''),
    scope: 'global',
  } as Parameters<TaskFileSync['upsertFromFile']>[0];
}

const DISCOVERY = { source: 'discovery' } as const;

describe('the settings are part of the approval', () => {
  let db: Db;
  let store: TaskStore;

  beforeEach(() => {
    db = createTestDb();
    store = new TaskStore(db);
  });

  /** A schedule a person approved (an operator write arrives with a grant). */
  const approvedSchedule = (settings: Settings = {}) =>
    store.fileSync.upsertFromFile(definition(settings)).id;

  it.each([
    ['runtime', { runtime: 'codex' }],
    ['model', { model: 'claude-opus-4' }],
  ])('asks again when a file changes the %s', (_, settings) => {
    // Purpose: each of these changes what an unattended run does or costs, so
    // a person who approved one value did not approve another.
    approvedSchedule();

    expect(store.fileSync.upsertFromFile(definition(settings), undefined, DISCOVERY).status).toBe(
      'pending_approval'
    );
  });

  it('keeps an approved schedule approved through a sync of the same settings', () => {
    // Purpose: the over-parking direction; the key of what arrives and the key
    // of the row must agree for unchanged content with every setting set.
    const settings = {
      runtime: 'codex',
      model: 'gpt-5',
      effort: 'high',
      maxRuntime: '30m',
      sticky: true,
    };
    approvedSchedule(settings);

    expect(store.fileSync.upsertFromFile(definition(settings), undefined, DISCOVERY).status).toBe(
      'active'
    );
  });

  describe('an agent’s edit through the API', () => {
    it('parks with a sentence about how it runs, and says what changed', () => {
      // Purpose: the card shows old → new model and runtime (DOR-2323).
      const id = approvedSchedule({ model: 'claude-sonnet-4' });
      const before = { ...taskWorkOf(store.getTask(id)!), status: 'active' };
      store.updateTask(id, { model: 'claude-opus-4', runtime: 'codex' });

      expect(store.approvals.settleApprovedWorkChange(id, before, { trusted: false })).toBe(
        'parked'
      );

      const parked = store.getTask(id)!;
      expect(parked).toMatchObject({
        status: 'pending_approval',
        reason: AGENT_SETTINGS_CHANGE_REASON,
        reasonSource: 'dorkos',
      });
      expect(parked.approvalChanges).toEqual([
        { field: 'runtime', from: null, to: 'codex', via: 'schedule' },
        { field: 'model', from: 'claude-sonnet-4', to: 'claude-opus-4', via: 'schedule' },
      ]);
    });

    it('prefers the sentence about what it does, then about how it runs, then about when', () => {
      // Purpose: the prompt is the part a person most needs to read.
      const cases = [
        [{ prompt: 'Delete the digest.', model: 'x' }, AGENT_CONTENT_CHANGE_REASON],
        [{ model: 'x', cron: '0 8 * * *' }, AGENT_SETTINGS_CHANGE_REASON],
        [{ cron: '0 8 * * *' }, AGENT_TIMING_CHANGE_REASON],
      ] as const;
      for (const [change, reason] of cases) {
        const id = store.fileSync.upsertFromFile({
          ...definition(),
          filePath: `/x/${reason.length}/${Object.keys(change).join()}/SKILL.md`,
        }).id;
        const before = { ...taskWorkOf(store.getTask(id)!), status: 'active' };
        store.updateTask(id, change, { timingLandsOn: 'file' });
        store.approvals.settleApprovedWorkChange(id, before, { trusted: false });
        expect(store.getTask(id)!.reason).toBe(reason);
      }
    });

    it('keeps saying what changed when a sync parked it first, mid-request', () => {
      // Purpose: the race DOR-2313 covers: a sync lands between the file write
      // and the row write, and withdraws the grant with its own sentence.
      const id = approvedSchedule({ model: 'claude-sonnet-4' });
      const before = { ...taskWorkOf(store.getTask(id)!), status: 'active' };
      store.fileSync.upsertFromFile(definition({ model: 'claude-opus-4' }), undefined, DISCOVERY);
      store.updateTask(id, { model: 'claude-opus-4' });

      store.approvals.settleApprovedWorkChange(id, before, { trusted: false });

      expect(store.getTask(id)).toMatchObject({
        reason: AGENT_SETTINGS_CHANGE_REASON,
        approvalChanges: [
          { field: 'model', from: 'claude-sonnet-4', to: 'claude-opus-4', via: 'schedule' },
        ],
      });
    });
  });

  describe('a person’s edit', () => {
    it('moves the approval to the new settings (stays approved)', () => {
      // Purpose: the person changing it is the approval.
      const id = approvedSchedule();
      store.updateTask(id, { runtime: 'codex' });
      store.approvals.recordApproval(id);

      expect(
        store.fileSync.upsertFromFile(definition({ runtime: 'codex' }), undefined, DISCOVERY).status
      ).toBe('active');
    });
  });

  it('does not quote the instructions in what changed', () => {
    // Purpose: the card says "changed"; the old prompt stays out of the payload.
    const id = approvedSchedule();
    const before = { ...taskWorkOf(store.getTask(id)!), status: 'active' };
    store.updateTask(id, { prompt: 'Delete the digest.' });
    store.approvals.settleApprovedWorkChange(id, before, { trusted: false });

    expect(store.getTask(id)!.approvalChanges).toEqual([
      { field: 'prompt', from: null, to: null, via: 'schedule' },
    ]);
  });

  describe('carrying an approval from an older key format', () => {
    /** Put a row back to a grant an older build would have written for it. */
    function withGrant(id: string, key: string): void {
      db.update(pulseSchedules)
        .set({ approvedContentKey: key })
        .where(eq(pulseSchedules.id, id))
        .run();
    }
    const threePart = (prompt = PROMPT) => JSON.stringify([prompt, CRON, 'UTC']);

    it('keeps an approved schedule approved through the next sync (never silently breaks)', () => {
      const settings = { runtime: 'codex', model: 'gpt-5', sticky: true };
      const id = approvedSchedule(settings);
      withGrant(id, threePart());

      expect(store.approvals.upgradeLegacyApprovalKeys()).toBe(1);

      expect(store.fileSync.upsertFromFile(definition(settings), undefined, DISCOVERY).status).toBe(
        'active'
      );
    });

    it('covers only the settings it runs with now (never silently widens)', () => {
      const id = approvedSchedule({ model: 'claude-sonnet-4' });
      withGrant(id, threePart());
      store.approvals.upgradeLegacyApprovalKeys();

      expect(
        store.fileSync.upsertFromFile(definition({ model: 'claude-opus-4' }), undefined, DISCOVERY)
          .status
      ).toBe('pending_approval');
    });

    it('withdraws a stale grant exactly as it would have been withdrawn before', () => {
      const id = approvedSchedule();
      withGrant(id, threePart('an older prompt'));

      store.approvals.upgradeLegacyApprovalKeys();

      expect(store.fileSync.upsertFromFile(definition(), undefined, DISCOVERY).status).toBe(
        'pending_approval'
      );
    });
  });
});

describe('upgradeLegacyContentKey', () => {
  const current = {
    timezone: 'Asia/Tokyo',
    name: 'digest',
    runtime: 'codex',
    model: null,
    effort: 'low',
    maxRuntime: 60_000,
    sticky: true,
    account: null,
  };

  it('extends a three-part key with the settings it runs with now', () => {
    expect(upgradeLegacyContentKey(JSON.stringify([PROMPT, CRON, 'UTC']), current)).toBe(
      scheduleContentKey({ ...current, prompt: PROMPT, cron: CRON, timezone: 'UTC' })
    );
  });
});
