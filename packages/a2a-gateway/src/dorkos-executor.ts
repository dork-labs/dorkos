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
import type { AgentExecutor, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { ExecutorDeps } from './types.js';
import { a2aMessageToRelayPayload } from './schema-translator.js';
import { parseReplyEvent } from './reply-events.js';

/** Response subscription timeout in milliseconds (2 minutes). */
const RESPONSE_TIMEOUT_MS = 120_000;

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

/** Maximum number of registered agents listed in the missing-target diagnostic. */
const MAX_AGENTS_IN_DIAGNOSTIC = 10;

/**
 * Build the diagnostic for a request that named no target agent.
 *
 * Routing is deliberately never guessed (no first-registered-agent fallback —
 * that would nondeterministically hand external prompts to an arbitrary
 * agent), so the error must teach the caller both targeting mechanisms.
 */
function buildMissingTargetError(agents: AgentManifest[]): string {
  if (agents.length === 0) {
    return 'No agents registered in the fleet';
  }
  const listed = agents
    .slice(0, MAX_AGENTS_IN_DIAGNOSTIC)
    .map((agent) => `${agent.id} (${agent.name})`)
    .join(', ');
  const suffix = agents.length > MAX_AGENTS_IN_DIAGNOSTIC ? ', …' : '';
  return (
    "No target agent specified. POST to the agent's own endpoint at " +
    '/a2a/agents/{agentId} (the url advertised on its agent card) or set ' +
    `metadata.agentId on the message. Registered agents: ${listed}${suffix}`
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
 *    with the real diagnostic message
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

  /** Tracks active task IDs that have been marked for cancellation. */
  private readonly canceledTasks = new Set<string>();

  constructor(deps: ExecutorDeps) {
    this.relay = deps.relay;
    this.agentRegistry = deps.agentRegistry;
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
          : buildMissingTargetError(this.agentRegistry.list())
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
      for (const fn of cleanups) fn();
    };

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
   * Cancel a running task.
   *
   * Marks the task for cancellation, emits a `canceled` status event,
   * and signals completion on the event bus.
   *
   * @param taskId - The ID of the task to cancel
   * @param eventBus - The event bus to emit the cancellation status
   */
  cancelTask = async (taskId: string, eventBus: ExecutionEventBus): Promise<void> => {
    this.canceledTasks.add(taskId);

    // Use an empty contextId — the SDK populates the real one from the stored task
    eventBus.publish(buildStatusEvent(taskId, '', 'canceled', true));

    eventBus.finished();

    // Clean up the cancellation marker after a short delay to allow
    // in-flight response handlers to see it
    setTimeout(() => {
      this.canceledTasks.delete(taskId);
    }, 5_000);
  };
}
