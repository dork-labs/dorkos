/**
 * DOR-1770: an expired envelope is refused at every seam.
 *
 * Two handlers read the same field of the same envelope and used to give
 * opposite answers. The scheduled-run path refused a message whose `budget.ttl`
 * had passed; the agent-turn path handed it `defaultTimeoutMs` — a fresh full
 * deadline — and ran it as if it had just arrived. This suite is the pin: one
 * envelope, one clock, both handlers, and the same answer.
 *
 * The policy and each seam's refusal shape are written down in
 * `packages/relay/src/lib/envelope-ttl.ts`.
 *
 * ## Not one wall-clock reading anywhere
 *
 * Every budget is dated from {@link EPOCH} and every handler is handed a fixed
 * clock, for the reason `inbound-turn-budgets.test.ts` states at length: a
 * deadline read off the wall clock counts the handler's own startup against the
 * message, so a fixture that is live by a millisecond when it is written is
 * expired by the time the code reads it — and then the test proves nothing about
 * the branch it names.
 */
import { describe, it, expect, vi } from 'vitest';
import type { RelayEnvelope, RelayBudget } from '@dorkos/shared/relay-schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { handleAgentMessage } from '../agent-handler.js';
import { handleTasksMessage } from '../task-handler.js';
import { AbortRegistry } from '../../../lib/abort-registry.js';
import type { AgentRuntimeLike, TasksStoreLike } from '../types.js';
import type { RelayPublisher, TraceStoreLike } from '../../../types.js';

/** The one instant every budget here is dated from. */
const EPOCH = Date.UTC(2026, 8, 3, 10, 0, 0);

/** A clock that never moves, so a deadline is spent in milliseconds the test owns. */
const now = (): number => EPOCH;

const AGENT_ID = 'agent-01';
const AGENT_SUBJECT = `relay.agent.default.${AGENT_ID}`;
const TASK_SUBJECT = 'relay.system.tasks.nightly';
const RUN_ID = 'run-1';

/** How much time an envelope in a given case has left, in milliseconds. */
const EXPIRED = -1;
/** Exactly on the deadline. The boundary is inclusive: no time left is expired. */
const ON_THE_DEADLINE = 0;
const BARELY_ALIVE = 1;

/** What a person is told when their message went stale before an agent got to it. */
const REFUSED = 'The message expired before the agent could start';

function budget(ttlOffsetMs: number): RelayBudget {
  return {
    hopCount: 1,
    maxHops: 5,
    ancestorChain: [],
    ttl: EPOCH + ttlOffsetMs,
    callBudgetRemaining: 9,
  };
}

function agentEnvelope(
  ttlOffsetMs: number,
  replyTo = 'relay.a2a.reply.task-1.nonce'
): RelayEnvelope {
  return {
    id: 'msg-agent-1',
    subject: AGENT_SUBJECT,
    from: 'relay.agent.default.agent-02',
    replyTo,
    budget: budget(ttlOffsetMs),
    createdAt: new Date(EPOCH).toISOString(),
    payload: { content: 'is anyone still reading this?' },
  };
}

function taskEnvelope(ttlOffsetMs: number): RelayEnvelope {
  return {
    id: 'msg-task-1',
    subject: TASK_SUBJECT,
    from: 'relay.system.scheduler',
    budget: budget(ttlOffsetMs),
    createdAt: new Date(EPOCH).toISOString(),
    payload: {
      type: 'task_dispatch',
      taskId: 'task-1',
      runId: RUN_ID,
      prompt: 'run the nightly report',
      cwd: null,
      permissionMode: 'default',
      taskName: 'Nightly',
      cron: null,
      trigger: 'schedule',
    },
  };
}

/** A runtime that would answer instantly, so nothing but the refusal can stop it. */
function willingRuntime(): AgentRuntimeLike {
  return {
    ensureSession: vi.fn(),
    sendMessage: vi.fn().mockImplementation(() =>
      (async function* () {
        yield { type: 'text_delta', data: { text: 'here you go' } } as StreamEvent;
        yield { type: 'done', data: {} } as StreamEvent;
      })()
    ),
    getSdkSessionId: vi.fn().mockReturnValue(undefined),
    approveTool: vi.fn().mockReturnValue(true),
    interruptQuery: vi.fn().mockResolvedValue(true),
  };
}

function traceStore(): TraceStoreLike {
  return { insertSpan: vi.fn(), updateSpan: vi.fn() };
}

