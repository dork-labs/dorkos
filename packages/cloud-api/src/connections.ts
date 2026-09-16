import { z } from 'zod';

import { IdSchema, TimestampSchema, pageOf } from './primitives.js';

/**
 * How a toolkit is authenticated.
 *
 * Mechanism: it tells a client which flow to run, and names no vendor.
 */
export const AuthenticationKindSchema = z
  .enum(['oauth2', 'api_key', 'basic', 'bearer', 'none'])
  .describe('Which authentication flow a toolkit needs. Mechanism only; no vendor is named.');

/** The lifecycle of one managed connection. */
export const ConnectionStatusSchema = z
  .enum(['pending', 'active', 'degraded', 'expired', 'revoked'])
  .describe('The lifecycle state of a managed connection.');

/** One toolkit the catalog offers. */
export const ToolkitSummarySchema = z
  .object({
    toolkit: z.string().describe('The opaque toolkit identifier.'),
    displayName: z.string(),
    description: z.string().optional(),
    iconUrl: z.string().url().optional(),
    authentication: AuthenticationKindSchema,
    version: z.string().describe('The catalog version of this toolkit, as an opaque string.'),
  })
  .describe('One toolkit the managed-connection catalog offers.');

/** One toolkit the managed-connection catalog offers. */
export type ToolkitSummary = z.infer<typeof ToolkitSummarySchema>;

/** `GET /v1/connections/catalog` — every toolkit on offer. */
export const ConnectionCatalogResponseSchema = pageOf(
  ToolkitSummarySchema,
  'A page of the toolkits the managed-connection catalog offers.'
);

/** `GET /v1/connections/toolkits/{toolkit}/version`. */
export const ToolkitVersionResponseSchema = z
  .object({
    toolkit: z.string(),
    version: z.string().describe('An opaque version string. Compare for equality; never parse it.'),
    updatedAt: TimestampSchema,
  })
  .describe('The current catalog version of one toolkit.');

/** One callable operation a toolkit exposes. */
export const ToolkitOperationSchema = z
  .object({
    slug: z.string().describe('The opaque operation identifier.'),
    displayName: z.string(),
    description: z.string().optional(),
    inputSchema: z
      .unknown()
      .describe('A JSON Schema for the operation`s input, as published by the toolkit.'),
    outputSchema: z
      .unknown()
      .optional()
      .describe('A JSON Schema for the operation`s output, where one is published.'),
  })
  .describe('One callable operation a toolkit exposes.');

/** `GET /v1/connections/toolkits/{toolkit}/operations`. */
export const ToolkitOperationsResponseSchema = pageOf(
  ToolkitOperationSchema,
  'A page of the operations one toolkit exposes.'
);

/** One event a toolkit can deliver. */
export const ToolkitEventSchema = z
  .object({
    slug: z.string().describe('The opaque event identifier.'),
    displayName: z.string(),
    description: z.string().optional(),
    payloadSchema: z
      .unknown()
      .optional()
      .describe('A JSON Schema for the event payload, where one is published.'),
  })
  .describe('One event a toolkit can deliver.');

/** `GET /v1/connections/toolkits/{toolkit}/events`. */
export const ToolkitEventsResponseSchema = pageOf(
  ToolkitEventSchema,
  'A page of the events one toolkit can deliver.'
);

/** One managed connection belonging to the caller. */
export const ConnectionSchema = z
  .object({
    id: IdSchema,
    toolkit: z.string(),
    displayName: z.string(),
    status: ConnectionStatusSchema,
    orgId: IdSchema.nullable(),
    seatId: IdSchema.nullable(),
    createdAt: TimestampSchema,
    expiresAt: TimestampSchema.nullable(),
    lastUsedAt: TimestampSchema.nullable(),
  })
  .describe('One managed connection belonging to the caller.');

/** One managed connection belonging to the caller. */
export type Connection = z.infer<typeof ConnectionSchema>;

/** `GET /v1/connections`. */
export const ConnectionListResponseSchema = pageOf(
  ConnectionSchema,
  'A page of the caller`s managed connections.'
);

/** `POST /v1/connections/authentication-flows` — begin connecting a toolkit. */
export const AuthenticationFlowRequestSchema = z
  .object({
    toolkit: z.string(),
    seatId: IdSchema.optional().describe('The seat the resulting connection belongs to.'),
    redirectUrl: z
      .string()
      .url()
      .optional()
      .describe('Where to send the person after the hosted flow completes.'),
  })
  .describe(
    'Begin connecting a toolkit. The hosted page is a runtime value; no origin is baked into this package.'
  );

/** An authentication flow in progress. */
export const AuthenticationFlowSchema = z
  .object({
    flowId: IdSchema,
    toolkit: z.string(),
    status: z
      .enum(['pending', 'awaiting_user', 'succeeded', 'failed', 'expired'])
      .describe('How far the flow has got.'),
    redirectUrl: z
      .string()
      .url()
      .nullable()
      .describe('The hosted page to send the person to, or null when no redirect is needed.'),
    connectionId: IdSchema.nullable().describe(
      'The connection this flow produced, once it succeeded.'
    ),
    createdAt: TimestampSchema,
    expiresAt: TimestampSchema,
  })
  .describe('An authentication flow in progress, or its outcome.');

