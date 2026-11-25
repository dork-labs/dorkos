/**
 * A person's work queue doors (DOR-3462) as capabilities the mount serves on
 * `/api/agents/{id}/work-queue/*` and `/api/work-queues/stop` (ADR 261123-170830).
 *
 * Every one is person-only (`http.audience: 'person'`): an agent reads and
 * changes queues with its own tools (`work-queue-capabilities.ts`), which carry
 * its turn's power and ask a person where they must. With login on, the person
 * must also own the install, the same owner bar the hand routes used.
 *
 * A domain of its own (`workqueue.*`), apart from the agents' `work-queue.*`
 * tools, so it meets the capability conformance suite on its own deps.
 *
 * @module services/work-queue/work-queue-person-capabilities
 */
import { z } from 'zod';
import {
  AddWorkItemRequestSchema,
  ReorderWorkQueueRequestSchema,
  SetWorkQueuesStoppedRequestSchema,
  UpdateWorkQueueRequestSchema,
  WorkItemSchema,
  WorkQueueSchema,
} from '@dorkos/shared/work-queue-schemas';

import { isInstallOwner } from '../core/auth/install-owner.js';
import {
  defineCapability,
  type CapabilityDeps,
  type CapabilityDomain,
  type CapabilityHandlerContext,
} from '../core/capabilities/index.js';
import { CapabilityToolError } from '../core/capabilities/mcp-envelope.js';
import {
  WorkQueueError,
  type WorkQueueErrorCode,
  type WorkQueueService,
} from './work-queue-service.js';

declare module '../core/capabilities/capability-definition.js' {
  interface CapabilityDeps {
    /** A person's work queue doors: the queue service and who is on the team. */
    workQueuePersonDeps?: {
      /** The work queue service. */
      service: Pick<
        WorkQueueService,
        'read' | 'add' | 'remove' | 'update' | 'reorder' | 'requeue' | 'setAllStopped'
      >;
      /**
       * Whether an agent with this Mesh id is on the team.
       *
       * @param agentId - The Mesh id.
       */
      agentExists(agentId: string): boolean;
    };
  }
}

/** What a person-only door reads from its deps. */
function queueOf(deps: CapabilityDeps) {
  if (!deps.workQueuePersonDeps) throw new Error('Work queue is unavailable.');
  return deps.workQueuePersonDeps;
}

/**
 * Refuse a signed-in person who is not this install's owner. The person bar
 * itself is the mount's (`audience: 'person'`), and with login on it has
 * already asked for a browser session, so a user is present exactly when one
 * must be compared.
 */
function assertOwner(context: CapabilityHandlerContext): void {
  if (context.userId !== undefined && !isInstallOwner({ userId: context.userId })) {
    throw new CapabilityToolError({ code: 'OWNER_ONLY', error: 'Only the owner can do this.' });
  }
}

/** The owner check, then the agent the path names: it must be on the team. */
function agentOf(deps: CapabilityDeps, agentId: string, context: CapabilityHandlerContext) {
  assertOwner(context);
  const queue = queueOf(deps);
  if (!queue.agentExists(agentId)) {
    throw new CapabilityToolError({
      code: 'WORK_QUEUE_AGENT_NOT_FOUND',
      error: 'No agent on the team has that id.',
    });
  }
  return queue;
}

/** The tool code each queue refusal answers with (`routes/capability-refusals.ts`). */
const REFUSAL_CODE: Record<WorkQueueErrorCode, string> = {
  NOT_FOUND: 'WORK_ITEM_NOT_FOUND',
  NOT_YOURS: 'NOT_YOURS',
  NOT_QUEUED: 'WORK_ITEM_STARTED',
  NOT_ENDED: 'WORK_ITEM_NOT_ENDED',
  FULL: 'WORK_QUEUE_FULL',
  BAD_CWD: 'WORK_ITEM_BAD_CWD',
  CAP_CEILING: 'WORK_QUEUE_CAP_CEILING',
  STALE_QUEUE: 'STALE_QUEUE',
};

/** Run a queue change, answering a {@link WorkQueueError} as a tool refusal. */
function refusing<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof WorkQueueError) {
      throw new CapabilityToolError({ code: REFUSAL_CODE[error.code], error: error.message });
    }
    throw error;
  }
}

/** The agent a path names. */
const AgentId = z.string().min(1).describe('The Mesh id of the agent whose queue this is.');
/** The item a path names. */
const ItemId = z.string().min(1).describe('The work item.');
/** `{id}` in the path fills `agentId`. */
const AGENT_PARAM = { id: 'agentId' } as const;
/** Why a person-only door is closed to agents, for the catalog. */
const PERSON_ONLY_NOTE = 'a person’s own queue controls; agents use the work queue tools';

/** `workqueue.get`: one agent's queue, as a person sees it. */
export const workQueueGetCapability = defineCapability({
  id: 'workqueue.get',
  title: 'Open an agent’s work queue',
  description:
    'What waits in order, what is running, what recently ended, whether the queue is on, its ' +
    'target and daily cap, and what is stopping the next start.',
  tier: 'observe',
  area: null,
  areaNote: PERSON_ONLY_NOTE,
  input: z.object({ agentId: AgentId }),
  output: WorkQueueSchema,
  surfaces: {
    http: {
      method: 'get',
      path: '/api/agents/{id}/work-queue',
      params: AGENT_PARAM,
      audience: 'person',
    },
  },
  invoke: async (deps, input, context) =>
    agentOf(deps, input.agentId, context).service.read(input.agentId),
});