function publisher(): RelayPublisher {
  return {
    publish: vi.fn().mockResolvedValue({ messageId: 'resp-1', deliveredTo: 1 }),
    onSignal: vi.fn().mockReturnValue(() => {}),
    subscribe: vi.fn().mockReturnValue(() => {}),
  };
}

/**
 * Drive the agent-turn seam with one envelope.
 *
 * @param envelope - The message to deliver.
 * @param runtime - The runtime that would answer it.
 * @param relay - Where its replies go.
 * @param opts - `clock` overrides the fixed clock (the window case moves time
 *   on purpose); `controller` is the turn handle, when a case needs to read it
 *   back afterwards.
 */
function deliverToAgent(
  envelope: RelayEnvelope,
  runtime: AgentRuntimeLike,
  relay: RelayPublisher,
  opts: { clock?: () => number; controller?: AbortController } = {}
) {
  const clock = opts.clock ?? now;
  return handleAgentMessage(
    AGENT_SUBJECT,
    envelope,
    undefined,
    clock(),
    {
      agentManager: runtime,
      traceStore: traceStore(),
      turnController: opts.controller ?? new AbortController(),
      now: clock,
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    },
    relay
  );
}

/** Drive the scheduled-run seam with one envelope. */
function deliverToTask(envelope: RelayEnvelope, runtime: AgentRuntimeLike, store: TasksStoreLike) {
  return handleTasksMessage(
    TASK_SUBJECT,
    envelope,
    undefined,
    now(),
    { defaultCwd: '/tmp' },
    {
      agentManager: runtime,
      traceStore: traceStore(),
      taskStore: store,
      runningTasks: new AbortRegistry(),
      now,
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }
  );
}

