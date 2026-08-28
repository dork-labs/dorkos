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
import type { AdapterContext, DeliveryResult, TraceStoreLike } from '../../types.js';
import type { AgentRuntimeLike, TasksStoreLike } from './types.js';
import { OPERATOR_CANCEL } from './task-cancel-handler.js';
import type { AbortRegistry } from '../../lib/abort-registry.js';
import { interruptTurn } from './interrupt.js';

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
 * this path): sharing it would mean a new `@dorkos/shared` subpath for ~20
 * lines. Fix both if you fix one — since DOR-1567 dropped the progress republish
 * that used to make this copy `await` its `onEvent`, they do the same work.
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
 * @param startTime - Timestamp when delivery began (for durationMs calculation)
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
  const now = Date.now();

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
      durationMs: Date.now() - startTime,
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
  // The session this run runs on. A STICKY task resolves a resume target on the
  // scheduler side — the REAL SDK id of its previous run — and carries it here;
  // every other run falls back to the run id, the isolated-per-run session this
  // path has always used (DOR-1571). `resumeSession` is that session's
  // `hasStarted`: resume the existing conversation, or start fresh — false for
  // every non-sticky run and a sticky task's first fire.
  const sessionId = payload.sessionId ?? runId;
  const hasStarted = payload.resumeSession ?? false;
  // A run carries `payload.sessionId` only when it is sticky. For those, the id
  // to WRITE on the run row is the runtime's own id after the turn — the id the
  // SDK actually wrote its transcript under (`getSdkSessionId`), which the next
  // fire resumes and which makes the run clickable to the real conversation.
  // Non-sticky is unchanged: the run's own id. Resolved lazily so each terminal
  // branch records the freshest answer.
  const isSticky = payload.sessionId !== undefined;
  const persistedSessionId = (): string =>
    isSticky ? (deps.agentManager.getSdkSessionId(sessionId) ?? sessionId) : sessionId;

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

  // Set up timeout from TTL budget
  const ttlRemaining = envelope.budget.ttl - Date.now();
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  if (ttlRemaining <= 0) {
    controller.abort();
  } else {
    timeout = setTimeout(() => controller.abort(), ttlRemaining);
  }

  // From here until the `finally` below, this run can be stopped from the
  // cockpit: the registry is what the stop-request subscription reaches for.
  deps.runningTasks.register(runId, controller);

  let outputSummary = '';
  let releaseInboundBudget: (() => void) | undefined;

  try {
    if (controller.signal.aborted) {
      throw new Error('Run timed out (TTL budget expired)');
    }

    deps.agentManager.ensureSession(sessionId, {
      permissionMode,
      cwd: effectiveCwd,
      // Resume a sticky session that has already run; start fresh otherwise. This
      // explicit `ensureSession` short-circuits `sendMessage`'s transcript probe,
      // so the answer is carried on the wire (DOR-1571). The direct-dispatch twin
      // in `task-scheduler-service.ts` does the same.
      hasStarted,
      // Nobody is coming back to a scheduled run, so an unanswered prompt is
      // refused at ten minutes instead of parking for four hours and stalling
      // the run (spec `ask-parks-on-timeout` §7). The direct-dispatch twin in
      // `task-scheduler-service.ts` says the same thing; a run must not depend
      // on which path carried it.
      unattended: true,
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
        if (event.type === 'text_delta' && outputSummary.length < OUTPUT_SUMMARY_MAX_CHARS) {
          const data = event.data as { text: string };
          outputSummary += data.text;
        }
      }
    );

    const durationMs = Date.now() - startTime;
    const truncatedSummary = outputSummary.slice(0, OUTPUT_SUMMARY_MAX_CHARS);
    // Both stops record `cancelled` — the run-status vocabulary has no separate
    // timeout — so the error line is what tells a person which one happened,
    // and it matches the direct-dispatch path word for word.
    const stoppedByOperator = stopped && controller.signal.reason === OPERATOR_CANCEL;

    if (deps.taskStore) {
      if (stopped) {
        deps.taskStore.updateRun(runId, {
          status: 'cancelled',
          finishedAt: new Date().toISOString(),
          durationMs,
          outputSummary: truncatedSummary,
          error: stoppedByOperator ? 'Run cancelled' : 'Run timed out (TTL budget expired)',
          sessionId: persistedSessionId(),
        });
      } else {
        deps.taskStore.updateRun(runId, {
          status: 'completed',
          finishedAt: new Date().toISOString(),
          durationMs,
          outputSummary: truncatedSummary,
          sessionId: persistedSessionId(),
        });
      }
    }

    deps.traceStore.updateSpan(envelope.id, {
      status: 'processed',
      processedAt: Date.now(),
    });

    return {
      // A run somebody stopped on purpose was DELIVERED and acted on — the
      // delivery did its job, and the run's own record is where the stop is
      // written. Only the deadline is a delivery that did not work out.
      success: !stopped || stoppedByOperator,
      error: stopped && !stoppedByOperator ? 'TTL budget expired' : undefined,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : String(err);

    if (deps.taskStore) {
      deps.taskStore.updateRun(runId, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        durationMs,
        outputSummary: outputSummary.slice(0, OUTPUT_SUMMARY_MAX_CHARS),
        error: errorMsg,
        sessionId: persistedSessionId(),
      });
    }

    deps.traceStore.updateSpan(envelope.id, {
      status: 'failed',
      processedAt: Date.now(),
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
