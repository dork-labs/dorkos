/** Authoritative tenant-scoped hosted connector usage reads. */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import {
  ManagedConnectorUsageRequestSchema,
  ManagedConnectorUsageResponseSchema,
  type ManagedConnectorUsageResponse,
} from '@dorkos/shared/connector-managed-usage-schemas';
import { and, count, countDistinct, desc, eq, lt, or } from 'drizzle-orm';

import { schema } from '@/db/client';
import {
  managedRequestHash,
  type ManagedConnectorDatabase,
  type ManagedConnectorPrincipal,
} from './authority-service';
import { managedExecutionReceiptFromRow } from './execution-service';

/** Invalid or scope-mismatched opaque usage cursor. */
export class ManagedUsageCursorError extends Error {
  constructor() {
    super('Managed usage cursor is invalid.');
    this.name = 'ManagedUsageCursorError';
  }
}

/** Missing and foreign exact managed connections share one safe result. */
export class ManagedUsageNotFoundError extends Error {
  constructor() {
    super('Managed connection was not found.');
    this.name = 'ManagedUsageNotFoundError';
  }
}

interface UsageCursorPayload {
  v: 1;
  s: string;
  t: string;
  i: string;
}

function cursorKey(secret: string): Buffer {
  return createHash('sha256').update(`managed-usage:${secret}`).digest();
}

function encodeCursor(secret: string, payload: UsageCursorPayload): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', cursorKey(secret), nonce);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url');
}

function decodeCursor(
  secret: string,
  raw: string,
  principal: ManagedConnectorPrincipal,
  filterHash: string
): { createdAt: Date; attemptId: string } {
  try {
    const encoded = Buffer.from(raw, 'base64url');
    if (encoded.length <= 28) throw new ManagedUsageCursorError();
    const decipher = createDecipheriv('aes-256-gcm', cursorKey(secret), encoded.subarray(0, 12));
    decipher.setAuthTag(encoded.subarray(12, 28));
    const payload = JSON.parse(
      Buffer.concat([decipher.update(encoded.subarray(28)), decipher.final()]).toString('utf8')
    ) as UsageCursorPayload;
    const scopeHash = managedRequestHash({
      tenantId: principal.tenantId,
      instanceId: principal.instanceId,
      filterHash,
    });
    const createdAt = new Date(payload.t);
    if (
      payload.v !== 1 ||
      payload.s !== scopeHash ||
      !payload.i ||
      Number.isNaN(createdAt.getTime())
    ) {
      throw new ManagedUsageCursorError();
    }
    return { createdAt, attemptId: payload.i };
  } catch (error) {
    if (error instanceof ManagedUsageCursorError) throw error;
    throw new ManagedUsageCursorError();
  }
}

/** Read one snapshot-consistent hosted usage page and lifetime counts. */
export async function listManagedConnectorUsage(input: {
  db: ManagedConnectorDatabase;
  principal: ManagedConnectorPrincipal;
  rawRequest: unknown;
  cursorSecret: string;
}): Promise<ManagedConnectorUsageResponse> {
  const request = ManagedConnectorUsageRequestSchema.parse(input.rawRequest);
  const filterHash = managedRequestHash({
    managedConnectionId: request.managedConnectionId ?? null,
    agentId: request.agentId ?? null,
  });
  const cursor = request.cursor
    ? decodeCursor(input.cursorSecret, request.cursor, input.principal, filterHash)
    : undefined;

  return input.db.transaction(
    async (tx) => {
      if (request.managedConnectionId) {
        const [owned] = await tx
          .select({ id: schema.managedConnectorConnection.id })
          .from(schema.managedConnectorConnection)
          .where(
            and(
              eq(schema.managedConnectorConnection.tenantId, input.principal.tenantId),
              eq(
                schema.managedConnectorConnection.originatingInstanceId,
                input.principal.instanceId
              ),
              eq(schema.managedConnectorConnection.id, request.managedConnectionId)
            )
          )
          .limit(1);
        if (!owned) throw new ManagedUsageNotFoundError();
      }
      const baseFilters = [
        eq(schema.managedConnectorExecutionAttempt.tenantId, input.principal.tenantId),
        eq(schema.managedConnectorExecutionAttempt.instanceId, input.principal.instanceId),
        ...(request.managedConnectionId
          ? [eq(schema.managedConnectorExecutionAttempt.connectionId, request.managedConnectionId)]
          : []),
        ...(request.agentId
          ? [eq(schema.managedConnectorExecutionAttempt.agentId, request.agentId)]
          : []),
      ];
      const [counts] = await tx
        .select({
          logicalOperationCount: countDistinct(
            schema.managedConnectorExecutionAttempt.logicalOperationId
          ),
          attemptCount: count(),
        })
        .from(schema.managedConnectorExecutionAttempt)
        .where(and(...baseFilters));
      const rows = await tx
        .select({
          attempt: schema.managedConnectorExecutionAttempt,
          revision: schema.managedConnectorOperationRevision,
        })
        .from(schema.managedConnectorExecutionAttempt)
        .innerJoin(
          schema.managedConnectorOperationRevision,
          and(
            eq(
              schema.managedConnectorOperationRevision.tenantId,
              schema.managedConnectorExecutionAttempt.tenantId
            ),
            eq(
              schema.managedConnectorOperationRevision.id,
              schema.managedConnectorExecutionAttempt.operationRevisionId
            )
          )
        )
        .where(
          and(
            ...baseFilters,
            ...(cursor
              ? [
                  or(
                    lt(schema.managedConnectorExecutionAttempt.createdAt, cursor.createdAt),
                    and(
                      eq(schema.managedConnectorExecutionAttempt.createdAt, cursor.createdAt),
                      lt(schema.managedConnectorExecutionAttempt.attemptId, cursor.attemptId)
                    )
                  )!,
                ]
              : [])
          )
        )
        .orderBy(
          desc(schema.managedConnectorExecutionAttempt.createdAt),
          desc(schema.managedConnectorExecutionAttempt.attemptId)
        )
        .limit(request.limit + 1);
      const visible = rows.slice(0, request.limit);
      const last = visible.at(-1);
      return ManagedConnectorUsageResponseSchema.parse({
        version: 1,
        status: 'available',
        counts: {
          logicalOperationCount: counts?.logicalOperationCount ?? 0,
          attemptCount: counts?.attemptCount ?? 0,
        },
        items: visible.map(({ attempt, revision }) => ({
          attemptId: attempt.attemptId,
          logicalOperationId: attempt.logicalOperationId,
          attemptIndex: attempt.attemptIndex,
          managedConnectionId: attempt.connectionId,
          agentId: attempt.agentId,
          revision: {
            operationSlug: revision.operationSlug,
            toolkitVersion: revision.toolkitVersion,
            schemaHash: revision.schemaHash,
          },
          toolkit: revision.toolkit,
          payer: 'dorkos_managed',
          surface: attempt.surface,
          actorKind: attempt.actorKind,
          startedAt: attempt.createdAt.toISOString(),
          state: attempt.state,
          ...(attempt.state === 'recorded'
            ? { receipt: managedExecutionReceiptFromRow(attempt) }
            : {}),
        })),
        ...(rows.length > request.limit && last
          ? {
              nextCursor: encodeCursor(input.cursorSecret, {
                v: 1,
                s: managedRequestHash({
                  tenantId: input.principal.tenantId,
                  instanceId: input.principal.instanceId,
                  filterHash,
                }),
                t: last.attempt.createdAt.toISOString(),
                i: last.attempt.attemptId,
              }),
            }
          : {}),
      });
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' }
  );
}
