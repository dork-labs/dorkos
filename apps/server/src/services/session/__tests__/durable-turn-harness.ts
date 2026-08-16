/**
 * Shared conformance support: drive ONE real turn of a runtime through the
 * ACTUAL trigger path — `getOrCreateProjector` → `feedProjector` — the way
 * `POST /api/sessions/:id/messages` does, and let a conformance suite observe
 * the result.
 *
 * Two harnesses, both injected into `runtimeConformance` as opts because
 * `packages/test-utils` cannot import server internals:
 *
 * - {@link driveDurableTurn} (`durableHistory`) proves history survives a
 *   restart for a log-backed runtime (DOR-189).
 * - {@link drivePresenceTurn} (`presenceTurn`) opens a turn, hands control back
 *   while it is OPEN, and again once it has closed — the only way the presence
 *   assertions can watch a lifecycle actually transition. A runtime's own
 *   `sendMessage` generator moves no projector by itself (it is a pure event
 *   producer), so a presence case driven off `sendMessage` alone reads `idle`
 *   for every runtime at every moment and asserts nothing.
 *
 * Not a test file (no `.test.ts` suffix) — a test-support module only.
 *
 * @module services/session/__tests__/durable-turn-harness
 */
import { randomUUID } from 'node:crypto';
import { createTestDb } from '@dorkos/test-utils/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { HistoryMessage, StreamEvent } from '@dorkos/shared/types';
import {
  SessionEventStore,
  setSessionEventStore,
  getOrCreateProjector,
  disposeProjector,
  feedProjector,
  readLogBackedHistory,
  dispatchMessage,
  listQueuedMessages,
  MessageQueueStore,
  setMessageQueueStore,
} from '../index.js';
import { resetMessageDispatcher } from '../message-dispatcher.js';
import { resetStagedContextStore } from '../staged-context-store.js';

/**
 * Run one complete turn of `runtime` through a persistence-enabled projector
 * backed by a fresh in-memory store, drop the live projector (the server-restart
 * analog), and return the history reconstructed durably from the store.
 *
 * @param runtime - The log-backed runtime under test (its real `sendMessage`)
 * @param sessionId - A unique session id for this turn
 * @param content - The user message to send
 * @param cwd - The working directory for the turn
 */
export async function driveDurableTurn(
  runtime: AgentRuntime,
  sessionId: string,
  content: string,
  cwd: string
): Promise<HistoryMessage[]> {
  const store = new SessionEventStore(createTestDb());
  setSessionEventStore(store);
  try {
    const projector = getOrCreateProjector(sessionId, cwd, { persist: 'history' });
    await feedProjector(projector, runtime.sendMessage(sessionId, content, { cwd }), {
      userMessage: content,
    });
    // Restart analog: the live projector is gone; history must read durably.
    disposeProjector(sessionId);
    return readLogBackedHistory(sessionId);
  } finally {
    setSessionEventStore(undefined);
  }
}

/**
 * Yield every event of `source`, calling `probe` exactly once while the turn is
 * still OPEN.
 *
 * The probe fires after the consumer has ingested the first event — a `yield`
 * resumes only when the consumer asks for the next item, so by then
 * `feedProjector` has projected both its synthesized `turn_start` and that
 * event. The `done` case is special: it CLOSES the turn, so the probe runs
 * before it is handed over. A stream that ends without yielding anything is
 * probed after the loop, still ahead of `feedProjector`'s closing `finally`.
 *
 * @param source - The runtime's own StreamEvent generator for one turn.
 * @param probe - Called once, with the turn open.
 */
async function* probeWhileOpen(
  source: AsyncIterable<StreamEvent>,
  probe: () => Promise<void>
): AsyncGenerator<StreamEvent> {
  let probed = false;
  for await (const event of source) {
    if (!probed && event.type === 'done') {
      await probe();
      probed = true;
    }
    yield event;
    if (!probed) {
      await probe();
      probed = true;
    }
  }
  if (!probed) await probe();
}

