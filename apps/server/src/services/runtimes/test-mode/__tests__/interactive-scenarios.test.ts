/**
 * The interactive test-mode turn, driven through the real server path (DOR-1214).
 *
 * These scenarios exist so a browser test can prove the interactive-session rows
 * of `meta/chat-capabilities.md` — I-01 to I-04, R-05 to R-07, C-10 — and the
 * browser test can only be trusted if the events beneath it are. So this file
 * asserts the thing the e2e cannot see: that the turn genuinely BLOCKS until the
 * runtime's own interactive method is called, and that the two branches of every
 * decision differ in the stream rather than only on screen.
 *
 * Everything here goes through `triggerTurn` → the durable projector, the same
 * path `POST /:id/messages` takes, so a scenario that only worked when driven
 * directly would fail here.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import {
  disposeProjector,
  getOrCreateProjector,
} from '../../../session/session-state-projector.js';
import { reconstructHistoryFromEvents } from '../../../session/event-log-history.js';
import { triggerTurn } from '../../../session/trigger-turn.js';
import { interactionGate } from '../interaction-gate.js';
import { scenarioStore } from '../scenario-store.js';
import { TestModeRuntime } from '../test-mode-runtime.js';

const SESSION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CTX = { cwd: '/projects/test', permissionMode: 'default' as const };

/** Start a turn the way the messages route does, WITHOUT waiting for it to end. */
function startTurn(runtime: TestModeRuntime, content: string) {
  const projector = getOrCreateProjector(SESSION, CTX.cwd);
  return {
    projector,
    accepted: triggerTurn({
      sessionId: SESSION,
      clientId: 'test-client',
      content,
      cwd: CTX.cwd,
      projector,
      deps: {
        acquireLock: (sid, cid, res) => runtime.acquireLock(sid, cid, res),
        releaseLock: (sid, cid) => runtime.releaseLock(sid, cid),
        sendMessage: (sid, text, opts) => runtime.sendMessage(sid, text, opts),
        interruptQuery: (sid) => runtime.interruptQuery(sid),
        getInternalSessionId: (sid) => runtime.getInternalSessionId(sid),
        rekeyProjector: () => {},
        getCapabilities: () => runtime.getCapabilities(),
      },
    }),
  };
}

/** Every event the projector has recorded for this turn, oldest first. */
function replay(projector: ReturnType<typeof getOrCreateProjector>): SessionEvent[] {
  return [...projector.replayFrom(0)];
}

/** All assistant text the turn has produced so far, concatenated. */
function streamedText(projector: ReturnType<typeof getOrCreateProjector>): string {
  return replay(projector)
    .filter((e): e is Extract<SessionEvent, { type: 'text_delta' }> => e.type === 'text_delta')
    .map((e) => e.text)
    .join('');
}

/** Wait until the turn has parked on its interaction (or its step barrier). */
async function waitForPending(
  projector: ReturnType<typeof getOrCreateProjector>,
  count = 1
): Promise<void> {
  await vi.waitFor(() => {
    expect(replay(projector).filter(isBlockingAsk)).toHaveLength(count);
  });
}

/** The three stream members that stop a turn and wait on a person. */
function isBlockingAsk(event: SessionEvent): boolean {
  return (
    event.type === 'approval_required' ||
    event.type === 'question_prompt' ||
    event.type === 'elicitation_prompt'
  );
}

/** Wait for the turn to close. */
async function waitForSettled(
  projector: ReturnType<typeof getOrCreateProjector>,
  lifecycle: 'idle' | 'error' | 'interrupted' = 'idle'
): Promise<void> {
  await vi.waitFor(() => {
    expect(projector.getStatus().lifecycle).toBe(lifecycle);
  });
}

/**
 * Release one step barrier, waiting for the scenario to REACH it first.
 *
 * `interactionGate.step` answers `false` when nothing is parked yet, and a
 * scenario is only parked once every event before the barrier has been consumed
 * — which is a microtask or two behind the call that started it. Firing two
 * steps back to back therefore drops the second on the floor and leaves the turn
 * hanging on a barrier nobody will ever release again. The browser specs poll
 * `POST /api/test/step` for exactly this reason; so does this.
 */
