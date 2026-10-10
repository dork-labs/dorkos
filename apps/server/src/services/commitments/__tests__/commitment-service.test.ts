/**
 * Commitments (spec `heartbeats` §12): what an agent promised, who may change
 * it, overdue computed on read, the due wake and the missed mark an hour
 * later, and an audit row for every change.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { auditEvents, commitments, type Db } from '@dorkos/db';
import { AuditLog } from '../../audit/audit-log.js';
import { AccountIds } from '../../audit/account-ids.js';
import { initAuditTrail, resetAuditTrail } from '../../audit/audit-trail.js';
import { runWithAuditActor } from '../../audit/audit-context.js';
import { CommitmentStore } from '../commitment-store.js';
import {
  CommitmentError,
  CommitmentService,
  type CommitmentDueEvent,
} from '../commitment-service.js';

vi.mock('../../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const START = new Date('2026-10-10T09:00:00.000Z');
const HOUR = 60 * 60 * 1000;

describe('CommitmentService', () => {
  let db: Db;
  let service: CommitmentService;

  /** Audit rows, oldest first. */
  function auditRows() {
    return db.select().from(auditEvents).all();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    db = createTestDb();
    initAuditTrail({
      log: new AuditLog(db),
      accounts: new AccountIds({ db, installId: 'inst-1', readOwnerAccount: () => null }),
    });
    service = new CommitmentService({ store: new CommitmentStore(db) });
  });

  afterEach(() => {
    service.stop();
    resetAuditTrail();
    vi.useRealTimers();
  });

  describe('create', () => {
    it('records an open promise for the agent with the source chat and an audit row', () => {
      const made = service.create('agent-a', {
        what: 'Send Acme the revised quote',
        to: 'external:Acme',
        dueAt: '2026-10-10T17:00:00+02:00',
        sourceSessionId: 'chat-1',
        sourceRoomEntryId: 'entry-9',
      });

      expect(made).toMatchObject({
        agentId: 'agent-a',
        to: 'external:Acme',
        state: 'open',
        overdue: false,
        // Normalized to UTC so dates compare and sort alike.
        dueAt: '2026-10-10T15:00:00.000Z',
        sourceSessionId: 'chat-1',
        sourceRoomEntryId: 'entry-9',
        closedAt: null,
      });
      expect(db.select().from(commitments).all()).toHaveLength(1);

      const [row] = auditRows();
      expect(row).toMatchObject({
        action: 'commitment.created',
        operation: 'create',
        targetType: 'commitment',
        targetId: made.id,
        containerId: 'agent-a',
        outcome: 'ok',
        visibility: 'space',
        summary: 'Send Acme the revised quote',
      });
    });

    it('refuses a promise longer than 300 characters at the table', () => {
      expect(() => service.create('agent-a', { what: 'x'.repeat(301) })).toThrow();
    });
  });

  describe('overdue', () => {
    it('is computed on read: false before the due time, true after, never for a closed one', () => {
      const made = service.create('agent-a', {
        what: 'Reply to Sam',
        dueAt: new Date(START.getTime() + HOUR).toISOString(),
      });
      expect(service.get(made.id)!.overdue).toBe(false);

      vi.setSystemTime(START.getTime() + HOUR + 1);
      expect(service.get(made.id)!.overdue).toBe(true);
      // Nothing about overdue is stored.
      expect(db.select().from(commitments).all()[0]).not.toHaveProperty('overdue');

      service.update({ kind: 'agent', agentId: 'agent-a' }, made.id, { state: 'kept' });
      expect(service.get(made.id)!.overdue).toBe(false);
    });

    it('is never true for a promise with no due date', () => {
      const made = service.create('agent-a', { what: 'Tidy the docs' });
      vi.setSystemTime(START.getTime() + 365 * 24 * HOUR);
      expect(service.get(made.id)!.overdue).toBe(false);
    });
  });

  describe('who may change one', () => {
    it('lets the promising agent mark it kept, with a kept audit row', () => {
      const made = service.create('agent-a', { what: 'Ship the fix' });
      const kept = service.update({ kind: 'agent', agentId: 'agent-a' }, made.id, {
        state: 'kept',
        note: 'Merged',
      });
      expect(kept).toMatchObject({ state: 'kept', note: 'Merged', closedAt: START.toISOString() });
      expect(auditRows().map((r) => r.action)).toEqual(['commitment.created', 'commitment.kept']);
    });

    it('lets a person drop it, with a dropped audit row', () => {
      const made = service.create('agent-a', { what: 'Ship the fix' });
      expect(service.update({ kind: 'person' }, made.id, { state: 'dropped' }).state).toBe(
        'dropped'
      );
      expect(auditRows().at(-1)!.action).toBe('commitment.dropped');
    });

    it("refuses another agent closing someone else's promise, and changes nothing", () => {
      const made = service.create('agent-a', { what: 'Ship the fix' });
      expect(() =>
        service.update({ kind: 'agent', agentId: 'agent-b' }, made.id, { state: 'kept' })
      ).toThrow(expect.objectContaining({ code: 'NOT_YOURS' }));
      expect(service.get(made.id)!.state).toBe('open');
      expect(auditRows()).toHaveLength(1);
    });

    it('refuses an unknown id, and a change to the state it is already in', () => {
      expect(() => service.update({ kind: 'person' }, 'nope', { state: 'kept' })).toThrow(
        expect.objectContaining({ code: 'NOT_FOUND' })
      );
      const made = service.create('agent-a', { what: 'Ship the fix' });
      service.update({ kind: 'person' }, made.id, { state: 'kept' });
      expect(() => service.update({ kind: 'person' }, made.id, { state: 'kept' })).toThrow(
        CommitmentError
      );
    });

    it("refuses another agent reopening someone else's promise", () => {
      const made = service.create('agent-a', { what: 'Ship the fix' });
      service.update({ kind: 'person' }, made.id, { state: 'dropped' });
      expect(() =>
        service.update({ kind: 'agent', agentId: 'agent-b' }, made.id, { state: 'open' })
      ).toThrow(expect.objectContaining({ code: 'NOT_YOURS' }));
      expect(service.get(made.id)!.state).toBe('dropped');
    });
  });

  describe('reopening', () => {
    it('lets the promising agent reopen a missed promise with a new date', () => {
      const made = service.create('agent-a', {
        what: 'Reply',
        dueAt: new Date(START.getTime() + HOUR).toISOString(),
      });
      vi.advanceTimersByTime(2 * HOUR);
      expect(service.get(made.id)!.state).toBe('missed');

      const newDue = new Date(START.getTime() + 10 * HOUR).toISOString();
      const reopened = service.update({ kind: 'agent', agentId: 'agent-a' }, made.id, {
        state: 'open',
        dueAt: newDue,
      });
      expect(reopened).toMatchObject({ state: 'open', dueAt: newDue, closedAt: null });
      expect(auditRows().at(-1)!.action).toBe('commitment.reopened');
    });

    it('lets a person undo a kept mark, keeping the old date, with no second wake', () => {
      const onDue = vi.fn();
      service.observe(onDue);
      const made = service.create('agent-a', {
        what: 'Reply',
        dueAt: new Date(START.getTime() + HOUR).toISOString(),
      });
      vi.advanceTimersByTime(HOUR);
      expect(onDue).toHaveBeenCalledTimes(1);
      service.update({ kind: 'person' }, made.id, { state: 'kept' });
      vi.advanceTimersByTime(5 * HOUR);

      const undone = service.update({ kind: 'person' }, made.id, { state: 'open' });
      expect(undone).toMatchObject({ state: 'open', overdue: true });
      // A fresh hour from the undo, not an instant missed mark, and no new wake.
      vi.advanceTimersByTime(HOUR - 1);
      expect(service.get(made.id)!.state).toBe('open');
      vi.advanceTimersByTime(1);
      expect(service.get(made.id)!.state).toBe('missed');
      expect(onDue).toHaveBeenCalledTimes(1);
    });
  });

  describe('round-2 rules', () => {
    it('wakes once on reopening a promise dropped before its due time passed', () => {
      const onDue = vi.fn();
      service.observe(onDue);
      const made = service.create('agent-a', {
        what: 'Reply',
        dueAt: new Date(START.getTime() + HOUR).toISOString(),
      });
      service.update({ kind: 'person' }, made.id, { state: 'dropped' });
      vi.advanceTimersByTime(2 * HOUR);
      expect(onDue).not.toHaveBeenCalled();

      service.update({ kind: 'person' }, made.id, { state: 'open' });
      expect(onDue).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(HOUR - 1);
      expect(service.get(made.id)!.state).toBe('open');
      vi.advanceTimersByTime(1);
      expect(service.get(made.id)!.state).toBe('missed');
      expect(onDue).toHaveBeenCalledTimes(1);
    });

    it('refuses a change whose `from` no longer matches, and changes nothing', () => {
      const made = service.create('agent-a', { what: 'Reply' });
      service.update({ kind: 'person' }, made.id, { state: 'kept' });
      service.update({ kind: 'person' }, made.id, { state: 'dropped' });
      // An Undo of the earlier "kept" arrives late.
      expect(() =>
        service.update({ kind: 'person' }, made.id, { state: 'open', from: 'kept' })
      ).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
      expect(service.get(made.id)!.state).toBe('dropped');
      expect(
        service.update({ kind: 'person' }, made.id, { state: 'open', from: 'dropped' }).state
      ).toBe('open');
    });

    it('saves a note on an open promise without refusing it', () => {
      const made = service.create('agent-a', { what: 'Reply' });
      const noted = service.update({ kind: 'agent', agentId: 'agent-a' }, made.id, {
        state: 'open',
        note: 'Waiting on Sam',
      });
      expect(noted).toMatchObject({ state: 'open', note: 'Waiting on Sam' });
      expect(auditRows().at(-1)!.action).toBe('commitment.noted');
    });

    it('lists closed promises most recently closed first', () => {
      const first = service.create('agent-a', { what: 'Made first' });
      const second = service.create('agent-a', { what: 'Made second' });
      vi.setSystemTime(START.getTime() + 1000);
      service.update({ kind: 'person' }, second.id, { state: 'kept' });
      vi.setSystemTime(START.getTime() + 2000);
      service.update({ kind: 'person' }, first.id, { state: 'kept' });
      expect(service.list({ state: 'kept' }).map((c) => c.what)).toEqual([
        'Made first',
        'Made second',
      ]);
      expect(service.list({}).map((c) => c.what)).toEqual(['Made first', 'Made second']);
    });
  });

  describe('past due dates', () => {
    it('refuses a past due date on create, and allows a minute of clock skew', () => {
      expect(() =>
        service.create('agent-a', {
          what: 'Reply',
          dueAt: new Date(START.getTime() - 5 * 60 * 1000).toISOString(),
        })
      ).toThrow(expect.objectContaining({ code: 'PAST_DUE' }));
      expect(service.list({})).toEqual([]);
      expect(
        service.create('agent-a', {
          what: 'Reply',
          dueAt: new Date(START.getTime() - 30 * 1000).toISOString(),
        }).state
      ).toBe('open');
    });

    it('refuses moving a promise to a past date', () => {
      const made = service.create('agent-a', { what: 'Reply' });
      expect(() =>
        service.update({ kind: 'person' }, made.id, {
          state: 'open',
          dueAt: new Date(START.getTime() - HOUR).toISOString(),
        })
      ).toThrow(expect.objectContaining({ code: 'PAST_DUE' }));
      expect(service.get(made.id)!.dueAt).toBeNull();
    });
  });

  describe('moving the date', () => {
    it('records commitment.moved with the old and new dates', () => {
      const made = service.create('agent-a', {
        what: 'Reply to Sam',
        dueAt: '2026-10-11T09:00:00.000Z',
      });
      const moved = service.update({ kind: 'agent', agentId: 'agent-a' }, made.id, {
        state: 'open',
        dueAt: '2026-10-12T09:00:00.000Z',
        note: 'Sam asked for Monday',
      });
      expect(moved.dueAt).toBe('2026-10-12T09:00:00.000Z');
      const row = auditRows().at(-1)!;
      expect(row.action).toBe('commitment.moved');
      expect(row.operation).toBe('modify');
      expect(JSON.parse(row.change!)).toEqual([
        { field: 'dueAt', before: '2026-10-11T09:00:00.000Z', after: '2026-10-12T09:00:00.000Z' },
      ]);
    });

    it('refuses a state of open with no new date', () => {
      const made = service.create('agent-a', { what: 'Reply', dueAt: '2026-10-11T09:00:00Z' });
      expect(() => service.update({ kind: 'person' }, made.id, { state: 'open' })).toThrow(
        expect.objectContaining({ code: 'NOTHING_TO_CHANGE' })
      );
    });
  });

  describe('the due timer', () => {
    it('emits commitment.due at the due time, and marks it missed an hour later', () => {
      const due: CommitmentDueEvent[] = [];
      service.observe((event) => due.push(event));
      const made = service.create('agent-a', {
        what: 'Reply to Sam',
        dueAt: new Date(START.getTime() + 2 * HOUR).toISOString(),
      });

      vi.advanceTimersByTime(2 * HOUR - 1);
      expect(due).toHaveLength(0);
      vi.advanceTimersByTime(1);
      expect(due).toHaveLength(1);
      expect(due[0]).toMatchObject({ type: 'commitment.due', commitment: { id: made.id } });
      expect(due[0]!.commitment.overdue).toBe(false);
      expect(service.get(made.id)!.state).toBe('open');

      vi.advanceTimersByTime(HOUR - 1);
      expect(service.get(made.id)!.state).toBe('open');
      vi.advanceTimersByTime(1);
      expect(service.get(made.id)!.state).toBe('missed');

      const missed = auditRows().at(-1)!;
      expect(missed).toMatchObject({ action: 'commitment.missed', actorId: 'system' });
    });

    it('names DorkOS as the actor of the missed mark even when an agent armed the timer', () => {
      const agentActor = { accountId: 'agent-a', kind: 'agent' as const, name: 'A' };
      runWithAuditActor({ actor: agentActor, surface: 'mcp' }, () =>
        service.create('agent-a', {
          what: 'Reply',
          dueAt: new Date(START.getTime() + HOUR).toISOString(),
        })
      );
      // A real timer keeps the async scope it was armed in; run the clock inside
      // the agent's scope to stand for that.
      runWithAuditActor({ actor: agentActor, surface: 'mcp' }, () =>
        vi.advanceTimersByTime(2 * HOUR)
      );
      const rows = auditRows();
      expect(rows[0]!.actorId).toBe('agent-a');
      expect(rows.at(-1)).toMatchObject({ action: 'commitment.missed', actorId: 'system' });
    });

    it('never marks a kept promise missed, and never wakes for it', () => {
      const onDue = vi.fn();
      service.observe(onDue);
      const made = service.create('agent-a', {
        what: 'Reply',
        dueAt: new Date(START.getTime() + HOUR).toISOString(),
      });
      service.update({ kind: 'agent', agentId: 'agent-a' }, made.id, { state: 'kept' });
      vi.advanceTimersByTime(3 * HOUR);
      expect(onDue).not.toHaveBeenCalled();
      expect(service.get(made.id)!.state).toBe('kept');
    });

    it('follows a moved date: no wake at the old time, a wake at the new one', () => {
      const onDue = vi.fn();
      service.observe(onDue);
      const made = service.create('agent-a', {
        what: 'Reply',
        dueAt: new Date(START.getTime() + HOUR).toISOString(),
      });
      service.update({ kind: 'person' }, made.id, {
        state: 'open',
        dueAt: new Date(START.getTime() + 5 * HOUR).toISOString(),
      });
      vi.advanceTimersByTime(3 * HOUR);
      expect(onDue).not.toHaveBeenCalled();
      expect(service.get(made.id)!.state).toBe('open');
      vi.advanceTimersByTime(2 * HOUR);
      expect(onDue).toHaveBeenCalledTimes(1);
    });

    it('stops listening when the observer unsubscribes', () => {
      const onDue = vi.fn();
      const stop = service.observe(onDue);
      service.create('agent-a', {
        what: 'Reply',
        dueAt: new Date(START.getTime() + HOUR).toISOString(),
      });
      stop();
      vi.advanceTimersByTime(HOUR);
      expect(onDue).not.toHaveBeenCalled();
    });

    it('rebuilds timers from the table at startup', () => {
      const first = service.create('agent-a', {
        what: 'Reply',
        dueAt: new Date(START.getTime() + HOUR).toISOString(),
      });
      service.stop();

      // A fresh service over the same table, as after a restart.
      const restarted = new CommitmentService({ store: new CommitmentStore(db) });
      const onDue = vi.fn();
      restarted.observe(onDue);
      restarted.start();
      vi.advanceTimersByTime(HOUR);
      expect(onDue).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(HOUR);
      expect(restarted.get(first.id)!.state).toBe('missed');
      restarted.stop();
    });

    it('at startup, treats a long-overdue promise as due now and gives it a fresh hour', () => {
      // Created with nobody listening, then the server went down before it came due.
      const made = service.create('agent-a', {
        what: 'Reply',
        dueAt: new Date(START.getTime() + HOUR).toISOString(),
      });
      service.stop();
      vi.setSystemTime(START.getTime() + 5 * HOUR);

      const restarted = new CommitmentService({ store: new CommitmentStore(db) });
      const onDue = vi.fn();
      restarted.observe(onDue);
      restarted.start();
      expect(onDue).toHaveBeenCalledTimes(1);
      expect(restarted.get(made.id)!.state).toBe('open');
      vi.advanceTimersByTime(HOUR - 1);
      expect(restarted.get(made.id)!.state).toBe('open');
      vi.advanceTimersByTime(1);
      expect(restarted.get(made.id)!.state).toBe('missed');
      restarted.stop();
    });

    it('holds wakes that fire before anyone listens, and hands them to the first observer', () => {
      service.create('agent-a', {
        what: 'Reply',
        dueAt: new Date(START.getTime() + HOUR).toISOString(),
      });
      service.stop();
      vi.setSystemTime(START.getTime() + 2 * HOUR);

      const restarted = new CommitmentService({ store: new CommitmentStore(db) });
      restarted.start();
      const first = vi.fn();
      restarted.observe(first);
      expect(first).toHaveBeenCalledTimes(1);
      expect(first.mock.calls[0]![0]).toMatchObject({ type: 'commitment.due' });
      // Delivered once: a second observer does not get the held wake again.
      const second = vi.fn();
      restarted.observe(second);
      expect(second).not.toHaveBeenCalled();
      restarted.stop();
    });

    it('never wakes twice for the same due date, across a restart', () => {
      const onDue = vi.fn();
      service.observe(onDue);
      const made = service.create('agent-a', {
        what: 'Reply',
        dueAt: new Date(START.getTime() + HOUR).toISOString(),
      });
      vi.advanceTimersByTime(HOUR);
      expect(onDue).toHaveBeenCalledTimes(1);
      service.stop();

      const restarted = new CommitmentService({ store: new CommitmentStore(db) });
      const again = vi.fn();
      restarted.observe(again);
      restarted.start();
      vi.advanceTimersByTime(30 * 60 * 1000);
      expect(again).not.toHaveBeenCalled();
      // Its hour still runs from the first wake.
      vi.advanceTimersByTime(30 * 60 * 1000);
      expect(restarted.get(made.id)!.state).toBe('missed');
      restarted.stop();
    });

    it('wakes again once the date moves', () => {
      const onDue = vi.fn();
      service.observe(onDue);
      const made = service.create('agent-a', {
        what: 'Reply',
        dueAt: new Date(START.getTime() + HOUR).toISOString(),
      });
      vi.advanceTimersByTime(HOUR);
      service.update({ kind: 'person' }, made.id, {
        state: 'open',
        dueAt: new Date(START.getTime() + 3 * HOUR).toISOString(),
      });
      vi.advanceTimersByTime(2 * HOUR);
      expect(onDue).toHaveBeenCalledTimes(2);
    });
  });

  describe('list', () => {
    it("lets anyone read every agent's list, open first and overdue marked", () => {
      service.create('agent-a', { what: 'Old', dueAt: '2026-10-10T10:00:00Z' });
      const closed = service.create('agent-b', { what: 'Done thing' });
      service.update({ kind: 'person' }, closed.id, { state: 'kept' });
      service.create('agent-b', { what: 'Later', dueAt: '2026-10-20T08:00:00Z' });
      service.create('agent-a', { what: 'No date' });
      vi.setSystemTime(START.getTime() + 2 * HOUR);

      const all = service.list();
      expect(all.map((c) => c.what)).toEqual(['Old', 'Later', 'No date', 'Done thing']);
      expect(all[0]!.overdue).toBe(true);

      expect(service.list({ agentId: 'agent-b' }).map((c) => c.what)).toEqual([
        'Later',
        'Done thing',
      ]);
      expect(service.list({ state: 'kept' }).map((c) => c.what)).toEqual(['Done thing']);
    });

    it('never drops an open promise behind 500 newer closed ones', () => {
      const old = service.create('agent-a', { what: 'Still open' });
      // 510 promises made after it, all closed.
      for (let i = 0; i < 510; i += 1) {
        vi.setSystemTime(START.getTime() + (i + 1) * 1000);
        const c = service.create('agent-a', { what: `Done ${i}` });
        service.update({ kind: 'person' }, c.id, { state: 'kept' });
      }
      const list = service.list({});
      expect(list).toHaveLength(500);
      expect(list[0]!.id).toBe(old.id);
      // The closed ones that fill the rest are the newest.
      expect(list[1]!.what).toBe('Done 509');
    });
  });
});
