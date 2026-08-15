/**
 * Contract tests for the test-mode {@link interactionGate} (DOR-1214).
 *
 * The gate is what makes an interactive browser test possible, and the way it
 * fails is silent: a wait that never settles does not throw, it leaves a turn
 * hung `streaming` and a projector holding it, and the spec that depends on it
 * dies thirty seconds later on a locator timeout that names something else
 * entirely. So the emphasis here is on the settling — every wait resolves, or
 * rejects on abort, and never neither.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { ScenarioAborted, interactionGate } from '../interaction-gate.js';

const SESSION = 'session-under-test';

afterEach(() => {
  interactionGate.reset();
});

describe('interactionGate — answering a parked scenario', () => {
  it('delivers an approval decision to the scenario waiting on it', async () => {
    const ctx = interactionGate.open(SESSION);
    const waiting = ctx.awaitApproval('tool-1');

    expect(
      interactionGate.resolveApproval(SESSION, 'tool-1', { approved: true, alwaysAllow: true })
    ).toBe(true);

    await expect(waiting).resolves.toEqual({ approved: true, alwaysAllow: true });
  });

  it('carries a refusal and the words that came with it', async () => {
    const ctx = interactionGate.open(SESSION);
    const waiting = ctx.awaitApproval('tool-1');

    interactionGate.resolveApproval(SESSION, 'tool-1', {
      approved: false,
      denyReason: 'not this file',
    });

    await expect(waiting).resolves.toEqual({ approved: false, denyReason: 'not this file' });
  });

  it('delivers answers and elicitation responses to their own waiters', async () => {
    const ctx = interactionGate.open(SESSION);
    const answers = ctx.awaitAnswers('q-1');
    const elicitation = ctx.awaitElicitation('e-1');

    interactionGate.resolveAnswers(SESSION, 'q-1', { 'Test runner': 'Vitest' });
    interactionGate.resolveElicitation(SESSION, 'e-1', {
      action: 'accept',
      content: { environment: 'staging' },
    });

    await expect(answers).resolves.toEqual({ 'Test runner': 'Vitest' });
    await expect(elicitation).resolves.toEqual({
      action: 'accept',
      content: { environment: 'staging' },
    });
  });

  it('resolves several approvals independently, in any order', async () => {
    // The batch card answers three asks at once and gives no ordering promise,
    // so a gate that only answered them in the order they were registered would
    // hang `approval-batch` on whichever one came back second.
    const ctx = interactionGate.open(SESSION);
    const waits = Promise.all([
      ctx.awaitApproval('a'),
      ctx.awaitApproval('b'),
      ctx.awaitApproval('c'),
    ]);

    for (const id of ['c', 'a', 'b']) {
      expect(interactionGate.resolveApproval(SESSION, id, { approved: true })).toBe(true);
    }

    await expect(waits).resolves.toEqual([
      { approved: true },
      { approved: true },
      { approved: true },
    ]);
  });
});

describe('interactionGate — reporting what was NOT waiting', () => {
  it('refuses an answer for a session with no open turn', () => {
    expect(interactionGate.resolveApproval('never-opened', 'tool-1', { approved: true })).toBe(
      false
    );
    expect(interactionGate.resolveAnswers('never-opened', 'q-1', {})).toBe(false);
    expect(interactionGate.resolveElicitation('never-opened', 'e-1', { action: 'accept' })).toBe(
      false
    );
    expect(interactionGate.step('never-opened')).toBe(false);
  });

  it('refuses a SECOND answer to the same ask', async () => {
    // What the `/approve` route turns into a 409. A gate that answered twice
    // would let a double-click resolve the NEXT interaction to reuse the id.
    const ctx = interactionGate.open(SESSION);
    const waiting = ctx.awaitApproval('tool-1');

    expect(interactionGate.resolveApproval(SESSION, 'tool-1', { approved: true })).toBe(true);
    expect(interactionGate.resolveApproval(SESSION, 'tool-1', { approved: false })).toBe(false);

    await expect(waiting).resolves.toEqual({ approved: true });
  });

  it('refuses an answer for an id nobody is parked on', () => {
    const ctx = interactionGate.open(SESSION);
    void ctx.awaitApproval('tool-1').catch(() => {});
    expect(interactionGate.resolveApproval(SESSION, 'other-tool', { approved: true })).toBe(false);
  });
});

describe('interactionGate — step barriers', () => {
  it('releases exactly one parked step per call, in order', async () => {
    const ctx = interactionGate.open(SESSION);
    const order: number[] = [];
    const first = ctx.awaitStep().then(() => order.push(1));
    const second = ctx.awaitStep().then(() => order.push(2));

    expect(interactionGate.step(SESSION)).toBe(true);
    await first;
    expect(order).toEqual([1]);

    expect(interactionGate.step(SESSION)).toBe(true);
    await second;
    expect(order).toEqual([1, 2]);

    // Nothing left parked: the third call reports honestly rather than
    // pre-releasing a barrier the scenario has not reached.
    expect(interactionGate.step(SESSION)).toBe(false);
  });
});

describe('interactionGate — stopping a turn', () => {
  it('rejects every outstanding wait with ScenarioAborted', async () => {
    const ctx = interactionGate.open(SESSION);
    const approval = ctx.awaitApproval('tool-1');
    const answers = ctx.awaitAnswers('q-1');
    const step = ctx.awaitStep();

    expect(interactionGate.abort(SESSION)).toBe(true);

    await expect(approval).rejects.toBeInstanceOf(ScenarioAborted);
    await expect(answers).rejects.toBeInstanceOf(ScenarioAborted);
    await expect(step).rejects.toBeInstanceOf(ScenarioAborted);
    expect(ctx.signal.aborted).toBe(true);
  });

  it('rejects a wait registered AFTER the abort, rather than hanging forever', async () => {
    // The race a stop always has: the scenario may be between two awaits when
    // the interrupt lands. If the next `await` parked normally on an already-torn
    // gate, the turn would never end — the exact leak this gate exists to avoid.
    const ctx = interactionGate.open(SESSION);
    interactionGate.abort(SESSION);
    await expect(ctx.awaitApproval('tool-1')).rejects.toBeInstanceOf(ScenarioAborted);
  });

  it('reports false when there was no turn to stop', () => {
    expect(interactionGate.abort('never-opened')).toBe(false);
  });

  it('wakes a sleeping scenario immediately instead of waiting out the delay', async () => {
    // `long-turn` sleeps a second per heartbeat; an abort that could not
    // interrupt a sleep would leave Stop looking slow and, on a long delay,
    // broken. Sized so a delay that is genuinely waited out cannot pass: the
    // assertion runs long before 30s elapse.
    const ctx = interactionGate.open(SESSION);
    const sleeping = ctx.delay(30_000);
    interactionGate.abort(SESSION);
    await expect(sleeping).rejects.toBeInstanceOf(ScenarioAborted);
  });
});

describe('interactionGate — turn lifecycle', () => {
  it('a new turn on the same session abandons the previous turn’s waits', async () => {
    // Otherwise a stale approval from an abandoned turn would answer the next
    // turn's card the moment it reused a tool-call id — and the scenarios here
    // use FIXED ids on purpose, so that collision is guaranteed rather than rare.
    const first = interactionGate.open(SESSION);
    const stale = first.awaitApproval('gated-edit-1');

    const second = interactionGate.open(SESSION);
    await expect(stale).rejects.toBeInstanceOf(ScenarioAborted);

    const fresh = second.awaitApproval('gated-edit-1');
    interactionGate.resolveApproval(SESSION, 'gated-edit-1', { approved: true });
    await expect(fresh).resolves.toEqual({ approved: true });
  });

  it('close() ends the turn and rejects anything still parked', async () => {
    const ctx = interactionGate.open(SESSION);
    const parked = ctx.awaitStep();
    expect(interactionGate.isOpen(SESSION)).toBe(true);

    interactionGate.close(SESSION);

    expect(interactionGate.isOpen(SESSION)).toBe(false);
    await expect(parked).rejects.toBeInstanceOf(ScenarioAborted);
  });

  it('reset() aborts every session at once', async () => {
    const a = interactionGate.open('session-a');
    const b = interactionGate.open('session-b');
    const waits = [a.awaitStep(), b.awaitStep()];

    interactionGate.reset();

    await expect(Promise.allSettled(waits)).resolves.toEqual([
      { status: 'rejected', reason: expect.any(ScenarioAborted) },
      { status: 'rejected', reason: expect.any(ScenarioAborted) },
    ]);
    expect(interactionGate.isOpen('session-a')).toBe(false);
    expect(interactionGate.isOpen('session-b')).toBe(false);
  });
});
