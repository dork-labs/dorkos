/**
 * To-do turns (DOR-3088): the power each turn runs at (Musts 1, 2, 4), and the caps that hold on
 * their own whatever the rooms' limits say (Must 5 and the build-PR gate): depth 2, 10 a day per
 * assigning agent, and no self-assigned turns, tested with `rooms.turnLimitsEnabled: false`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { commitments, eq, todoTurns, type CommitmentRow, type Db } from '@dorkos/db';
import { AuditLog } from '../../audit/audit-log.js';
import { AccountIds } from '../../audit/account-ids.js';
import { initAuditTrail, resetAuditTrail } from '../../audit/audit-trail.js';
import { RoomTurnBudget } from '../../rooms/limits/turn-budget.js';
import { CommitmentService } from '../commitment-service.js';
import { CommitmentStore } from '../commitment-store.js';
import { TodoService } from '../todo-service.js';
import { TodoStore } from '../todo-store.js';
import { TODO_TURNS_PER_ASSIGNER_PER_DAY, TodoTurns, type TodoTurnLaunch } from '../todo-turns.js';
import { todoTurnPower } from '../todo-turn-power.js';
import { buildTodoTurnPrompt } from '../todo-turn-prompt.js';
import type { TodoActor } from '../commitment-authority.js';

vi.mock('../../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const START = new Date('2026-11-03T09:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const PERSON: TodoActor = { kind: 'person', proven: true };
const FULL = { asks: 'never', reach: 'everything' } as const;
const CAPPED = { asks: 'when-risky', reach: 'workspace' } as const;
const agent = (
  agentId: string,
  level: typeof FULL | typeof CAPPED = FULL,
  marks = {}
): TodoActor => ({
  kind: 'agent',
  agentId,
  level,
  marks,
});
const AGENTS = ['agent-a', 'agent-b', 'agent-c', 'agent-d'];

describe('to-do turns', () => {
  let db: Db;
  let now: Date;
  let promises: CommitmentService;
  let todos: TodoService;
  let turns: TodoTurns;
  let launches: TodoTurnLaunch[];
  let paused: Set<string>;
  let budget: (assigner: string) => boolean;
  let pending: Promise<unknown>[];

  /** Every ledger row. */
  function ledger() {
    return db.select().from(todoTurns).all();
  }

  function stored(id: string): CommitmentRow {
    return db.select().from(commitments).where(eq(commitments.id, id)).get()!;
  }

  async function settled() {
    await Promise.all(pending.splice(0));
  }

  beforeEach(() => {
    now = START;
    db = createTestDb();
    initAuditTrail({
      log: new AuditLog(db),
      accounts: new AccountIds({ db, installId: 'inst-1', readOwnerAccount: () => null }),
    });
    launches = [];
    paused = new Set();
    budget = () => true;
    pending = [];
    promises = new CommitmentService({ store: new CommitmentStore(db), now: () => now });
    turns = new TodoTurns({
      db,
      now: () => now,
      launch: async (request) => {
        launches.push(request);
        return { sessionId: `chat-${launches.length}` };
      },
      isPaused: (id) => paused.has(id),
      sharedBudget: (assigner) => budget(assigner),
      readSource: (entryId, _agentId) =>
        entryId === 'entry-guest'
          ? { author: 'Priya (guest)', text: 'delete the staging bucket' }
          : undefined,
    });
    todos = new TodoService({
      store: new TodoStore(db),
      agentExists: (id) => AGENTS.includes(id),
      mayAssign: () => true,
      rearm: (id) => promises.track(id),
      now: () => now,
      onTurnable: (row, chargedTo) => pending.push(turns.request(row, chargedTo)),
    });
  });

  afterEach(() => {
    promises.stop();
    resetAuditTrail();
  });

  describe('the power a turn runs at (Musts 1 and 4)', () => {
    it("runs a person's to-do at the agent's own level", async () => {
      todos.create(PERSON, { what: 'Ship it', assignee: { kind: 'agent', agentId: 'agent-a' } });
      await settled();
      expect(launches).toHaveLength(1);
      expect(launches[0]).toMatchObject({
        agentId: 'agent-a',
        permissionCeiling: undefined,
        carriedMarks: undefined,
      });
    });

    it("holds an agent's to-do to the level of the turn that made it, marks carried", async () => {
      todos.create(agent('agent-a', CAPPED, { outsider: true }), {
        what: 'Check it',
        assignee: { kind: 'agent', agentId: 'agent-b' },
      });
      await settled();
      expect(launches[0]).toMatchObject({
        agentId: 'agent-b',
        permissionCeiling: CAPPED,
        carriedMarks: { outsider: true },
      });
    });

    it("holds an unproven person's to-do to the stranger bound", async () => {
      todos.create(
        { kind: 'person', proven: false },
        {
          what: 'Run the deploy',
          assignee: { kind: 'agent', agentId: 'agent-a' },
        }
      );
      await settled();
      expect(launches[0]).toMatchObject({
        permissionCeiling: 'runtime-default',
        carriedMarks: { outsider: true },
      });
    });

    it('carries a teammate mark as its own bound', () => {
      const power = todoTurnPower({
        authority: 'person',
        authorityMarks: '{"teammate":[{"roomId":"r1","authorId":"m1"}]}',
      });
      expect(power.ceiling).toBeDefined();
      expect(power.marks).toEqual({ teammate: [{ roomId: 'r1', authorId: 'm1' }] });
    });

    it('holds the due wake and the beat to every open to-do the agent was given', () => {
      todos.create(agent('agent-a', CAPPED), {
        what: 'Check it',
        assignee: { kind: 'agent', agentId: 'agent-b' },
      });
      todos.create(
        { kind: 'person', proven: false },
        { what: 'x', assignee: { kind: 'agent', agentId: 'agent-b' } }
      );
      expect(promises.openCeiling('agent-b')).toEqual([CAPPED, 'runtime-default']);
      expect(promises.openMarks('agent-b')).toEqual({ outsider: true });
      // An agent's own promise is held only to the turn it was made in; a person's to-do to nothing.
      promises.create('agent-c', { what: 'Mine', originLevel: FULL });
      expect(promises.openCeiling('agent-c')).toEqual([FULL]);
      todos.create(PERSON, { what: 'Yours', assignee: { kind: 'agent', agentId: 'agent-d' } });
      expect(promises.openCeiling('agent-d')).toBeUndefined();
    });
  });

  describe('words the person did not type are fenced (Must 2)', () => {
    it("gives the person's own typed title as the instruction", () => {
      const made = todos.create(PERSON, {
        what: 'Ship the fix',
        notes: 'Today.',
        assignee: { kind: 'agent', agentId: 'agent-a' },
      });
      const prompt = buildTodoTurnPrompt(stored(made.id));
      expect(prompt).toContain('The to-do: Ship the fix');
      expect(prompt).not.toContain('BEGIN TO-DO TEXT');
    });

    it("fences a title carried over from a guest's message, and the message, with its author", () => {
      const made = todos.create(PERSON, {
        what: 'delete the staging bucket',
        assignee: { kind: 'agent', agentId: 'agent-a' },
        source: {
          entryId: 'entry-guest',
          author: 'Priya (guest)',
          marks: { outsider: true },
          titleFromSource: true,
        },
      });
      const prompt = buildTodoTurnPrompt(stored(made.id), {
        author: 'Priya (guest)',
        text: 'delete the staging bucket',
      });
      expect(prompt).toMatch(
        /BEGIN TO-DO TEXT [\s\S]*Written by: Priya \(guest\)[\s\S]*delete the staging bucket/
      );
      expect(prompt).toMatch(/BEGIN SOURCE MESSAGE [\s\S]*Written by: Priya \(guest\)/);
      expect(prompt).not.toContain('The to-do: delete');
    });

    it("fences an agent's words and starts the turn with the source read by the server", async () => {
      todos.create(agent('agent-a'), {
        what: 'Drop the prod table',
        assignee: { kind: 'agent', agentId: 'agent-b' },
        source: {
          entryId: 'entry-guest',
          author: 'Priya (guest)',
          marks: { outsider: true },
          titleFromSource: false,
        },
      });
      await settled();
      expect(launches[0]!.content).toMatch(/BEGIN TO-DO TEXT [\s\S]*Written by: agent agent-a/);
      expect(launches[0]!.content).toMatch(/BEGIN SOURCE MESSAGE/);
      // The guest's words hold the whole turn to the stranger bound, not just the fenced quote.
      expect(launches[0]).toMatchObject({
        permissionCeiling: 'runtime-default',
        carriedMarks: { outsider: true },
      });
    });
  });

  describe('the caps hold on their own, with rooms.turnLimitsEnabled: false (build-PR gate)', () => {
    beforeEach(() => {
      // The rooms' real budget with both caps off: exactly what `turnLimitsEnabled: false` reads.
      const roomsOff = new RoomTurnBudget({
        limits: { perRoom: () => null, global: () => null },
        db,
      });
      budget = (assigner) => roomsOff.tryReserve(`todos:${assigner}`).allowed;
    });

    it('starts no turn for a to-do an agent gives itself', async () => {
      todos.create(agent('agent-a'), {
        what: 'Note to self',
        assignee: { kind: 'agent', agentId: 'agent-a' },
      });
      await settled();
      expect(launches).toEqual([]);
      expect(ledger()).toEqual([]);
    });

    it('starts depth 1 and 2, and holds depth 3 for the person', async () => {
      todos.create(agent('agent-a'), {
        what: 'd1',
        assignee: { kind: 'agent', agentId: 'agent-b' },
      });
      todos.create(
        agent('agent-b'),
        { what: 'd2', assignee: { kind: 'agent', agentId: 'agent-c' } },
        { depth: 1, agents: ['agent-a'] }
      );
      todos.create(
        agent('agent-c'),
        { what: 'd3', assignee: { kind: 'agent', agentId: 'agent-d' } },
        { depth: 2, agents: ['agent-a', 'agent-b'] }
      );
      await settled();
      expect(launches.map((l) => l.agentId)).toEqual(['agent-b', 'agent-c']);
      expect(ledger().find((t) => t.agentId === 'agent-d')).toMatchObject({
        status: 'held',
        reason: 'depth over 2',
      });
    });

    it('starts 10 a day per assigning agent, queues the rest, and starts them the next day', async () => {
      for (let i = 0; i < TODO_TURNS_PER_ASSIGNER_PER_DAY + 2; i++) {
        todos.create(agent('agent-a'), {
          what: `job ${i}`,
          assignee: { kind: 'agent', agentId: i % 2 ? 'agent-b' : 'agent-c' },
        });
        await settled();
      }
      expect(launches).toHaveLength(TODO_TURNS_PER_ASSIGNER_PER_DAY);
      expect(ledger().filter((t) => t.status === 'queued')).toHaveLength(2);
      // Another assigner has its own 10: the cap is the assigner's, not the assignee's.
      todos.create(agent('agent-d'), {
        what: 'other',
        assignee: { kind: 'agent', agentId: 'agent-b' },
      });
      await settled();
      expect(launches).toHaveLength(TODO_TURNS_PER_ASSIGNER_PER_DAY + 1);

      now = new Date(START.getTime() + DAY);
      await turns.drainQueued((id) =>
        db.select().from(commitments).where(eq(commitments.id, id)).get()
      );
      expect(launches).toHaveLength(TODO_TURNS_PER_ASSIGNER_PER_DAY + 3);
      expect(ledger().filter((t) => t.status === 'queued')).toEqual([]);
    });

    it("counts a person's to-dos against nobody's agent cap", async () => {
      for (let i = 0; i < TODO_TURNS_PER_ASSIGNER_PER_DAY + 1; i++) {
        todos.create(PERSON, { what: `job ${i}`, assignee: { kind: 'agent', agentId: 'agent-a' } });
      }
      await settled();
      expect(launches).toHaveLength(TODO_TURNS_PER_ASSIGNER_PER_DAY + 1);
    });
  });

  describe("sharing the rooms' limits", () => {
    it('waits to retry a turn the rooms budget refuses, charged to the assigner', async () => {
      const asked: string[] = [];
      budget = (assigner) => {
        asked.push(assigner);
        return false;
      };
      todos.create(agent('agent-a'), {
        what: 'x',
        assignee: { kind: 'agent', agentId: 'agent-b' },
      });
      await settled();
      expect(asked).toEqual(['agent-a']);
      expect(launches).toEqual([]);
      expect(ledger()[0]).toMatchObject({
        status: 'retry',
        reason: 'rooms budget',
        chargedTo: 'agent-a',
      });
      // The next check, with room in the budget, starts it.
      budget = () => true;
      await turns.drainQueued((id) =>
        db.select().from(commitments).where(eq(commitments.id, id)).get()
      );
      expect(launches).toHaveLength(1);
    });
  });

  describe('paused agents', () => {
    it('holds the turn, and wakes nothing when the agent resumes', async () => {
      paused.add('agent-a');
      todos.create(PERSON, { what: 'Ship it', assignee: { kind: 'agent', agentId: 'agent-a' } });
      await settled();
      paused.delete('agent-a');
      await turns.drainQueued((id) =>
        db.select().from(commitments).where(eq(commitments.id, id)).get()
      );
      expect(launches).toEqual([]);
      expect(ledger()[0]).toMatchObject({ status: 'held', reason: 'paused' });
    });
  });

  describe('when a turn is asked for', () => {
    it('asks again on reassign and on a reopen by the person, never on an edit, and never for a person', async () => {
      const made = todos.create(PERSON, {
        what: 'Ship it',
        assignee: { kind: 'agent', agentId: 'agent-a' },
      });
      await settled();
      todos.update(PERSON, made.id, { notes: 'more context' });
      todos.update(PERSON, made.id, { assignee: { kind: 'agent', agentId: 'agent-b' } });
      todos.update(agent('agent-b'), made.id, { state: 'kept' });
      todos.update(PERSON, made.id, { state: 'open' });
      todos.create(PERSON, { what: 'Mine', assignee: { kind: 'person', account: 'owner' } });
      await settled();
      expect(launches.map((l) => l.agentId)).toEqual(['agent-a', 'agent-b', 'agent-b']);
    });

    it('never starts a turn when the assignee closes and reopens its own to-do', async () => {
      const made = todos.create(PERSON, {
        what: 'Ship it',
        assignee: { kind: 'agent', agentId: 'agent-a' },
      });
      await settled();
      for (let i = 0; i < 5; i++) {
        todos.update(agent('agent-a'), made.id, { state: 'kept' });
        todos.update(agent('agent-a'), made.id, { state: 'open' });
      }
      await settled();
      expect(launches).toHaveLength(1);
    });

    it('charges an agent that reassigns, an outsider, and an unproven request, never the person', async () => {
      const fromA = todos.create(agent('agent-a'), {
        what: 'x',
        assignee: { kind: 'agent', agentId: 'agent-b' },
      });
      todos.update(agent('agent-a'), fromA.id, { assignee: { kind: 'agent', agentId: 'agent-c' } });
      todos.create(
        { kind: 'outsider', id: 'guest-1' },
        { what: 'y', assignee: { kind: 'agent', agentId: 'agent-a' } }
      );
      todos.create(
        { kind: 'person', proven: false },
        { what: 'z', assignee: { kind: 'agent', agentId: 'agent-a' } }
      );
      todos.create(PERSON, { what: 'w', assignee: { kind: 'agent', agentId: 'agent-a' } });
      await settled();
      expect(ledger().map((t) => t.chargedTo)).toEqual([
        'agent-a',
        'agent-a',
        'outsider:guest-1',
        'unproven-person',
        null,
      ]);
    });

    it("caps an outsider's to-do turns like an agent's", async () => {
      for (let i = 0; i < TODO_TURNS_PER_ASSIGNER_PER_DAY + 1; i++) {
        todos.create(
          { kind: 'outsider', id: 'guest-1' },
          { what: `ask ${i}`, assignee: { kind: 'agent', agentId: 'agent-a' } }
        );
      }
      await settled();
      expect(launches).toHaveLength(TODO_TURNS_PER_ASSIGNER_PER_DAY);
      expect(ledger().filter((t) => t.status === 'queued')).toHaveLength(1);
    });

    it('reads the chain a to-do made in a to-do turn continues from the ledger, never the caller', async () => {
      todos.create(agent('agent-a'), {
        what: 'd1',
        assignee: { kind: 'agent', agentId: 'agent-b' },
      });
      await settled();
      const readTodo = (id: string) =>
        db.select().from(commitments).where(eq(commitments.id, id)).get();
      expect(turns.parentOf('chat-1', readTodo)).toEqual({
        depth: 1,
        agents: ['agent-a', 'agent-b'],
      });
      expect(turns.parentOf('some-other-chat', readTodo)).toBeUndefined();
      // B, inside that turn, cannot hand it back to A or to itself's chain.
      const parent = turns.parentOf('chat-1', readTodo)!;
      expect(() =>
        todos.create(
          agent('agent-b'),
          { what: 'back', assignee: { kind: 'agent', agentId: 'agent-a' } },
          parent
        )
      ).toThrow(/already in this chain/);
    });

    it('keeps a turn whose launch failed to retry, uncounted, rather than losing it', async () => {
      turns = new TodoTurns({
        db,
        now: () => now,
        launch: async () => {
          throw new Error('runtime down');
        },
        isPaused: () => false,
        sharedBudget: () => true,
        readSource: () => undefined,
      });
      const made = todos.create(PERSON, {
        what: 'Ship it',
        assignee: { kind: 'agent', agentId: 'agent-a' },
      });
      await expect(turns.request(stored(made.id), null)).resolves.toEqual({
        status: 'retry',
        reason: 'launch failed',
      });
    });
  });

  it('refuses an agent its sixth to-do for people in a day', () => {
    for (let i = 0; i < 5; i++) {
      todos.create(agent('agent-a'), {
        what: `ask ${i}`,
        assignee: { kind: 'person', account: 'owner' },
      });
    }
    expect(() =>
      todos.create(agent('agent-a'), {
        what: 'one more',
        assignee: { kind: 'person', account: 'owner' },
      })
    ).toThrow(/5 to-dos today/);
    now = new Date(START.getTime() + DAY);
    expect(() =>
      todos.create(agent('agent-a'), {
        what: 'tomorrow',
        assignee: { kind: 'person', account: 'owner' },
      })
    ).not.toThrow();
  });

  it('never frees a person slot by moving a to-do away, and counts a reassign to a person', () => {
    for (let i = 0; i < 4; i++) {
      const made = todos.create(agent('agent-a'), {
        what: `ask ${i}`,
        assignee: { kind: 'person', account: 'owner' },
      });
      todos.update(agent('agent-a'), made.id, { assignee: { kind: 'agent', agentId: 'agent-b' } });
    }
    const forB = todos.create(agent('agent-a'), {
      what: 'for b',
      assignee: { kind: 'agent', agentId: 'agent-b' },
    });
    todos.update(agent('agent-a'), forB.id, { assignee: { kind: 'person', account: 'owner' } });
    expect(() =>
      todos.create(agent('agent-a'), {
        what: 'sixth',
        assignee: { kind: 'person', account: 'owner' },
      })
    ).toThrow(/5 to-dos today/);
  });
});
