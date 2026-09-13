/**
 * Tasks (scheduled job) handling for the Claude Code adapter.
 *
 * Parses TaskDispatchPayload envelopes and executes scheduled jobs
 * via the Claude Agent SDK. Integrates with the TasksStore for job
 * status tracking and the TraceStore for delivery span recording.
 *
 * @module relay/adapters/claude-code-task-handler
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import { TaskDispatchPayloadSchema } from '@dorkos/shared/relay-schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { createRunOutcomeTracker } from '@dorkos/shared/run-outcome';
import { createRefusedAskLog, withRefusedAsks } from '@dorkos/shared/run-refusals';
// The one sentence a run stopped by a clock is described with, written by this
// path and by the direct-dispatch twin in `apps/server` (DOR-1786).
import { runTimeLimitError } from '@dorkos/shared/run-time-limit';
import type { AdapterContext, DeliveryResult, TraceStoreLike } from '../../types.js';
import type { AgentRuntimeLike, RefusedAskReporter, TasksStoreLike } from './types.js';
import { OPERATOR_CANCEL } from './task-cancel-handler.js';
import type { AbortRegistry } from '../../lib/abort-registry.js';
import { interruptTurn } from './interrupt.js';
// One answer to "has this message run out of time?", shared with the publish
// gate, the agent-turn handler and the capacity line so the four cannot
// disagree. The policy — an expired envelope never runs — is written down there.
import { isExpired, ttlRemainingMs } from '../../lib/envelope-ttl.js';

/** Maximum characters to collect for run output summary. */
const OUTPUT_SUMMARY_MAX_CHARS = 1000;

/**
 * Race sentinel: the run was stopped — by a person or by its TTL budget —
 * before the agent produced its next event.
 */
const RUN_STOPPED = Symbol('run-stopped');

/**
 * Consume a run's event stream until it ends or the run's budget expires.
 *
 * Stopping has to reach the RUNTIME, not just this loop. A turn parked on a
 * tool-approval prompt yields nothing for as long as the prompt stands, so
 * checking the signal at the top of the loop body never runs again and the TTL
 * budget never bites. Two things fix that, and both are needed: `onStop` ends
 * the turn at the agent, and racing each `next()` against the signal returns
 * even if the runtime ignores the interrupt or answers slowly.
 *
 * On a stop the source is ABANDONED rather than awaited: its pending `next()`
 * is rejection-silenced and `return()` is fired without awaiting, because an
 * async generator's `return()` queues behind the pending `next()` and would
 * hang on exactly the parked turn this exists to escape.
 *
 * Deliberately duplicated from `consumeRunStream` in
 * `apps/server/src/services/tasks/run-stream.ts` (the direct-dispatch twin of
 * this path). Fix both if you fix one — since DOR-1567 dropped the progress
 * republish that used to make this copy `await` its `onEvent`, they do the same
 * work.
 *
 * A `@dorkos/shared` subpath does now exist for this pair — `run-outcome`, which
 * both callers use so the two dispatch paths cannot disagree about whether a run
 * FAILED (DOR-1658). The loop itself stays copied because what it duplicates is
 * mechanical and what it races is not: this copy still awaits its `onEvent` and
 * the server's does not, and an extra microtask per event lands in exactly the
 * window between the stream's last event and a stop, which is the one the
 * server's `turnThatEndsAsItIsStopped` test exists to pin. A judgement two paths
 * must share is worth a subpath; twenty mechanical lines with a timing
 * difference are not.
 *
 * @param stream - The agent's per-turn event stream.
 * @param signal - Aborts when the run is stopped or out of budget.
 * @param onStop - Runs once when the signal aborts; ends the turn at the agent.
 * @param onEvent - Receives each event that arrives before the stop.
 * @returns Whether a stop is what ended the run. Read this rather than the
 *   signal: a stop that lands in the moment between the stream's last event and
 *   this function returning aborts a signal nobody is waiting on any more, and
 *   a run that finished must not be recorded as one somebody stopped.
 */
