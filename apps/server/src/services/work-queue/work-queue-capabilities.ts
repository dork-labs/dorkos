/** Permission actions for work queues; all targets and changes are bound to the card. */
import { z } from 'zod';
import {
  AddWorkItemRequestSchema,
  UpdateWorkQueueRequestSchema,
  WorkItemSchema,
  WorkQueueSchema,
} from '@dorkos/shared/work-queue-schemas';
import {
  defineCapability,
  type CapabilityDeps,
  type CapabilityDomain,
  type CapabilityHandlerContext,
  type CapabilityInvocationContext,
} from '../core/capabilities/index.js';
import { CapabilityToolError } from '../core/capabilities/mcp-envelope.js';
import { lastTurnLevelOf, marksOf } from '../core/turn-power/turn-levels.js';
import { isServerPrincipal } from '../connectors/principal/server-principal.js';
import { anotherAgentTurnRefusal, noteMarkedTurnRefusal } from '../connectors/access/turn-gate.js';
import { WorkQueueError, type WorkQueueService } from './work-queue-service.js';

declare module '../core/capabilities/capability-definition.js' {
  interface CapabilityDeps {
    /** Queue policy and registered identities. */
    workQueueDeps?: {
      service: Pick<
        WorkQueueService,
        'read' | 'add' | 'remove' | 'update' | 'reorder' | 'requeue' | 'item'
      >;
      agentIdForPath(agentPath: string): string | undefined;
      agentName(agentId: string): string | undefined;
    };
  }
}

const RefusalSchema = z.object({ ok: z.literal(false), code: z.string(), error: z.string() });
const ItemResult = z.union([
  z.object({ ok: z.literal(true), item: WorkItemSchema }),
  RefusalSchema,
]);
const QueueResult = z.union([
  z.object({ ok: z.literal(true), queue: WorkQueueSchema }),
  RefusalSchema,
]);
const Target = {
  agentId: z.string().min(1).optional().describe('The target agent; absent means your own queue.'),
};
const Settings = z.object({
  enabled: z.boolean(),
  target: z.number().int(),
  dailyStartCap: z.number().int(),
});
const Configure = z.object({ ...Target, before: Settings, changes: UpdateWorkQueueRequestSchema });
const ItemTarget = z.object({ ...Target, id: z.string().min(1).max(100) });

function requireDeps(deps: CapabilityDeps) {
  if (!deps.workQueueDeps) throw new Error('Work queue is unavailable.');
  return deps.workQueueDeps;
}

/** Canonical turn for external runtimes; never an argument supplied by an agent. */
function sessionOf(
  context: CapabilityInvocationContext | CapabilityHandlerContext
): string | undefined {
  const principal = context.serverPrincipal;
  return principal && isServerPrincipal(principal) && principal.claims.kind === 'runtime'
    ? principal.claims.canonicalSessionId
    : context.sessionId;
}

/** What a marked turn's refused cross-agent queue change names on its Activity line (DOR-4023). */
const OTHER_QUEUE_ACTION = {
  id: 'work-queue.other_agent',
  title: "Change another agent's work queue",
};

/** Resolve both agents from server identity, refusing unsafe cross-agent turns before asking. */
function targetOf(
  deps: CapabilityDeps,
  input: { agentId?: string },
  context: CapabilityInvocationContext | CapabilityHandlerContext
) {
  const queue = requireDeps(deps);
  const identity = context.identity;
  if (!identity || identity.inactive)
    throw new CapabilityToolError({ code: 'NO_AGENT', error: 'This chat needs an active agent.' });
  const requester = queue.agentIdForPath(identity.agentPath);
  if (!requester)
    throw new CapabilityToolError({
      code: 'UNKNOWN_AGENT',
      error: 'This agent is not registered.',
    });
  const target = input.agentId ?? requester;
  const name = queue.agentName(target);
  if (!name)
    throw new CapabilityToolError({ code: 'NOT_FOUND', error: 'The target agent was not found.' });
  if (target !== requester) {
    const caller = { sessionId: sessionOf(context), agentPath: identity.agentPath };
    const refusal = anotherAgentTurnRefusal(caller);
    if (refusal === 'GRANT_MARKED_TURN') noteMarkedTurnRefusal(caller, OTHER_QUEUE_ACTION);
    if (refusal)
      throw new CapabilityToolError({
        code: refusal,
        error: 'This turn cannot change another queue. Ask a person.',
      });
  }
  return { queue, requester, target, name, identity };
}

function answer<T>(run: () => T) {
  try {
    return run();
  } catch (error) {
    if (error instanceof WorkQueueError)
      return { ok: false as const, code: error.code, error: error.message };
    throw error;
  }
}

