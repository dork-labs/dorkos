/**
 * The scripted held process, and the per-session answers that ride it (DOR-1326).
 *
 * What these pin is the property the browser leg is built on: **the same runtime
 * answers differently for two sessions**. Every assertion below is written so
 * that a registry which forgot the opt-in — or one that simply answered `true`
 * for everything, which is what test-mode used to do — turns it red.
 *
 * Conformance C4/C5/C7/C8/C9 hold the contract itself (`conformance.test.ts`);
 * this file holds the mechanics underneath it, plus the `warm-echo` scenario
 * whose text is what a Playwright spec reads to learn which path served a turn.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import { heldProcesses } from '../held-process.js';
import { interactionGate } from '../interaction-gate.js';
import { scenarioStore } from '../scenario-store.js';
import { TestModeRuntime } from '../test-mode-runtime.js';

const SESSION = 'ddddddd0-dddd-4ddd-8ddd-dddddddddddd';
const OTHER = 'eeeeeee0-eeee-4eee-8eee-eeeeeeeeeeee';

afterEach(() => {
  heldProcesses.reset();
  scenarioStore.reset();
});

/**
 * Drain one turn, releasing a step barrier if the scenario parks on one.
 *
 * The `warm-echo` fixture holds its turn open until a step is released, so a
 * bare drain would hang. The release is fired from a parallel promise rather
 * than before the drain, because a step fired before the scenario reaches the
 * barrier is dropped on the floor.
 */
