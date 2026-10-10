/** Public document HTTP contracts; documentation never creates a capability surface or actor. */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { ErrorResponseSchema, WriteFileRequestSchema } from '@dorkos/shared/schemas';
import {
  PageEventSchema,
  CanvasChannelEventReceiptSchema,
  CanvasChannelReplayResponseSchema,
  CanvasChannelReplayQuerySchema,
  CanvasChannelSelectionRequestSchema,
  CanvasChannelCheckboxRequestSchema,
  CanvasChannelCheckboxReceiptSchema,
  CanvasChannelPresenceRequestSchema,
  CanvasChannelPresenceResponseSchema,
  CanvasChannelManagementSnapshotSchema,
  CanvasChannelTokenRequestSchema,
  CanvasChannelTokenResponseSchema,
  CanvasChannelDeclarationSchema,
  CanvasChannelRouteGrantRequestSchema,
  CanvasChannelRouteApprovalResultSchema,
  CanvasChannelBatchReplayRequestSchema,
  CanvasChannelBatchReplayResultSchema,
  CanvasChannelJsonValueSchema,
} from '@dorkos/shared/canvas-channel-schemas';

const documentId = z.string().min(1).max(200);
const params = z.object({ id: documentId }).strict();
const generationHeaders = z.object({
  'X-DorkOS-Doc-Generation': z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .meta({ pattern: '^[a-f0-9]{64}$' }),
});
const approvalHeaders = z.object({ 'X-DorkOS-Approval': z.string().min(1).optional() });
const tokenHeaders = z.object({
  Authorization: z
    .string()
    .regex(/^Bearer dct_[A-Za-z0-9_-]{43}$/u)
    .meta({ pattern: '^Bearer dct_[A-Za-z0-9_-]{43}$' }),
});
const approvedGrantIds = z
  .array(z.string().min(1).max(200))
  .max(1024)
  .refine((ids) => new Set(ids).size === ids.length);
const tokenIssue = z
  .object({ request: CanvasChannelTokenRequestSchema, approvedGrantIds })
  .strict();
const tokenRevoked = z
  .object({ tokenId: documentId, revokedAt: z.string().datetime({ offset: true }) })
  .strict();
const tierApproval = z
  .object({
    status: z.literal('approval_required'),
    capabilityId: z.string(),
    capabilityTitle: z.string(),
    tier: z.string(),
    approvalId: z.string(),
    approvalToken: z.string(),
    expiresAt: z.string(),
    reason: z.string(),
    message: z.string(),
    retry: z.object({ channel: z.string(), field: z.string(), instructions: z.string() }).strict(),
  })
  .strict();
const tierDenied = z
  .object({
    status: z.literal('denied'),
    capabilityId: z.string(),
    capabilityTitle: z.string(),
    tier: z.string(),
    reason: z.string(),
    approvable: z.boolean(),
    message: z.string(),
    approvalId: z.string().optional(),
  })
  .strict();
const error = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorResponseSchema } },
});
const json = (schema: z.ZodType, description = 'Successful response') => ({
  description,
  content: { 'application/json': { schema } },
});
const host =
  'Ordinary Host, same-origin and installation session gates apply. The server derives the current actor and document source. A standalone document bearer cannot authorize operator controls. ';
const refusal = {
  400: error('Malformed or oversized bounded document request; no caller authority is accepted'),
  401: error('Installation authentication is required'),
  403: error('Current caller, source or operation is not permitted'),
  404: error('No current accessible document'),
  409: error('Original generation, operation, receipt or current source cannot be confirmed'),
  413: error('Request exceeds the actual parser or envelope bound'),
  422: error('Current source declaration or manifest refuses the operation'),
  429: error('Current rate or backlog limit refuses the operation'),
  500: error('Operation unavailable; a failed response does not prove that a write did not occur'),
  503: error('Installed original document service is unavailable'),
  507: error('Retained document storage is exhausted'),
};
// Token read DATA is deliberately narrower than the authenticated host replay; it has no state or routes.
const bearerRefusal = {
  400: error('Invalid bounded query or event body'),
  401: error('Original credential, expiry, source, type or permission is not available'),
  409: error('Original filtered event confirmation is unavailable'),
  413: error('Event body exceeds 16 KiB'),
};
const tokenEvent = z
  .object({
    id: z.string(),
    docSeq: z.number().int().nonnegative(),
    type: z.string(),
    direction: z.enum(['upstream', 'downstream', 'system']),
    receivedAt: z.string(),
    payloadPrunedAt: z.string().nullable(),
    payload: CanvasChannelJsonValueSchema,
  })
  .strict();
