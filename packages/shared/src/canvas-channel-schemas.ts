/** Strict, transport-independent document channel contracts. No transport is enabled here. */
import { z } from 'zod';
import { CanvasDocIncarnationSchema } from './canvas-doc-incarnation.js';
export {
  CanvasDocIncarnationSchema,
  sameCanvasDocIncarnation,
  type CanvasDocIncarnation,
} from './canvas-doc-incarnation.js';
import {
  CANVAS_CHANNEL_ENVELOPE_BYTES,
  CanvasChannelJsonValueSchema,
  CanvasChannelStateSchema,
  RecursiveJsonSchema,
  boundedJson,
  unsafeKeys,
} from './canvas-channel-json.js';
export {
  CANVAS_CHANNEL_ENVELOPE_BYTES,
  CANVAS_CHANNEL_JSON_DEPTH,
  CANVAS_CHANNEL_STATE_BYTES,
  CanvasChannelJsonValueSchema,
  CanvasChannelStateSchema,
  inspectCanvasChannelJson,
  type CanvasChannelJsonValue,
} from './canvas-channel-json.js';

const IdentifierSchema = z.string().min(1).max(200);
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
/** Safe nonnegative sequence or revision; zero is the empty baseline. */
export const CanvasChannelSequenceSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** Stable event identifier: UUID format, without requiring a particular version. */
export const CanvasChannelEventIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu);
/** Complete, dot-separated ASCII event type without wildcard segments. */
export const CanvasChannelEventTypeSchema = z
  .string()
  .max(128)
  .regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/u);
/** Exact type or one terminal segment wildcard used by a declared route. */
export const CanvasChannelEventPatternSchema = z
  .string()
  .max(128)
  .regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*(?:\.\*)?$/u);
/** Public page types cannot impersonate host, state or application receipts. */
export const CanvasChannelPublicEventTypeSchema = CanvasChannelEventTypeSchema.refine(
  (type) =>
    !type.startsWith('doc.') &&
    !type.startsWith('state.') &&
    type !== 'selection.ask' &&
    type !== 'md.task.toggled' &&
    type !== 'event.status' &&
    type !== 'app.ack',
  { message: 'This event type is reserved' }
);

/** Agent event types permit application acknowledgements, never host/system events. */
export const CanvasChannelDownstreamEventTypeSchema = z.union([
  CanvasChannelPublicEventTypeSchema,
  z.literal('app.ack'),
]);

const PageEventShape = {
  v: z.literal(1),
  id: CanvasChannelEventIdSchema,
  type: CanvasChannelEventTypeSchema,
  payload: RecursiveJsonSchema,
  coalesceKey: z.string().min(1).max(128).optional(),
  ts: z.string().datetime({ offset: true }).optional(),
};
/** Untrusted public upstream envelope, bounded before recursive parsing. */
export const PageEventSchema = boundedJson(
  z.object({ ...PageEventShape, type: CanvasChannelPublicEventTypeSchema }).strict()
);
/** Validated public page envelope. */
export type PageEvent = z.infer<typeof PageEventSchema>;
/** Trusted host/storage envelope, permitting reserved types without granting authority. */
export const StoredPageEventSchema = boundedJson(z.object(PageEventShape).strict());
/** Trusted envelope; access checks still belong to the service. */
export type StoredPageEvent = z.infer<typeof StoredPageEventSchema>;

/** Durable ingestion acceptance, distinct from delivery completion. */
export const IngestReceiptSchema = z
  .object({
    id: CanvasChannelEventIdSchema,
    status: z.enum(['recorded', 'duplicate']),
    docSeq: CanvasChannelSequenceSchema,
  })
  .strict();
/** Durable ingestion acceptance. */
export type IngestReceipt = z.infer<typeof IngestReceiptSchema>;
/** Stored event projection without private viewer identities. */
export const CanvasChannelEventSchema = z
  .object({
    id: CanvasChannelEventIdSchema,
    type: CanvasChannelEventTypeSchema,
    payload: CanvasChannelJsonValueSchema,
    direction: z.enum(['upstream', 'downstream', 'system']),
    receivedAt: z.string().datetime({ offset: true }),
  })
  .strict();
