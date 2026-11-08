/**
 * Strict hosted usage wire for DorkOS-managed connector attempts.
 *
 * Arguments, results, provider logs, account references, tenant identity, and
 * provider sessions never enter this linked-instance response.
 *
 * @module connector-providers/connector-managed-usage-schemas
 */
import { z } from 'zod';
import { ConnectionGrantExtensionIdSchema } from '@dork-labs/cloud-api';
import {
  ManagedConnectorActorKindSchema,
  ManagedConnectorExecutionReceiptSchema,
  ManagedConnectorSurfaceSchema,
} from './connector-managed-schemas.js';

const ManagedUsageIdSchema = z.string().min(1).max(200);

/** Strict filters for one hosted usage page. */
export const ManagedConnectorUsageRequestSchema = z
  .object({
    version: z.literal(1),
    managedConnectionId: ManagedUsageIdSchema.optional(),
    agentId: ManagedUsageIdSchema.optional(),
    /** Only one extension's reads (DOR-3980). */
    extensionId: ConnectionGrantExtensionIdSchema.optional(),
    cursor: z.string().min(1).max(500).optional(),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();
/** Strict filters for one hosted usage page. */
export type ManagedConnectorUsageRequest = z.infer<typeof ManagedConnectorUsageRequestSchema>;

const ManagedUsageItemBaseShape = {
  attemptId: ManagedUsageIdSchema,
  logicalOperationId: ManagedUsageIdSchema,
  attemptIndex: z.number().int().positive(),
  managedConnectionId: ManagedUsageIdSchema,
  /** The agent that called; absent only on an extension's read. */
  agentId: ManagedUsageIdSchema.optional(),
  /** The extension that read (DOR-3980); present only on an extension's read. */
  extensionId: ConnectionGrantExtensionIdSchema.optional(),
  revision: z
    .object({
      operationSlug: ManagedUsageIdSchema,
      toolkitVersion: ManagedUsageIdSchema,
      schemaHash: ManagedUsageIdSchema,
    })
    .strict(),
  toolkit: ManagedUsageIdSchema,
  payer: z.literal('dorkos_managed'),
  surface: ManagedConnectorSurfaceSchema,
  actorKind: ManagedConnectorActorKindSchema,
  startedAt: z.string().datetime(),
};

/** One pending intent or immutable hosted receipt. */
export const ManagedConnectorUsageItemSchema = z
  .discriminatedUnion('state', [
    z.object({ ...ManagedUsageItemBaseShape, state: z.literal('pending') }).strict(),
    z
      .object({
        ...ManagedUsageItemBaseShape,
        state: z.literal('recorded'),
        receipt: ManagedConnectorExecutionReceiptSchema,
      })
      .strict(),
  ])
  .superRefine((item, context) => {
    // An extension's read names the extension and no agent; every other row
    // names its agent and no extension.
    const byExtension = item.actorKind === 'extension';
    if (
      byExtension !== (item.surface === 'extension') ||
      byExtension !== (item.extensionId !== undefined) ||
      byExtension === (item.agentId !== undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message:
          "An extension's read names the extension and no agent; any other row names its agent.",
        path: ['actorKind'],
      });
    }
    if (
      item.state === 'recorded' &&
      (item.receipt.attemptId !== item.attemptId ||
        item.receipt.logicalOperationId !== item.logicalOperationId ||
        item.receipt.attemptIndex !== item.attemptIndex)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Recorded usage attribution does not match its receipt.',
        path: ['receipt'],
      });
    }
  });
/** One pending intent or immutable hosted receipt. */
export type ManagedConnectorUsageItem = z.infer<typeof ManagedConnectorUsageItemSchema>;

/** Authoritative hosted usage result, or a safe explicit unavailable state. */
export const ManagedConnectorUsageResponseSchema = z.discriminatedUnion('status', [
  z
    .object({
      version: z.literal(1),
      status: z.literal('available'),
      counts: z
        .object({
          logicalOperationCount: z.number().int().nonnegative(),
          attemptCount: z.number().int().nonnegative(),
        })
        .strict(),
      items: z.array(ManagedConnectorUsageItemSchema).max(100),
      nextCursor: z.string().min(1).max(500).optional(),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      status: z.literal('unavailable'),
      reason: z.string().min(1).max(1_000),
    })
    .strict(),
]);
/** Authoritative hosted usage result, or a safe explicit unavailable state. */
export type ManagedConnectorUsageResponse = z.infer<typeof ManagedConnectorUsageResponseSchema>;