/**
 * Run one complete turn of `runtime` through the projector the trigger path
 * feeds, pausing to let the caller read the runtime's presence twice: once
 * with the turn OPEN, once after it has closed.
 *
 * The projector is created here — the same module-global registry entry the
 * runtime's own `getSessionSnapshot` resolves — so what the caller reads is the
 * adapter answering about a turn that is genuinely running. Disposed at the end
 * so no live projection outlives the test.
 *
 * @param runtime - The runtime under test (its real `sendMessage`).
 * @param sessionId - A unique session id for this turn.
 * @param content - The user message to send.
 * @param cwd - The working directory for the turn.
 * @param probes.midTurn - Called once with the turn open.
 * @param probes.afterTurn - Called once after the turn has closed.
 */
export async function drivePresenceTurn(
  runtime: AgentRuntime,
  sessionId: string,
  content: string,
  cwd: string,
  probes: { midTurn: () => Promise<void>; afterTurn: () => Promise<void> }
): Promise<void> {
  const projector = getOrCreateProjector(sessionId, cwd);
  try {
    await feedProjector(
      projector,
      probeWhileOpen(runtime.sendMessage(sessionId, content, { cwd }), probes.midTurn),
      { userMessage: content }
    );
    await probes.afterTurn();
  } finally {
    disposeProjector(sessionId);
  }
}

/**
 * How a runtime's `dispositionTurn` driver holds a turn OPEN across `midTurn` and
 * then lets it close. Both halves are runtime-specific because "a turn is open"
 * means different things per adapter: test-mode's turn is open while its scenario
 * generator is live (`interactionGate.isOpen`), claude-code's while a persistent
 * window is unanswered — there is no portable way to hold or release one.
 */
export interface DispositionTurnControl {
  /**
   * Resolve once the turn's window is GENUINELY open — a steer delivered now
   * would find a turn to join. Polling the projector's lifecycle alone is not
   * enough: `feedProjector` ingests `turn_start` before it has pulled the first
   * event from `sendMessage`, so the runtime's own "is a turn open" gate can
   * still read false at `streaming`. The driver knows its adapter's real signal.
   */
  awaitOpen: () => Promise<void>;
  /** End the held-open turn so it can reach its terminal and close. */
  endTurn: () => void | Promise<void>;
}

/**
 * Drive ONE turn to the point where it is OPEN, call `midTurn`, then let it close
 * — the harness behind the C1 disposition-honesty case
 * (`RuntimeConformanceOpts.dispositionTurn`).
 *
 * A steer only reaches a turn that is already running, so a conformance case that
 * asserts "a declared steer delivers into the open turn, minting no new
 * `turn_start`" needs a turn genuinely open underneath it — and a runtime's own
 * `sendMessage` moves no projector by itself, so the turn is driven through the
 * SAME `getOrCreateProjector` → `feedProjector` seam the trigger path uses. What
 * the suite reads back with `getSessionSnapshot` mid-`midTurn` is therefore the
 * adapter answering about a turn that is really streaming.
 *
 * The `control` closures are the adapter-specific part: `awaitOpen` waits for the
 * window this adapter would let a steer join, and `endTurn` releases it. The
 * projector plumbing here is common; those two are not (see
 * {@link DispositionTurnControl}).
 *
 * @param runtime - The runtime under test (its real `sendMessage`).
 * @param sessionId - A unique session id for this turn.
 * @param content - The user message that opens the turn.
 * @param cwd - The working directory for the turn.
 * @param probes.midTurn - Called once with the turn open — where the suite steers
 *   and stages and reads presence.
 * @param control - How this adapter holds the window open and then releases it.
 */
export async function driveDispositionTurn(
  runtime: AgentRuntime,
  sessionId: string,
  content: string,
  cwd: string,
  probes: { midTurn: () => Promise<void> },
  control: DispositionTurnControl
): Promise<void> {
  const projector = getOrCreateProjector(sessionId, cwd);
  try {
    // Started, NOT awaited: the turn is held open (test-mode's scenario keeps
    // streaming, claude-code's window stays unanswered), so this promise does
    // not settle until `endTurn` releases it below.
    const running = feedProjector(projector, runtime.sendMessage(sessionId, content, { cwd }), {
      userMessage: content,
    });
    await control.awaitOpen();
    await probes.midTurn();
    await control.endTurn();
    await running;
  } finally {
    disposeProjector(sessionId);
  }
}

