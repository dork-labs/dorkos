/**
 * The `work-queue` capability domain (DOR-3462): an agent's tools for its own
 * queue. The caller is the verified identity, so no tool takes a "who".
 *
 * Agents add, remove and read. They get no tool for turning a queue on, its target,
 * its daily start cap, or the stop on every queue: those are a person's, on the
 * person's routes.
 *
 * ## Permission
 *
 * The changes are `area: 'agents'`, where `session_start` lives: queueing work is
 * starting a chat later, so the setting that governs starting one governs this
 * too. Reading your own queue is `observe`, with no area.
 *
 * ## Strangers
 *
 * A turn's marks are not checked here (Security, DOR-3462). The item's chat runs at
 * the agent's own level, read when it starts, so a stranger's words can reach a
 * queue the way they can reach anything else that agent writes down. That gap
 * belongs with DOR-3443.
 *
 * @module services/work-queue/work-queue-capabilities
 */
import { z } from 'zod';
import {
  AddWorkItemRequestSchema,
  WorkItemSchema,
  WorkQueueSchema,
} from '@dorkos/shared/work-queue-schemas';
import {
  defineCapability,
  type CapabilityDeps,
  type CapabilityDomain,
  type CapabilityHandlerContext,
} from '../core/capabilities/index.js';
import { WorkQueueError, type WorkQueueService } from './work-queue-service.js';

declare module '../core/capabilities/capability-definition.js' {
  interface CapabilityDeps {
    /** Present when the work queue is running; gates the `work-queue` domain. */
    workQueueDeps?: {
      /** Reads and changes queues. */
      service: Pick<WorkQueueService, 'read' | 'add' | 'remove'>;
      /**
       * The Mesh id of the agent living at a home folder, or undefined.
       *
       * @param agentPath - The agent's home folder.
       */
      agentIdForPath(agentPath: string): string | undefined;
    };
  }
}

/** A refusal, as every work queue tool answers one. */
const RefusalSchema = z.object({
  ok: z.literal(false),
  /** A stable code. */
  code: z.string(),
  /** A plain sentence for the calling agent. */
  error: z.string(),
});

/** A refusal value. */
type Refusal = z.infer<typeof RefusalSchema>;

/** Narrow the bag, throwing if the registry was composed without it. */
function requireDeps(deps: CapabilityDeps): NonNullable<CapabilityDeps['workQueueDeps']> {
  if (!deps.workQueueDeps) {
    throw new Error('Work queue capability invoked without workQueueDeps in the registry bag.');
  }
  return deps.workQueueDeps;
}

/**
 * The calling agent's Mesh id, or a refusal.
 *
 * @param deps - The work queue deps.
 * @param context - The invocation context.
 */
function callingAgentId(
  deps: NonNullable<CapabilityDeps['workQueueDeps']>,
  context: CapabilityHandlerContext
): string | Refusal {
  const identity = context.identity;
  if (!identity || identity.inactive) {
    return {
      ok: false,
      code: 'NO_AGENT',
      error: 'Only an agent can use its own work queue, and this chat is not running as one.',
    };
  }
  const agentId = deps.agentIdForPath(identity.agentPath);
  if (agentId) return agentId;
  return {
    ok: false,
    code: 'UNKNOWN_AGENT',
    error: 'This agent is not registered on the team yet, so it has no work queue.',
  };
}

/** Run a change, answering a {@link WorkQueueError} as a refusal. */
function answer<T>(run: () => T): T | Refusal {
  try {
    return run();
  } catch (err) {
    if (err instanceof WorkQueueError) return { ok: false, code: err.code, error: err.message };
    throw err;
  }
}

/** The work queue domain. */
export const workQueueDomain: CapabilityDomain = {
  name: 'work-queue',
  assertDeps: requireDeps,
  capabilities: [
    defineCapability({
      id: 'work-queue.add',
      title: 'Queue work',
      description:
        'Add one piece of work to the back of your own queue. A queue is off until a person ' +
        'turns it on. Once on, when one of your queued chats ends and you are under the target a ' +
        'person set, DorkOS starts the next item as a new chat of yours, at your own permission ' +
        'level, on the account with the most room. It waits while the disk or computer is too ' +
        "busy, or every account is near its limit. `prompt` is the chat's first message and has " +
        'to stand alone: the chat sees nothing of this one.',
      tier: 'act',
      area: 'agents',
      approvalDisplayFields: ['title', 'prompt', 'cwd'],
      input: AddWorkItemRequestSchema,
      output: z.union([z.object({ ok: z.literal(true), item: WorkItemSchema }), RefusalSchema]),
      surfaces: {
        mcp: {
          toolName: 'work_queue_add',
          servers: ['in-session', 'external'],
          annotations: { idempotentHint: false },
        },
      },
      invoke: async (deps, input, context) => {
        const workQueueDeps = requireDeps(deps);
        const agentId = callingAgentId(workQueueDeps, context);
        if (typeof agentId !== 'string') return agentId;
        return answer(() => ({
          ok: true as const,
          item: workQueueDeps.service.add({ kind: 'agent', agentId }, agentId, input),
        }));
      },
    }),
    defineCapability({
      id: 'work-queue.remove',
      title: 'Remove queued work',
      description: 'Remove an item that is still waiting in your own queue.',
      tier: 'act',
      area: 'agents',
      approvalDisplayFields: ['id'],
      input: z.object({
        id: z.string().min(1).max(100).describe('The item id, from work_queue_list.'),
      }),
      output: z.union([z.object({ ok: z.literal(true) }), RefusalSchema]),
      surfaces: {
        mcp: {
          toolName: 'work_queue_remove',
          servers: ['in-session', 'external'],
          annotations: { idempotentHint: false },
        },
      },
      invoke: async (deps, input, context) => {
        const workQueueDeps = requireDeps(deps);
        const agentId = callingAgentId(workQueueDeps, context);
        if (typeof agentId !== 'string') return agentId;
        return answer(() => {
          workQueueDeps.service.remove({ kind: 'agent', agentId }, input.id);
          return { ok: true as const };
        });
      },
    }),
    defineCapability({
      id: 'work-queue.list',
      title: 'Read your work queue',
      description:
        'Read your own queue: what is waiting in order, what is running, what recently ended and ' +
        'how, whether a person turned it on, the target and daily cap they set, and what is ' +
        'stopping the next start.',
      tier: 'observe',
      area: null,
      areaNote: "the agent's own list of its own work",
      input: z.object({}),
      output: z.union([z.object({ ok: z.literal(true), queue: WorkQueueSchema }), RefusalSchema]),
      surfaces: {
        mcp: {
          toolName: 'work_queue_list',
          servers: ['in-session', 'external'],
          annotations: { idempotentHint: true },
        },
      },
      invoke: async (deps, _input, context) => {
        const workQueueDeps = requireDeps(deps);
        const agentId = callingAgentId(workQueueDeps, context);
        if (typeof agentId !== 'string') return agentId;
        return { ok: true as const, queue: workQueueDeps.service.read(agentId) };
      },
    }),
  ],
};