function settings(queue: ReturnType<WorkQueueService['read']>) {
  return { enabled: queue.enabled, target: queue.target, dailyStartCap: queue.dailyStartCap };
}

function configureTarget(
  deps: CapabilityDeps,
  input: z.infer<typeof Configure>,
  context: CapabilityInvocationContext | CapabilityHandlerContext
) {
  const target = targetOf(deps, input, context);
  if (
    JSON.stringify(settings(target.queue.service.read(target.target))) !==
    JSON.stringify(input.before)
  ) {
    throw new CapabilityToolError({
      code: 'STALE_QUEUE',
      error: 'The queue changed. Read it again before retrying.',
    });
  }
  return target;
}

/** Classify only against a before-value the handler checks again, never an unverified assertion. */
function configureDirection(raw: unknown): 'narrow' | 'widen' {
  const parsed = Configure.safeParse(raw);
  if (!parsed.success) return 'widen';
  const { before, changes } = parsed.data;
  return (changes.enabled === true && !before.enabled) ||
    (changes.target !== undefined && changes.target > before.target) ||
    (changes.dailyStartCap !== undefined && changes.dailyStartCap > before.dailyStartCap)
    ? 'widen'
    : 'narrow';
}

function boundItem(
  deps: CapabilityDeps,
  input: z.infer<typeof ItemTarget>,
  context: CapabilityInvocationContext | CapabilityHandlerContext
) {
  const target = targetOf(deps, input, context);
  const item = target.queue.service.item(input.id);
  if (item.agentId !== target.target)
    throw new CapabilityToolError({
      code: 'NOT_YOURS',
      error: 'That item belongs to another queue.',
    });
  return { ...target, item };
}

const mcp = (toolName: string, idempotentHint = false) => ({
  mcp: {
    toolName,
    servers: ['in-session', 'external'] as ('in-session' | 'external')[],
    annotations: { idempotentHint },
  },
});