async function releaseStep(sessionId: string): Promise<void> {
  await vi.waitFor(() => {
    expect(interactionGate.step(sessionId)).toBe(true);
  });
}

afterEach(() => {
  scenarioStore.reset();
  disposeProjector(SESSION);
});

describe('approval-gated (I-01) — the turn waits, and the answer changes the outcome', () => {
  it('blocks on the approval, then runs the tool when it is approved', async () => {
    scenarioStore.setForSession(SESSION, 'approval-gated');
    const runtime = new TestModeRuntime();
    const { projector, accepted } = startTurn(runtime, 'edit the notes');
    expect((await accepted).accepted).toBe(true);

    await waitForPending(projector);

    // THE CLAIM THIS SUITE EXISTS FOR: the turn is genuinely parked. A scenario
    // that streamed its tail regardless would already have said which branch it
    // took, and every browser assertion downstream would be vacuous.
    expect(projector.getStatus().lifecycle).toBe('blocked');
    expect(streamedText(projector)).not.toContain('APPROVED-BRANCH');
    expect(streamedText(projector)).not.toContain('DENIED-BRANCH');

    expect(runtime.approveTool(SESSION, 'gated-edit-1', true)).toBe(true);
    await waitForSettled(projector);

    expect(streamedText(projector)).toContain('APPROVED-BRANCH');
    // `tool_call_end` PROJECTS as `tool_result` — the raw member name never
    // reaches a client, so asserting on it here would be asserting on something
    // the browser test downstream can never see.
    //
    // TWO of them, and the pair is deliberate (DOR-1269). The normalizer folds
    // `tool_call_end` and a real `tool_result` onto the same member, and
    // claude-code produces one of each: the block CLOSE the moment the model
    // stops streaming the tool's input (which a cold hydrate then replays as
    // `complete` for a tool that has not run), and later the actual outcome.
    // Only the LAST one can speak for whether the tool ran.
    const results = replay(projector).filter((e) => e.type === 'tool_result');
    expect(results).toHaveLength(2);
    expect(JSON.stringify(results[0])).not.toContain('Applied 1 edit');
    const terminal = results[results.length - 1];
    expect(terminal).toMatchObject({ status: 'complete' });
    // The tool really ran: a result came back.
    expect(JSON.stringify(terminal)).toContain('Applied 1 edit');
  });

  it('refuses the tool when it is denied, and carries the reason', async () => {
    scenarioStore.setForSession(SESSION, 'approval-gated');
    const runtime = new TestModeRuntime();
    const { projector } = startTurn(runtime, 'edit the notes');
    await waitForPending(projector);

    expect(runtime.approveTool(SESSION, 'gated-edit-1', false, { denyReason: 'wrong file' })).toBe(
      true
    );
    await waitForSettled(projector);

    expect(streamedText(projector)).toContain('DENIED-BRANCH');
    expect(streamedText(projector)).not.toContain('APPROVED-BRANCH');
    // The refusal is in the STREAM, not merely on the card: the person's words
    // reached the agent, and the call ended in error with no result.
    expect(streamedText(projector)).toContain('wrong file');
    // The terminal one, for the reason the approve case spells out: the first
    // merely closes the streamed input block.
    const results = replay(projector).filter((e) => e.type === 'tool_result');
    expect(results).toHaveLength(2);
    expect(results[results.length - 1]).toMatchObject({ status: 'error' });
    expect(JSON.stringify(results)).not.toContain('Applied 1 edit');
  });

  it('drops the pending card from the projection once it is answered', async () => {
    // Without the projector resolve, every window would go on showing an
    // answerable card over a turn that had already moved on (the DOR-1148 ghost).
    scenarioStore.setForSession(SESSION, 'approval-gated');
    const runtime = new TestModeRuntime();
    const { projector } = startTurn(runtime, 'edit the notes');
    await waitForPending(projector);

    const snapshotBefore = await runtime.getSessionSnapshot(CTX, SESSION);
    expect(snapshotBefore.pendingInteractions).toHaveLength(1);

    runtime.approveTool(SESSION, 'gated-edit-1', true);
    await waitForSettled(projector);

    const snapshotAfter = await runtime.getSessionSnapshot(CTX, SESSION);
    expect(snapshotAfter.pendingInteractions).toEqual([]);
    expect(replay(projector).some((e) => e.type === 'interaction_resolved')).toBe(true);
  });

  it('reports false for an answer nobody was waiting for', async () => {
    scenarioStore.setForSession(SESSION, 'approval-gated');
    const runtime = new TestModeRuntime();
    const { projector } = startTurn(runtime, 'edit the notes');
    await waitForPending(projector);

    // What the /approve route turns into a 409 rather than a silent 200.
    expect(runtime.approveTool(SESSION, 'some-other-tool', true)).toBe(false);
    runtime.approveTool(SESSION, 'gated-edit-1', true);
    await waitForSettled(projector);
    expect(runtime.approveTool(SESSION, 'gated-edit-1', true)).toBe(false);
  });
});