async function consumeRunStream(
  stream: AsyncIterable<StreamEvent>,
  signal: AbortSignal,
  onStop: () => void,
  onEvent: (event: StreamEvent) => Promise<void> | void
): Promise<boolean> {
  const iterator = stream[Symbol.asyncIterator]();
  let onAbort!: () => void;
  const stopped = new Promise<typeof RUN_STOPPED>((resolve) => {
    onAbort = () => {
      resolve(RUN_STOPPED);
      onStop();
    };
    // A signal that aborted before we subscribed never fires the event.
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    // Exactly one pending next() at a time, so no event is ever dropped
    // between race rounds.
    let pending = iterator.next();
    for (;;) {
      const winner = await Promise.race([pending, stopped]);
      if (winner === RUN_STOPPED) {
        void pending.catch(() => {});
        void Promise.resolve(iterator.return?.()).catch(() => {});
        return true;
      }
      if (winner.done) return false;
      await onEvent(winner.value);
      pending = iterator.next();
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** Dependencies required by the tasks handler. */
export interface TasksHandlerDeps {
  agentManager: AgentRuntimeLike;
  traceStore: TraceStoreLike;
  taskStore?: TasksStoreLike;
  /**
   * Where this run's refused asks are reported, so a scheduled run that could
   * not use a tool says so in the activity feed on this path too (DOR-1580).
   *
   * Optional, and absent in most tests: without it the run's summary line is
   * still written, exactly as before.
   */
  onRefusedAsk?: RefusedAskReporter;
  /**
   * The adapter's in-flight run registry — the only handle anything outside
   * this function has on a running task (DOR-808). Required, not optional: a
   * handler that forgot to register its run is a Stop button that answers
   * "not found" for a run that is plainly executing, which is the exact bug
   * this registry exists to close.
   */
  runningTasks: AbortRegistry;
  /**
   * Where this run records the envelope it is answering, so its own
   * `relay_send*` calls continue that budget rather than minting a fresh one
   * (DOR-791). A scheduled run is an agent turn like any other and can message
   * peers from inside it; without this it started every chain over.
   */
  inboundBudgets?: import('../../inbound-turn-budgets.js').InboundTurnBudgets;
  /**
   * This run's clock, injectable so a test can pin the TTL boundary instead of
   * racing it (DOR-1729).
   *
   * The run's deadline is `envelope.budget.ttl - now()`, so reading the wall
   * clock for it makes this function's own startup part of the sum: a fixture
   * with a millisecond-scale TTL is already expired before `sendMessage` on a
   * machine under load, and the run is refused outright instead of being
   * stopped mid-stream — which is a different path from the one the test is
   * about. A fixed clock spends the budget in the unit the code spends.
   *
   * Defaults to `Date.now`, which is what every host gets: nothing wires this.
   */
  now?: () => number;
  logger?: import('@dorkos/shared/logger').Logger;
}

/** Resolved config values needed by the tasks handler. */
export interface TasksHandlerConfig {
  defaultCwd: string;
}

/**
 * Handle a relay.system.tasks.{taskId} message.
 *
 * Validates the TaskDispatchPayload, runs the agent, and updates
 * the TasksStore with the final run status (completed/failed/cancelled).
 *
 * **A task run publishes nothing while it runs**, unlike an agent turn. The
 * scheduler that dispatched it does not listen — the run row is the only thing
 * that knows how the run ends — so the progress stream this used to republish
 * to `<subject>.response` had no reader at all, and re-entered the adapter's own
 * tasks prefix as a malformed dispatch, one dead letter per event (DOR-1567).
 * If a reader for a run's progress is ever wanted, give it a subject OUTSIDE
 * this prefix, the way the stop path did.
 *
 * @param _subject - The tasks subject (unused, kept for interface consistency)
 * @param envelope - The relay envelope containing the tasks dispatch payload
 * @param context - Optional adapter context with agent directory info
 * @param startTime - Timestamp when delivery began (for durationMs calculation).
 *   An ARGUMENT rather than a clock read, so it sits outside the fence
 *   {@link TasksHandlerDeps.now} draws: source it from the same clock you
 *   inject there, or the two disagree and the duration comes out negative.
 * @param config - Resolved adapter configuration
 * @param deps - Injected dependencies
 */
export async function handleTasksMessage(
  _subject: string,
  envelope: RelayEnvelope,
  context: AdapterContext | undefined,
  startTime: number,
  config: TasksHandlerConfig,
  deps: TasksHandlerDeps
): Promise<DeliveryResult> {
  const traceId = randomUUID();
  const spanId = randomUUID();
  // Every clock read in this run, so a test that pins one pins all of them —
  // a run that took its deadline from an injected clock and its trace
  // timestamps from the wall clock would report a run that ended before it
  // started. See {@link TasksHandlerDeps.now}.
  const clock = deps.now ?? Date.now;
  const now = clock();

  // Validate tasks payload
  const parsed = TaskDispatchPayloadSchema.safeParse(envelope.payload);
  if (!parsed.success) {
    deps.traceStore.insertSpan({
      messageId: envelope.id,
      traceId,
      spanId,
      parentSpanId: null,
      subject: envelope.subject,
      fromEndpoint: envelope.from,
      toEndpoint: 'tasks:unknown',
      status: 'failed',
      budgetHopsUsed: envelope.budget.hopCount,
      budgetTtlRemainingMs: envelope.budget.ttl - now,
      sentAt: now,
      deliveredAt: now,
      processedAt: now,
      error: `Invalid TaskDispatchPayload: ${JSON.stringify(z.flattenError(parsed.error).fieldErrors)}`,
    });
    return {
      success: false,
      error: 'Invalid TaskDispatchPayload',
      durationMs: clock() - startTime,
    };
  }

  const payload = parsed.data;
  const { taskId, runId, prompt, cwd, permissionMode, systemPromptAppend } = payload;
  // What this run resolved to run on, decided by the scheduler and carried on
  // the wire (DOR-1615/DOR-1347). Spread into BOTH agent calls below, exactly as
  // `agent-handler.ts` spreads its `executionSettings` and for the same reason:
  // the claude-code runtime reads `session.model` when it LAUNCHES a query, and
  // that field is written once, at session creation — a model handed over only
  // at `sendMessage` would reach nothing — while a runtime that does not hold
  // sessions in memory sees the send and not the create. An absent key means
  // "the runtime decides", so a payload without them behaves as it always did.
  const executionSettings = {
    ...(payload.model !== undefined ? { model: payload.model } : {}),
    ...(payload.effort !== undefined ? { effort: payload.effort } : {}),
  };
  const effectiveCwd = cwd ?? context?.agent?.directory ?? config.defaultCwd;
  // The session this run runs on, decided on the scheduler side and carried here
  // on every envelope (DOR-1571). A STICKY task resolves a resume target — the
  // REAL SDK id of its previous run; every other run resolves a fresh session of
  // its own. `resumeSession` is that session's `hasStarted`: resume the existing
  // conversation, or start fresh — false for every non-sticky run and a sticky
  // task's first fire.
  //
  // The fallback is for an envelope published by an older scheduler, which
  // carried the id only for a sticky run. It used to fall back to the RUN ID,
  // and that is the one id it must not use: a run id is a ULID, every session
  // route validates a UUID, and a session under one can be opened by nobody — no
  // event stream, no approval routes, no snapshot. A fresh UUID is the same
  // isolated-per-run session that fallback always meant, minus the dead end.
  const sessionId = payload.sessionId ?? randomUUID();
  const hasStarted = payload.resumeSession ?? false;
  // The id to WRITE on the run row is the runtime's own id after the turn — the
  // id the SDK actually wrote its transcript under (`getSdkSessionId`), which a
  // sticky task's next fire resumes and which makes any run clickable through to
  // the real conversation. Resolved lazily so each terminal branch records the
  // freshest answer.
  //
  // A runtime that does not rename its own sessions (codex, opencode) declares
  // no `getSdkSessionId`, and the id it ran under is already the durable one —
  // so the same expression records the right thing for it without a branch.
  const persistedSessionId = (): string =>
    deps.agentManager.getSdkSessionId?.(sessionId) ?? sessionId;

  // Record trace span as delivered
  deps.traceStore.insertSpan({
    messageId: envelope.id,
    traceId,
    spanId,
    parentSpanId: null,
    subject: envelope.subject,
    fromEndpoint: envelope.from,
    toEndpoint: `tasks:${taskId}`,
    status: 'delivered',
    budgetHopsUsed: envelope.budget.hopCount,
    budgetTtlRemainingMs: envelope.budget.ttl - now,
    sentAt: now,
    deliveredAt: now,
    processedAt: null,
    error: null,
  });

  // Set up timeout from TTL budget. An expired envelope never runs
  // (`lib/envelope-ttl.ts`): the controller starts aborted, the throw below is
  // the refusal, and the run row it writes is how a person sees that this run
  // was refused rather than left pinned to `running`.
  //
  // ONE reading of the clock decides both halves — whether the run may start,
  // and how long it gets if it may — and the boundary between them is asked
  // through the shared predicate, so this seam and the agent turn beside it
  // cannot end up on different sides of the same millisecond.
  const ttlRemaining = ttlRemainingMs(envelope, clock);
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  if (isExpired(ttlRemaining)) {
    controller.abort();
  } else {
    timeout = setTimeout(() => controller.abort(), ttlRemaining);
  }

  // From here until the `finally` below, this run can be stopped from the
  // cockpit: the registry is what the stop-request subscription reaches for.
  deps.runningTasks.register(runId, controller);

  let outputSummary = '';
  let releaseInboundBudget: (() => void) | undefined;
  // How the turn behind this run SETTLES — the same question, and the same
  // answer, as the direct-dispatch twin in `apps/server` (DOR-1658). The rule
  // is shared rather than copied beside the loop below: a run row that says
  // "completed" on one dispatch path and "failed" on the other for the same
  // stream is the drift this is worth a subpath to avoid.
  const outcome = createRunOutcomeTracker();
  // Which asks this run was refused without anybody being consulted, on the same
  // shared rule the direct twin uses (spec
  // `unattended-session-permission-prompts`). Two records come out of it: the
  // summary line on the run row below, and — through `deps.onRefusedAsk`, since
  // this package cannot see the activity feed — the same live feed entry per
  // refused tool the direct twin writes (DOR-1580). With the relay adapter
  // connected, which is the ordinary install, this path is the one a scheduled
  // run actually takes, so the entry existed for nobody until it was wired here.
  const refusals = createRefusedAskLog();

  try {
    if (controller.signal.aborted) {
      // A run refused before it began, which is NOT what the shared time-limit
      // sentence describes: nothing ran, so nothing was "stopped". The agent
      // turn beside this one splits the same two cases for the same reason
      // (`abortText` in `agent-handler.ts`) — a person reading a run row can act
      // on "it sat too long before it started" and not on "it timed out".
      throw new Error('Run expired before it could start');
    }

    deps.agentManager.ensureSession(sessionId, {
      permissionMode,
      cwd: effectiveCwd,
      // Resume a sticky session that has already run; start fresh otherwise. This
      // explicit `ensureSession` short-circuits `sendMessage`'s transcript probe,
      // so the answer is carried on the wire (DOR-1571). The direct-dispatch twin
      // in `task-scheduler-service.ts` does the same.
      hasStarted,
      // Nobody is coming back to a run the timer started, so an ask raised in it
      // is refused the moment it is raised (spec
      // `unattended-session-permission-prompts`). Only a SCHEDULED fire: a "Run
      // now" a person clicked can travel this path too, and they are waiting in
      // front of the app for it. The direct-dispatch twin in
      // `task-scheduler-service.ts` reads the same field the same way; a run
      // must not depend on which path carried it.
      unattended: payload.trigger === 'scheduled',
      ...executionSettings,
    });

    // Tie this run to the envelope that dispatched it, for as long as it runs
    // (DOR-791). `sessionId` — not `runId` — is the key the turn executes under,
    // which is what the host's tool surface is handed, so anything this run
    // sends with `relay_send*` continues THIS budget instead of starting a fresh
    // chain. A sticky task resumes a real SDK session, and its key is that one.
    // Released in the `finally` below — except on a stop, which holds it for the
    // reason the agent turn does; see there.
    releaseInboundBudget = deps.inboundBudgets?.bind(sessionId, envelope.budget);

    const eventStream = deps.agentManager.sendMessage(sessionId, prompt, {
      permissionMode,
      cwd: effectiveCwd,
      ...executionSettings,
      // Built server-side by `buildTaskAppend` and carried on the wire, because
      // the pieces it is made of (the task's agent, the run's trigger) do not
      // otherwise reach this process. Without it a relay-dispatched run was
      // never told it was unattended and would stop to ask questions nobody
      // was there to answer (DOR-1567).
      ...(systemPromptAppend ? { systemPromptAppend } : {}),
    });

    const stopped = await consumeRunStream(
      eventStream,
      controller.signal,
      () => void interruptTurn(deps.agentManager, sessionId, `run ${runId}`, deps.logger),
      (event) => {
        outcome.observe(event);
        // `observe` answers only on a tool's FIRST refusal, so this is one
        // report per refused tool per run and the dedupe lives in one place.
        const refused = refusals.observe(event);
        if (refused) deps.onRefusedAsk?.({ taskId, runId, refused });
        if (event.type === 'text_delta' && outputSummary.length < OUTPUT_SUMMARY_MAX_CHARS) {
          const data = event.data as { text: string };
          outputSummary += data.text;
        }
      }
    );

    const durationMs = clock() - startTime;
    // The refused asks lead the summary, so the run-history row and the
    // finished-run message — both of which quote only its FIRST line — say what
    // the run could not do before they say what it did.
    const truncatedSummary = withRefusedAsks(
      refusals.summaryLine(),
      outputSummary.slice(0, OUTPUT_SUMMARY_MAX_CHARS)
    );
    // Both stops record `cancelled` — the run-status vocabulary has no separate
    // timeout — so the error line is what tells a person which one happened.
    //
    // Both dispatch paths now word it the same way, and the parity is a shared
    // function rather than a promise: `runTimeLimitError`
    // (`@dorkos/shared/run-time-limit`) is what this path and the direct twin
    // (`task-scheduler-service.ts`) each call. They differ only in the DURATION
    // they can name — the twin passes the task's own `maxRuntime`, formatted,
    // while this path is handed an absolute deadline on the envelope and never
    // learns the span it was cut from, so it names no number. That is a
    // deliberate hole, not a gap to fill by reconstructing one; the module note
    // says why a made-up duration is worse than none. `Run cancelled` is shared
    // as the plain literal it always was.
    const stoppedByOperator = stopped && controller.signal.reason === OPERATOR_CANCEL;

    if (deps.taskStore) {
      if (stopped) {
        deps.taskStore.updateRun(runId, {
          status: 'cancelled',
          finishedAt: new Date().toISOString(),
          durationMs,
          outputSummary: truncatedSummary,
          error: stoppedByOperator ? 'Run cancelled' : runTimeLimitError(),
          sessionId: persistedSessionId(),
        });
      } else {
        // The stream ending is not the work having succeeded: a turn that
        // streamed a typed `error` and then ended used to be filed as a success
        // here too (DOR-1658). The DELIVERY is still a success either way — the
        // envelope was carried and acted on — so only the run row changes; the
        // trace span below and this handler's return value are untouched, or a
        // run that genuinely ran would be dead-lettered and redelivered.
        const failure = outcome.settle();
        deps.taskStore.updateRun(runId, {
          status: failure ? 'failed' : 'completed',
          finishedAt: new Date().toISOString(),
          durationMs,
          outputSummary: truncatedSummary,
          ...(failure ? { error: failure } : {}),
          sessionId: persistedSessionId(),
        });
      }
    }

    deps.traceStore.updateSpan(envelope.id, {
      status: 'processed',
      processedAt: clock(),
    });

    return {
      // A run somebody stopped on purpose was DELIVERED and acted on — the
      // delivery did its job, and the run's own record is where the stop is
      // written. Only the deadline is a delivery that did not work out.
      success: !stopped || stoppedByOperator,
      // The dead-letter reason for this delivery, and a person reads it in the
      // relay's own surfaces — so it is the same sentence the run row above
      // carries, not the jargon it used to abbreviate to.
      error: stopped && !stoppedByOperator ? runTimeLimitError() : undefined,
      durationMs,
    };
  } catch (err) {
    const durationMs = clock() - startTime;
    const errorMsg = err instanceof Error ? err.message : String(err);

    if (deps.taskStore) {
      deps.taskStore.updateRun(runId, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        durationMs,
        outputSummary: withRefusedAsks(
          refusals.summaryLine(),
          outputSummary.slice(0, OUTPUT_SUMMARY_MAX_CHARS)
        ),
        error: errorMsg,
        sessionId: persistedSessionId(),
      });
    }

    deps.traceStore.updateSpan(envelope.id, {
      status: 'failed',
      processedAt: clock(),
      error: errorMsg,
    });

    return {
      success: false,
      error: errorMsg,
      deadLettered: true,
      durationMs,
    };
  } finally {
    if (timeout) clearTimeout(timeout);
    // Released when the QUERY is over, which is not the same instant this
    // function returns (DOR-791) — the same rule, for the same reason, as the
    // agent turn's binding in `agent-handler.ts`.
    //
    // A run that ended on its own, or threw, is done. A STOPPED run — its TTL,
    // or the operator's Stop — is not known to be: `consumeRunStream` ABANDONS
    // the stream rather than awaiting it. Both of the things it does on a stop
    // are unawaited (`void interruptTurn(...)` through `onStop`, and
    // `void iterator.return()`), and `interruptTurn` is itself bounded and
    // best-effort, so all this path guarantees is that the interrupt was
    // REQUESTED. It cannot prove the model stopped producing.
    //
    // A `relay_send` from that orphan, inheriting nothing, would mint a FRESH
    // full budget — hop zero, ten calls, another hour — the chain escaping on
    // exactly the stop meant to end it. So a stopped run KEEPS its binding
    // exactly as it stood: a TTL death leaves an expired budget the publish gate
    // refuses as `ttl_expired`, an operator Stop leaves a live one that is still
    // the chain's own and still decrements. One entry per session, replaced by
    // that session's next dispatch, bounded by the registry's LRU cap.
    if (!controller.signal.aborted) releaseInboundBudget?.();
    // Nothing awaits between the run's terminal write above and this line, so
    // a stop request either reached a run that was genuinely still going or
    // finds it gone — never a half-finalized run it could stop twice.
    deps.runningTasks.release(runId, controller);
  }
}
