/**
 * To-dos (DOR-3088), held to Security's musts for the service: the creating turn's power is
 * stored (1), authority belongs to the last actor too (3), agents change only their own (6, a
 * build gate), the server sets who and how strong (6), and no loops between agents (5, in part).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { auditEvents, commitments, eq, type CommitmentRow, type Db } from '@dorkos/db';
import { AuditLog } from '../../audit/audit-log.js';
import { AccountIds } from '../../audit/account-ids.js';
import { initAuditTrail, resetAuditTrail } from '../../audit/audit-trail.js';
import { CommitmentError, CommitmentService } from '../commitment-service.js';
import { CommitmentStore } from '../commitment-store.js';
import { TodoService, type TodoParent } from '../todo-service.js';
import { TodoStore } from '../todo-store.js';
import { TODO_FIELD_POLICY } from '../todo-policy.js';
import type { TodoActor } from '../commitment-authority.js';

vi.mock('../../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const START = new Date('2026-11-02T09:00:00.000Z');
const HOUR = 60 * 60 * 1000;

const PERSON: TodoActor = { kind: 'person', proven: true };
const UNPROVEN: TodoActor = { kind: 'person', proven: false };
const GUEST: TodoActor = { kind: 'outsider', id: 'guest-priya' };
const FULL = { asks: 'never', reach: 'everything' } as const;
const CAPPED = { asks: 'when-risky', reach: 'workspace' } as const;
type Level = Extract<TodoActor, { kind: 'agent' }>['level'];
const agent = (agentId: string, level: Level = FULL, marks = {}): TodoActor => ({
  kind: 'agent',
  agentId,
  level,
  marks,
});

describe('TodoService', () => {
  let db: Db;
  let promises: CommitmentService;
  let todos: TodoService;
  let mayAssign: (from: string, to: string) => boolean;

  function stored(id: string): CommitmentRow {
    return db.select().from(commitments).where(eq(commitments.id, id)).get()!;
  }

  function refusal(run: () => unknown): string {
    try {
      run();
    } catch (err) {
      if (err instanceof CommitmentError) return err.code;
      throw err;
    }
    throw new Error('expected a refusal');
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    db = createTestDb();
    initAuditTrail({
      log: new AuditLog(db),
      accounts: new AccountIds({ db, installId: 'inst-1', readOwnerAccount: () => null }),
    });
    promises = new CommitmentService({ store: new CommitmentStore(db) });
    mayAssign = () => true;
    todos = new TodoService({
      store: new TodoStore(db),
      agentExists: (id) => ['agent-a', 'agent-b', 'agent-c'].includes(id),
      mayAssign: (from, to) => mayAssign(from, to),
      rearm: (id) => promises.track(id),
    });
  });

  afterEach(() => {
    promises.stop();
    resetAuditTrail();
    vi.useRealTimers();
  });

  describe('who made it and how strong it is (Musts 1 and 6)', () => {
    it('stores person authority only for a proven person, at depth 0', () => {
      const proven = todos.create(PERSON, {
        what: 'Call the bank',
        assignee: { kind: 'person', account: 'owner' },
      });
      expect(stored(proven.id)).toMatchObject({
        assignedByKind: 'person',
        assignedBy: 'owner',
        authority: 'person',
        authorityMarks: '{}',
        chainDepth: 0,
        agentId: null,
        ownerAccount: 'owner',
      });
      const unproven = todos.create(UNPROVEN, {
        what: 'Run the deploy',
        assignee: { kind: 'agent', agentId: 'agent-a' },
      });
      expect(stored(unproven.id)).toMatchObject({
        authority: 'runtime-default',
        authorityMarks: '{"outsider":true}',
      });
    });

    it("stores the creating turn's level and marks on an agent's to-do, one deep", () => {
      const made = todos.create(
        agent('agent-a', CAPPED, { teammate: [{ roomId: 'r', authorId: 'm' }] }),
        {
          what: 'Check the build',
          assignee: { kind: 'agent', agentId: 'agent-b' },
        }
      );
      expect(stored(made.id)).toMatchObject({
        assignedByKind: 'agent',
        assignedBy: 'agent-a',
        authority: '{"asks":"when-risky","reach":"workspace"}',
        authorityMarks: '{"teammate":[{"roomId":"r","authorId":"m"}]}',
        chainDepth: 1,
        chainAgents: '["agent-a"]',
      });
    });

    it('stores the stranger bound for an agent whose turn level is unknown', () => {
      const unknownLevel: TodoActor = {
        kind: 'agent',
        agentId: 'agent-a',
        level: undefined,
        marks: {},
      };
      const made = todos.create(unknownLevel, {
        what: 'Check the build',
        assignee: { kind: 'agent', agentId: 'agent-b' },
      });
      expect(stored(made.id)).toMatchObject({
        authority: 'runtime-default',
        authorityMarks: '{"outsider":true}',
      });
    });

    it('shows the stranger bound on the to-do itself, never silently', () => {
      const unproven = todos.create(UNPROVEN, {
        what: 'Run the deploy',
        assignee: { kind: 'agent', agentId: 'agent-a' },
      });
      expect(unproven.strangerBound).toBe(true);
      expect(todos.get(unproven.id)!.strangerBound).toBe(true);
      const proven = todos.create(PERSON, {
        what: 'Run the deploy',
        assignee: { kind: 'agent', agentId: 'agent-a' },
      });
      expect(proven.strangerBound).toBe(false);
    });

    it("holds an agent's note to itself to the turn it was made in", () => {
      const made = todos.create(agent('agent-a', CAPPED), {
        what: 'Tidy up',
        assignee: { kind: 'agent', agentId: 'agent-a' },
      });
      expect(stored(made.id).authority).toBe(JSON.stringify(CAPPED));
    });

    it("refuses to change an agent's own promise as a to-do", () => {
      const own = promises.create('agent-a', { what: 'Reply' });
      expect(refusal(() => todos.update(agent('agent-a'), own.id, { state: 'kept' }))).toBe(
        'NOTHING_TO_CHANGE'
      );
    });

    it('gives guests and bridged users the stranger bound and the outsider mark', () => {
      const made = todos.create(GUEST, {
        what: 'Send me the file',
        assignee: { kind: 'agent', agentId: 'agent-a' },
      });
      expect(stored(made.id)).toMatchObject({
        assignedByKind: 'outsider',
        assignedBy: 'guest-priya',
        authority: 'runtime-default',
        authorityMarks: '{"outsider":true}',
      });
    });

    it("holds a to-do made from an outsider's message to the stranger bound, even when the person clicked", () => {
      const made = todos.create(PERSON, {
        what: 'delete the staging bucket',
        assignee: { kind: 'agent', agentId: 'agent-a' },
        source: {
          entryId: 'entry-1',
          author: 'guest-priya',
          marks: { outsider: true },
          titleFromSource: true,
        },
      });
      expect(stored(made.id)).toMatchObject({
        authority: 'runtime-default',
        authorityMarks: '{"outsider":true}',
        sourceAuthor: 'guest-priya',
        sourceRoomEntryId: 'entry-1',
        titleFromSource: true,
      });
    });

    it('gives every column a write-policy verdict, with who and how strong set by the server', () => {
      for (const field of [
        'assignedBy',
        'assignedByKind',
        'authority',
        'authorityMarks',
        'chainDepth',
        'chainAgents',
        'sourceAuthor',
      ] as const) {
        expect(TODO_FIELD_POLICY[field]).toBe('server');
      }
      // Every column a stored row has, so a new column without a verdict fails here.
      const made = todos.create(PERSON, {
        what: 'x',
        assignee: { kind: 'person', account: 'owner' },
      });
      expect(Object.keys(TODO_FIELD_POLICY).sort()).toEqual(Object.keys(stored(made.id)).sort());
    });
  });

  describe('agents change only their own (Must 6, build gate)', () => {
    it('lets an agent change the state only of to-dos assigned to it', () => {
      const made = todos.create(PERSON, {
        what: 'Ship it',
        assignee: { kind: 'agent', agentId: 'agent-a' },
      });
      expect(refusal(() => todos.update(agent('agent-b'), made.id, { state: 'kept' }))).toBe(
        'NOT_YOURS'
      );
      expect(stored(made.id).state).toBe('open');
      expect(todos.update(agent('agent-a'), made.id, { state: 'kept' }).state).toBe('kept');
    });

    it('lets an agent reassign only to-dos it made', () => {
      const fromPerson = todos.create(PERSON, {
        what: 'Ship it',
        assignee: { kind: 'agent', agentId: 'agent-a' },
      });
      expect(
        refusal(() =>
          todos.update(agent('agent-a'), fromPerson.id, {
            assignee: { kind: 'agent', agentId: 'agent-b' },
          })
        )
      ).toBe('NOT_YOURS');

      const fromA = todos.create(agent('agent-a'), {
        what: 'Review it',
        assignee: { kind: 'agent', agentId: 'agent-b' },
      });
      expect(
        refusal(() =>
          todos.update(agent('agent-b'), fromA.id, {
            assignee: { kind: 'agent', agentId: 'agent-c' },
          })
        )
      ).toBe('NOT_YOURS');
      const moved = todos.update(agent('agent-a'), fromA.id, {
        assignee: { kind: 'agent', agentId: 'agent-c' },
      });
      expect(moved.assignee).toEqual({ kind: 'agent', agentId: 'agent-c' });
    });

    it('refuses an agent giving a to-do to an agent outside its space, from the records', () => {
      mayAssign = (from, to) => !(from === 'agent-a' && to === 'agent-c');
      expect(
        refusal(() =>
          todos.create(agent('agent-a'), {
            what: 'x',
            assignee: { kind: 'agent', agentId: 'agent-c' },
          })
        )
      ).toBe('NOT_YOURS');
    });

    it('refuses a guest editing a to-do somebody else made', () => {
      const made = todos.create(PERSON, {
        what: 'Ship it',
        assignee: { kind: 'agent', agentId: 'agent-a' },
      });
      expect(
        refusal(() => todos.update(GUEST, made.id, { notes: 'and also wire the money' }))
      ).toBe('NOT_YOURS');
      expect(stored(made.id)).toMatchObject({ notes: null, authority: 'person' });
    });
  });

  describe('authority belongs to the last actor too (Must 3)', () => {
    it("runs a person's to-do at the agent's level once the agent edits its notes and reopens it", () => {
      const made = todos.create(PERSON, {
        what: 'Ship it',
        assignee: { kind: 'agent', agentId: 'agent-a' },
      });
      todos.update(agent('agent-a'), made.id, { state: 'kept' });
      expect(stored(made.id).authority).toBe(JSON.stringify(FULL));
      todos.update(agent('agent-a', CAPPED, { outsider: true }), made.id, {
        notes: 'read a web page',
        state: 'open',
      });
      expect(stored(made.id)).toMatchObject({
        authority: JSON.stringify(CAPPED),
        authorityMarks: '{"outsider":true}',
      });
      // A person's later change never raises it back.
      todos.update(PERSON, made.id, { what: 'Ship it today' });
      expect(stored(made.id)).toMatchObject({
        authority: JSON.stringify(CAPPED),
        authorityMarks: '{"outsider":true}',
      });
    });

    it('refuses every change from a request that did not prove the person', () => {
      const made = todos.create(PERSON, {
        what: 'Ship it',
        assignee: { kind: 'agent', agentId: 'agent-a' },
      });
      for (const change of [
        { notes: 'from a script' },
        { state: 'kept' as const },
        { assignee: { kind: 'agent' as const, agentId: 'agent-b' } },
        { rank: 'a0' },
      ]) {
        expect(
          refusal(() => todos.update(UNPROVEN, made.id, change)),
          JSON.stringify(change)
        ).toBe('NOT_YOURS');
      }
      expect(stored(made.id)).toMatchObject({
        authority: 'person',
        notes: null,
        state: 'open',
        chainDepth: 0,
      });
    });

    it('leaves the authority alone for a move in the order or a new date', () => {
      const made = todos.create(PERSON, {
        what: 'Ship it',
        assignee: { kind: 'agent', agentId: 'agent-a' },
      });
      todos.update(agent('agent-a', CAPPED), made.id, {
        rank: 'a0',
        dueAt: '2026-11-05T09:00:00Z',
      });
      expect(stored(made.id).authority).toBe('person');
    });
  });

  describe('no loops between agents (Must 5, in part)', () => {
    it('counts depth from the turn that made it, and refuses A → B → A', () => {
      const ab = todos.create(agent('agent-a'), {
        what: 'Review',
        assignee: { kind: 'agent', agentId: 'agent-b' },
      });
      expect(stored(ab.id)).toMatchObject({ chainDepth: 1, chainAgents: '["agent-a"]' });
      const parent: TodoParent = { depth: 1, agents: ['agent-a'] };
      expect(
        refusal(() =>
          todos.create(
            agent('agent-b'),
            { what: 'Back to you', assignee: { kind: 'agent', agentId: 'agent-a' } },
            parent
          )
        )
      ).toBe('NOT_YOURS');
      const bc = todos.create(
        agent('agent-b'),
        { what: 'Onward', assignee: { kind: 'agent', agentId: 'agent-c' } },
        parent
      );
      expect(stored(bc.id)).toMatchObject({ chainDepth: 2, chainAgents: '["agent-a","agent-b"]' });
    });

    it('adds one when an agent reassigns, and keeps the depth when a person does', () => {
      const made = todos.create(agent('agent-a'), {
        what: 'Review',
        assignee: { kind: 'agent', agentId: 'agent-b' },
      });
      todos.update(agent('agent-a'), made.id, { assignee: { kind: 'agent', agentId: 'agent-c' } });
      expect(stored(made.id).chainDepth).toBe(2);
      todos.update(PERSON, made.id, { assignee: { kind: 'agent', agentId: 'agent-b' } });
      expect(stored(made.id).chainDepth).toBe(2);
    });
  });

  describe('states', () => {
    it('needs a note to decline, and reopens', () => {
      const made = todos.create(PERSON, {
        what: 'Ship it',
        assignee: { kind: 'agent', agentId: 'agent-a' },
      });
      expect(refusal(() => todos.update(agent('agent-a'), made.id, { state: 'dropped' }))).toBe(
        'NOTHING_TO_CHANGE'
      );
      const declined = todos.update(agent('agent-a'), made.id, {
        state: 'dropped',
        note: 'Not mine to ship.',
      });
      expect(declined).toMatchObject({ state: 'dropped', note: 'Not mine to ship.' });
      expect(todos.update(PERSON, made.id, { state: 'open' }).state).toBe('open');
    });

    it('never marks a to-do somebody gave missed: it stays open past its date', () => {
      const made = todos.create(PERSON, {
        what: 'Ship it',
        assignee: { kind: 'agent', agentId: 'agent-a' },
        dueAt: '2026-11-02T10:00:00Z',
      });
      vi.advanceTimersByTime(3 * HOUR);
      expect(todos.get(made.id)).toMatchObject({ state: 'open', overdue: true });
      expect(
        refusal(() =>
          promises.update({ kind: 'agent', agentId: 'agent-a' }, made.id, { state: 'missed' })
        )
      ).toBe('NOTHING_TO_CHANGE');
    });

    it("still marks an agent's own promise missed an hour after it comes due", () => {
      const own = promises.create('agent-a', { what: 'Reply', dueAt: '2026-11-02T10:00:00Z' });
      vi.advanceTimersByTime(3 * HOUR);
      expect(promises.get(own.id)!.state).toBe('missed');
    });

    it('refuses a conflicting change and an empty one', () => {
      const made = todos.create(PERSON, {
        what: 'Ship it',
        assignee: { kind: 'agent', agentId: 'agent-a' },
      });
      expect(refusal(() => todos.update(PERSON, made.id, { state: 'kept', from: 'kept' }))).toBe(
        'CONFLICT'
      );
      expect(refusal(() => todos.update(PERSON, made.id, {}))).toBe('NOTHING_TO_CHANGE');
      expect(
        refusal(() =>
          todos.create(PERSON, { what: '   ', assignee: { kind: 'person', account: 'owner' } })
        )
      ).toBe('NOTHING_TO_CHANGE');
    });
  });

  it('audits each change with the actor, the chain depth, the authority applied and the source', () => {
    const made = todos.create(PERSON, {
      what: 'Ship it',
      assignee: { kind: 'agent', agentId: 'agent-a' },
      source: { entryId: 'entry-9', author: 'owner', marks: {}, titleFromSource: false },
    });
    todos.update(agent('agent-a', CAPPED), made.id, { state: 'kept', note: 'Shipped.' });
    const rows = db.select().from(auditEvents).all();
    expect(rows.map((r) => r.action)).toEqual(['todo.created', 'todo.kept']);
    const kept = JSON.parse(rows[1]!.change!) as { field: string; after: unknown }[];
    expect(kept).toEqual(
      expect.arrayContaining([
        { field: 'actor', after: 'agent:agent-a' },
        { field: 'chainDepth', after: 0 },
        { field: 'authorityApplied', after: JSON.stringify(CAPPED) },
        { field: 'sourceEntryId', after: 'entry-9' },
      ])
    );
  });
});