describe('approval-batch (I-02) — three asks pending at once', () => {
  it('posts all three before waiting on any of them', async () => {
    // The batch bar only mounts at two or more pending. A scenario that awaited
    // each ask as it emitted would render one card three times and never the bar.
    scenarioStore.setForSession(SESSION, 'approval-batch');
    const runtime = new TestModeRuntime();
    const { projector } = startTurn(runtime, 'do the three things');

    await waitForPending(projector, 3);
    const snapshot = await runtime.getSessionSnapshot(CTX, SESSION);
    expect(snapshot.pendingInteractions).toHaveLength(3);
  });

  it('settles once every ask is answered, in whatever order they come back', async () => {
    scenarioStore.setForSession(SESSION, 'approval-batch');
    const runtime = new TestModeRuntime();
    const { projector } = startTurn(runtime, 'do the three things');
    await waitForPending(projector, 3);

    // Deliberately not emission order — "Approve All" gives no ordering promise.
    for (const id of ['batch-bash-1', 'batch-edit-1', 'batch-write-1']) {
      expect(runtime.approveTool(SESSION, id, true)).toBe(true);
    }
    await waitForSettled(projector);

    expect(streamedText(projector)).toContain('BATCH-SETTLED: 3 of 3 approved');
  });

  it('answers a mixed batch honestly', async () => {
    scenarioStore.setForSession(SESSION, 'approval-batch');
    const runtime = new TestModeRuntime();
    const { projector } = startTurn(runtime, 'do the three things');
    await waitForPending(projector, 3);

    runtime.approveTool(SESSION, 'batch-edit-1', true);
    runtime.approveTool(SESSION, 'batch-write-1', false);
    runtime.approveTool(SESSION, 'batch-bash-1', false);
    await waitForSettled(projector);

    expect(streamedText(projector)).toContain('BATCH-SETTLED: 1 of 3 approved');
  });
});

describe('question-prompt (I-03) — the answer is delivered, not merely dismissed', () => {
  it('blocks until an answer arrives, then quotes it back', async () => {
    scenarioStore.setForSession(SESSION, 'question-prompt');
    const runtime = new TestModeRuntime();
    const { projector } = startTurn(runtime, 'set up tests');
    await waitForPending(projector);

    expect(streamedText(projector)).not.toContain('ANSWER-RECEIVED');
    expect(runtime.submitAnswers(SESSION, 'question-1', { 'Test runner': 'Vitest' })).toBe(true);
    await waitForSettled(projector);

    // Quoting the CHOICE is what distinguishes "delivered" from "dismissed": a
    // product that dropped the answer and resumed would still clear the card.
    expect(streamedText(projector)).toContain('ANSWER-RECEIVED: Vitest');
    expect(runtime.submitAnswers(SESSION, 'question-1', { 'Test runner': 'Jest' })).toBe(false);
  });
});

