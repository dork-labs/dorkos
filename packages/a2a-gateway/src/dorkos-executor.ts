/**
 * DorkOS Agent Executor bridging A2A requests to the Relay message bus.
 *
 * Implements the `@a2a-js/sdk` `AgentExecutor` interface. On each `execute()`
 * call, the executor resolves the target agent via Mesh, translates the inbound
 * A2A message to a Relay StandardPayload, publishes to the agent's Relay subject,
 * subscribes for the response, and emits A2A task status updates back through
 * the event bus.
 *
 * @module a2a-gateway/dorkos-executor
 */
import type { Message, TaskStatusUpdateEvent } from '@a2a-js/sdk';
import type { AgentExecutor, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import type { RelayEnvelope, StandardPayload } from '@dorkos/shared/relay-schemas';
import type { ExecutorDeps } from './types.js';
import { a2aMessageToRelayPayload, relayPayloadToA2aMessage } from './schema-translator.js';

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

/**
 * Bridges A2A protocol requests to the DorkOS Relay message bus.
 *
 * For each `execute()` call, the executor:
 * 1. Resolves the target agent via metadata or falls back to the first registered agent
 * 2. Translates the A2A message to a Relay StandardPayload
 * 3. Subscribes to a unique reply subject for the response
 * 4. Publishes the payload to `relay.agent.{namespace}.{agentId}`
 * 5. Emits a `working` status update via the event bus
 * 6. On response: emits the translated message and a `completed` status, then finishes
 * 7. On timeout (2 min): emits a `failed` status, then finishes
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

    // Resolve target agent
    const agentId = extractAgentId(requestContext);
    const agent = agentId ? this.agentRegistry.get(agentId) : this.agentRegistry.list()[0];

    if (!agent) {
      eventBus.publish(
        buildStatusEvent(
          taskId,
          contextId,
          'failed',
          true,
          buildErrorMessage(
            taskId,
            contextId,
            agentId
              ? `Agent '${agentId}' not found in registry`
              : 'No agents registered in the fleet'
          )
        )
      );
      eventBus.finished();
      return;
    }

    const namespace = agent.namespace ?? 'default';
    const resolvedAgentId = agent.id;
    const subject = `${AGENT_SUBJECT_PREFIX}.${namespace}.${resolvedAgentId}`;
    const replySubject = `${REPLY_SUBJECT_PREFIX}.${taskId}`;

    // Translate A2A message to Relay payload
    const payload = a2aMessageToRelayPayload(userMessage);

    // Subscribe for the response before publishing to avoid race conditions.
    // Uses a cleanup callbacks array so settle() doesn't need forward references
    // to unsubscribe/responseTimeout, allowing both to be const.
    let settled = false;
    const cleanups: Array<() => void> = [];

    const settle = () => {
      if (settled) return;
      settled = true;
      for (const fn of cleanups) fn();
    };

    const unsubscribe = this.relay.subscribe(replySubject, (envelope: RelayEnvelope) => {
      if (settled) return;

      // Check for cancellation before processing response
      if (this.canceledTasks.has(taskId)) {
        settle();
        return;
      }

      settle();

      const responsePayload = envelope.payload as StandardPayload;
      const responseMessage = relayPayloadToA2aMessage(responsePayload, taskId, contextId);

      // Emit the response message
      eventBus.publish(responseMessage);

      // Emit completed status
      eventBus.publish(buildStatusEvent(taskId, contextId, 'completed', true, responseMessage));

      eventBus.finished();
    });
    cleanups.push(unsubscribe);

    // Set up timeout
    const responseTimeout = setTimeout(() => {
      if (settled) return;
      settle();

      eventBus.publish(
        buildStatusEvent(
          taskId,
          contextId,
          'failed',
          true,
          buildErrorMessage(
            taskId,
            contextId,
            `Response timeout after ${RESPONSE_TIMEOUT_MS}ms waiting for agent '${resolvedAgentId}'`
          )
        )
      );

      eventBus.finished();
    }, RESPONSE_TIMEOUT_MS);
    cleanups.push(() => clearTimeout(responseTimeout));

    // Publish to Relay
    try {
      const result = await this.relay.publish(subject, payload, {
        from: A2A_GATEWAY_SENDER,
        replyTo: replySubject,
      });

      if (result.deliveredTo === 0) {
        settle();
        eventBus.publish(
          buildStatusEvent(
            taskId,
            contextId,
            'failed',
            true,
            buildErrorMessage(
              taskId,
              contextId,
              `Message not delivered — no subscribers on '${subject}'`
            )
          )
        );
        eventBus.finished();
        return;
      }

      // Emit working status — message accepted by Relay
      eventBus.publish(buildStatusEvent(taskId, contextId, 'working', false));
    } catch (error: unknown) {
      settle();
      const errorMessage = error instanceof Error ? error.message : 'Unknown publish error';
      eventBus.publish(
        buildStatusEvent(
          taskId,
          contextId,
          'failed',
          true,
          buildErrorMessage(taskId, contextId, `Relay publish failed: ${errorMessage}`)
        )
      );
      eventBus.finished();
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

/**
 * Build an A2A Message containing an error description.
 *
 * Used as the `message` field inside TaskStatusUpdateEvent status objects
 * to communicate error details to the A2A client.
 */
function buildErrorMessage(taskId: string, contextId: string, errorText: string): Message {
  return {
    kind: 'message',
    role: 'agent',
    messageId: crypto.randomUUID(),
    parts: [{ kind: 'text', text: errorText }],
    taskId,
    contextId,
  };
}
