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
import type {
  RelayPublisher,
  AdapterContext,
  DeliveryResult,
  PublishOptions,
  TraceStoreLike,
} from '../../types.js';
import type { AgentRuntimeLike, TasksStoreLike } from './types.js';

/** Maximum characters to collect for run output summary. */
const OUTPUT_SUMMARY_MAX_CHARS = 1000;

/**
 * Race sentinel: the run's TTL budget expired before the agent produced its
 * next event.
 */
const RUN_STOPPED = Symbol('run-stopped');

/** Race sentinel: the runtime's interrupt did not settle inside its own bound. */
const INTERRUPT_TIMEOUT = Symbol('interrupt-timeout');

/**
 * How long to wait for the runtime's interrupt before giving up on learning its
 * outcome. Mirrors `SESSIONS.STALL_INTERRUPT_TIMEOUT_MS` in
 * `apps/server/src/config/constants.ts`, restated here because this package
 * cannot import server config. Keep the two in step.
 */
const INTERRUPT_TIMEOUT_MS = 30_000;

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
 * lines, and the two differ in how they forward events (this one awaits an
 * async publish). Fix both if you fix one.
 *
 * @param stream - The agent's per-turn event stream.
 * @param signal - Aborts when the run is out of budget.
 * @param onStop - Runs once when the signal aborts; ends the turn at the agent.
 * @param onEvent - Receives each event that arrives before the stop.
 */
async function consumeRunStream(
  stream: AsyncIterable<StreamEvent>,
  signal: AbortSignal,
  onStop: () => void,
  onEvent: (event: StreamEvent) => Promise<void> | void
): Promise<void> {
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
        return;
      }
      if (winner.done) return;
      await onEvent(winner.value);
      pending = iterator.next();
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Ask the runtime to end the turn behind a stopped run.
 *
 * Never rejects: it is called from an abort listener, where a rejection would
 * surface as an unhandled rejection, and a runtime that cannot be interrupted
 * must not stop the run from being finalized.
 *
 * Bounded by {@link INTERRUPT_TIMEOUT_MS}: `interruptQuery` reaches the very
 * subprocess being interrupted, so it can hang, and an unobserved dangling
 * await is a leak nobody ever sees. The run is finalized by the caller either
 * way — this bound only decides how long we wait to learn the outcome. Mirrors
 * `interruptRun` in `apps/server/src/services/tasks/run-stream.ts`.
 *
 * @param deps - Handler dependencies (runtime + optional logger).
 * @param runId - The run id, which is also its session key.
 */
async function interruptRun(deps: TasksHandlerDeps, runId: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const expiry = new Promise<typeof INTERRUPT_TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(INTERRUPT_TIMEOUT), INTERRUPT_TIMEOUT_MS);
      // Never hold the process open for an interrupt we already gave up on.
      timer.unref();
    });
    const outcome = await Promise.race([deps.agentManager.interruptQuery(runId), expiry]);
    if (outcome === INTERRUPT_TIMEOUT) {
      deps.logger?.warn(
        `[tasks] run ${runId}: interrupt did not settle within ${INTERRUPT_TIMEOUT_MS}ms; ` +
          'the run is finalized anyway'
      );
    } else if (!outcome) {
      // Also the honest answer for a turn that just finished, so this is not
      // evidence of a leak.
      deps.logger?.debug(`[tasks] run ${runId}: runtime reported no in-flight turn to interrupt`);
    }
  } catch (err) {
    deps.logger?.error(`[tasks] run ${runId}: interrupting the turn failed`, err);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Dependencies required by the tasks handler. */
export interface TasksHandlerDeps {
  agentManager: AgentRuntimeLike;
  traceStore: TraceStoreLike;
  taskStore?: TasksStoreLike;
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
 * @param _subject - The tasks subject (unused, kept for interface consistency)
 * @param envelope - The relay envelope containing the tasks dispatch payload
 * @param context - Optional adapter context with agent directory info
 * @param startTime - Timestamp when delivery began (for durationMs calculation)
 * @param config - Resolved adapter configuration
 * @param deps - Injected dependencies
 * @param relay - The relay publisher for response streaming (may be null)
 */
export async function handleTasksMessage(
  _subject: string,
  envelope: RelayEnvelope,
  context: AdapterContext | undefined,
  startTime: number,
  config: TasksHandlerConfig,
  deps: TasksHandlerDeps,
  relay: RelayPublisher | null
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
  const { taskId, runId, prompt, cwd, permissionMode } = payload;
  const effectiveCwd = cwd ?? context?.agent?.directory ?? config.defaultCwd;

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

  let outputSummary = '';

  try {
    if (controller.signal.aborted) {
      throw new Error('Run timed out (TTL budget expired)');
    }

    deps.agentManager.ensureSession(runId, {
      permissionMode,
      cwd: effectiveCwd,
      hasStarted: false,
    });

    const eventStream = deps.agentManager.sendMessage(runId, prompt, {
      cwd: effectiveCwd,
    });

    await consumeRunStream(
      eventStream,
      controller.signal,
      () => void interruptRun(deps, runId),
      async (event) => {
        if (event.type === 'text_delta' && outputSummary.length < OUTPUT_SUMMARY_MAX_CHARS) {
          const data = event.data as { text: string };
          outputSummary += data.text;
        }

        if (envelope.replyTo && relay) {
          await publishResponse(envelope, event, runId, relay);
        }
      }
    );

    const durationMs = Date.now() - startTime;
    const truncatedSummary = outputSummary.slice(0, OUTPUT_SUMMARY_MAX_CHARS);
    const aborted = controller.signal.aborted;

    if (deps.taskStore) {
      if (aborted) {
        deps.taskStore.updateRun(runId, {
          status: 'cancelled',
          finishedAt: new Date().toISOString(),
          durationMs,
          outputSummary: truncatedSummary,
          error: 'Run timed out (TTL budget expired)',
          sessionId: runId,
        });
      } else {
        deps.taskStore.updateRun(runId, {
          status: 'completed',
          finishedAt: new Date().toISOString(),
          durationMs,
          outputSummary: truncatedSummary,
          sessionId: runId,
        });
      }
    }

    deps.traceStore.updateSpan(envelope.id, {
      status: 'processed',
      processedAt: Date.now(),
    });

    return {
      success: !aborted,
      error: aborted ? 'TTL budget expired' : undefined,
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
        sessionId: runId,
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
  }
}

/**
 * Publish a response event for tasks flows (no correlationId).
 *
 * @param originalEnvelope - The original incoming envelope
 * @param event - The StreamEvent to publish
 * @param fromId - The run ID to use as the sender
 * @param relay - The relay publisher
 */
async function publishResponse(
  originalEnvelope: RelayEnvelope,
  event: StreamEvent,
  fromId: string,
  relay: RelayPublisher
): Promise<void> {
  if (!originalEnvelope.replyTo) return;
  const opts: PublishOptions = {
    from: `agent:${fromId}`,
    budget: {
      hopCount: originalEnvelope.budget.hopCount + 1,
    },
  };
  await relay.publish(originalEnvelope.replyTo, event, opts);
}