describe('question-expires (I-07) — the ask nobody answers', () => {
  it('closes the turn with an expiry, and history says so instead of "answered"', async () => {
    scenarioStore.setForSession(SESSION, 'question-expires');
    const runtime = new TestModeRuntime();
    const { projector } = startTurn(runtime, 'set up tests');
    await waitForPending(projector);

    // Still answerable while it is parked — the expiry has to be the thing that
    // ends it, not the scenario having already moved on.
    expect(streamedText(projector)).not.toContain('MOVED-ON');

    await releaseStep(SESSION);
    await waitForSettled(projector);

    // The answer window really closed: a late submission finds nothing.
    expect(runtime.submitAnswers(SESSION, 'question-expired-1', { 'Test runner': 'Vitest' })).toBe(
      false
    );

    // And what a reload is served. This is the DOR-1293 claim end to end for a
    // log-backed runtime: the reconstructed history holds the question, holds
    // no answers, and SAYS why — before the fix it held the first two alone,
    // which the renderer read as "Question answered".
    const history = reconstructHistoryFromEvents(replay(projector));
    const asked = history
      .flatMap((m) => m.toolCalls ?? [])
      .find((tc) => tc.toolCallId === 'question-expired-1');
    expect(asked?.questions?.[0].question).toBe('Which test runner should I set up?');
    expect(asked?.answers).toBeUndefined();
    expect(asked?.questionOutcome).toBe('expired');
    expect(asked?.approvalOutcome).toBeUndefined();
  });
});

describe('elicitation-prompt (I-04) — an MCP ask the turn blocks on', () => {
  it('carries an accepted value into the reply', async () => {
    scenarioStore.setForSession(SESSION, 'elicitation-prompt');
    const runtime = new TestModeRuntime();
    const { projector } = startTurn(runtime, 'deploy it');
    await waitForPending(projector);

    expect(
      runtime.submitElicitation(SESSION, 'elicitation-1', 'accept', { environment: 'staging' })
    ).toBe(true);
    await waitForSettled(projector);

    expect(streamedText(projector)).toContain('ELICITATION-ACCEPTED: staging');
  });

  it('takes a decline as a refusal, not an empty acceptance', async () => {
    scenarioStore.setForSession(SESSION, 'elicitation-prompt');
    const runtime = new TestModeRuntime();
    const { projector } = startTurn(runtime, 'deploy it');
    await waitForPending(projector);

    runtime.submitElicitation(SESSION, 'elicitation-1', 'decline');
    await waitForSettled(projector);

    expect(streamedText(projector)).toContain('ELICITATION-DECLINE');
    expect(streamedText(projector)).not.toContain('ELICITATION-ACCEPTED');
  });
});

describe('step-gated progressions (R-05, R-06, R-07)', () => {
  it('todo-progress advances one status per released step, and no faster', async () => {
    scenarioStore.setForSession(SESSION, 'todo-progress');
    const runtime = new TestModeRuntime();
    const { projector } = startTurn(runtime, 'plan the work');

    const todoEvents = () => replay(projector).filter((e) => e.type === 'todo_update');
    await vi.waitFor(() => expect(todoEvents()).toHaveLength(3));

    // Parked: the three creations are on screen and nothing has moved. A paced
    // scenario would already have advanced past whatever a slow runner sampled.
    expect(JSON.stringify(todoEvents())).not.toContain('in_progress');

    await releaseStep(SESSION);
    await vi.waitFor(() => expect(JSON.stringify(todoEvents())).toContain('in_progress'));
    expect(JSON.stringify(todoEvents())).not.toContain('completed');

    await releaseStep(SESSION);
    await vi.waitFor(() => expect(JSON.stringify(todoEvents())).toContain('completed'));
  });

  it('subagent-fanout keeps two sub-agents running until a step settles them', async () => {
    scenarioStore.setForSession(SESSION, 'subagent-fanout');
    const runtime = new TestModeRuntime();
    const { projector } = startTurn(runtime, 'fan it out');

    const subagents = () => replay(projector).filter((e) => e.type === 'subagent_update');
    await vi.waitFor(() => expect(subagents()).toHaveLength(2));
    expect(projector.getStatus().runningSubagentCount).toBe(2);

    await releaseStep(SESSION); // progress beats
    await releaseStep(SESSION); // completions
    await waitForSettled(projector);

    expect(streamedText(projector)).toContain('FANOUT-SETTLED');
    expect(projector.getStatus().runningSubagentCount).toBe(0);
  });
});

