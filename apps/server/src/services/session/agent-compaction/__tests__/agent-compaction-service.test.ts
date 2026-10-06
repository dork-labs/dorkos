/**
 * An agent asking for its own conversation to be summarized (DOR-2732), driven
 * through the real service and the real dispatcher against `FakeAgentRuntime`.
 *
 * The promises this pins:
 *
 * - it only ever reaches the CALLER's conversation, and refuses plainly when
 *   there is none or it is not loaded;
 * - it never runs mid-turn: nothing is dispatched while the asking turn runs,
 *   and exactly one compaction runs once it ends — a second request while one
 *   is waiting does not make two;
 * - the boundary it produces says the agent asked, and how full it was;
 * - a runtime that cannot summarize on request is refused honestly;
 * - once an hour per session.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { StreamEvent } from '@dorkos/shared/types';
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';

vi.mock('../../context-assembler.js', () => ({
  assembleAdditionalContext: vi.fn(async () => []),
}));

import {
  dispatchMessage,
  hasPendingAgentCompaction,
  scheduleAgentCompaction,
  noteSessionOrphaned,
  noteTurnBoundary,
  resetMessageDispatcher,
  sweepOrphanedMessageQueues,
} from '../../message-dispatcher.js';
import { linkSessionId } from '../../session-key-registry.js';
import { SESSIONS } from '../../../../config/constants.js';
import { disposeProjector, getOrCreateProjector } from '../../session-state-projector.js';
import { AgentCompactionService } from '../agent-compaction-service.js';
import { CompactionRequestBudget } from '../compaction-budget.js';

let runtime: FakeAgentRuntime;
let session: string;
let counter = 0;
let gates: Array<() => void>;
let now: number;

/** A promise plus its opener, registered so teardown can unpark it. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  gates.push(open);
  return { wait, open };
}

/** A turn that streams, parks on `hold`, then ends. */
function heldTurn(hold: Promise<void>) {
  return async function* (): AsyncGenerator<StreamEvent> {
    yield { type: 'text_delta', data: { text: 'working' } } as StreamEvent;
    await hold;
    yield { type: 'done', data: {} } as StreamEvent;
  };
}

/** Let queued microtasks and the pump's deferral drain. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
}

/** The agent's turn: open on the session until `open()` is called. */
async function startAgentTurn(): Promise<() => void> {
  const turn = gate();
  runtime.withScenarios([heldTurn(turn.wait)]);
  await dispatchMessage({
    sessionId: session,
    clientId: 'window-a',
    content: 'keep going',
    projector: getOrCreateProjector(session),
    runtime,
  });
  await settle();
  return turn.open;
}

function service(opts: { isBlocked?: () => Promise<boolean> } = {}): AgentCompactionService {
  return new AgentCompactionService({
    resolveRuntime: async () => runtime,
    budget: new CompactionRequestBudget({ now: () => now }),
    isBlocked: opts.isBlocked ?? (async () => false),
  });
}

beforeEach(() => {
  counter += 1;
  session = `00000000-0000-4000-9000-${String(counter).padStart(12, '0')}`;
  gates = [];
  now = Date.parse('2026-10-06T12:00:00.000Z');
  runtime = new FakeAgentRuntime();
  runtime.getInternalSessionId.mockReturnValue(undefined);
});

afterEach(async () => {
  for (const open of gates) open();
  await settle();
  resetMessageDispatcher();
  disposeProjector(session);
  vi.restoreAllMocks();
});

describe('compact_my_session — whose conversation', () => {
  it('refuses a call that came from no conversation, and schedules nothing', async () => {
    const outcome = await service().request({});
    expect(outcome).toMatchObject({ status: 'refused', code: 'no-session' });
    await settle();
    expect(runtime.executeCommandIntent).not.toHaveBeenCalled();
  });

  it('refuses a conversation that is not loaded, naming it', async () => {
    const outcome = await service().request({ sessionId: 'not-a-live-session' });
    expect(outcome).toMatchObject({ status: 'refused', code: 'unknown-session' });
    expect(outcome.message).toContain('not-a-live-session');
    await settle();
    expect(runtime.executeCommandIntent).not.toHaveBeenCalled();
  });

  it('summarizes only the session it was asked from', async () => {
    const other = `${session}-other`;
    runtime.hasSession.mockImplementation((id) => id === session || id === other);

    const outcome = await service().request({ sessionId: session });
    await settle();

    expect(outcome.status).toBe('scheduled');
    expect(runtime.executeCommandIntent).toHaveBeenCalledTimes(1);
    expect(runtime.executeCommandIntent.mock.calls[0]![0]).toBe(session);
    disposeProjector(other);
  });
});

