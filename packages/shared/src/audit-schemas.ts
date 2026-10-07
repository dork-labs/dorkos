/**
 * Zod schemas for the audit log (spec `audit-trail`).
 *
 * The audit log is the one append-only, hash-chained record of every action on
 * a DorkOS server. These are its wire shapes: the event as a reader sees it, and
 * the answer to "is the chain intact?".
 *
 * @module shared/audit-schemas
 */
import { z } from 'zod';
import { extendZodWithOpenApiOnce } from './zod-openapi.js';

extendZodWithOpenApiOnce();

/** What kind of account acted. */
export const AuditActorKindSchema = z
  .enum(['person', 'agent', 'system', 'external'])
  .openapi('AuditActorKind');

/** An audit actor's kind. */
export type AuditActorKind = z.infer<typeof AuditActorKindSchema>;

/** The broad kind of operation, borrowed from GitHub's audit log. */
export const AuditOperationSchema = z
  .enum(['create', 'modify', 'remove', 'access', 'execute', 'auth'])
  .openapi('AuditOperation');

/** An audit event's operation. */
export type AuditOperation = z.infer<typeof AuditOperationSchema>;

/** How an action came out. */
export const AuditOutcomeSchema = z.enum(['ok', 'failed', 'refused']).openapi('AuditOutcome');

/** An audit event's outcome. */
export type AuditOutcome = z.infer<typeof AuditOutcomeSchema>;

/**
 * Who may read a row: every member of the space, only the accounts named in
 * `participants`, or only admins (spec `audit-trail` §3.4).
 */
export const AuditVisibilitySchema = z
  .enum(['space', 'participants', 'admins'])
  .openapi('AuditVisibility');

/** An audit event's visibility class. */
export type AuditVisibility = z.infer<typeof AuditVisibilitySchema>;

/** Where an action came in. */
export const AuditSurfaceSchema = z
  .enum(['app', 'http', 'mcp', 'cli', 'relay', 'task', 'bridge', 'runtime-tool', 'system'])
  .openapi('AuditSurface');

/** An audit event's surface. */
export type AuditSurface = z.infer<typeof AuditSurfaceSchema>;

/** Who acted, by a stable account id and the name they had at the time. */
export const AuditActorSchema = z
  .object({
    accountId: z.string(),
    kind: AuditActorKindSchema,
    name: z.string(),
  })
  .openapi('AuditActor');

/** An audit actor. */
export type AuditActor = z.infer<typeof AuditActorSchema>;

/** Where the action came from: surface, and the session or run it belongs to. */
export const AuditSourceSchema = z
  .object({
    surface: AuditSurfaceSchema,
    runtime: z.string().optional(),
    sessionId: z.string().optional(),
    turnId: z.string().optional(),
    taskRunId: z.string().optional(),
    toolCallId: z.string().optional(),
  })
  .openapi('AuditSource');

/** An audit event's source. */
export type AuditSource = z.infer<typeof AuditSourceSchema>;

/** What was acted on. */
export const AuditTargetSchema = z
  .object({
    type: z.string(),
    id: z.string(),
    name: z.string().optional(),
    containerId: z.string().optional(),
  })
  .openapi('AuditTarget');

/** An audit event's target. */
export type AuditTarget = z.infer<typeof AuditTargetSchema>;

/** One field that changed. A secret field carries `redacted: true` and no values. */
export const AuditChangeSchema = z
  .object({
    field: z.string(),
    before: z.unknown().optional(),
    after: z.unknown().optional(),
    redacted: z.boolean().optional(),
  })
  .openapi('AuditChange');

/** One changed field. */
export type AuditChange = z.infer<typeof AuditChangeSchema>;

/** Records elsewhere that this event points at. */
export const AuditLinksSchema = z
  .object({
    activityId: z.string().optional(),
    approvalId: z.string().optional(),
    traceId: z.string().optional(),
    causedBy: z.string().optional(),
    connectorAttemptId: z.string().optional(),
  })
  .openapi('AuditLinks');

/** An audit event's links. */
export type AuditLinks = z.infer<typeof AuditLinksSchema>;

/** One audit event, as a reader sees it. */
export const AuditEventSchema = z
  .object({
    seq: z.number().int().positive(),
    id: z.string(),
    at: z.string(),
    spaceId: z.string().nullable(),
    actor: AuditActorSchema,
    onBehalfOf: z
      .array(
        z.object({
          accountId: z.string(),
          via: z.enum(['schedule', 'delegation', 'room-turn', 'extension', 'bridge']),
        })
      )
      .optional(),
    credential: z.object({ kind: z.string(), idHash: z.string() }).optional(),
    source: AuditSourceSchema,
    action: z.string(),
    operation: AuditOperationSchema,
    target: AuditTargetSchema.nullable(),
    outcome: AuditOutcomeSchema,
    error: z.string().optional(),
    change: z.array(AuditChangeSchema).optional(),
    reason: z.string().optional(),
    links: AuditLinksSchema.optional(),
    summary: z.string(),
    visibility: AuditVisibilitySchema,
    participants: z.array(z.string()).optional(),
    prevHash: z.string(),
    hash: z.string(),
  })
  .openapi('AuditEvent');

/** One audit event. */
export type AuditEvent = z.infer<typeof AuditEventSchema>;

/** The most rows one chain check walks; a longer log is checked in pages. */
export const AUDIT_VERIFY_MAX_ROWS = 100_000;

/**
 * Which part of the chain to check: from `fromSeq` (default the first row), at
 * most `limit` rows (default and ceiling {@link AUDIT_VERIFY_MAX_ROWS}).
 */
export const AuditVerifyQuerySchema = z
  .object({
    fromSeq: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().max(AUDIT_VERIFY_MAX_ROWS).optional(),
  })
  .openapi('AuditVerifyQuery');

/** Input to a chain check. */
export type AuditVerifyQuery = z.infer<typeof AuditVerifyQuerySchema>;

/** Whether the chain is intact, and where it first breaks if not. */
export const AuditVerifyResultSchema = z
  .object({
    ok: z.boolean(),
    checked: z.number().int().nonnegative(),
    lastSeq: z.number().int().nonnegative(),
    lastHash: z.string(),
    firstBreak: z.object({ seq: z.number().int(), reason: z.string() }).optional(),
    /** Set when rows remain past this page: check again from here. */
    nextFromSeq: z.number().int().positive().optional(),
  })
  .openapi('AuditVerifyResult');

/** The result of a chain check. */
export type AuditVerifyResult = z.infer<typeof AuditVerifyResultSchema>;