describe('stoppable-turn (C-10) — Stop ends a turn that would never end itself', () => {
  it('closes the turn with an honest terminal reason', async () => {
    scenarioStore.setForSession(SESSION, 'stoppable-turn');
    const runtime = new TestModeRuntime();
    const { projector } = startTurn(runtime, 'go');

    await vi.waitFor(() => {
      expect(streamedText(projector)).toContain('STOPPABLE-TURN');
      expect(projector.getStatus().lifecycle).toBe('streaming');
    });

    expect(await runtime.interruptQuery(SESSION)).toBe(true);
    // `interrupted`, not `idle`: the projection says WHY the turn ended rather
    // than pretending it finished, which is the whole of "settles honestly".
    await waitForSettled(projector, 'interrupted');

    // The turn CLOSED — a `turn_end` reached the stream, which is what brings
    // every window's composer back. A stop that only stopped the generator would
    // leave the projection streaming forever and the UI lying about it.
    expect(replay(projector).some((e) => e.type === 'turn_end')).toBe(true);
    // And it did not run on past the barrier.
    expect(streamedText(projector)).not.toContain('unreachable');
  });

  it('reports false when there is no turn to stop', async () => {
    const runtime = new TestModeRuntime();
    expect(await runtime.interruptQuery(SESSION)).toBe(false);
  });

  it('ends a turn parked on an approval nobody will ever give', async () => {
    // The leak the gate exists to prevent: a blocked turn is still a turn, and
    // Stop has to reach it.
    scenarioStore.setForSession(SESSION, 'approval-gated');
    const runtime = new TestModeRuntime();
    const { projector } = startTurn(runtime, 'edit the notes');
    await waitForPending(projector);
    expect(projector.getStatus().lifecycle).toBe('blocked');
    expect((await runtime.getSessionSnapshot(CTX, SESSION)).pendingInteractions).toHaveLength(1);

    expect(await runtime.interruptQuery(SESSION)).toBe(true);
    await waitForSettled(projector, 'interrupted');

    expect(replay(projector).some((e) => e.type === 'turn_end')).toBe(true);
    expect(streamedText(projector)).not.toContain('APPROVED-BRANCH');
    expect(streamedText(projector)).not.toContain('DENIED-BRANCH');

    // THE HALF THAT WAS MISSING. The scenario waiting on that card is gone, so
    // the card can never be answered — and a snapshot that still advertises it
    // hands every window an immortal prompt that replies 409 to anyone who
    // presses it. `interruptQuery` resolves the interaction like the other three
    // interactive methods, and this is what proves it did.
    const snapshot = await runtime.getSessionSnapshot(CTX, SESSION);
    expect(snapshot.pendingInteractions).toEqual([]);
    expect(replay(projector).some((e) => e.type === 'interaction_resolved')).toBe(true);
  });

  it('resolves EVERY stranded card when a batch of them is interrupted', async () => {
    scenarioStore.setForSession(SESSION, 'approval-batch');
    const runtime = new TestModeRuntime();
    const { projector } = startTurn(runtime, 'do the three things');
    await waitForPending(projector, 3);

    expect(await runtime.interruptQuery(SESSION)).toBe(true);
    await waitForSettled(projector, 'interrupted');

    // All three, not just the first: a stop resolves the whole parked set.
    expect((await runtime.getSessionSnapshot(CTX, SESSION)).pendingInteractions).toEqual([]);
  });
});
