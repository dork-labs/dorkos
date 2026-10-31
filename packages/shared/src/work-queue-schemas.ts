/**
 * Zod schemas for an agent's work queue (DOR-3462): an ordered list of work, and
 * how many of its chats may run at once. Once a person turns a queue on, a chat
 * ending under that number starts the next item on its own.
 *
 * @module shared/work-queue-schemas
 */
import { z } from 'zod';
import { extendZodWithOpenApiOnce } from './zod-openapi.js';

extendZodWithOpenApiOnce();

/** The longest an item's title may be. */
export const WORK_ITEM_TITLE_MAX = 80;

/** The longest an item's prompt may be. */
export const WORK_ITEM_PROMPT_MAX = 20_000;

/** The most chats a queue's target may ask for, the same top as `runtimes.maxAgentChats`. */
export const WORK_QUEUE_TARGET_MAX = 64;

/** The highest daily start cap a person may set. */
export const WORK_QUEUE_DAILY_CAP_MAX = 500;

/** The most items that may wait in one queue. */
export const WORK_QUEUE_MAX_QUEUED = 200;

/** Where an item stands. */
export const WorkItemStateSchema = z
  .enum(['queued', 'starting', 'running', 'ended'])
  .openapi('WorkItemState');

/** An item's state. */
export type WorkItemState = z.infer<typeof WorkItemStateSchema>;

/**
 * How an item ended. `limit` means its chat stopped at an account limit, and
 * `interrupted` means the server restarted while it ran: it is never run again
 * unless someone queues it again.
 */
export const WorkItemOutcomeSchema = z
  .enum(['finished', 'failed', 'stopped', 'limit', 'interrupted'])
  .openapi('WorkItemOutcome');

/** An item's outcome. */
export type WorkItemOutcome = z.infer<typeof WorkItemOutcomeSchema>;

/** One piece of work in a queue. */
export const WorkItemSchema = z
  .object({
    id: z.string(),
    agentId: z.string(),
    title: z.string(),
    prompt: z.string(),
    /** The folder the chat works in, or null for the agent's own. */
    cwd: z.string().nullable(),
    state: WorkItemStateSchema,
    outcome: WorkItemOutcomeSchema.nullable(),
    note: z.string().nullable(),
    /** The chat it started, or null before then. */
    sessionId: z.string().nullable(),
    /** The account the chat runs on, or null when the usual choice decided. */
    accountId: z.string().nullable(),
    addedBy: z.enum(['person', 'agent']),
    createdAt: z.string(),
    startedAt: z.string().nullable(),
    endedAt: z.string().nullable(),
  })
  .openapi('WorkItem');

/** One piece of work in a queue. */
export type WorkItem = z.infer<typeof WorkItemSchema>;

/**
 * Why a queue is not starting its next item right now. Null when nothing holds
 * it. Read off the last pass, so it can lag by up to a pass.
 */
export const WorkQueueHoldSchema = z
  .enum([
    'stopped',
    'daily-cap',
    'disk',
    'load',
    'accounts',
    'chat-cap',
    'permission',
    'agent-paused',
    'agent-missing',
  ])
  .openapi('WorkQueueHold');

/** A hold on a queue. */
export type WorkQueueHold = z.infer<typeof WorkQueueHoldSchema>;

/** One agent's queue, as a reader sees it. */
export const WorkQueueSchema = z
  .object({
    agentId: z.string(),
    /** Whether a person turned it on. Off by default, and off is how it is paused. */
    enabled: z.boolean(),
    /** How many of its chats may run at once. */
    target: z.number().int(),
    /** The most chats it may start in one UTC day. */
    dailyStartCap: z.number().int(),
    /** How many it started today (UTC). */
    startsToday: z.number().int(),
    /** Whether a person stopped every queue on this install. */
    allStopped: z.boolean(),
    /** What is stopping the next start, or null. */
    hold: WorkQueueHoldSchema.nullable(),
    /** Waiting items in order, then the ones running. */
    items: z.array(WorkItemSchema),
    /** The most recently ended items, newest first. */
    recent: z.array(WorkItemSchema),
  })
  .openapi('WorkQueue');

/** One agent's queue. */
export type WorkQueue = z.infer<typeof WorkQueueSchema>;

/** Adding one item to a queue. */
export const AddWorkItemRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(WORK_ITEM_TITLE_MAX),
    prompt: z.string().trim().min(1).max(WORK_ITEM_PROMPT_MAX),
    cwd: z.string().min(1).optional(),
  })
  .openapi('AddWorkItemRequest');

/** Adding one item to a queue. */
export type AddWorkItemRequest = z.infer<typeof AddWorkItemRequestSchema>;

/** Changing how a queue runs: a person's call. */
export const UpdateWorkQueueRequestSchema = z
  .object({
    enabled: z.boolean().optional(),
    target: z.number().int().min(1).max(WORK_QUEUE_TARGET_MAX).optional(),
    dailyStartCap: z.number().int().min(1).max(WORK_QUEUE_DAILY_CAP_MAX).optional(),
  })
  .refine(
    (body) =>
      body.enabled !== undefined || body.target !== undefined || body.dailyStartCap !== undefined,
    { message: 'Send enabled, target or dailyStartCap.' }
  )
  .openapi('UpdateWorkQueueRequest');

/** Changing how a queue runs. */
export type UpdateWorkQueueRequest = z.infer<typeof UpdateWorkQueueRequestSchema>;

/** Stopping or restarting every queue on this install: a person's call. */
export const SetWorkQueuesStoppedRequestSchema = z
  .object({ stopped: z.boolean() })
  .openapi('SetWorkQueuesStoppedRequest');

/** Stopping or restarting every queue on this install. */
export type SetWorkQueuesStoppedRequest = z.infer<typeof SetWorkQueuesStoppedRequestSchema>;

/** The new order of a queue's waiting items. */
export const ReorderWorkQueueRequestSchema = z
  .object({ itemIds: z.array(z.string().min(1)).min(1).max(WORK_QUEUE_MAX_QUEUED) })
  .openapi('ReorderWorkQueueRequest');

/** The new order of a queue's waiting items. */
export type ReorderWorkQueueRequest = z.infer<typeof ReorderWorkQueueRequestSchema>;