describe('compact_my_session — after the turn, never during it', () => {
  it('dispatches nothing while the asking turn runs, then exactly once when it ends', async () => {
    const endTurn = await startAgentTurn();

    const first = await service().request({ sessionId: session, note: 'the open migration' });
    const second = await service().request({ sessionId: session });
    await settle();

    expect(first.status).toBe('scheduled');
    expect(second.status).toBe('already-scheduled');
    expect(runtime.executeCommandIntent).not.toHaveBeenCalled();

    endTurn();
    await settle();

    expect(runtime.executeCommandIntent).toHaveBeenCalledTimes(1);
    expect(runtime.executeCommandIntent).toHaveBeenCalledWith(
      session,
      'compact',
      expect.objectContaining({ instructions: 'the open migration' })
    );
  });

  it('waits out a pending approval as well as the turn', async () => {
    const endTurn = await startAgentTurn();
    const projector = getOrCreateProjector(session);
    const asking = vi.spyOn(projector, 'hasPendingInteractions').mockReturnValue(true);

    await service().request({ sessionId: session });
    endTurn();
    await settle();
    expect(runtime.executeCommandIntent).not.toHaveBeenCalled();

    asking.mockReturnValue(false);
    // An answered ask is a turn boundary; it is what moves anything waiting.
    const { noteTurnBoundary } = await import('../../message-dispatcher.js');
    noteTurnBoundary(session);
    await settle();
    expect(runtime.executeCommandIntent).toHaveBeenCalledTimes(1);
  });

  it('runs ahead of a message the person queued behind the turn', async () => {
    const endTurn = await startAgentTurn();
    const order: string[] = [];
    runtime.executeCommandIntent.mockImplementation(async function* () {
      order.push('compact');
      yield { type: 'compact_boundary', data: {} } as StreamEvent;
    });
    runtime.withScenarios([
      async function* () {
        order.push('queued message');
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);

    await service().request({ sessionId: session });
    await dispatchMessage({
      sessionId: session,
      clientId: 'window-a',
      content: 'and then this',
      projector: getOrCreateProjector(session),
      runtime,
    });
    endTurn();
    await settle();
    await settle();

    expect(order).toEqual(['compact', 'queued message']);
  });

  it('stamps the boundary with who asked and how full the conversation was', async () => {
    const endTurn = await startAgentTurn();
    const projector = getOrCreateProjector(session);
    projector.seedStatus({
      contextUsage: {
        totalTokens: 178_000,
        maxTokens: 200_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    });

    await service().request({ sessionId: session });
    endTurn();
    await settle();

    const boundary = projector.replayFrom(0).find((event) => event.type === 'compact_boundary');
    expect(boundary).toMatchObject({ requestedBy: 'agent', contextPercent: 89 });
  });
});

describe('compact_my_session — refusals', () => {
  it('refuses honestly on a runtime that cannot summarize on request', async () => {
    const supported = runtime.getCapabilities();
    runtime.getCapabilities.mockReturnValue({
      ...supported,
      type: 'codex',
      commandIntents: { compact: { supported: false } },
    } as RuntimeCapabilities);
    const endTurn = await startAgentTurn();

    const outcome = await service().request({ sessionId: session });
    endTurn();
    await settle();

    expect(outcome).toMatchObject({ status: 'refused', code: 'unsupported' });
    expect(outcome.message).toContain('Codex');
    expect(runtime.executeCommandIntent).not.toHaveBeenCalled();
  });

  it('allows one request an hour, and says when the next may be made', async () => {
    runtime.hasSession.mockReturnValue(true);
    const compaction = service();

    expect((await compaction.request({ sessionId: session })).status).toBe('scheduled');
    await settle();
    expect(runtime.executeCommandIntent).toHaveBeenCalledTimes(1);

    now += 30 * 60 * 1000;
    const again = await compaction.request({ sessionId: session });
    expect(again).toMatchObject({
      status: 'refused',
      code: 'rate-limited',
      retryAfter: '2026-10-06T13:00:00.000Z',
    });
    await settle();
    expect(runtime.executeCommandIntent).toHaveBeenCalledTimes(1);

    now += 30 * 60 * 1000;
    expect((await compaction.request({ sessionId: session })).status).toBe('scheduled');
  });
});

describe('compact_my_session — turns the dispatcher never saw (review, DOR-2732)', () => {
  it('waits out a turn only the runtime can see, then runs once it ends', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      runtime.hasSession.mockReturnValue(true);
      const hold = gate();
      runtime.withScenarios([heldTurn(hold.wait)]);
      // A Relay delivery or an unattended scheduled run: the runtime is called
      // directly — no lock, no projector turn, no in-flight slot.
      const relayTurn = runtime
        .sendMessage(session, 'from another agent', {})
        [Symbol.asyncIterator]();
      await relayTurn.next();

      const outcome = await service().request({ sessionId: session });
      await vi.advanceTimersByTimeAsync(50);
      expect(outcome.status).toBe('scheduled');
      expect(runtime.executeCommandIntent).not.toHaveBeenCalled();

      // The relay turn ends; no boundary reaches the dispatcher, so the waiting
      // summary finds out on its own clock.
      hold.open();
      while (!(await relayTurn.next()).done) {
        // drain
      }
      await vi.advanceTimersByTimeAsync(SESSIONS.AGENT_COMPACTION_RECHECK_MS + 50);
      expect(runtime.executeCommandIntent).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('compact_my_session — the gates the queue head respects (review, DOR-2732)', () => {
  it('waits while a delivery the runtime owes is pending, and runs when it lands', async () => {
    runtime.hasSession.mockReturnValue(true);
    runtime.isSegmentPending.mockReturnValue(true);

    await service().request({ sessionId: session });
    await settle();
    expect(runtime.executeCommandIntent).not.toHaveBeenCalled();

    runtime.isSegmentPending.mockReturnValue(false);
    noteTurnBoundary(session);
    await settle();
    expect(runtime.executeCommandIntent).toHaveBeenCalledTimes(1);
  });

  it('waits while a message is held for the agent’s background work', async () => {
    runtime.hasSession.mockReturnValue(true);
    runtime.withScenarios([
      async function* () {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);
    runtime.holdDispatch.mockReturnValue({
      reason: 'background-work',
      holding: { agents: 1, shells: 0, other: 0 },
      pins: [],
      targetFolderName: 'repo',
      since: Date.now(),
      releaseAt: Date.now() + 60 * 60_000,
    });
    await dispatchMessage({
      sessionId: session,
      clientId: 'window-a',
      content: 'move to the other folder',
      projector: getOrCreateProjector(session),
      runtime,
    });
    await settle();

    await service().request({ sessionId: session });
    await settle();
    expect(runtime.executeCommandIntent).not.toHaveBeenCalled();

    runtime.holdDispatch.mockReturnValue(undefined);
    noteTurnBoundary(session);
    await settle();
    expect(runtime.executeCommandIntent).toHaveBeenCalledTimes(1);
  });

  it('asks the lock under the canonical id the lock is held under', async () => {
    const canonical = `${session}-canonical`;
    linkSessionId(session, canonical);
    runtime.getInternalSessionId.mockImplementation((id) =>
      id === session || id === canonical ? canonical : undefined
    );
    runtime.hasSession.mockReturnValue(true);
    runtime.isLocked.mockImplementation((id) => id === canonical);

    await service().request({ sessionId: canonical });
    await settle();
    expect(runtime.executeCommandIntent).not.toHaveBeenCalled();

    runtime.isLocked.mockReturnValue(false);
    noteTurnBoundary(session);
    await settle();
    expect(runtime.executeCommandIntent).toHaveBeenCalledTimes(1);
  });
});

describe('compact_my_session — dropped requests give the hour back (review, DOR-2732)', () => {
  it('does not run if the owner blocked it after it was asked for, and the hour comes back', async () => {
    runtime.hasSession.mockReturnValue(true);
    let blocked = false;
    const compaction = service({ isBlocked: async () => blocked });
    const endTurn = await startAgentTurn();

    expect((await compaction.request({ sessionId: session })).status).toBe('scheduled');
    blocked = true;
    endTurn();
    await settle();

    expect(runtime.executeCommandIntent).not.toHaveBeenCalled();
    expect(hasPendingAgentCompaction(session, runtime)).toBe(false);
    // Nothing was summarized, so asking again is not "once an hour" refused.
    blocked = false;
    expect((await compaction.request({ sessionId: session })).status).toBe('scheduled');
  });

  it('drops a request that waited past its ceiling, and the hour comes back', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      runtime.hasSession.mockReturnValue(true);
      runtime.isSegmentPending.mockReturnValue(true); // the session never comes free
      const compaction = service();

      expect((await compaction.request({ sessionId: session })).status).toBe('scheduled');
      expect((await compaction.request({ sessionId: session })).status).toBe('already-scheduled');
      await vi.advanceTimersByTimeAsync(SESSIONS.AGENT_COMPACTION_MAX_WAIT_MS + 10);

      expect(hasPendingAgentCompaction(session, runtime)).toBe(false);
      expect(runtime.executeCommandIntent).not.toHaveBeenCalled();
      expect((await compaction.request({ sessionId: session })).status).toBe('scheduled');
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a waiting request when its session goes away, giving the hour back', async () => {
    runtime.hasSession.mockReturnValue(true);
    runtime.isSegmentPending.mockReturnValue(true);
    const compaction = service();

    await compaction.request({ sessionId: session });
    noteSessionOrphaned(session);
    sweepOrphanedMessageQueues({ isLive: () => false });

    expect(hasPendingAgentCompaction(session, runtime)).toBe(false);
    expect((await compaction.request({ sessionId: session })).status).toBe('scheduled');
  });
});

describe('compact_my_session — a failed summary still says who asked (review, DOR-2732)', () => {
  it('tags the compaction progress, so the failure row can name the agent', async () => {
    runtime.hasSession.mockReturnValue(true);
    runtime.executeCommandIntent.mockImplementation(async function* () {
      yield {
        type: 'operation_progress',
        data: { operation: 'compaction', state: 'failed', determinate: false, error: 'no room' },
      } as StreamEvent;
    });

    await service().request({ sessionId: session });
    await settle();

    const failed = getOrCreateProjector(session)
      .replayFrom(0)
      .find((event) => event.type === 'operation_progress');
    expect(failed).toMatchObject({ state: 'failed', requestedBy: 'agent' });
  });
});

describe('compact_my_session — the percent on a first turn (live proof, DOR-2732)', () => {
  it('reads the percent at launch when the asking turn had none yet', async () => {
    const hold = gate();
    // A first turn: no reading exists until the turn reports one at its end.
    runtime.withScenarios([
      async function* () {
        yield { type: 'text_delta', data: { text: 'working' } } as StreamEvent;
        await hold.wait;
        yield {
          type: 'session_status',
          data: { contextTokens: 178_000, contextMaxTokens: 200_000 },
        } as StreamEvent;
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);
    await dispatchMessage({
      sessionId: session,
      clientId: 'window-a',
      content: 'first message',
      projector: getOrCreateProjector(session),
      runtime,
    });
    await settle();
    expect(getOrCreateProjector(session).getStatus().contextUsage).toBeNull();

    await service().request({ sessionId: session });
    hold.open();
    await settle();

    const boundary = getOrCreateProjector(session)
      .replayFrom(0)
      .find((event) => event.type === 'compact_boundary');
    expect(boundary).toMatchObject({ requestedBy: 'agent', contextPercent: 89 });
  });
});

describe('compact_my_session — the ceiling is never skipped (review, DOR-2732)', () => {
  it('drops a request whose deadline passed while its launch was out and the lock refused it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      runtime.hasSession.mockReturnValue(true);
      let finish!: (result: { accepted: boolean }) => void;
      const onDropped = vi.fn();
      scheduleAgentCompaction({
        sessionId: session,
        runtime,
        launch: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
        onDropped,
      });
      await vi.advanceTimersByTimeAsync(10);
      expect(finish).toBeDefined(); // the launch is out

      await vi.advanceTimersByTimeAsync(SESSIONS.AGENT_COMPACTION_MAX_WAIT_MS + 10);
      expect(hasPendingAgentCompaction(session, runtime)).toBe(true); // left to finish
      finish({ accepted: false }); // refused by a lock
      await vi.advanceTimersByTimeAsync(10);

      expect(hasPendingAgentCompaction(session, runtime)).toBe(false);
      expect(onDropped).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a request whose deadline passed while its permission check was out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      runtime.hasSession.mockReturnValue(true);
      let answer!: (allowed: boolean) => void;
      const launch = vi.fn(async () => ({ accepted: true }));
      scheduleAgentCompaction({
        sessionId: session,
        runtime,
        launch,
        admit: () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      });
      await vi.advanceTimersByTimeAsync(SESSIONS.AGENT_COMPACTION_MAX_WAIT_MS + 10);
      answer(true);
      await vi.advanceTimersByTimeAsync(10);

      expect(launch).not.toHaveBeenCalled();
      expect(hasPendingAgentCompaction(session, runtime)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