async function releaseStepWhenParked(sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (interactionGate.step(sessionId)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function drainTurn(
  runtime: TestModeRuntime,
  sessionId: string,
  content: string,
  opts?: Parameters<TestModeRuntime['sendMessage']>[2]
): Promise<string> {
  const events: StreamEvent[] = [];
  const releasing = releaseStepWhenParked(sessionId);
  for await (const event of runtime.sendMessage(sessionId, content, opts)) events.push(event);
  await releasing;
  return events
    .filter((event) => event.type === 'text_delta')
    .map((event) => (event.data as { text: string }).text)
    .join('');
}

describe('the scripted held process', () => {
  it('holds nothing for a session that never opted in, whatever it does', async () => {
    const runtime = new TestModeRuntime();
    await drainTurn(runtime, SESSION, 'hello');

    // The resume path: each turn is its own scripted work, so there is no
    // warmth, nothing to cut into, and nothing to append to.
    expect(runtime.getSessionWarmth(SESSION)).toBe('cold');
    expect(runtime.canSteerSession(SESSION)).toBe(false);
    expect(runtime.canStageSession(SESSION)).toBe(false);
  });

  it('answers for a session it has never heard of instead of throwing', () => {
    const runtime = new TestModeRuntime();
    expect(runtime.getSessionWarmth(OTHER)).toBe('cold');
    expect(runtime.canSteerSession(OTHER)).toBe(false);
    expect(runtime.canStageSession(OTHER)).toBe(false);
  });

  it('is steerable and stageable from the opt-in, before any turn has run', () => {
    const runtime = new TestModeRuntime();
    heldProcesses.setEnabled(SESSION, true);

    // The question is "would the NEXT turn run on a held process", not "is one
    // warm this instant" — the same answer claude-code's shouldDispatch gives.
    expect(runtime.canSteerSession(SESSION)).toBe(true);
    expect(runtime.canStageSession(SESSION)).toBe(true);
    // And warmth is still honest: nothing is held yet.
    expect(runtime.getSessionWarmth(SESSION)).toBe('cold');
  });

  it('reports running while its turn runs and warm once it ends', async () => {
    const runtime = new TestModeRuntime();
    heldProcesses.setEnabled(SESSION, true);
    scenarioStore.setForSession(SESSION, 'warm-echo');

    const turn = runtime.sendMessage(SESSION, 'first');
    await turn.next();
    expect(runtime.getSessionWarmth(SESSION)).toBe('running');

    // Release the barrier and let the generator finish, which is what hands the
    // process back.
    const releasing = releaseStepWhenParked(SESSION);
    while (!(await turn.next()).done) {
      // Drained to completion so `sendMessage`'s finally runs.
    }
    await releasing;
    expect(runtime.getSessionWarmth(SESSION)).toBe('warm');
  });

  it('does not cool a held session when the opt-in is turned back off', async () => {
    const runtime = new TestModeRuntime();
    heldProcesses.setEnabled(SESSION, true);
    await drainTurn(runtime, SESSION, 'first');

    heldProcesses.setEnabled(SESSION, false);

    // Mirrors claude-code (ADR 260812-134510): turning the experiment off does
    // not take a warm process back, so the session stays steerable until the
    // process is actually given back.
    expect(runtime.getSessionWarmth(SESSION)).toBe('warm');
    expect(runtime.canSteerSession(SESSION)).toBe(true);
  });

  it('gives the process back on a reap, and the next turn starts a fresh one', async () => {
    const runtime = new TestModeRuntime();
    heldProcesses.setEnabled(SESSION, true);
    scenarioStore.setForSession(SESSION, 'warm-echo');

    expect(await drainTurn(runtime, SESSION, 'one')).toContain('HELD-PROCESS-TURN-1');
    expect(await drainTurn(runtime, SESSION, 'two')).toContain('HELD-PROCESS-TURN-2');

    await runtime.reapSession(SESSION);
    expect(runtime.getSessionWarmth(SESSION)).toBe('cold');

    // Counting from 1 again is the honest report that a DIFFERENT process
    // answered — and the session is still on the path, so it boots one.
    expect(await drainTurn(runtime, SESSION, 'three')).toContain('HELD-PROCESS-TURN-1');
  });

  it('settles no open turn, because a scripted turn cannot outlive its stream', async () => {
    const runtime = new TestModeRuntime();
    heldProcesses.setEnabled(SESSION, true);
    await drainTurn(runtime, SESSION, 'first');

    // Warm and idle — the state a constant `true` would get wrong.
    expect(await runtime.settleOpenTurn(SESSION)).toBe(false);
    expect(await runtime.settleOpenTurn(OTHER)).toBe(false);
  });
});

describe('the warm-echo scenario', () => {
  it('says which path served the turn, and a session off the path says so', async () => {
    const runtime = new TestModeRuntime();
    scenarioStore.setForSession(SESSION, 'warm-echo');

    // Off the path first: this is the reading that makes every WARM assertion
    // in the browser leg able to fail.
    expect(await drainTurn(runtime, SESSION, 'cold one')).toContain('NO-HELD-PROCESS: cold one');

    heldProcesses.setEnabled(SESSION, true);
    expect(await drainTurn(runtime, SESSION, 'warm one')).toContain(
      'HELD-PROCESS-TURN-1: warm one'
    );
    expect(await drainTurn(runtime, SESSION, 'warm two')).toContain(
      'HELD-PROCESS-TURN-2: warm two'
    );
  });

  it('repeats words staged onto the held process, exactly once', async () => {
    const runtime = new TestModeRuntime();
    heldProcesses.setEnabled(SESSION, true);
    scenarioStore.setForSession(SESSION, 'warm-echo');
    await drainTurn(runtime, SESSION, 'first');

    const receipt = await runtime.deliverIntoTurn(SESSION, 'use the staging branch', {
      mode: 'stage',
      messageId: 'stage-held-1',
    });
    expect(receipt).toEqual({ delivered: true });

    // The next answer carries them — which is how a browser proves the stage
    // LANDED rather than that a receipt was emitted.
    expect(await drainTurn(runtime, SESSION, 'second')).toContain(
      'staged-native: use the staging branch'
    );
    // And only the next one: a transcript entry is consumed once.
    expect(await drainTurn(runtime, SESSION, 'third')).not.toContain('staged-native:');
  });

  it('repeats words the server FOLDED into the dispatch, labelled as the fold', async () => {
    const runtime = new TestModeRuntime();
    scenarioStore.setForSession(SESSION, 'warm-echo');

    // The route a stage takes on a session that cannot be staged onto: the
    // server holds the words and hands them to the next turn as context
    // (ADR-0273). Labelled apart from the native path so a test meaning to
    // exercise one cannot pass on the other.
    const answer = await drainTurn(runtime, SESSION, 'go on', {
      additionalContext: [
        { kind: 'staged_context', scope: 'per-turn', data: { text: 'mind the rate limit' } },
      ],
    });
    expect(answer).toContain('staged-folded: mind the rate limit');
    expect(answer).not.toContain('staged-native:');
  });
});