/** Scope notification; docSeq is independent of scope-stream cursors and document rev. */
export const CanvasChannelFrameSchema = z
  .object({
    type: z.literal('canvas_event'),
    scope: IdentifierSchema,
    documentId: IdentifierSchema,
    docSeq: CanvasChannelSequenceSchema,
    incarnation: CanvasDocIncarnationSchema.optional(),
    event: CanvasChannelEventSchema,
  })
  .strict()
  .refine((value) => !Object.hasOwn(value, 'incarnation') || value.incarnation !== undefined, {
    message: 'A supplied document incarnation must be complete',
    path: ['incarnation'],
  });
/** One channel frame. */
export type CanvasChannelFrame = z.infer<typeof CanvasChannelFrameSchema>;

/** Complete segment matching; a terminal wildcard matches descendants only. */
export function matchesCanvasChannelEvent(pattern: string, type: string): boolean {
  if (
    !CanvasChannelEventPatternSchema.safeParse(pattern).success ||
    !CanvasChannelEventTypeSchema.safeParse(type).success
  )
    return false;
  return pattern.endsWith('.*') ? type.startsWith(pattern.slice(0, -1)) : pattern === type;
}

/** Route target; no cross-room routing address exists. */
export const CanvasChannelDestinationSchema = z.union([
  z.literal('log'),
  z.literal('agent:owner'),
  z.literal('room:self'),
  z
    .string()
    .regex(/^agent:[A-Za-z0-9_-]+$/u)
    .max(206),
]);
/** Scheduling declaration. Immediate still observes admission and rate limits. */
export const CanvasChannelTurnSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }).strict(),
  z.object({ mode: z.literal('immediate'), maxBatch: z.number().int().min(1).max(100) }).strict(),
  z
    .object({
      mode: z.literal('coalesce'),
      windowMs: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
      maxBatch: z.number().int().min(1).max(100),
    })
    .strict(),
]);
/** A page declaration is data and never an approval. */
export const CanvasChannelRouteSchema = z
  .object({
    id: IdentifierSchema,
    on: CanvasChannelEventPatternSchema,
    to: CanvasChannelDestinationSchema,
    turn: CanvasChannelTurnSchema,
    coalescibleTypes: z.array(CanvasChannelEventTypeSchema).max(128).optional(),
  })
  .strict();
/** Stable declaration with no default routes or implicit consent. */
export const CanvasChannelDeclarationSchema = z
  .object({ routes: z.array(CanvasChannelRouteSchema).max(16) })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.routes.map((route) => route.id)).size !== value.routes.length)
      context.addIssue({ code: 'custom', path: ['routes'], message: 'Route IDs must be unique' });
  });
/** Declaration for any canvas content type. */
export type CanvasChannelDeclaration = z.infer<typeof CanvasChannelDeclarationSchema>;
/** One declared route. */
export type CanvasChannelRoute = z.infer<typeof CanvasChannelRouteSchema>;

/** Exact approved source binding for the restricted checkbox operation. */
export const CanvasChannelCheckboxBindingSchema = z
  .object({
    operation: z.literal('checkbox-toggle'),
    sourceIdentity: IdentifierSchema,
    resolvedCwd: z.string().min(1),
    treeKind: z.enum(['room-main', 'worktree', 'agent-cwd']),
    canonicalPath: z.string().min(1),
  })
  .strict();
