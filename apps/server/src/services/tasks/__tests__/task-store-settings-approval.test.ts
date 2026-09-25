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
  } as Parameters<TaskStore['upsertFromFile']>[0];
}

const DISCOVERY = { source: 'discovery' } as const;

describe('the settings are part of the approval', () => {
  let db: Db;
  let store: TaskStore;

  beforeEach(() => {
    db = createTestDb();
    store = new TaskStore(db);
  });

  const row = (id: string) =>
    db.select().from(pulseSchedules).where(eq(pulseSchedules.id, id)).get()!;

  /** A schedule a person approved (an operator write arrives with a grant). */
  const approvedSchedule = (settings: Settings = {}) =>
    store.upsertFromFile(definition(settings)).id;

  it.each([
    ['runtime', { runtime: 'codex' }],
    ['model', { model: 'claude-opus-4' }],
    ['effort', { effort: 'high' }],
    ['time limit', { maxRuntime: '2h' }],
    ['memory of earlier runs', { sticky: true }],
  ])('asks again when a file changes the %s', (_, settings) => {
    // Purpose: each of these changes what an unattended run does or costs, so
    // a person who approved one value did not approve another.
    approvedSchedule();

    expect(store.upsertFromFile(definition(settings), undefined, DISCOVERY).status).toBe(
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

    expect(store.upsertFromFile(definition(settings), undefined, DISCOVERY).status).toBe('active');
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
        { field: 'runtime', from: null, to: 'codex' },
        { field: 'model', from: 'claude-sonnet-4', to: 'claude-opus-4' },
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
        const id = store.upsertFromFile({
          ...definition(),
          filePath: `/x/${reason.length}/${Object.keys(change).join()}/SKILL.md`,
        }).id;
        const before = { ...taskWorkOf(store.getTask(id)!), status: 'active' };
        store.updateTask(id, change, { timingLandsOn: 'file' });
        store.approvals.settleApprovedWorkChange(id, before, { trusted: false });
        expect(store.getTask(id)!.reason).toBe(reason);
      }
    });

    it('never switches a schedule on', () => {
      const id = approvedSchedule();
      store.updateTask(id, { enabled: false });
      const before = { ...taskWorkOf(store.getTask(id)!), status: 'active' };
      store.updateTask(id, { model: 'claude-opus-4' });

      store.approvals.settleApprovedWorkChange(id, before, { trusted: false });

      expect(store.getTask(id)!.enabled).toBe(false);
    });

    it('keeps saying what changed when a sync parked it first, mid-request', () => {
      // Purpose: the race DOR-2313 covers: a sync lands between the file write
      // and the row write, and withdraws the grant with its own sentence.
      const id = approvedSchedule({ model: 'claude-sonnet-4' });
      const before = { ...taskWorkOf(store.getTask(id)!), status: 'active' };
      store.upsertFromFile(definition({ model: 'claude-opus-4' }), undefined, DISCOVERY);
      store.updateTask(id, { model: 'claude-opus-4' });

      store.approvals.settleApprovedWorkChange(id, before, { trusted: false });

      expect(store.getTask(id)).toMatchObject({
        reason: AGENT_SETTINGS_CHANGE_REASON,
        approvalChanges: [{ field: 'model', from: 'claude-sonnet-4', to: 'claude-opus-4' }],
      });
    });

    it('keeps the sentence through the next sync of the same file', () => {
      const id = approvedSchedule();
      const before = { ...taskWorkOf(store.getTask(id)!), status: 'active' };
      store.updateTask(id, { model: 'claude-opus-4' });
      store.approvals.settleApprovedWorkChange(id, before, { trusted: false });

      const synced = store.upsertFromFile(
        definition({ model: 'claude-opus-4' }),
        undefined,
        DISCOVERY
      );

      expect(synced).toMatchObject({
        status: 'pending_approval',
        reason: AGENT_SETTINGS_CHANGE_REASON,
      });
      expect(synced.approvalChanges).toEqual([{ field: 'model', from: null, to: 'claude-opus-4' }]);
    });
  });

  describe('a person’s edit', () => {
    it('moves the approval to the new settings (stays approved)', () => {
      // Purpose: the person changing it is the approval.
      const id = approvedSchedule();
      store.updateTask(id, { runtime: 'codex' });
      store.approvals.recordApproval(id);

      expect(
        store.upsertFromFile(definition({ runtime: 'codex' }), undefined, DISCOVERY).status
      ).toBe('active');
    });

    it('clears what the card said changed, once approved', () => {
      const id = approvedSchedule();
      const before = { ...taskWorkOf(store.getTask(id)!), status: 'active' };
      store.updateTask(id, { model: 'claude-opus-4' });
      store.approvals.settleApprovedWorkChange(id, before, { trusted: false });

      store.updateTask(id, { status: 'active' });

      expect(store.getTask(id)!.approvalChanges).toEqual([]);
      expect(row(id).previousApprovalKey).toBeNull();
    });
  });

  it('does not quote the instructions in what changed', () => {
    // Purpose: the card says "changed"; the old prompt stays out of the payload.
    const id = approvedSchedule();
    const before = { ...taskWorkOf(store.getTask(id)!), status: 'active' };
    store.updateTask(id, { prompt: 'Delete the digest.' });
    store.approvals.settleApprovedWorkChange(id, before, { trusted: false });

    expect(store.getTask(id)!.approvalChanges).toEqual([{ field: 'prompt', from: null, to: null }]);
  });

  it('does not park over an effort value the API cannot show', () => {
    // Purpose: a row holding an effort the schema does not know reads as "none"
    // on the task; the key must read it the same way, or an unrelated edit
    // would look like a change to the approved work.
    const id = approvedSchedule();
    db.update(pulseSchedules).set({ effort: 'turbo' }).where(eq(pulseSchedules.id, id)).run();
    store.approvals.recordApproval(id);
    const before = { ...taskWorkOf(store.getTask(id)!), status: 'active' };
    store.updateTask(id, { description: 'Tidier words' });

    expect(store.approvals.settleApprovedWorkChange(id, before, { trusted: false })).toBe(
      'unchanged'
    );
    expect(store.getTask(id)!.status).toBe('active');
  });

  it('keeps the withdrawn approval when a migration parks a drifted row', () => {
    // Purpose: the card's "what changed" must work for every park, the
    // migration's included.
    const id = approvedSchedule();
    store.approvals.rekeyMigratedFile(FILE_PATH, '/new/home/SKILL.md', {
      prompt: 'An edited prompt.',
      cron: CRON,
      timezone: 'UTC',
    });

    expect(store.getTask(id)).toMatchObject({ status: 'pending_approval' });
    // The row takes the file's new prompt at the next sync of its new home.
    const synced = store.upsertFromFile(
      { ...definition({}, 'An edited prompt.'), filePath: '/new/home/SKILL.md' },
      undefined,
      DISCOVERY
    );
    expect(synced.approvalChanges).toEqual([{ field: 'prompt', from: null, to: null }]);
  });

  it('says nothing changed on a schedule that is not waiting', () => {
    // Purpose: "what changed" belongs to a schedule waiting for a decision; a
    // running one with a stale record of a withdrawn approval shows nothing.
    const id = approvedSchedule();
    db.update(pulseSchedules)
      .set({ previousApprovalKey: row(id).approvedContentKey })
      .where(eq(pulseSchedules.id, id))
      .run();
    store.updateTask(id, { model: 'claude-opus-4' });

    expect(store.getTask(id)!.status).toBe('active');
    expect(store.getTask(id)!.approvalChanges).toEqual([]);
  });

  it('says nothing changed on a schedule nobody approved yet', () => {
    // Purpose: "what changed" is against an approval; a first sighting has none.
    const parked = store.upsertFromFile(definition(), undefined, DISCOVERY);

    expect(parked.status).toBe('pending_approval');
    expect(parked.approvalChanges).toEqual([]);
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

      expect(store.upsertFromFile(definition(settings), undefined, DISCOVERY).status).toBe(
        'active'
      );
    });

    it('covers only the settings it runs with now (never silently widens)', () => {
      const id = approvedSchedule({ model: 'claude-sonnet-4' });
      withGrant(id, threePart());
      store.approvals.upgradeLegacyApprovalKeys();

      expect(
        store.upsertFromFile(definition({ model: 'claude-opus-4' }), undefined, DISCOVERY).status
      ).toBe('pending_approval');
    });

    it('withdraws a stale grant exactly as it would have been withdrawn before', () => {
      const id = approvedSchedule();
      withGrant(id, threePart('an older prompt'));

      store.approvals.upgradeLegacyApprovalKeys();

      expect(store.upsertFromFile(definition(), undefined, DISCOVERY).status).toBe(
        'pending_approval'
      );
    });

    it('still upgrades a two-part key from before DOR-2307, all the way', () => {
      const id = approvedSchedule({ model: 'gpt-5' });
      withGrant(id, JSON.stringify([PROMPT, CRON]));

      store.approvals.upgradeLegacyApprovalKeys();

      expect(row(id).approvedContentKey).toBe(
        scheduleContentKey({ ...taskWorkOf(store.getTask(id)!) })
      );
    });

    it('does nothing the second time', () => {
      const id = approvedSchedule();
      withGrant(id, threePart());

      expect(store.approvals.upgradeLegacyApprovalKeys()).toBe(1);
      expect(store.approvals.upgradeLegacyApprovalKeys()).toBe(0);
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
  };

  it('extends a three-part key with the settings it runs with now', () => {
    expect(upgradeLegacyContentKey(JSON.stringify([PROMPT, CRON, 'UTC']), current)).toBe(
      scheduleContentKey({ ...current, prompt: PROMPT, cron: CRON, timezone: 'UTC' })
    );
  });

  it('leaves a current key, and anything it did not write, alone', () => {
    const now = scheduleContentKey({ ...current, prompt: PROMPT, cron: CRON });
    expect(upgradeLegacyContentKey(now, current)).toBeNull();
    expect(upgradeLegacyContentKey(JSON.stringify([PROMPT, CRON, 7]), current)).toBeNull();
    expect(upgradeLegacyContentKey('nope', current)).toBeNull();
  });
});