/** Agents can configure, read and manage queues under Other agents. */
export const workQueueDomain: CapabilityDomain = {
  name: 'work-queue',
  assertDeps: requireDeps,
  capabilities: [
    defineCapability({
      id: 'work-queue.add',
      title: 'Queue work',
      tier: 'destructive',
      area: 'agents',
      description:
        'Queue one standalone prompt for yourself or agentId. Adding work asks a person, even at Full. Other-agent writes refuse marked, agent-started, scheduled and heartbeat turns. The chat keeps the requester’s marks and runs no higher than either agent or its first run. Queues start only when enabled and within their caps.',
      permissionDirectionForInput: () => 'widen',
      approvalDisplayFields: ['agentId', 'title', 'cwd'],
      input: AddWorkItemRequestSchema.extend(Target),
      output: ItemResult,
      surfaces: mcp('work_queue_add'),
      describeApprovalChange: async (deps, input, context) => {
        const { identity, name, queue, target } = targetOf(deps, input, context);
        return `${identity.displayName} wants ${name} to do: ${input.title}\n${input.prompt}\nBefore: ${JSON.stringify(queue.service.read(target).items.map(({ title, prompt, cwd, state }) => ({ title, prompt, cwd, state })))}\nAfter: add this work`;
      },
      invoke: async (deps, input, context) => {
        const { queue, requester, target, identity } = targetOf(deps, input, context);
        if (!context.approval && !context.trusted)
          throw new CapabilityToolError({
            code: 'APPROVAL_REQUIRED',
            error: 'Adding work needs a person’s approval.',
          });
        const level = sessionOf(context) ? lastTurnLevelOf(sessionOf(context)!) : undefined;
        return answer(() => ({
          ok: true as const,
          item: queue.service.add(
            {
              kind: 'agent',
              agentId: requester,
              sessionId: sessionOf(context),
              level: {
                ...(level ?? { asks: 'always', reach: 'read', outsider: true }),
                ...marksOf(sessionOf(context), identity.agentPath),
              },
              otherQueueApproved: true,
            },
            target,
            input
          ),
        }));
      },
    }),
    defineCapability({
      id: 'work-queue.remove',
      title: 'Remove queued work',
      tier: 'act',
      area: 'agents',
      description:
        'Remove waiting work from your queue or agentId. Narrowing needs no Ask. Cross-agent turn restrictions still apply.',
      permissionDirectionForInput: () => 'narrow',
      approvalDisplayFields: ['agentId', 'id'],
      input: ItemTarget,
      output: z.union([z.object({ ok: z.literal(true) }), RefusalSchema]),
      surfaces: mcp('work_queue_remove'),
      invoke: async (deps, input, context) => {
        const { queue, requester } = boundItem(deps, input, context);
        return answer(() => {
          queue.service.remove(
            { kind: 'agent', agentId: requester, otherQueueApproved: true },
            input.id
          );
          return { ok: true as const };
        });
      },
    }),
    defineCapability({
      id: 'work-queue.list',
      title: 'Read your work queue',
      tier: 'observe',
      area: null,
      areaNote: 'reading the caller’s own queue is always available',
      description:
        'Read your own waiting, running and ended work, settings and current holds. Use the tool for reading another agent’s queue.',
      input: z.object({}),
      output: QueueResult,
      surfaces: mcp('work_queue_list', true),
      invoke: async (deps, input, context) => {
        const { queue, target } = targetOf(deps, input, context);
        return { ok: true as const, queue: queue.service.read(target) };
      },
    }),
    defineCapability({
      id: 'work-queue.read_agent',
      title: 'Read another work queue',
      tier: 'act',
      area: 'agents',
      description:
        'Read agentId’s work queue under Other agents. Asks a person by default. Cross-agent turn restrictions apply.',
      permissionDirectionForInput: () => 'widen',
      approvalDisplayFields: ['agentId'],
      input: z.object({ agentId: z.string().min(1) }),
      output: QueueResult,
      surfaces: mcp('work_queue_read_agent', true),
      invoke: async (deps, input, context) => {
        const { queue, target } = targetOf(deps, input, context);
        return { ok: true as const, queue: queue.service.read(target) };
      },
    }),
    defineCapability({
      id: 'work-queue.configure',
      title: 'Change work queue',
      tier: 'destructive',
      area: 'agents',
      description:
        'Change enabled, target or dailyStartCap on your queue or agentId. Supply current settings as before. Narrowing needs no Ask; widening asks even at Full. An agent cannot raise the daily cap past the last limit a person set in queue Settings.',
      permissionDirectionForInput: configureDirection,
      approvalDisplayFields: ['agentId', 'before', 'changes'],
      input: Configure,
      output: QueueResult,
      surfaces: mcp('work_queue_configure'),
      describeApprovalChange: async (deps, input, context) => {
        const { name } = configureTarget(deps, input, context);
        return `${name}\n${Object.entries(input.changes)
          .map(
            ([field, value]) =>
              `${field}: ${input.before[field as keyof typeof input.before]} → ${value}`
          )
          .join('\n')}`;
      },
      invoke: async (deps, input, context) => {
        const { queue, target } = configureTarget(deps, input, context);
        if (configureDirection(input) === 'widen' && !context.approval && !context.trusted)
          throw new CapabilityToolError({
            code: 'APPROVAL_REQUIRED',
            error: 'Increasing queued work needs a person’s approval.',
          });
        return answer(() => ({
          ok: true as const,
          queue: queue.service.update(target, input.changes, { agent: true }),
        }));
      },
    }),
    defineCapability({
      id: 'work-queue.reorder',
      title: 'Reorder waiting work',
      tier: 'act',
      area: 'agents',
      description:
        'Reorder waiting itemIds within your queue or agentId. It starts no new work and needs no Ask. Cross-agent turn restrictions still apply.',
      permissionDirectionForInput: () => 'narrow',
      approvalDisplayFields: ['agentId', 'itemIds'],
      input: z.object({ ...Target, itemIds: z.array(z.string().min(1)).min(1).max(200) }),
      output: QueueResult,
      surfaces: mcp('work_queue_reorder'),
      invoke: async (deps, input, context) => {
        const { queue, target } = targetOf(deps, input, context);
        return { ok: true as const, queue: queue.service.reorder(target, input.itemIds) };
      },
    }),
    defineCapability({
      id: 'work-queue.requeue',
      title: 'Queue ended work again',
      tier: 'destructive',
      area: 'agents',
      description:
        'Explicitly requeue an ended item. This is a new start and asks even at Full. It keeps the original author, marks and first-run ceiling. Cross-agent turn restrictions still apply.',
      permissionDirectionForInput: () => 'widen',
      approvalDisplayFields: ['agentId', 'id'],
      input: ItemTarget,
      output: ItemResult,
      surfaces: mcp('work_queue_requeue'),
      describeApprovalChange: async (deps, input, context) => {
        const { item, name } = boundItem(deps, input, context);
        return `${name}\n${item.title}\n${item.prompt}\nFolder: ${item.cwd ?? name}\nBefore: ${item.state}\nAfter: queued for a new start`;
      },
      invoke: async (deps, input, context) => {
        const { queue } = boundItem(deps, input, context);
        if (!context.approval && !context.trusted)
          throw new CapabilityToolError({
            code: 'APPROVAL_REQUIRED',
            error: 'Requeueing work needs a person’s approval.',
          });
        return answer(() => ({ ok: true as const, item: queue.service.requeue(input.id) }));
      },
    }),
  ],
};
