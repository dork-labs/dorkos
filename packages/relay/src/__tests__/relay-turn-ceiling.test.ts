/**
 * DOR-791: the publish pipeline caps how many agent turns the bus may start per
 * hour, at the adapter dispatch — the one choke point every surface that can
 * make an agent answer crosses.
 *
 * These drive the MECHANISM through a real `RelayCore` with a stub adapter
 * registry standing in for the runtime, because "no turn ran" is only provable
 * where the turn would have run.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { RelayCore } from '../relay-core.js';
import { dispatchTurnAccounting, RelayTurnCeiling } from '../turn-ceiling.js';
import { TASK_SCHEDULER_PRINCIPAL, type RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type {
  AdapterRegistryLike,
  AdapterContext,
  DeliveryResult,
  RelayAdapter,
  RelayPublisher,
  RelayLogger,
} from '../types.js';

const AGENT_SUBJECT = 'relay.agent.demo.agent-1';
const TASKS_SUBJECT = 'relay.system.tasks.nightly-report';
/** Only the scheduler may send to a task subject (DOR-2432). */
const SCHEDULER = TASK_SCHEDULER_PRINCIPAL;
const TURN_PREFIXES = ['relay.agent.', 'relay.system.tasks.'];

/**
 * A registry that answers for every `relay.agent.*` subject and records the
 * envelopes it was asked to deliver. Each delivery here stands for one real,
 * paid agent turn.
 */
class RecordingRegistry implements AdapterRegistryLike {
  readonly delivered: RelayEnvelope[] = [];
  /** When set, every delivery fails with this reason instead of running. */
  refuse: string | undefined;
  /**
   * A prefix this registry answers for with an adapter that declares it runs no
   * turns — the case `startsAgentTurns` exists to make expressible.
   */
  freeSubjectPrefix: string | undefined;

  setRelay(_relay: RelayPublisher): void {}

  async deliver(
    _subject: string,
    envelope: RelayEnvelope,
    _context?: AdapterContext
  ): Promise<DeliveryResult | null> {
    if (this.refuse) {
      return { success: false, error: this.refuse, code: 'at_capacity', durationMs: 0 };
    }
    this.delivered.push(envelope);
    return { success: true, durationMs: 0 };
  }

  /**
   * Stands in for the Claude Code adapter, which answers for BOTH the agent
   * prefixes and `relay.system.tasks.*` and runs a paid turn on either — plus,
   * when {@link freeSubjectPrefix} is set, an adapter that answers for an
   * agent-SHAPED subject while declaring it runs no turns.
   *
   * @param subject - The subject being routed.
   */
  getBySubject(subject: string): RelayAdapter | undefined {
    if (this.freeSubjectPrefix && subject.startsWith(this.freeSubjectPrefix)) {
      return { startsAgentTurns: () => false } as unknown as RelayAdapter;
    }
    return TURN_PREFIXES.some((p) => subject.startsWith(p))
      ? ({ startsAgentTurns: () => true } as unknown as RelayAdapter)
      : undefined;
  }

  async shutdown(): Promise<void> {}
}

let tmpDir: string;
let relay: RelayCore;
let registry: RecordingRegistry;

async function makeRelay(
  turnCeiling?: { perAgent: () => number | null; global: () => number | null },
  logger?: RelayLogger
): Promise<RelayCore> {
  registry = new RecordingRegistry();
  return new RelayCore({
    dataDir: tmpDir,
    adapterRegistry: registry,
    ...(turnCeiling ? { turnCeiling } : {}),
    ...(logger ? { logger } : {}),
  });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-turn-ceiling-test-'));
});