/**
 * Drive one turn WINDOW that carries two native terminals with no reopening
 * content between them, and report how many `turn_end` events the projector
 * synthesized — the harness behind the C2 terminal-exactly-once case
 * (`RuntimeConformanceOpts.terminalOnce`).
 *
 * The C2 invariant lives in `feedProjector`'s idempotent `closeTurn` (spec
 * `persistent-session-runtime` P0 / task 0.1): a stream can carry more than one
 * native `result` in ONE window — the persistent pump coalesces a dequeued batch
 * into a single turn that answers with several — and every one but the first must
 * be a no-op. So this feeds a two-`done` single-window stream (two terminals,
 * nothing between them that {@link probeWhileOpen}'s reopen rule would treat as a
 * new window) through the REAL projector and counts the `turn_end`s it produced.
 *
 * It is deliberately runtime-neutral: the terminal-collapse is `feedProjector`'s
 * job, not any adapter's, so the input is a synthetic backend rather than the
 * runtime under test — "however many native results the backend produced" is
 * exactly the variable C2 pins, and no shipped adapter emits two in one window on
 * demand. The suite asserts the count is `1`; seeding the defect (removing the
 * `if (!turnOpen) return` guard in `session-event-normalizer.ts`) makes it climb,
 * which is how the check is proved able to fail.
 *
 * @param cwd - The working directory the projector is keyed under.
 * @returns The number of `turn_end` events the projector synthesized.
 */
export async function driveTerminalOnce(cwd: string): Promise<number> {
  const sessionId = randomUUID();
  const projector = getOrCreateProjector(sessionId, cwd);
  try {
    async function* twoNativeResults(): AsyncGenerator<StreamEvent> {
      yield { type: 'text_delta', data: { text: 'one window' } } as StreamEvent;
      // First native result closes the window.
      yield { type: 'done', data: {} } as StreamEvent;
      // A SECOND native result in the SAME window: no content between them, so
      // nothing reopens it. A runtime with a persistent query does this every
      // time a coalesced batch answers with more than one result.
      yield { type: 'done', data: {} } as StreamEvent;
    }
    await feedProjector(projector, twoNativeResults(), { userMessage: 'c2 terminal-once' });
    return projector.replayFrom(0).filter((event) => event.type === 'turn_end').length;
  } finally {
    disposeProjector(sessionId);
  }
}

/** What {@link driveQueueDurability} observed about the server-owned queue. */
export interface QueueDurabilityReport {
  /** A message queued behind a turn that FAILED still ran once the turn settled. */
  ranBehindFailedTurn: boolean;
  /** A message queued behind an OPEN interaction did NOT run while it was pending. */
  heldWhileInteractionPending: boolean;
  /** That same message DID run once the interaction was resolved. */
  ranAfterInteractionResolved: boolean;
}

/** Let queued microtasks and the pump's `queueMicrotask` deferral drain. */
async function settleQueue(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
}

/** A promise plus the function that resolves it. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/**
 * Exercise the two durability promises of the server-owned queue against the REAL
 * dispatcher, projector, and SQLite store — the harness behind the C3 case
 * (`RuntimeConformanceOpts.queueDurability`).
 *
 * The queue is server-owned by construction (spec `persistent-session-runtime`
 * §2.4: "the server always owns the queue, so every runtime supports queueing")
 * — there is no `supportsQueue` flag and no adapter can opt out — so C3 is a
 * platform invariant every runtime inherits rather than a per-adapter behavior.
 * It is driven with a controllable {@link FakeAgentRuntime} because the two
 * failure modes it guards against require a turn that PARKS on command (a held
 * failure, an open approval), which no shipped adapter's mocked backend can be
 * made to do inside the conformance harness. The subject is the queue, and the
 * queue is the same object behind every runtime.
 *
 * Two rules, each a bug every queue-capable tool has shipped:
 * - a message queued behind a turn that FAILS still runs (the failed turn frees
 *   the queue like any other — it does not eat the message behind it),
 * - a message never runs while a pending interaction is open (firing a queued
 *   prompt into an open approval is read as the person's reply — OpenCode #2609,
 *   Gemini #17719), and runs the moment the interaction resolves.
 *
 * Self-contained: it stands up its own store, resets the process-global
 * dispatcher state on the way out, and uses its own session ids, so it neither
 * needs nor leaves shared setup.
 *
 * @param cwd - A NON-git directory for the driven turns. Passed so the per-turn
 *   neutral-context assembly (`git status`) fails fast instead of scanning a real
 *   repo: a conformance file that mocks `validateBoundary` to succeed would
 *   otherwise run `git status` against the whole checkout on every turn, and the
 *   several-second delay outruns the assertion. A path that does not exist
 *   `ENOENT`s immediately — the same fast answer the unmocked boundary gives.
 * @returns What it observed for each rule; the suite asserts all three are true.
 */