/** Server-owned authority evidence, never part of the page envelope. */
export const CanvasChannelGrantSchema = z
  .object({
    grantId: IdentifierSchema,
    documentId: IdentifierSchema,
    routeId: IdentifierSchema,
    openerAgentId: IdentifierSchema.nullable(),
    targetAgentId: IdentifierSchema.nullable(),
    targetSessionId: IdentifierSchema.nullable(),
    targetRuntime: IdentifierSchema.nullable(),
    revision: CanvasChannelSequenceSchema,
    route: CanvasChannelRouteSchema,
    routeHash: HashSchema,
    declarationHash: HashSchema,
    manifestHash: HashSchema.nullable(),
    allowedTypes: z.array(CanvasChannelEventPatternSchema).min(1).max(128),
    limits: z
      .object({
        envelopeBytes: z.number().int().min(1).max(CANVAS_CHANNEL_ENVELOPE_BYTES),
        eventsPerMinute: z.number().int().min(1).max(60),
        turnsPerHour: z.number().int().min(1).max(10),
      })
      .strict(),
    approvedBy: IdentifierSchema,
    approvalId: IdentifierSchema.nullable(),
    write: CanvasChannelCheckboxBindingSchema.nullable(),
    createdAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    revokedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
/** Grant evidence; service revalidation is required at dispatch. */
export type CanvasChannelGrant = z.infer<typeof CanvasChannelGrantSchema>;

/** Delivery outcomes deliberately separate admission, runtime settlement and app handling. */
export const CanvasChannelDeliveryStatusSchema = z.enum([
  'saved',
  'pending',
  'routed',
  'waiting',
  'accepted',
  'turn_started',
  'turn_done',
  'failed',
  'in_doubt',
  'expired',
  'superseded',
  'cancelled',
  'handled',
  'rejected',
  'unavailable',
]);
/** Per-input, per-route durable result. */
export const CanvasChannelDeliverySchema = z
  .object({
    eventId: CanvasChannelEventIdSchema,
    routeId: IdentifierSchema,
    batchId: IdentifierSchema.nullable(),
    status: CanvasChannelDeliveryStatusSchema,
    turnId: IdentifierSchema.nullable(),
    reason: z.string().max(1000).nullable(),
    nextEligibleAt: z.string().datetime({ offset: true }).optional(),
    updatedAt: z.string().datetime({ offset: true }),
    ackOutcome: z.enum(['handled', 'rejected']).nullable().optional(),
    acknowledgedAt: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();
/** Receipt plus per-route outcomes; failure never erases ingestion. */
export const CanvasChannelEventReceiptSchema = z
  .object({
    receipt: IngestReceiptSchema,
    deliveries: z.array(CanvasChannelDeliverySchema).max(16),
    payloadAvailable: z.boolean().optional(),
  })
  .strict();
/** Public acceptance and per-route receipt, without private actor or authority evidence. */
export type CanvasChannelEventReceipt = z.infer<typeof CanvasChannelEventReceiptSchema>;
/** Canonical application acknowledgement; correlation is checked by the service. */
export const CanvasChannelAppAckSchema = z
  .object({
    batchId: IdentifierSchema,
    routeId: IdentifierSchema,
    eventIds: z.array(CanvasChannelEventIdSchema).min(1).max(1000),
    outcome: z.enum(['handled', 'rejected']),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.eventIds).size !== value.eventIds.length)
      context.addIssue({
        code: 'custom',
        path: ['eventIds'],
        message: 'Acknowledged event IDs must be unique',
      });
  });
/** Application acknowledgement data. */
export type CanvasChannelAppAck = z.infer<typeof CanvasChannelAppAckSchema>;

/** Literal JSON Pointer; rejects malformed escapes and decoded prototype segments. */
export const CanvasChannelPointerSchema = z
  .string()
  .max(4096)
  .refine(
    (path) => {
      if (path === '') return true;
      if (!path.startsWith('/')) return false;
      return path
        .slice(1)
        .split('/')
        .every(
          (segment) =>
            !/~(?![01])/u.test(segment) &&
            !unsafeKeys.has(segment.replaceAll('~1', '/').replaceAll('~0', '~'))
        );
    },
    { message: 'Expected a safe JSON Pointer' }
  );
/** Restricted state operation; no expressions or arbitrary object mutation. */
export const CanvasChannelStateOperationSchema = z.discriminatedUnion('op', [
  z
    .object({ op: z.literal('set'), path: CanvasChannelPointerSchema, value: RecursiveJsonSchema })
    .strict(),
  z.object({ op: z.literal('remove'), path: CanvasChannelPointerSchema }).strict(),
]);
/** Atomic state-patch tool request, bounded including its entire envelope. */
export const CanvasChannelPatchStateRequestSchema = boundedJson(
  z
    .object({
      documentId: IdentifierSchema,
      eventId: CanvasChannelEventIdSchema,
      expectedStateRev: CanvasChannelSequenceSchema,
      roomId: IdentifierSchema.optional(),
      operations: z.array(CanvasChannelStateOperationSchema).min(1).max(100),
    })
    .strict()
);
/** Atomic state-patch request. */
export type CanvasChannelPatchStateRequest = z.infer<typeof CanvasChannelPatchStateRequestSchema>;
/** Downstream agent send; app.ack remains permitted for authorized targets. */
export const CanvasChannelSendRequestSchema = boundedJson(
  z
    .object({
      documentId: IdentifierSchema,
      eventId: CanvasChannelEventIdSchema,
      type: CanvasChannelDownstreamEventTypeSchema,
      payload: RecursiveJsonSchema,
      roomId: IdentifierSchema.optional(),
    })
    .strict()
);
/** Downstream agent send request. */
export type CanvasChannelSendRequest = z.infer<typeof CanvasChannelSendRequestSchema>;
/** State-patch result, not proof a viewer rendered the update. */
export const CanvasChannelPatchStateReceiptSchema = z
  .object({ receipt: IngestReceiptSchema, stateRev: CanvasChannelSequenceSchema })
  .strict();
/** Replay request; zero asks for the empty baseline. */
export const CanvasChannelReplayQuerySchema = z
  .object({
    since: CanvasChannelSequenceSchema.optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();
/** Channel health exposes actionable reasons without private identities. */
export const CanvasChannelHealthSchema = z
  .object({
    status: z.enum(['ready', 'warning', 'closed', 'in_doubt']),
    reasons: z.array(z.string().min(1).max(1000)).max(128),
  })
  .strict();
/** Replay and reset projection; state is not document content. */
/** Current server-verified route readiness, never inferred from declarations or page data. */
export const CanvasChannelRoutingSchema = z
  .object({
    enabled: z.boolean(),
    approvedEventTypes: z.array(CanvasChannelEventPatternSchema).max(2048),
    destinationLabel: z.string().max(500),
  })
  .strict();
export type CanvasChannelRouting = z.infer<typeof CanvasChannelRoutingSchema>;
/** Own undefined is a malformed supplied birth, not genuine legacy absence. */
function hasCompleteSuppliedIncarnation(value: { incarnation?: unknown }): boolean {
  return !Object.hasOwn(value, 'incarnation') || value.incarnation !== undefined;
}
/** Unrefined base allows snapshot projection before applying the identical birth check. */
const canvasChannelReplayBaseSchema = z
  .object({
    routing: CanvasChannelRoutingSchema.optional(),
    events: z.array(CanvasChannelFrameSchema).max(200),
    incarnation: CanvasDocIncarnationSchema.optional(),
    state: CanvasChannelStateSchema,
    stateRev: CanvasChannelSequenceSchema,
    highWatermark: CanvasChannelSequenceSchema,
    retentionFloor: CanvasChannelSequenceSchema,
    receiptRetentionFloor: CanvasChannelSequenceSchema,
    resetRequired: z.boolean(),
    health: CanvasChannelHealthSchema,
    receipts: z.array(CanvasChannelEventReceiptSchema).max(200),
  })
  .strict();
export const CanvasChannelReplayResponseSchema = canvasChannelReplayBaseSchema.refine(
  hasCompleteSuppliedIncarnation,
  {
    message: 'A supplied document incarnation must be complete',
    path: ['incarnation'],
  }
);
/** Replay projection. */
export type CanvasChannelReplayResponse = z.infer<typeof CanvasChannelReplayResponseSchema>;

/** Structured untrusted context data, not yet an AdditionalContext discriminant. */
export const CanvasChannelDocEventsContextSchema = z
  .object({
    documentId: IdentifierSchema,
    documentLabel: z.string().max(500),
    scope: IdentifierSchema,
    batchId: IdentifierSchema,
    routeId: IdentifierSchema,
    grantId: IdentifierSchema,
    events: z
      .array(
        z
          .object({
            id: CanvasChannelEventIdSchema,
            type: CanvasChannelEventTypeSchema,
            payload: CanvasChannelJsonValueSchema,
            docSeq: CanvasChannelSequenceSchema,
          })
          .strict()
      )
      .min(1)
      .max(100),
  })
  .strict();
/** Context for runtime-independent prompt assembly. */
export type CanvasChannelDocEventsContext = z.infer<typeof CanvasChannelDocEventsContextSchema>;
/** Native widget emission data; host supplies all provenance. */
export const CanvasChannelEmitActionSchema = z
  .object({
    kind: z.literal('emit'),
    type: CanvasChannelPublicEventTypeSchema,
    payload: CanvasChannelJsonValueSchema,
    coalesceKey: z.string().min(1).max(128).optional(),
  })
  .strict();
/** Declarative state binding, using a literal pointer only. */
export const CanvasChannelBindSchema = z.object({ path: CanvasChannelPointerSchema }).strict();
/** Per-mount presence; only server-issued viewers can refresh or leave. */
export const CanvasChannelPresenceRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('mount') }).strict(),
  z.object({ action: z.literal('heartbeat'), viewerId: IdentifierSchema }).strict(),
  z.object({ action: z.literal('unmount'), viewerId: IdentifierSchema }).strict(),
]);
/** Presence response reveals counts of mounts, not person identities. */
export const CanvasChannelPresenceResponseSchema = z
  .object({
    viewerId: IdentifierSchema,
    views: CanvasChannelSequenceSchema,
    heartbeatMs: z.literal(30_000),
    ttlMs: z.literal(75_000),
  })
  .strict();