afterEach(async () => {
  await relay?.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('the turn ceiling at the adapter dispatch (DOR-791)', () => {
  it('refuses the dispatch once the per-agent ceiling is spent, whoever is publishing', async () => {
    relay = await makeRelay({ perAgent: () => 2, global: () => null });

    for (let i = 0; i < 2; i++) {
      const ok = await relay.publish(AGENT_SUBJECT, { text: `hop ${i}` }, { from: 'relay.test.a' });
      expect(ok.rejected).toBeUndefined();
    }

    // The third arrives from a DIFFERENT principal, which is the whole point:
    // the ceiling counts the dispatch, not the caller.
    const refused = await relay.publish(
      AGENT_SUBJECT,
      { text: 'third' },
      { from: 'relay.test.somebody-else' }
    );

    expect(registry.delivered).toHaveLength(2);
    expect(refused.rejected?.[0]?.reason).toBe('turn_ceiling');
    expect(refused.deliveredTo).toBe(0);
  });

  it('reports the GLOBAL ceiling when that is the one that refused, even for an unspent agent', async () => {
    relay = await makeRelay({ perAgent: () => 100, global: () => 1 });

    await relay.publish(AGENT_SUBJECT, { text: 'first' }, { from: 'relay.test.a' });
    const refused = await relay.publish(
      'relay.agent.demo.agent-2',
      { text: 'a different agent entirely' },
      { from: 'relay.test.a' }
    );

    expect(registry.delivered).toHaveLength(1);
    expect(refused.rejected?.[0]?.reason).toBe('turn_ceiling');
  });

  it('makes the refusal visible: a warning log, a dead letter naming the ceiling, and a settled waiter', async () => {
    const warn = vi.fn();
    const logger: RelayLogger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
    relay = await makeRelay({ perAgent: () => 0, global: () => null }, logger);

    const replyInbox = 'relay.inbox.query.waiting-caller';
    const replies: RelayEnvelope[] = [];
    await relay.registerEndpoint(replyInbox);
    relay.subscribe(replyInbox, (env) => {
      replies.push(env);
    });

    await relay.publish(
      AGENT_SUBJECT,
      { text: 'nobody is going to answer this' },
      { from: 'relay.test.a', replyTo: replyInbox }
    );

    // 1. The log says what happened and why.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('turn ceiling'));

    // 2. A dead letter under the target subject — which is what fires the host's
    //    `onDeadLetter` notice, so the refusal reaches a person.
    const deadLetters = await relay.getDeadLetters();
    const letter = deadLetters.find((d) => d.envelope?.subject === AGENT_SUBJECT);
    expect(letter).toBeDefined();
    expect(letter?.reason).toContain('hourly limit');
    // The reason names the setting to change, not the internals.
    expect(letter?.reason).toContain('relay.maxAgentTurnsPerAgentPerHour');

    // 3. The caller blocked on a reply inbox is settled now, not at its timeout —
    //    once, with a notice that names the setting to change.
    //    The notifier's terminal pair, exactly: one error naming the ceiling and
    //    the setting to change, then the `done` that ends the caller's wait.
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    expect(replies.map((r) => (r.payload as { type: string }).type)).toEqual(['error', 'done']);
    expect(JSON.stringify(replies[0]!.payload)).toContain('relay.maxAgentTurnsPerAgentPerHour');
  });

  it('does not spend the ceiling on a non-agent subject, or on an agent subject with no adapter behind it', async () => {
    relay = await makeRelay({ perAgent: () => 1, global: () => 1 });

    // A subject the registry does not answer for: no dispatch, so no charge.
    await relay.publish(
      'relay.human.telegram.tg1.chat-1',
      { text: 'outbound' },
      {
        from: 'relay.test.a',
      }
    );

    // The one agent turn is still affordable afterwards.
    const ok = await relay.publish(
      AGENT_SUBJECT,
      { text: 'still allowed' },
      {
        from: 'relay.test.a',
      }
    );
    expect(ok.rejected).toBeUndefined();
    expect(registry.delivered).toHaveLength(1);
  });

  it('counts nothing when both ceilings are unlimited', async () => {
    relay = await makeRelay({ perAgent: () => null, global: () => null });

    for (let i = 0; i < 25; i++) {
      await relay.publish(AGENT_SUBJECT, { text: `hop ${i}` }, { from: 'relay.test.a' });
    }
    expect(registry.delivered).toHaveLength(25);
  });

  it('decrements the envelope budget on the copy that starts the turn', async () => {
    relay = await makeRelay({ perAgent: () => null, global: () => null });

    await relay.publish(
      AGENT_SUBJECT,
      { text: 'one hop' },
      { from: 'relay.test.a', budget: { hopCount: 0, callBudgetRemaining: 10 } }
    );

    const dispatched = registry.delivered[0]!;
    expect(dispatched.budget.hopCount).toBe(1);
    expect(dispatched.budget.callBudgetRemaining).toBe(9);
    expect(dispatched.budget.ancestorChain).toEqual([AGENT_SUBJECT]);
  });

  it('counts a scheduled-task dispatch too — it is the same adapter and the same paid turn', async () => {
    // The hole this closes: the ceiling used to match `relay.agent.*` only,
    // while the Claude Code adapter also answers for `relay.system.tasks.*` and
    // routes it to `ensureSession` + `sendMessage`. Before DOR-2432 `relay_send`
    // reached that subject, so the bound was bypassable by exactly the party it
    // bounds; a scheduled run is still a paid turn and still counts.
    relay = await makeRelay({ perAgent: () => null, global: () => 1 });

    const ok = await relay.publish(TASKS_SUBJECT, { taskId: 't1' }, { from: SCHEDULER });
    expect(ok.rejected).toBeUndefined();
    expect(registry.delivered).toHaveLength(1);

    const refused = await relay.publish(
      AGENT_SUBJECT,
      { text: 'the task turn already spent the install allowance' },
      { from: 'relay.test.a' }
    );
    expect(refused.rejected?.[0]?.reason).toBe('turn_ceiling');
  });

  it('refuses a task dispatch at the cap, on the same terms as an agent one', async () => {
    relay = await makeRelay({ perAgent: () => 1, global: () => null });

    await relay.publish(TASKS_SUBJECT, { taskId: 't1' }, { from: SCHEDULER });
    const refused = await relay.publish(
      TASKS_SUBJECT,
      { taskId: 't1' },
      {
        from: SCHEDULER,
      }
    );

    expect(registry.delivered).toHaveLength(1);
    expect(refused.rejected?.[0]?.reason).toBe('turn_ceiling');
  });

  it('gives the allowance back when an awaited dispatch never ran', async () => {
    // A task dispatch is awaited, so its refusal is known before publish
    // returns. Charging it would let a busy install drain its whole hourly
    // allowance having run nothing at all.
    relay = await makeRelay({ perAgent: () => 1, global: () => 1 });
    registry.refuse = 'at capacity';

    await relay.publish(TASKS_SUBJECT, { taskId: 't1' }, { from: SCHEDULER });

    registry.refuse = undefined;
    const ok = await relay.publish(TASKS_SUBJECT, { taskId: 't1' }, { from: SCHEDULER });
    expect(ok.rejected).toBeUndefined();
    expect(registry.delivered).toHaveLength(1);
  });

  it.each(['awaited', 'detached'] as const)(
    'preserves %s skipped-delivery refund eligibility',
    async (mode) => {
      relay = await makeRelay({ perAgent: () => 1, global: () => 1 });
      vi.spyOn(registry, 'deliver').mockResolvedValue({
        success: true,
        skipped: true,
        durationMs: 0,
      });
      const internals = relay as unknown as {
        publishPipeline: {
          deps: { adapterDelivery: { finishDetached: (...args: unknown[]) => Promise<void> } };
        };
      };
      const adapter = internals.publishPipeline.deps.adapterDelivery;
      const actualFinish = adapter.finishDetached.bind(adapter);
      let completion: Promise<void> | undefined;
      const finished = vi.spyOn(adapter, 'finishDetached').mockImplementation((...args) => {
        completion = actualFinish(...args);
        return completion;
      });
      const subject = mode === 'awaited' ? TASKS_SUBJECT : AGENT_SUBJECT;
      const opts = { from: mode === 'awaited' ? SCHEDULER : 'relay.test.a' };
      await relay.publish(subject, { text: 'skipped' }, opts);
      if (mode === 'detached') {
        await vi.waitFor(() => expect(finished).toHaveBeenCalledOnce());
        await completion;
      }
      const next = await relay.publish(subject, { text: 'next' }, opts);
      expect(next.rejected?.[0]?.reason).toBe(mode === 'detached' ? 'turn_ceiling' : undefined);
    }
  );

  it('gives the allowance back when a DETACHED dispatch is refused a slot', async () => {
    // `relay.agent.*` is accepted immediately and settles in the background, so
    // the refund is the delivery layer's rather than the pipeline's. An agent
    // whose slots are all full would otherwise burn its whole hourly allowance
    // having run zero turns.
    relay = await makeRelay({ perAgent: () => 1, global: () => null });
    registry.refuse = 'at capacity';

    await relay.publish(AGENT_SUBJECT, { text: 'no slot' }, { from: 'relay.test.a' });
    // The refusal lands with the dead letter, so wait for that rather than for a
    // timer — it is also what proves the failure actually completed.
    await vi.waitFor(async () => expect(await relay.getDeadLetters()).toHaveLength(1));

    registry.refuse = undefined;
    const ok = await relay.publish(
      AGENT_SUBJECT,
      { text: 'a slot at last' },
      {
        from: 'relay.test.a',
      }
    );
    expect(ok.rejected).toBeUndefined();
    expect(registry.delivered).toHaveLength(1);
  });

  it('does NOT refund a detached failure the ceiling never charged', async () => {
    // The asymmetry this closes: the reserve asks the ADAPTER whether a dispatch
    // runs a turn, and a refund that re-derived the answer instead would pop a
    // charge somebody else made. An adapter declaring `startsAgentTurns: false`
    // on an agent-shaped subject is uncounted — so its failure must give nothing
    // back, or two paid turns run under a one-turn ceiling.
    relay = await makeRelay({ perAgent: () => null, global: () => 1 });
    registry.freeSubjectPrefix = 'relay.agent.free.';

    // One real, counted turn spends the install's single unit.
    await relay.publish(AGENT_SUBJECT, { text: 'the one paid turn' }, { from: 'relay.test.a' });

    // A free-adapter delivery that fails afterwards must not hand that unit back.
    registry.refuse = 'at capacity';
    await relay.publish(
      'relay.agent.free.thing',
      { text: 'costs nothing' },
      {
        from: 'relay.test.a',
      }
    );
    await vi.waitFor(async () => expect(await relay.getDeadLetters()).toHaveLength(1));
    registry.refuse = undefined;

    const refused = await relay.publish(
      AGENT_SUBJECT,
      { text: 'second paid turn' },
      {
        from: 'relay.test.a',
      }
    );
    expect(refused.rejected?.[0]?.reason).toBe('turn_ceiling');
  });

  it('never charges an adapter that declares it runs no turns', async () => {
    relay = await makeRelay({ perAgent: () => null, global: () => 1 });
    registry.freeSubjectPrefix = 'relay.agent.free.';

    await relay.publish('relay.agent.free.thing', { text: 'free' }, { from: 'relay.test.a' });
    const ok = await relay.publish(
      AGENT_SUBJECT,
      { text: 'still affordable' },
      {
        from: 'relay.test.a',
      }
    );

    expect(ok.rejected).toBeUndefined();
    expect(registry.delivered).toHaveLength(2);
  });

  it('refuses at the envelope budget before the ceiling is ever asked, when the chain is spent', async () => {
    relay = await makeRelay({ perAgent: () => null, global: () => null });

    const result = await relay.publish(
      AGENT_SUBJECT,
      { text: 'out of budget' },
      { from: 'relay.test.a', budget: { callBudgetRemaining: 0 } }
    );

    expect(result.rejected?.[0]?.reason).toBe('budget_exceeded');
    expect(registry.delivered).toHaveLength(0);
  });
});

describe('dispatch reservation survives an older delivery refund', () => {
  it.each(['same subject', 'different subjects'] as const)(
    'keeps the newer successful charge through its real hour: %s',
    async (mode) => {
      const hour = 3_600_000;
      const start = Date.parse('2026-10-03T00:00:00Z');
      let now = start;
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
      let failOlder!: (result: DeliveryResult) => void;
      const older = new Promise<DeliveryResult>((resolve) => (failOlder = resolve));
      try {
        relay = await makeRelay({
          perAgent: () => (mode === 'same subject' ? 2 : null),
          global: () => (mode === 'same subject' ? null : 2),
        });
        vi.spyOn(registry, 'deliver').mockImplementationOnce(() => older);
        const first = await relay.publish(
          AGENT_SUBJECT,
          { text: 'older A' },
          { from: 'relay.test.a' }
        );
        expect(first.deliveredTo).toBe(1);
        now = start + 59 * 60_000;
        const newerSubject = mode === 'same subject' ? AGENT_SUBJECT : 'relay.agent.demo.agent-2';
        const newer = await relay.publish(
          newerSubject,
          { text: 'successful B' },
          { from: 'relay.test.a' }
        );
        expect(newer.rejected).toBeUndefined();
        failOlder({ success: false, error: 'older delivery refused', durationMs: 0 });
        await vi.waitFor(async () => expect(await relay.getDeadLetters()).toHaveLength(1));
        now = start + hour + 1;
        if (mode === 'same subject') {
          // The installed real counter must retain B, not the older A timestamp.
          const counter = (
            relay as unknown as {
              publishPipeline: { turnCeiling: RelayTurnCeiling };
            }
          ).publishPipeline.turnCeiling;
          expect(counter.remaining(newerSubject)).toEqual({ agent: 1, global: null });
        } else {
          // One replacement turn fits beside B; a second would exceed the real bus cap.
          const third = await relay.publish(
            'relay.agent.demo.agent-3',
            { text: 'C' },
            { from: 'relay.test.a' }
          );
          expect(third.rejected).toBeUndefined();
          const fourth = await relay.publish(
            'relay.agent.demo.agent-4',
            { text: 'D' },
            { from: 'relay.test.a' }
          );
          expect(fourth.rejected?.[0]?.reason).toBe('turn_ceiling');
          expect(registry.delivered).toHaveLength(2);
        }
      } finally {
        clock.mockRestore();
      }
    }
  );
});

describe('RelayTurnCeiling — the counter itself', () => {
  it('rolls the window, so an hour spent an hour ago is not spent now', () => {
    let now = 1_000_000;
    const ceiling = new RelayTurnCeiling({
      limits: { perAgent: () => 2, global: () => null },
      now: () => now,
      windowMs: 60_000,
    });

    expect(ceiling.tryReserve(AGENT_SUBJECT).allowed).toBe(true);
    expect(ceiling.tryReserve(AGENT_SUBJECT).allowed).toBe(true);
    expect(ceiling.tryReserve(AGENT_SUBJECT).allowed).toBe(false);

    now += 60_001;
    expect(ceiling.tryReserve(AGENT_SUBJECT).allowed).toBe(true);
  });

  it('reports headroom as null for a ceiling that is off, and a number for one that is on', () => {
    const ceiling = new RelayTurnCeiling({
      limits: { perAgent: () => null, global: () => 5 },
    });
    ceiling.tryReserve(AGENT_SUBJECT);
    expect(ceiling.remaining(AGENT_SUBJECT)).toEqual({ agent: null, global: 4 });
  });

  it('charges a turn to the global window even when the per-agent ceiling is off', () => {
    const ceiling = new RelayTurnCeiling({
      limits: { perAgent: () => null, global: () => 1 },
    });
    expect(ceiling.tryReserve(AGENT_SUBJECT).counted).toBe(true);
    expect(ceiling.tryReserve('relay.agent.demo.other').scope).toBe('global');
  });

  it('forgets the least recently touched subject, and never invents a spend', () => {
    // The map is bounded, so a machine that visits many subjects in an hour
    // drops the oldest windows. Eviction may only ever be GENEROUS: an evicted
    // subject reads as unspent. The global window is not keyed by subject and is
    // never evicted, which is what keeps the install-wide number exact.
    const ceiling = new RelayTurnCeiling({ limits: { perAgent: () => 1, global: () => null } });

    for (let i = 0; i < 257; i++) {
      expect(ceiling.tryReserve(`relay.agent.demo.a-${i}`).allowed).toBe(true);
    }

    // The first subject was evicted, so it reads as unspent — forgotten, not
    // invented: it is allowed again rather than refused.
    expect(ceiling.tryReserve('relay.agent.demo.a-0').allowed).toBe(true);
    // The most recent one is still remembered and still spent.
    expect(ceiling.tryReserve('relay.agent.demo.a-256').allowed).toBe(false);
  });

  it('gives a reservation back, and does nothing when there was none to give', () => {
    const ceiling = new RelayTurnCeiling({ limits: { perAgent: () => 1, global: () => 1 } });
    expect(ceiling.tryReserve(AGENT_SUBJECT).allowed).toBe(true);
    expect(ceiling.tryReserve(AGENT_SUBJECT).allowed).toBe(false);

    ceiling.release(AGENT_SUBJECT);
    expect(ceiling.remaining(AGENT_SUBJECT)).toEqual({ agent: 1, global: 1 });

    // A release with nothing outstanding cannot manufacture headroom.
    ceiling.release(AGENT_SUBJECT);
    expect(ceiling.remaining(AGENT_SUBJECT)).toEqual({ agent: 1, global: 1 });
  });

  it('caps with the shipped defaults when a host wires no limits at all', () => {
    const ceiling = new RelayTurnCeiling();
    expect(ceiling.remaining(AGENT_SUBJECT)).toEqual({ agent: 1000, global: 5000 });
  });
});

describe('publisher-owned reservation identity', () => {
  function counter(now = () => 0) {
    return new RelayTurnCeiling({
      limits: { perAgent: () => 2, global: () => 2 },
      now,
      windowMs: 100,
    });
  }

  it('isolates public legacy release while sharing both ceilings', () => {
    const ceiling = counter();
    const owned = dispatchTurnAccounting(ceiling).reserve('agent');
    ceiling.release('agent');
    expect(ceiling.remaining('agent')).toEqual({ agent: 1, global: 1 });
    expect(ceiling.tryReserve('agent').allowed).toBe(true);
    expect(dispatchTurnAccounting(ceiling).reserve('agent').allowed).toBe(false);
    ceiling.release('agent');
    expect(ceiling.remaining('agent')).toEqual({ agent: 1, global: 1 });
    owned.refund!();
    expect(ceiling.remaining('agent')).toEqual({ agent: 2, global: 2 });
  });

  it('copied and repeated refund closures cannot remove another reservation or counter', () => {
    const ceiling = counter();
    const foreign = counter();
    dispatchTurnAccounting(foreign).reserve('agent');
    const first = dispatchTurnAccounting(ceiling).reserve('agent');
    dispatchTurnAccounting(ceiling).reserve('agent');
    const copied = { ...first };
    copied.refund!();
    first.refund!();
    expect(ceiling.remaining('agent')).toEqual({ agent: 1, global: 1 });
    expect(foreign.remaining('agent')).toEqual({ agent: 1, global: 1 });
  });

  it('refunds a pruned entry without erasing a later charge at the strict boundary', () => {
    let now = 0;
    const ceiling = counter(() => now);
    const first = dispatchTurnAccounting(ceiling).reserve('agent');
    now = 100;
    expect(ceiling.remaining('agent')).toEqual({ agent: 2, global: 2 });
    dispatchTurnAccounting(ceiling).reserve('agent');
    first.refund!();
    expect(ceiling.remaining('agent')).toEqual({ agent: 1, global: 1 });
  });

  it('an unlimited dispatch has no refund authority after live limits change', () => {
    let cap: number | null = null;
    const ceiling = new RelayTurnCeiling({ limits: { perAgent: () => cap, global: () => cap } });
    const uncounted = dispatchTurnAccounting(ceiling).reserve('agent');
    cap = 1;
    dispatchTurnAccounting(ceiling).reserve('agent');
    expect(uncounted.refund).toBeUndefined();
    expect(ceiling.remaining('agent')).toEqual({ agent: 0, global: 0 });
  });

  it('an evicted subject refund preserves newer global debt', () => {
    const ceiling = new RelayTurnCeiling({ limits: { perAgent: () => null, global: () => 300 } });
    const old = dispatchTurnAccounting(ceiling).reserve('old');
    for (let index = 0; index < 256; index++)
      dispatchTurnAccounting(ceiling).reserve(`agent-${index}`);
    dispatchTurnAccounting(ceiling).reserve('old');
    old.refund!();
    expect(ceiling.remaining('old')).toEqual({ agent: null, global: 43 });
  });
});

describe('expired owned refund preserves subject eviction order', () => {
  it.each([false, true])(
    'preserves newer B debt after another admission, stale refund=%s',
    (refundExpired) => {
      let now = 0;
      const ceiling = new RelayTurnCeiling({
        limits: { perAgent: () => 1, global: () => null },
        now: () => now,
        windowMs: 100,
      });
      const accounting = dispatchTurnAccounting(ceiling);
      const expired = accounting.reserve('A');
      now = 100;
      accounting.reserve('A');
      accounting.reserve('B');
      for (let index = 0; index < 254; index++) accounting.reserve(`other-${index}`);
      if (refundExpired) expired.refund!();
      accounting.reserve('C');
      expect(ceiling.remaining('B')).toEqual({ agent: 0, global: null });
      expect(accounting.reserve('B')).toEqual({ allowed: false, scope: 'agent', counted: false });
    }
  );
});

describe('expired unpruned refund preserves subject eviction order', () => {
  it.each([false, true])(
    'preserves live B debt when expired A stays stored, stale refund=%s',
    (refundExpired) => {
      let now = 0;
      const ceiling = new RelayTurnCeiling({
        limits: { perAgent: () => 1, global: () => null },
        now: () => now,
        windowMs: 100,
      });
      const accounting = dispatchTurnAccounting(ceiling);
      const expired = accounting.reserve('A');
      now = 50;
      accounting.reserve('B');
      for (let index = 0; index < 254; index++) accounting.reserve(`other-${index}`);
      now = 100;
      if (refundExpired) expired.refund!();
      accounting.reserve('C');
      expect(ceiling.remaining('B')).toEqual({ agent: 0, global: null });
      expect(accounting.reserve('B')).toEqual({ allowed: false, scope: 'agent', counted: false });
    }
  );
});