export async function driveQueueDurability(
  cwd = '/nonexistent-c3-queue-conformance'
): Promise<QueueDurabilityReport> {
  const store = new MessageQueueStore(createTestDb());
  setMessageQueueStore(store);
  const runtime = new FakeAgentRuntime();
  runtime.getInternalSessionId.mockReturnValue(undefined);

  const failSession = randomUUID();
  const interactionSession = randomUUID();
  try {
    // Rule 1: a message queued behind a turn that FAILS still runs.
    const failHold = gate();
    runtime.withScenarios([
      async function* (): AsyncGenerator<StreamEvent> {
        yield { type: 'text_delta', data: { text: 'working' } } as StreamEvent;
        await failHold.wait;
        throw new Error('the runtime fell over');
      },
      async function* (): AsyncGenerator<StreamEvent> {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);
    await dispatchMessage({
      sessionId: failSession,
      clientId: 'c3',
      content: 'a turn that will fail',
      cwd,
      projector: getOrCreateProjector(failSession, cwd),
      runtime,
    });
    await dispatchMessage({
      sessionId: failSession,
      clientId: 'c3',
      content: 'queued behind the failure',
      cwd,
      projector: getOrCreateProjector(failSession, cwd),
      runtime,
    });
    await settleQueue();
    const beforeFailure = runtime.sendMessage.mock.calls.length; // 1: only the first ran
    failHold.open();
    await settleQueue();
    const ranBehindFailedTurn = beforeFailure === 1 && runtime.sendMessage.mock.calls.length === 2;

    // Rule 2: a message queued behind an OPEN interaction waits, then runs on
    // resolution. A fresh runtime so the call count starts clean.
    const runtime2 = new FakeAgentRuntime();
    runtime2.getInternalSessionId.mockReturnValue(undefined);
    const approvalHold = gate();
    runtime2.withScenarios([
      async function* (): AsyncGenerator<StreamEvent> {
        yield {
          type: 'approval_required',
          data: {
            toolCallId: 'c3-call',
            toolName: 'Bash',
            input: '{}',
            timeoutMs: 60_000,
            remainingMs: 60_000,
          },
        } as unknown as StreamEvent;
        await approvalHold.wait;
        yield { type: 'done', data: {} } as StreamEvent;
      },
      async function* (): AsyncGenerator<StreamEvent> {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);
    const projector = getOrCreateProjector(interactionSession, cwd);
    await dispatchMessage({
      sessionId: interactionSession,
      clientId: 'c3',
      content: 'runs something that asks',
      cwd,
      projector,
      runtime: runtime2,
    });
    await dispatchMessage({
      sessionId: interactionSession,
      clientId: 'c3',
      content: 'queued behind the approval',
      cwd,
      projector,
      runtime: runtime2,
    });
    await settleQueue();
    // The turn ENDS with the approval unanswered (a stall/interrupt): the queue
    // must not move into an ask nobody replied to.
    approvalHold.open();
    await settleQueue();
    const heldWhileInteractionPending =
      projector.hasPendingInteractions() &&
      runtime2.sendMessage.mock.calls.length === 1 &&
      listQueuedMessages(interactionSession).length === 1;
    // Answered — now, and only now, the queue moves.
    projector.resolveInteraction('c3-call', 'approved');
    await settleQueue();
    const ranAfterInteractionResolved = runtime2.sendMessage.mock.calls.length === 2;

    return { ranBehindFailedTurn, heldWhileInteractionPending, ranAfterInteractionResolved };
  } finally {
    resetMessageDispatcher();
    resetStagedContextStore();
    setMessageQueueStore(undefined);
    disposeProjector(failSession);
    disposeProjector(interactionSession);
  }
}