describe('an expired envelope is refused at every seam (DOR-1770)', () => {
  describe('the agent-turn seam', () => {
    it('starts nothing: no session, no send, nothing billed', async () => {
      const runtime = willingRuntime();

      const result = await deliverToAgent(agentEnvelope(EXPIRED), runtime, publisher());

      // The bug this closes: `ttlRemaining > 0 ? ttlRemaining : defaultTimeoutMs`
      // handed an hour-old message a fresh five-minute deadline, and this call
      // happened. A refusal that still calls `sendMessage` is not a refusal.
      expect(runtime.sendMessage).not.toHaveBeenCalled();
      expect(runtime.ensureSession).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.error).toBe(REFUSED);
    });

    it('says so out loud — a terminal error, then done, so nobody is left waiting', async () => {
      const relay = publisher();

      await deliverToAgent(agentEnvelope(EXPIRED), willingRuntime(), relay);

      // Silence is what hangs a caller: a reply reader settles on the first
      // non-progress payload, and a bare `done` reads as a finished answer. So
      // the refusal goes out as an error event first, and the `done` after it.
      const types = vi
        .mocked(relay.publish)
        .mock.calls.map(([, payload]) => (payload as Record<string, unknown>).type);
      const errorIdx = types.indexOf('error');
      const doneIdx = types.lastIndexOf('done');
      expect(errorIdx).toBeGreaterThanOrEqual(0);
      expect(doneIdx).toBeGreaterThan(errorIdx);

      const errorPayload = vi.mocked(relay.publish).mock.calls[errorIdx]![1] as {
        data: { message: string };
      };
      expect(errorPayload.data.message).toBe(REFUSED);
    });

    it('carries the refusal on the one payload an inbox reader is told is terminal', async () => {
      const relay = publisher();

      await deliverToAgent(agentEnvelope(EXPIRED, 'relay.inbox.sender'), willingRuntime(), relay);

      const calls = vi.mocked(relay.publish).mock.calls;
      const final = calls[calls.length - 1]![1] as { type: string; done: boolean; error?: string };
      expect(final).toMatchObject({ type: 'agent_result', done: true });
      expect(final.error).toBe(REFUSED);
    });

    it('refuses a message that is exactly on its deadline — no time left is no time', async () => {
      const runtime = willingRuntime();

      await deliverToAgent(agentEnvelope(ON_THE_DEADLINE), runtime, publisher());

      // The inclusive boundary, pinned. Loosening `isExpired` to a strict `<`
      // lets a turn with zero milliseconds start here — and start on the other
      // side of the publish gate too, which is the drift the shared predicate
      // exists to make impossible.
      expect(runtime.sendMessage).not.toHaveBeenCalled();
    });

    it('still runs a message with a millisecond left — refusal is for expiry, not for haste', async () => {
      const runtime = willingRuntime();

      await deliverToAgent(agentEnvelope(BARELY_ALIVE), runtime, publisher());

      expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('a turn that passes the deadline check always GETS a deadline', async () => {
      // **The regression this closes.** The check and the deadline used to be
      // two separate readings of the clock, with `ensureSession` and a
      // synchronous span write in between. An envelope live at the first
      // reading and dead at the second was bounded by NEITHER: no refusal,
      // because it was alive when that was asked, and no timer either, because
      // by the second reading there was no positive remainder left to schedule.
      // The turn then ran with no deadline at all, holding a capacity slot and
      // its session's queue entry until the model stopped on its own — a strict
      // regression on the old `defaultTimeoutMs` fallback, which at least always
      // scheduled something.
      //
      // Time here slips forward ten seconds at `ensureSession`, which is exactly
      // the gap the two old readings straddled — no counting of clock reads
      // required, so this stays honest if the handler grows another one.
      const controller = new AbortController();
      let slipped = false;
      const slippingClock = (): number => (slipped ? EPOCH + 10_000 : EPOCH);

      const runtime: AgentRuntimeLike = {
        ensureSession: vi.fn(() => {
          slipped = true;
        }),
        sendMessage: vi.fn().mockImplementation(() =>
          (async function* () {
            yield { type: 'text_delta', data: { text: 'working' } } as StreamEvent;
            // Ends when the deadline lands. The bounded fallback is there so a
            // build with NO deadline fails an assertion instead of hanging the
            // runner — it is five times the deadline, so it never wins a race
            // against a turn that was bounded properly.
            await Promise.race([
              new Promise<void>((resolve) => {
                if (controller.signal.aborted) resolve();
                else controller.signal.addEventListener('abort', () => resolve(), { once: true });
              }),
              new Promise<void>((resolve) => setTimeout(resolve, 500)),
            ]);
          })()
        ),
        getSdkSessionId: vi.fn().mockReturnValue(undefined),
        approveTool: vi.fn().mockReturnValue(true),
        interruptQuery: vi.fn().mockResolvedValue(true),
      };

      // 100ms left when the decision is taken; 9.9 seconds overdrawn after.
      await deliverToAgent(agentEnvelope(100), runtime, publisher(), {
        clock: slippingClock,
        controller,
      });

      // Loud rather than vacuous: if the turn were refused instead, everything
      // below would pass for the wrong reason.
      expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
      // The property: it started, so it was bounded. Nothing that runs here may
      // run without a deadline.
      expect(controller.signal.aborted).toBe(true);
    });
  });

  describe('the scheduled-run seam', () => {
    it('starts nothing, and records the refusal on the run rather than leaving it running', async () => {
      const runtime = willingRuntime();
      const store: TasksStoreLike = { updateRun: vi.fn() };

      const result = await deliverToTask(taskEnvelope(EXPIRED), runtime, store);

      expect(runtime.sendMessage).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(store.updateRun).toHaveBeenCalledWith(
        RUN_ID,
        expect.objectContaining({
          status: 'failed',
          error: 'Run timed out (TTL budget expired)',
        })
      );
    });

    it('refuses a run that is exactly on its deadline, on the same boundary the turn uses', async () => {
      const runtime = willingRuntime();

      await deliverToTask(taskEnvelope(ON_THE_DEADLINE), runtime, { updateRun: vi.fn() });

      expect(runtime.sendMessage).not.toHaveBeenCalled();
    });

    it('still runs a message with a millisecond left', async () => {
      const runtime = willingRuntime();

      await deliverToTask(taskEnvelope(BARELY_ALIVE), runtime, { updateRun: vi.fn() });

      expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    });
  });

  it('gives the SAME answer on both paths — the disagreement this closes', async () => {
    const agentRuntime = willingRuntime();
    const taskRuntime = willingRuntime();

    const [agentResult, taskResult] = await Promise.all([
      deliverToAgent(agentEnvelope(EXPIRED), agentRuntime, publisher()),
      deliverToTask(taskEnvelope(EXPIRED), taskRuntime, { updateRun: vi.fn() }),
    ]);

    // Same envelope shape, same expired budget, same clock — so the two seams
    // must not disagree about whether it runs.
    expect(agentRuntime.sendMessage).not.toHaveBeenCalled();
    expect(taskRuntime.sendMessage).not.toHaveBeenCalled();
    expect(agentResult.success).toBe(false);
    expect(taskResult.success).toBe(false);
    // And both are dead-lettered, exactly as a turn that died on its TTL
    // mid-stream already was: the message was carried but never acted on.
    expect(agentResult.deadLettered).toBe(true);
    expect(taskResult.deadLettered).toBe(true);
  });
});
