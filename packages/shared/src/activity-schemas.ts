/**
 * Zod schemas for the Activity Feed.
 *
 * Defines schemas for activity events, query parameters, and paginated
 * responses. Used by both server (event emission, API validation) and
 * client (response parsing, type safety).
 *
 * @module shared/activity-schemas
 */
import { z } from 'zod';
import { extendZodWithOpenApiOnce } from './zod-openapi.js';

extendZodWithOpenApiOnce();

// === Enums ===

/**
 * Event category for filtering activity events by subsystem. `permissions` holds
 * every change to what agents may do (spec `agent-permissions` D14), and is kept
 * past the retention prune: a permission history that forgets cannot answer "who
 * allowed this".
 */
export const ActivityCategorySchema = z
  .enum(['tasks', 'relay', 'agent', 'config', 'system', 'permissions'])
  .openapi('ActivityCategory');

export type ActivityCategory = z.infer<typeof ActivityCategorySchema>;

/** Actor type: who triggered the event. */
export const ActorTypeSchema = z.enum(['user', 'agent', 'system', 'tasks']).openapi('ActorType');

export type ActorType = z.infer<typeof ActorTypeSchema>;

/** What the feed and the audit call a program the person bar let through with a key. */
export const PROGRAM_ACTOR_LABEL = 'A program with an API key';

/**
 * The actor for an action behind the person bar (`http.callerBar: 'person'`),
 * from who the bar let through: the person in the app, named `You` as the hand
 * routes named them, or a program holding a key (let through with login off),
 * named as a program and never as the person.
 *
 * @param caller - Who the person bar's pass says it saw.
 * @returns The actor fields to spread into an Activity event.
 */
export function personBarActivityActor(caller: 'person' | 'program'): {
  actorType: ActorType;
  actorLabel: string;
} {
  return caller === 'program'
    ? { actorType: 'system', actorLabel: PROGRAM_ACTOR_LABEL }
    : { actorType: 'user', actorLabel: 'You' };
}

// === Response Schemas ===

/** Single activity event returned by the API. */
export const ActivityItemSchema = z
  .object({
    id: z.string(),
    occurredAt: z.string(),
    actorType: ActorTypeSchema,
    actorId: z.string().nullable(),
    actorLabel: z.string(),
    category: ActivityCategorySchema,
    eventType: z.string(),
    resourceType: z.string().nullable(),
    resourceId: z.string().nullable(),
    resourceLabel: z.string().nullable(),
    summary: z.string(),
    linkPath: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()).nullable(),
  })
  .openapi('ActivityItem');

export type ActivityItem = z.infer<typeof ActivityItemSchema>;

// === Query Schemas ===

/**
 * Query parameters for `GET /api/activity`.
 *
 * Uses `z.coerce.number()` for `limit` because Express query params arrive as strings.
 * `categories` is a comma-separated string that the service splits — keeping the
 * query param flat avoids array-in-URL complexity.
 */
export const ListActivityQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional().default(50),
    /** ISO 8601 timestamp cursor — fetch events older than this. */
    before: z.string().datetime({ offset: true }).optional(),
    /** Comma-separated category names for filtering. */
    categories: z.string().optional(),
    actorType: ActorTypeSchema.optional(),
    actorId: z.string().optional(),
    /** Only events about this resource (an agent id, a schedule id, …). */
    resourceId: z.string().min(1).optional(),
    /** ISO 8601 timestamp lower bound — only events after this time. */
    since: z.string().datetime({ offset: true }).optional(),
  })
  .openapi('ListActivityQuery');

export type ListActivityQuery = z.infer<typeof ListActivityQuerySchema>;

/** Paginated activity response with cursor-based pagination. */
export const ListActivityResponseSchema = z
  .object({
    items: z.array(ActivityItemSchema),
    nextCursor: z.string().nullable(),
  })
  .openapi('ListActivityResponse');

export type ListActivityResponse = z.infer<typeof ListActivityResponseSchema>;