const tokenPage = z
  .object({
    documentId,
    generation: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .meta({ pattern: '^[a-f0-9]{64}$' }),
    highWatermark: z.number().int().nonnegative(),
    retentionFloor: z.number().int().nonnegative(),
    receiptRetentionFloor: z.number().int().nonnegative(),
    resetRequired: z.boolean(),
    events: z.array(tokenEvent).max(200),
  })
  .strict();
// Actual installed normal-save outcome; the legacy shared response documents only ok/hash.
const normalSave = z
  .object({
    ok: z.literal(true),
    hash: z.string(),
    effect: z.enum(['changed', 'no_op']),
    documentReceipt: CanvasChannelEventReceiptSchema.optional(),
  })
  .strict();
const fileConflict = z
  .object({
    error: z.literal('File changed on disk since it was opened'),
    code: z.literal('CONFLICT'),
    currentHash: z.string(),
    currentContent: z.string(),
  })
  .strict();

/** Register existing dedicated routes, using their original wire schemas and bounds. */
export function registerDocChannelOpenApi(registry: OpenAPIRegistry): void {
  const base = '/api/canvas/docs/{id}';
  registry.registerPath({
    method: 'get',
    path: base + '/channel',
    tags: ['Document channels'],
    summary: 'Replay one current document channel',
    description:
      host +
      'Document sequences and retained receipts are separate from the owning chat or Room stream cursor. Each retained frame carries the same current physical/channel incarnation as this response.',
    request: { params, query: CanvasChannelReplayQuerySchema },
    responses: { 200: json(CanvasChannelReplayResponseSchema), ...refusal },
  });
  registry.registerPath({
    method: 'post',
    path: base + '/events',
    tags: ['Document channels'],
    summary: 'Record a page document event',
    description:
      host +
      'Maximum 16 KiB envelope. Reserved host/downstream event names are refused. Recorded or duplicate acceptance is distinct from delivery, FIRST and per-input acknowledgement; it does not imply an agent turn.',
    request: {
      params,
      headers: generationHeaders,
      body: { content: { 'application/json': { schema: PageEventSchema } } },
    },
    responses: {
      200: json(CanvasChannelEventReceiptSchema, 'Original duplicate acceptance'),
      201: json(CanvasChannelEventReceiptSchema, 'New recorded acceptance'),
      ...refusal,
    },
  });
  registry.registerPath({
    method: 'get',
    path: base + '/events/{eventId}',
    tags: ['Document channels'],
    summary: 'Inspect an original document event receipt',
    description:
      host +
      'Inspection never resubmits uncertain work; missing or pruned confirmation returns 409.',
    request: { params: params.extend({ eventId: z.string().uuid() }), headers: generationHeaders },
    responses: { 200: json(CanvasChannelEventReceiptSchema), ...refusal },
  });
  registry.registerPath({
    method: 'post',
    path: base + '/editor/selection',
    tags: ['Document channels'],
    summary: 'Record an original editor selection',
    description:
      host +
      'Operator-only host command, not ordinary page ingress. Exact current FILE hash, source generation and UTF-16 ranges are verified against native bytes; selected text remains untrusted. A declaration and current approved route are independently required for delivery.',
    request: {
      params,
      body: { content: { 'application/json': { schema: CanvasChannelSelectionRequestSchema } } },
    },
    responses: { 200: json(CanvasChannelEventReceiptSchema), ...refusal },
  });
  registry.registerPath({
    method: 'post',
    path: base + '/checkbox',
    tags: ['Document channels'],
    summary: 'Apply an original FILE task marker',
    description:
      host +
      'Requires the installed original checkbox writer and exact original FILE approval/source. Refused, conflict and no-op outcomes do not manufacture changed completion.',
    request: {
      params,
      body: { content: { 'application/json': { schema: CanvasChannelCheckboxRequestSchema } } },
    },
    responses: { 200: json(CanvasChannelCheckboxReceiptSchema), ...refusal },
  });
  registry.registerPath({
    method: 'post',
    path: base + '/presence',
    tags: ['Document channels'],
    summary: 'Update a caller-bound document mount',
    description:
      host +
      'Server-issued viewer identity; identical logical-mount retry does not renew TTL or open twice. Focus is debounced and does not renew mount TTL. Quiet mount/count events are distinct from approved focus delivery.',
    request: {
      params,
      body: { content: { 'application/json': { schema: CanvasChannelPresenceRequestSchema } } },
    },
    responses: { 200: json(CanvasChannelPresenceResponseSchema), ...refusal },
  });
  registry.registerPath({
    method: 'get',
    path: base + '/management',
    tags: ['Document controls'],
    summary: 'Inspect current document control metadata',
    description:
      host +
      'Operator-only no-store metadata. Declarations, grants, token metadata, review availability and per-input acknowledgement do not create permission or prove FIRST. Token secrets are excluded.',
    request: { params },
    responses: { 200: json(CanvasChannelManagementSnapshotSchema), ...refusal },
  });
  registry.registerPath({
    method: 'post',
    path: base + '/tokens',
    tags: ['Document controls'],
    summary: 'Issue one scoped document credential',
    description:
      host +
      'Operator-only, no-store. Explicit document, type, direction, permission, expiry and selected current grant IDs. Reveal bearer once; never put it in URLs, content or state.',
    request: { params, body: { content: { 'application/json': { schema: tokenIssue } } } },
    responses: { 201: json(CanvasChannelTokenResponseSchema), ...refusal },
  });
  registry.registerPath({
    method: 'post',
    path: base + '/tokens/{tokenId}/revoke',
    tags: ['Document controls'],
    summary: 'Revoke one document credential',
    description:
      host +
      'Operator-only. Closes the credential’s active streams; it cannot be authorized by that credential.',
    request: {
      params: params.extend({ tokenId: documentId }),
      body: { content: { 'application/json': { schema: z.object({}).strict() } } },
    },
    responses: { 200: json(tokenRevoked), ...refusal },
  });
  const management = [
    [
      'configure',
      'Declare document routes',
      z
        .object({
          documentId,
          channel: CanvasChannelDeclarationSchema,
          openerAgentId: documentId.optional(),
        })
        .strict(),
      z.object({ configured: z.literal(true) }).strict(),
    ],
    [
      'approve',
      'Approve one exact document route',
      CanvasChannelRouteGrantRequestSchema.extend({
        routeApprovalToken: z.string().min(1).max(200).optional(),
      }).strict(),
      CanvasChannelRouteApprovalResultSchema,
    ],
    [
      'revoke',
      'Revoke one document route',
      z.object({ documentId, grantId: documentId }).strict(),
      z.object({ revoked: z.literal(true) }).strict(),
    ],
    [
      'replay',
      'Explicitly replay reviewed original work',
      CanvasChannelBatchReplayRequestSchema,
      CanvasChannelBatchReplayResultSchema,
    ],
    [
      'inspect',
      'Inspect current document controls',
      z.object({ documentId }).strict(),
      CanvasChannelManagementSnapshotSchema,
    ],
    [
      'issueToken',
      'Issue one scoped document credential',
      tokenIssue,
      CanvasChannelTokenResponseSchema,
    ],
    [
      'revokeToken',
      'Revoke one document credential',
      z.object({ documentId, tokenId: documentId }).strict(),
      tokenRevoked,
    ],
  ] as const;
  for (const [operation, summary, input, output] of management)
    registry.registerPath({
      method: 'post',
      path: base + '/manage/' + operation,
      tags: ['Document controls'],
      summary,
      description:
        host +
        'Operator access through the original capability registry; tier approval and exact route approval remain separate. X-DorkOS-Approval retries a tier ticket; routeApprovalToken retries the exact immutable route request. Replay permits only retained expired never-admitted chat or original Room work, excluding acknowledged, consumed, admitted and uncertain work; no automatic retry creates a new operation.',
      request: {
        params,
        headers: approvalHeaders,
        body: { content: { 'application/json': { schema: input } } },
      },
      responses: {
        200: json(output),
        202: {
          description:
            'Original capability tier approval is required; retain the same original input and review the actual approval subject',
          content: { 'application/json': { schema: tierApproval } },
        },
        ...refusal,
        403: json(
          z.union([tierDenied, ErrorResponseSchema]),
          'Original capability tier denial or ordinary document operation refusal'
        ),
      },
    });
  const bearerBase = '/api/canvas/token/docs/{id}';
  const bearerDescription =
    'Standalone Authorization: Bearer dct_ credential only, without cookies or query credentials. Exact document/types/directions/permissions/expiry are repeated against original current source; bearer CORS grants no installation or operator permission. No unfiltered state, routing, private grants or native identities are disclosed. ';
  registry.registerPath({
    method: 'get',
    path: bearerBase + '/channel',
    tags: ['Document tokens'],
    summary: 'Replay credential-visible document events',
    description: bearerDescription,
    request: { params, headers: tokenHeaders, query: CanvasChannelReplayQuerySchema },
    responses: { 200: json(tokenPage), ...bearerRefusal },
  });
  registry.registerPath({
    method: 'get',
    path: bearerBase + '/events/{eventId}',
    tags: ['Document tokens'],
    summary: 'Read one credential-visible retained event',
    description:
      bearerDescription +
      'This is filtered event DATA, not the host receipt shape. Missing confirmation returns 409.',
    request: { params: params.extend({ eventId: documentId }), headers: tokenHeaders },
    responses: { 200: json(tokenEvent), ...bearerRefusal },
  });
  registry.registerPath({
    method: 'get',
    path: bearerBase + '/stream',
    tags: ['Document tokens'],
    summary: 'Stream credential-visible document events',
    description:
      bearerDescription +
      'SSE reset DATA contains documentId/retentionFloor/highWatermark only; event DATA uses the same filtered event projection. Revocation, expiry or source retirement closes the original stream.',
    request: {
      params,
      headers: tokenHeaders,
      query: z.object({ since: z.number().int().nonnegative().optional() }).strict(),
    },
    responses: {
      200: {
        description: 'Filtered original SSE event/reset stream',
        content: { 'text/event-stream': { schema: z.string() } },
      },
      ...bearerRefusal,
    },
  });
  registry.registerPath({
    method: 'post',
    path: bearerBase + '/events',
    tags: ['Document tokens'],
    summary: 'Record a credential-scoped page event',
    description:
      bearerDescription +
      'Requires ingest permission; reserved host/downstream event names remain refused. Maximum 16 KiB body, same original native ingress and exact grant membership.',
    request: {
      params,
      headers: tokenHeaders,
      body: { content: { 'application/json': { schema: PageEventSchema } } },
    },
    responses: {
      200: json(CanvasChannelEventReceiptSchema),
      201: json(CanvasChannelEventReceiptSchema),
      ...bearerRefusal,
    },
  });
  registry.registerPath({
    method: 'put',
    path: '/api/files/content',
    tags: ['Files'],
    summary: 'Save an existing file with original concurrency checks',
    description:
      host +
      'Maximum 1 MiB request. Existing file only; cwd/path remain boundary-confined. With the installed original service, documentSave binds exact document/generation/stable event ID/expectedFileHash to the original normal-save writer. A refused installed service never falls back to raw I/O. doc.saved is recorded only after actual changed write/readback/cleanup; no-op or failed writes emit none. Filesystem success followed by event persistence failure is unknown: retain the same old-base/content/event-ID tuple, whose retry may recover a recorded completion or conflict without fabricating an event. Legacy non-document saves return ok/hash without a document receipt.',
    request: { body: { content: { 'application/json': { schema: WriteFileRequestSchema } } } },
    responses: {
      200: json(normalSave),
      ...refusal,
      409: {
        description: 'Disk baseline or retained document operation conflicts',
        content: { 'application/json': { schema: z.union([fileConflict, ErrorResponseSchema]) } },
      },
    },
  });
}