/** An authentication flow in progress, or its outcome. */
export type AuthenticationFlow = z.infer<typeof AuthenticationFlowSchema>;

/**
 * `POST /v1/connections/authority-commands` — an operation on a connection
 * that only the issuing authority can perform.
 */
export const AuthorityCommandRequestSchema = z
  .object({
    connectionId: IdSchema,
    command: z
      .enum(['refresh', 'reauthorize', 'disable', 'enable', 'delete'])
      .describe('What to do to the connection. Mechanism only.'),
    idempotencyKey: z
      .string()
      .min(1)
      .describe(
        'A client-chosen key. Repeating a command with the same key repeats its result, not its effect.'
      ),
  })
  .describe('An operation on a connection that only the issuing authority can perform.');

/** The state of an authority command. */
export const AuthorityCommandSchema = z
  .object({
    commandId: IdSchema,
    connectionId: IdSchema,
    status: z.enum(['queued', 'running', 'succeeded', 'failed']),
    createdAt: TimestampSchema,
    completedAt: TimestampSchema.nullable(),
  })
  .describe('The state of an authority command.');

/** `POST /v1/connections/executions` — run one toolkit operation. */
export const ExecutionRequestSchema = z
  .object({
    connectionId: IdSchema,
    operation: z.string().describe('The opaque operation slug to run.'),
    input: z
      .unknown()
      .describe('The operation input, matching the operation`s published input schema.'),
    idempotencyKey: z.string().min(1),
  })
  .describe('Run one toolkit operation through a managed connection.');

/** One attempt at a toolkit operation. */
export const ExecutionSchema = z
  .object({
    attemptId: IdSchema,
    connectionId: IdSchema,
    operation: z.string(),
    status: z.enum(['queued', 'running', 'succeeded', 'failed', 'canceled']),
    startedAt: TimestampSchema,
    completedAt: TimestampSchema.nullable(),
    output: z
      .unknown()
      .optional()
      .describe('The operation output, present once the attempt succeeded.'),
    failure: z
      .object({ reason: z.string(), retriable: z.boolean() })
      .nullable()
      .describe('Why the attempt failed, and whether repeating it could succeed.'),
  })
  .describe('One attempt at a toolkit operation.');

/** One attempt at a toolkit operation. */
export type Execution = z.infer<typeof ExecutionSchema>;

/**
 * `POST /v1/connections/events/pull` — lease a batch of pending events.
 *
 * Lease-based and deliberately cursor-free: a pull hands out work, and only an
 * exact lease receipt acknowledges it. The seat inbox is this route's sibling
 * rather than a second design.
 */
export const ConnectionEventPullRequestSchema = z
  .object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('How many events to lease. Defaults to 50, capped at 100.'),
  })
  .describe('Lease a batch of pending connector events. Cursor-free by design.');

/** One leased connector event. */
export const ConnectionEventSchema = z
  .object({
    id: IdSchema,
    leaseToken: z
      .string()
      .min(1)
      .describe('The receipt that acknowledges exactly this delivery of exactly this event.'),
    connectionId: IdSchema,
    toolkit: z.string(),
    event: z.string().describe('The opaque event slug.'),
    receivedAt: TimestampSchema,
    expiresAt: TimestampSchema.describe(
      'When the lease lapses and the event becomes pullable again.'
    ),
    payload: z.unknown(),
  })
  .describe('One connector event, leased to exactly one puller until its lease expires.');

/** A leased batch of connector events. */
export const ConnectionEventPullResponseSchema = z
  .object({ items: z.array(ConnectionEventSchema) })
  .describe('A leased batch of connector events. No cursor, by design.');

/** `POST /v1/connections/events/ack` — settle leases. */
export const ConnectionEventAckRequestSchema = z
  .object({
    items: z
      .array(z.object({ id: IdSchema, leaseToken: z.string().min(1) }))
      .min(1)
      .max(100),
  })
  .describe('Settle event leases with exact receipts. One to a hundred at a time.');

/** How many leases were settled. */
export const ConnectionEventAckResponseSchema = z
  .object({ acknowledged: z.number().int().nonnegative() })
  .describe('How many leases the server settled.');

/** `GET /v1/connections/usage` and `GET /v1/connections/{id}/usage`. */
export const ConnectionUsageResponseSchema = z
  .object({
    periodStart: TimestampSchema,
    periodEnd: TimestampSchema,
    rows: z.array(
      z.object({
        connectionId: IdSchema,
        toolkit: z.string(),
        actions: z.number().int().nonnegative().describe('How many operations ran in the period.'),
        events: z
          .number()
          .int()
          .nonnegative()
          .describe('How many events were delivered in the period.'),
      })
    ),
    totals: z.object({
      actions: z.number().int().nonnegative(),
      events: z.number().int().nonnegative(),
    }),
  })
  .describe(
    'Counts of managed-connection activity for a period. Counts only; no amount appears here.'
  );