/** Read-only frame bridge status. */
export const CanvasChannelBridgeStatusSchema = z.enum([
  'connecting',
  'ready',
  'offline',
  'revoked',
]);

/** Explicit restricted bearer issuance, independent of route grants. */
export const CanvasChannelTokenRequestSchema = z
  .object({
    documentId: IdentifierSchema,
    allowedTypes: z.array(CanvasChannelPublicEventTypeSchema).min(1).max(128),
    permissions: z
      .array(z.enum(['ingest', 'replay', 'stream']))
      .min(1)
      .max(3),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.permissions).size !== value.permissions.length ||
      new Set(value.allowedTypes).size !== value.allowedTypes.length
    )
      context.addIssue({ code: 'custom', message: 'Token permissions and types must be unique' });
  });
/** Persisted bearer authority contains a hash, never the recoverable bearer secret. */
export const CanvasChannelTokenRecordSchema = z
  .object({
    tokenId: IdentifierSchema,
    tokenHash: HashSchema,
    documentId: IdentifierSchema,
    allowedTypes: z.array(CanvasChannelPublicEventTypeSchema).min(1).max(128),
    permissions: z
      .array(z.enum(['ingest', 'replay', 'stream']))
      .min(1)
      .max(3),
    creatorId: IdentifierSchema,
    createdAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    revokedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
/** Hash-only persisted token evidence. */
export type CanvasChannelTokenRecord = z.infer<typeof CanvasChannelTokenRecordSchema>;

/** Secret issued once; never place this response in canvas content or snapshots. */
export const CanvasChannelTokenResponseSchema = z
  .object({
    tokenId: IdentifierSchema,
    token: z
      .string()
      .regex(/^dct_[A-Za-z0-9_-]{32,}$/u)
      .max(512),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();
/** Host-only checkbox request. A page envelope never becomes this operation. */
export const CanvasChannelCheckboxRequestSchema = z
  .object({
    documentId: IdentifierSchema,
    eventId: CanvasChannelEventIdSchema,
    line: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    textHash: HashSchema,
    expectedFileVersion: z.string().min(1).max(500),
    done: z.boolean(),
  })
  .strict();
/** Durable write intent allows restart reconciliation from before/after evidence. */
export const CanvasChannelCheckboxIntentSchema = z
  .object({
    request: CanvasChannelCheckboxRequestSchema,
    grantId: IdentifierSchema,
    binding: CanvasChannelCheckboxBindingSchema,
    beforeHash: HashSchema,
    afterHash: HashSchema,
    status: z.enum(['prepared', 'written', 'verified', 'conflict', 'no_op', 'in_doubt']),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();
/** Checkbox outcome; only verified changes may carry a routable success receipt. */
export const CanvasChannelCheckboxReceiptSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('changed'),
      receipt: IngestReceiptSchema,
      fileVersion: z.string().min(1),
    })
    .strict(),
  z
    .object({
      status: z.literal('no_op'),
      eventId: CanvasChannelEventIdSchema,
      fileVersion: z.string().min(1),
    })
    .strict(),
  z
    .object({
      status: z.literal('conflict'),
      eventId: CanvasChannelEventIdSchema,
      action: z.literal('reload'),
    })
    .strict(),
  z
    .object({
      status: z.literal('in_doubt'),
      eventId: CanvasChannelEventIdSchema,
      action: z.literal('review'),
    })
    .strict(),
]);

/** Current document state on a scope stream; it carries no transcript or room-entry cursor. */
export const CanvasChannelSnapshotFrameSchema = z
  .object({
    type: z.literal('canvas_channel_snapshot'),
    scope: IdentifierSchema,
    documentId: IdentifierSchema,
    snapshot: canvasChannelReplayBaseSchema
      .omit({ events: true })
      .refine(hasCompleteSuppliedIncarnation, {
        message: 'A supplied document incarnation must be complete',
        path: ['incarnation'],
      }),
  })
  .strict();
/** Document notification union shared by both scope protocols. */
export const CanvasChannelNotificationSchema = z.union([
  CanvasChannelFrameSchema,
  CanvasChannelSnapshotFrameSchema,
]);
export type CanvasChannelNotification = z.infer<typeof CanvasChannelNotificationSchema>;
