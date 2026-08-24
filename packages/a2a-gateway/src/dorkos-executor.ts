/**
 * DorkOS Agent Executor bridging A2A requests to the Relay message bus.
 *
 * Implements the `@a2a-js/sdk` `AgentExecutor` interface. On each `execute()`
 * call, the executor persists an initial A2A Task, resolves the target agent
 * via Mesh, translates the inbound A2A message to a Relay StandardPayload,
 * publishes to the agent's Relay subject, accumulates the streamed reply
 * events, and emits A2A task status updates back through the event bus.
 *
 * @module a2a-gateway/dorkos-executor
 */
import type { Message, Task, TaskStatusUpdateEvent } from '@a2a-js/sdk';
import { A2AError } from '@a2a-js/sdk/server';
import type { AgentExecutor, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import type {
  AgentCancelPayload,
  AgentCancelReason,
  RelayEnvelope,
} from '@dorkos/shared/relay-schemas';
import { AGENT_CANCEL_SUBJECT_PREFIX, A2A_GATEWAY_PRINCIPAL } from '@dorkos/shared/relay-schemas';
import type { ExecutorDeps } from './types.js';
import { a2aMessageToRelayPayload } from './schema-translator.js';
import { parseReplyEvent } from './reply-events.js';

/** Response subscription timeout in milliseconds (2 minutes). */
const RESPONSE_TIMEOUT_MS = 120_000;

/**
 * How long a stop request stays valid on the bus.
 *
 * Short on purpose, and for the same reason as the tasks path
 * (`services/tasks/run-cancel.ts`): the relay buffers a message nothing was
 * subscribed to and replays it to the next subscriber, and a stop replayed
 * minutes later names a turn that has long since ended.
 */
const CANCEL_SIGNAL_TTL_MS = 30_000;

/** Relay subject prefix for agent routing. */
const AGENT_SUBJECT_PREFIX = 'relay.agent';

/** Relay subject prefix for A2A reply subscriptions. */
const REPLY_SUBJECT_PREFIX = 'relay.a2a.reply';

/** Sender identity used in Relay publish options. */
const A2A_GATEWAY_SENDER = 'a2a-gateway';

/**
 * Resolve the target agent ID from the A2A request context.
 *
 * Checks, in order:
 * 1. `requestContext.userMessage.metadata.agentId`
 * 2. `requestContext.task?.metadata?.agentId`
 *
 * @returns The agent ID string, or `undefined` if not found in metadata.
 */
function extractAgentId(requestContext: RequestContext): string | undefined {
  const messageAgentId = (
    requestContext.userMessage.metadata as Record<string, unknown> | undefined
  )?.agentId;
  if (typeof messageAgentId === 'string' && messageAgentId.length > 0) {
    return messageAgentId;
  }

  const taskAgentId = (requestContext.task?.metadata as Record<string, unknown> | undefined)
    ?.agentId;
  if (typeof taskAgentId === 'string' && taskAgentId.length > 0) {
    return taskAgentId;
  }

  return undefined;
}

/**
 * Build the diagnostic for a request that named no target agent.
 *
 * Routing is deliberately never guessed (no first-registered-agent fallback —
 * that would nondeterministically hand external prompts to an arbitrary
 * agent), so the error teaches the caller both targeting mechanisms. It
 * deliberately does NOT enumerate the fleet: an error body reachable in
 * pass-through (no-auth) mode must not leak the agent roster — callers
 * discover agents via the fleet card instead.
 *
 * @param agentCount - Number of registered agents (zero gets a distinct message)
 */
function buildMissingTargetError(agentCount: number): string {
  if (agentCount === 0) {
    return 'No agents registered in the fleet';
  }
  return (
    "No target agent specified. POST to the agent's own endpoint at " +
    '/a2a/agents/{agentId} (the url advertised on its agent card) or set ' +
    'metadata.agentId on the message. Discover agents via the fleet card at ' +
    '/.well-known/agent-card.json — each skill id is an agent id.'
  );
}

/**
 * Build the initial A2A Task event for a new request.
 *
 * The SDK's ResultManager only persists tasks it has seen as a `kind: 'task'`
 * event — status-updates for unknown task IDs are dropped with a warning. This
 * initial event is what makes `tasks/get`, `tasks/cancel`, and every later
 * status transition (including error diagnostics) reach the task store.
 */
function buildInitialTask(requestContext: RequestContext, agentId: string | undefined): Task {
  const { taskId, contextId, userMessage } = requestContext;
  return {
    kind: 'task',
    id: taskId,
    contextId,
    status: {
      state: 'submitted',
      timestamp: new Date().toISOString(),
    },
    history: [userMessage],
    metadata: {
      ...(userMessage.metadata ?? {}),
      ...(agentId ? { agentId } : {}),
    },
  };
}

/**
 * Build a TaskStatusUpdateEvent for emitting status transitions via the event bus.
 *
 * @param taskId - The A2A task ID
 * @param contextId - The A2A context ID
 * @param state - The target task state
 * @param isFinal - Whether this is the final event in the stream
 * @param statusMessage - Optional status message to include
 */
function buildStatusEvent(
  taskId: string,
  contextId: string,
  state: TaskStatusUpdateEvent['status']['state'],
  isFinal: boolean,
  statusMessage?: Message
): TaskStatusUpdateEvent {
  return {
    kind: 'status-update',
    taskId,
    contextId,
    final: isFinal,
    status: {
      state,
      timestamp: new Date().toISOString(),
      ...(statusMessage ? { message: statusMessage } : {}),
    },
  };
}

/** One turn this gateway started and can still stop. */
interface InflightTurn {
  /** The per-execution reply subject, which is what names this turn on the bus. */
  replySubject: string;
  /** The agent it was addressed to, for the log line when a stop is not taken. */
  agentId: string;
  /** Stop listening for this turn's reply and cancel its response deadline. */
  settle: () => void;
}

/** What the bus did with a stop request. */
interface StopOutcome {
  /** How many runners took it. Zero is NOT the same as the turn having stopped. */
  deliveredTo: number;
  /** Why nothing took it — a refusal from the runner, or one from the bus. */
  reason?: string;
}

/** Build an agent-role A2A Message with a single text part. */
function buildAgentMessage(taskId: string, contextId: string, text: string): Message {
  return {
    kind: 'message',
    role: 'agent',
    messageId: crypto.randomUUID(),
    parts: [{ kind: 'text', text }],
    taskId,
    contextId,
  };
}

/**
 * Bridges A2A protocol requests to the DorkOS Relay message bus.
 *
 * For each `execute()` call, the executor:
 * 1. Publishes the initial `Task` event (state `submitted`) so the SDK
 *    persists the task before any status transitions
 * 2. Resolves the target agent from `metadata.agentId` (message first, then
 *    the stored task) and fails the task with a targeting diagnostic when no
 *    agent is named or found — routing is never guessed
 * 3. Translates the A2A message to a Relay StandardPayload
 * 4. Subscribes to a per-execution reply subject
 *    (`relay.a2a.reply.{taskId}.{nonce}`) and publishes the payload to
 *    `relay.agent.{namespace}.{agentId}`
 * 5. Emits a `working` status update once Relay accepts the message
 * 6. Accumulates streamed reply events (`text_delta` deltas, terminal `done`
 *    or aggregated `agent_result`) and completes the task exactly once with
 *    the full response text
 * 7. On stream error, timeout (2 min), or delivery failure: fails the task
 *    with the real diagnostic message — and on a timeout also asks the runtime
 *    adapter to end the turn, because a caller who stopped waiting must not
 *    leave a model running and billing
 * 8. On `tasks/cancel`: asks the adapter to end the turn and reports what
 *    actually happened — `canceled` only when a runner took the stop
 *
 * @example
 * ```typescript
 * const executor = new DorkOSAgentExecutor({ relay, agentRegistry });
 * // Used as the AgentExecutor in @a2a-js/sdk DefaultRequestHandler
 * const handler = new DefaultRequestHandler(agentCard, taskStore, executor);
 * ```
 */
export class DorkOSAgentExecutor implements AgentExecutor {
  private readonly relay: ExecutorDeps['relay'];
  private readonly agentRegistry: ExecutorDeps['agentRegistry'];
  private readonly logger: NonNullable<ExecutorDeps['logger']> | Console;

  /** Tracks active task IDs that have been marked for cancellation. */
  private readonly canceledTasks = new Set<string>();

  /**
   * The turns this gateway has in flight, per task.
   *
   * Keyed by task, then by reply subject, because a follow-up turn on a
   * non-terminal task runs CONCURRENTLY with the first: one entry per task
   * would let the earlier turn's cleanup drop the later turn's handle, and a
   * cancel would then find nothing to stop while an agent was plainly running.
   * Each value is the handle for one turn: what to publish a stop for, and how
   * to stop listening for its reply.
   */
  private readonly inflightTurns = new Map<string, Map<string, InflightTurn>>();

  constructor(deps: ExecutorDeps) {
    this.relay = deps.relay;
    this.agentRegistry = deps.agentRegistry;
    this.logger = deps.logger ?? console;
  }

  /**
   * Execute an A2A request by routing it through the Relay message bus.
   *
   * @param requestContext - The A2A request context containing the user message and task metadata
   * @param eventBus - The event bus to emit status updates and response messages
   */
  execute = async (requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> => {
    const { taskId, contextId, userMessage } = requestContext;

    // Resolve target agent — explicit only, never guessed. The Express layer
    // rejects untargeted requests before they reach the executor; this path
    // still covers follow-up turns whose stored task lost its agentId.
    const requestedAgentId = extractAgentId(requestContext);
    const agent = requestedAgentId ? this.agentRegistry.get(requestedAgentId) : undefined;

    // Persist the task before anything else — including error paths — so
    // failure diagnostics land in the task store instead of vanishing.
    if (!requestContext.task) {
      eventBus.publish(buildInitialTask(requestContext, agent?.id ?? requestedAgentId));
    } else {
      // Follow-up turn: re-emit the stored task snapshot (it already includes
      // this turn's user message in history — the SDK appends it before
      // execute() runs). A previous turn's still-attached processing loop
      // shares this event bus and holds a stale in-memory task copy; without
      // the refresh, its stale history wins the last write to the task store
      // and silently drops this turn's user message.
      eventBus.publish(requestContext.task);
    }

    const failTask = (errorText: string) => {
      eventBus.publish(
        buildStatusEvent(
          taskId,
          contextId,
          'failed',
          true,
          buildAgentMessage(taskId, contextId, errorText)
        )
      );
      eventBus.finished();
    };

    if (!agent) {
      failTask(
        requestedAgentId
          ? `Agent '${requestedAgentId}' not found in registry`
          : buildMissingTargetError(this.agentRegistry.list().length)
      );
      return;
    }

    const namespace = agent.namespace ?? 'default';
    const resolvedAgentId = agent.id;
    const subject = `${AGENT_SUBJECT_PREFIX}.${namespace}.${resolvedAgentId}`;
    // The reply subject carries a per-execution nonce: a follow-up turn on a
    // non-terminal task runs concurrently with the first, and a taskId-only
    // subject would deliver both streams to both subscriptions (interleaved
    // text, settling on either stream's terminal event). A UUID is a valid
    // subject token per the relay subject-matcher grammar (alphanumerics,
    // hyphens, underscores).
    const replySubject = `${REPLY_SUBJECT_PREFIX}.${taskId}.${crypto.randomUUID()}`;

    // Translate A2A message to Relay payload
    const payload = a2aMessageToRelayPayload(userMessage);

    // Subscribe for the response before publishing to avoid race conditions.
    // The responder streams one envelope per StreamEvent; text deltas are
    // accumulated and the task settles exactly once on the terminal event.
    let settled = false;
    let responseText = '';
    let streamErrorMessage: string | undefined;
    const cleanups: Array<() => void> = [];

    const settle = () => {
      if (settled) return;
      settled = true;
      this.forgetTurn(taskId, replySubject);
      for (const fn of cleanups) fn();
    };

    // Registered before the publish, so a cancel that races the message out is
    // still able to name this turn. A registered turn nothing ever started is
    // harmless: the stop is refused by every adapter and reported as such.
    this.rememberTurn(taskId, { replySubject, agentId: resolvedAgentId, settle });

    const completeTask = (text: string) => {
      settle();
      eventBus.publish(
        buildStatusEvent(
          taskId,
          contextId,
          'completed',
          true,
          buildAgentMessage(taskId, contextId, text)
        )
      );
      eventBus.finished();
    };

    const unsubscribe = this.relay.subscribe(replySubject, (envelope: RelayEnvelope) => {
      if (settled) return;

      // Check for cancellation before processing response events
      if (this.canceledTasks.has(taskId)) {
        settle();
        return;
      }

      // Intermediate `working` progress updates are deliberately not emitted
      // per delta: the SDK persists the task on every status-update, which
      // would mean one DB write per streamed token.
      const event = parseReplyEvent(envelope.payload);
      switch (event.kind) {
        case 'text_delta':
          responseText += event.text;
          return;
        case 'stream_error':
          streamErrorMessage = event.message;
          return;
        case 'agent_result':
          completeTask(event.text);
          return;
        case 'done':
          if (streamErrorMessage) {
            settle();
            failTask(`Agent stream failed: ${streamErrorMessage}`);
          } else {
            completeTask(responseText);
          }
          return;
        case 'ignored':
          return;
      }
    });
    cleanups.push(unsubscribe);

    // Set up timeout
    const responseTimeout = setTimeout(() => {
      if (settled) return;
      settle();
      failTask(
        `Response timeout after ${RESPONSE_TIMEOUT_MS}ms waiting for agent '${resolvedAgentId}'`
      );
      // The caller has stopped waiting; the agent has not stopped working. Ask
      // it to (DOR-791) — a gateway that only walks away leaves the model
      // running and billing for as long as it likes. Nothing on the wire can
      // report this outcome any more (the task is already failed), so the log
      // is where it has to be legible.
      void this.stopTurn(taskId, replySubject, 'caller_timeout').then((outcome) => {
        if (outcome.deliveredTo > 0) {
          this.logger.info(
            `[a2a] task ${taskId}: timed out after ${RESPONSE_TIMEOUT_MS}ms; ` +
              `the turn on agent '${resolvedAgentId}' was asked to stop`
          );
        } else {
          this.logger.warn(
            `[a2a] task ${taskId}: timed out after ${RESPONSE_TIMEOUT_MS}ms and the turn on ` +
              `agent '${resolvedAgentId}' could NOT be stopped (${outcome.reason ?? 'nothing acknowledged the stop'}) — ` +
              'it may still be running'
          );
        }
      });
    }, RESPONSE_TIMEOUT_MS);
    cleanups.push(() => clearTimeout(responseTimeout));

    // Publish to Relay
    try {
      const result = await this.relay.publish(subject, payload, {
        from: A2A_GATEWAY_SENDER,
        replyTo: replySubject,
      });

      if (result.deliveredTo === 0) {
        if (settled) return;
        settle();
        failTask(`Message not delivered — no subscribers on '${subject}'`);
        return;
      }

      // Emit working status — but only if the reply did not already settle
      // the task while we were awaiting the publish (a terminal event must
      // be the last status the client sees).
      if (!settled) {
        eventBus.publish(buildStatusEvent(taskId, contextId, 'working', false));
      }
    } catch (error: unknown) {
      if (settled) return;
      settle();
      const errorMessage = error instanceof Error ? error.message : 'Unknown publish error';
      failTask(`Relay publish failed: ${errorMessage}`);
    }
  };

  /**
   * Cancel a running task — for real, or not at all.
   *
   * The turn runs inside a runtime adapter, so cancelling means asking that
   * adapter to end it and then reporting what actually happened (DOR-791).
   * Two outcomes, and the difference is the whole point:
   *
   * - **A runner took the stop.** The turn is ending at the agent, the task is
   *   marked `canceled`, and the reply subscription is torn down.
   * - **Nothing took it** — no adapter is running it any more, the bus refused
   *   the message, or this process never held the turn (a restart). Then the
   *   task is left exactly as it was and the caller gets an error. It used to
   *   be told `canceled` here while the model carried on working and billing,
   *   which is the bug this method exists to fix. A caller who is told "not
   *   cancelable" can poll, retry, or escalate; one who is told "canceled"
   *   cannot do anything at all.
   *
   * @param taskId - The ID of the task to cancel
   * @param eventBus - The event bus to emit the cancellation status
   * @throws An A2A `TaskNotCancelable` error when no runner acknowledged the
   *   stop — the task keeps its current state, because it kept running.
   */
  cancelTask = async (taskId: string, eventBus: ExecutionEventBus): Promise<void> => {
    const turns = [...(this.inflightTurns.get(taskId)?.values() ?? [])];

    if (turns.length === 0) {
      this.logger.warn(
        `[a2a] task ${taskId}: cancel requested but this gateway holds no turn for it — ` +
          'nothing was stopped'
      );
      throw A2AError.taskNotCancelable(taskId);
    }

    // Marked BEFORE the stop goes out, and withdrawn below if nothing takes it:
    // a turn that is ending publishes its own terminal error, and without the
    // marker that error would race this method and fail a task the caller
    // successfully cancelled.
    this.canceledTasks.add(taskId);

    const outcomes = await Promise.all(
      turns.map((turn) => this.stopTurn(taskId, turn.replySubject, 'caller_canceled'))
    );
    const stopped = outcomes.filter((o) => o.deliveredTo > 0).length;

    if (stopped === 0) {
      // The turn is still going, so it must still be able to finish the task.
      this.canceledTasks.delete(taskId);
      this.logger.warn(
        `[a2a] task ${taskId}: nothing acknowledged the stop ` +
          `(${outcomes[0]?.reason ?? 'no runner is executing this turn'}) — ` +
          `the turn on agent '${turns[0]?.agentId ?? 'unknown'}' may still be running`
      );
      throw A2AError.taskNotCancelable(taskId);
    }

    if (stopped < turns.length) {
      // A follow-up turn ran alongside the first and only one of them stopped.
      // The task IS being cancelled, so `canceled` is honest — but the turn
      // nobody took is still out there, and only the log can say so.
      this.logger.warn(
        `[a2a] task ${taskId}: ${turns.length - stopped} of ${turns.length} turns did not ` +
          'acknowledge the stop and may still be running'
      );
    }

    for (const turn of turns) turn.settle();

    // Use an empty contextId — the SDK populates the real one from the stored task
    eventBus.publish(buildStatusEvent(taskId, '', 'canceled', true));

    eventBus.finished();

    // Clean up the cancellation marker after a short delay to allow
    // in-flight response handlers to see it
    setTimeout(() => {
      this.canceledTasks.delete(taskId);
    }, 5_000);
  };

  /**
   * Record a turn as in flight, so a later cancel can name it.
   *
   * @param taskId - The A2A task the turn belongs to.
   * @param turn - The handle for this one turn.
   */
  private rememberTurn(taskId: string, turn: InflightTurn): void {
    const forTask = this.inflightTurns.get(taskId) ?? new Map<string, InflightTurn>();
    forTask.set(turn.replySubject, turn);
    this.inflightTurns.set(taskId, forTask);
  }

  /**
   * Forget a turn that has settled.
   *
   * The task's entry disappears with its last turn, which is what makes a
   * cancel for work that already finished answerable with the truth.
   *
   * @param taskId - The A2A task the turn belongs to.
   * @param replySubject - The turn's reply subject.
   */
  private forgetTurn(taskId: string, replySubject: string): void {
    const forTask = this.inflightTurns.get(taskId);
    if (!forTask) return;
    forTask.delete(replySubject);
    if (forTask.size === 0) this.inflightTurns.delete(taskId);
  }

  /**
   * Ask whoever is running one turn to end it.
   *
   * Publishes to `relay.control.agent-cancel.{taskId}`, where the runtime
   * adapter's subscription turns it into the same abort a TTL expiry uses — and
   * from there into the runtime's own interrupt, which is the only thing that
   * actually stops the model. A runner that is not executing this turn REFUSES,
   * so `deliveredTo` is an honest answer to "did anything take this?".
   *
   * Never throws: a bus that refuses the stop is an outcome to report, not an
   * error to raise from a timeout callback.
   *
   * @param taskId - The A2A task, which names the subject for the trace row.
   * @param replySubject - The turn's reply subject — what identifies it.
   * @param reason - Whether the caller cancelled or stopped waiting.
   * @returns How many runners took the request, and why not when none did.
   */
  private async stopTurn(
    taskId: string,
    replySubject: string,
    reason: AgentCancelReason
  ): Promise<StopOutcome> {
    const payload: AgentCancelPayload = { type: 'agent_cancel', replyTo: replySubject, reason };
    try {
      const result = await this.relay.publish(`${AGENT_CANCEL_SUBJECT_PREFIX}${taskId}`, payload, {
        // The adapter refuses a stop from anyone else, so this is not decoration.
        from: A2A_GATEWAY_PRINCIPAL,
        budget: {
          // One hop, no fan-out, and a short life: a stop is a point-to-point
          // instruction, not something to forward on.
          maxHops: 1,
          ttl: Date.now() + CANCEL_SIGNAL_TTL_MS,
          callBudgetRemaining: 1,
        },
      });
      const rejection = result.rejected?.[0]?.reason;
      return {
        deliveredTo: result.deliveredTo,
        ...(rejection ? { reason: `the message bus refused the stop: ${rejection}` } : {}),
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'unknown publish error';
      return { deliveredTo: 0, reason: `the stop could not be published: ${message}` };
    }
  }
}