/** `workqueue.update`: turn a queue on or off, or set its target or daily cap. */
export const workQueueUpdateCapability = defineCapability({
  id: 'workqueue.update',
  title: 'Change how an agent’s work queue runs',
  description:
    'Turn a queue on or off, or set its target or daily cap. A queue is off until a person ' +
    'turns it on.',
  tier: 'act',
  area: null,
  areaNote: PERSON_ONLY_NOTE,
  input: z
    .object({ agentId: AgentId, ...UpdateWorkQueueRequestSchema.shape })
    .refine(
      (body) =>
        body.enabled !== undefined || body.target !== undefined || body.dailyStartCap !== undefined,
      { message: 'Send enabled, target or dailyStartCap.' }
    ),
  output: WorkQueueSchema,
  surfaces: {
    http: {
      method: 'patch',
      path: '/api/agents/{id}/work-queue',
      params: AGENT_PARAM,
      audience: 'person',
    },
  },
  invoke: async (deps, { agentId, ...changes }, context) =>
    agentOf(deps, agentId, context).service.update(agentId, changes),
});

/** `workqueue.stop_all`: stop every queue on this install, or lift the stop. */
export const workQueueStopAllCapability = defineCapability({
  id: 'workqueue.stop_all',
  title: 'Stop every work queue',
  description:
    'Stop every queue (`stopped: true`) or lift the stop. Chats already running keep going.',
  tier: 'act',
  area: null,
  areaNote: PERSON_ONLY_NOTE,
  input: SetWorkQueuesStoppedRequestSchema,
  output: SetWorkQueuesStoppedRequestSchema,
  surfaces: { http: { method: 'put', path: '/api/work-queues/stop', audience: 'person' } },
  invoke: async (deps, input, context) => {
    assertOwner(context);
    queueOf(deps).service.setAllStopped(input.stopped);
    return { stopped: input.stopped };
  },
});

/** `workqueue.set_order`: the order of what waits in one agent's queue. */
export const workQueueSetOrderCapability = defineCapability({
  id: 'workqueue.set_order',
  title: 'Set the order of waiting work',
  description: 'Set the order of what waits. An item that started meanwhile is left out.',
  tier: 'act',
  area: null,
  areaNote: PERSON_ONLY_NOTE,
  input: ReorderWorkQueueRequestSchema.extend({ agentId: AgentId }),
  output: WorkQueueSchema,
  surfaces: {
    http: {
      method: 'put',
      path: '/api/agents/{id}/work-queue/order',
      params: AGENT_PARAM,
      audience: 'person',
    },
  },
  invoke: async (deps, input, context) =>
    agentOf(deps, input.agentId, context).service.reorder(input.agentId, input.itemIds),
});

/** `workqueue.add_item`: a person adds work to the back of an agent's queue. */
export const workQueueAddItemCapability = defineCapability({
  id: 'workqueue.add_item',
  title: 'Add work to an agent’s queue',
  description: 'Add one item to the back of an agent’s queue: a title, a prompt and a folder.',
  tier: 'act',
  area: null,
  areaNote: PERSON_ONLY_NOTE,
  input: AddWorkItemRequestSchema.extend({ agentId: AgentId }),
  output: WorkItemSchema,
  surfaces: {
    http: {
      method: 'post',
      path: '/api/agents/{id}/work-queue/items',
      params: AGENT_PARAM,
      success: 201,
      audience: 'person',
    },
  },
  invoke: async (deps, { agentId, ...item }, context) => {
    const queue = agentOf(deps, agentId, context);
    return refusing(() => queue.service.add({ kind: 'person' }, agentId, item));
  },
});

/** `workqueue.remove_item`: take a waiting item out of a queue. */
export const workQueueRemoveItemCapability = defineCapability({
  id: 'workqueue.remove_item',
  title: 'Remove waiting work',
  description: 'Remove an item that has not started. A running item is its chat’s to end.',
  tier: 'act',
  area: null,
  areaNote: PERSON_ONLY_NOTE,
  input: z.object({ agentId: AgentId, itemId: ItemId }),
  // Nothing: the route answers 204 with no body.
  output: z.unknown(),
  surfaces: {
    http: {
      method: 'delete',
      path: '/api/agents/{id}/work-queue/items/{itemId}',
      params: AGENT_PARAM,
      success: 204,
      audience: 'person',
    },
  },
  invoke: async (deps, input, context) => {
    const queue = agentOf(deps, input.agentId, context);
    refusing(() => queue.service.remove({ kind: 'person' }, input.itemId));
  },
});

/** `workqueue.requeue_item`: queue an ended item again. */
export const workQueueRequeueItemCapability = defineCapability({
  id: 'workqueue.requeue_item',
  title: 'Queue ended work again',
  description: 'Put an ended item at the back of the queue. It starts a new chat.',
  tier: 'act',
  area: null,
  areaNote: PERSON_ONLY_NOTE,
  input: z.object({ agentId: AgentId, itemId: ItemId }),
  output: WorkItemSchema,
  surfaces: {
    http: {
      method: 'post',
      path: '/api/agents/{id}/work-queue/items/{itemId}/requeue',
      params: AGENT_PARAM,
      audience: 'person',
    },
  },
  invoke: async (deps, input, context) => {
    const queue = agentOf(deps, input.agentId, context);
    return refusing(() => queue.service.requeue(input.itemId));
  },
});

/** A person's work queue doors; on every server that runs work queues. */
export const workQueuePersonDomain: CapabilityDomain = {
  name: 'workqueue',
  assertDeps: queueOf,
  capabilities: [
    workQueueGetCapability,
    workQueueUpdateCapability,
    workQueueStopAllCapability,
    workQueueSetOrderCapability,
    workQueueAddItemCapability,
    workQueueRemoveItemCapability,
    workQueueRequeueItemCapability,
  ],
};
