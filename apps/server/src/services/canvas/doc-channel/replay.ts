import { hashApprovalInput } from '../../core/approvals/approval-input-hash.js';
import { UiCanvasContentSchema } from '@dorkos/shared/schemas';
import { CanvasChannelDeclarationSchema } from '@dorkos/shared/canvas-channel-schemas';
import { parseScope } from '../scopes.js';
/** Bounded snapshot/replay projection over the channel store, independent of scope-stream cursors. */
import {
  and,
  asc,
  eq,
  gt,
  isNull,
  lte,
  sql,
  canvasDocChannels,
  canvasDocEvents,
  canvasDocDeliveries,
  type DbTransaction,
} from '@dorkos/db';
import type {
  CanvasChannelFrame,
  CanvasChannelJsonValue,
} from '@dorkos/shared/canvas-channel-schemas';
import { CanvasDocIncarnationSchema } from '@dorkos/shared/canvas-doc-incarnation';
import { CanvasChannelReplayResponseSchema } from '@dorkos/shared/canvas-channel-schemas';
import { publicCurrentDelivery } from './current/current-operation-intentions.js';
import { copyCurrentDocData } from './current/current-operation-data.js';
import type {
  DocDocumentBirth,
  DocCurrentReplayResponse,
} from './current/current-operation-types.js';
import { readDocEventRow } from './writes/reservations/reservation-policy-census.js';
import { readChecked } from './storage/store-json.js';
import { protectedEventSql } from './current/accounting.js';
import { DocChannelStore, DocChannelClosedError, DocChannelCorruptionError } from './store.js';
import type { DocIngestAuthority } from './ingest-data/ingest-types.js';

/** Snapshot includes separate payload/receipt floors and at most one bounded page of receipt summaries. */
export interface DocReplaySnapshot {
  routing?: import('@dorkos/shared/canvas-channel-schemas').CanvasChannelRouting;
  events: CanvasChannelFrame[];
  state: unknown;
  stateRev: number;
  highWatermark: number;
  retentionFloor: number;
  receiptRetentionFloor: number;
  resetRequired: boolean;
  receipts: {
    id: string;
    docSeq: number;
    payloadAvailable: boolean;
    deliveries: ReturnType<DocChannelStore['listDeliveries']>;
  }[];
  health: { status: 'ready' | 'warning' | 'closed' | 'in_doubt'; reasons: string[] };
}

/** Capture a consistent high watermark/state/page after current access validation. */
export function replayDocChannel(
  store: DocChannelStore,
  authority: DocIngestAuthority,
  since = 0,
  limit = 200
): DocReplaySnapshot {
  if (
    !Number.isSafeInteger(since) ||
    since < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 200
  )
    throw new RangeError('Invalid replay page.');
  return store.transaction((tx) => {
    const access = authority(tx);
    const channel = store.getChannel(access.documentId, tx);
    if (!channel) throw new DocChannelClosedError(access.documentId);
    if (access.scope !== channel.scope) throw new Error('Document identity changed.');
    const highWatermark = channel.nextDocSeq - 1;
    const resetRequired = since < channel.retentionFloor - 1;
    const rows = tx
      .select({ eventId: canvasDocEvents.eventId })
      .from(canvasDocEvents)
      .where(
        and(
          eq(canvasDocEvents.documentId, access.documentId),
          gt(canvasDocEvents.docSeq, resetRequired ? channel.retentionFloor - 1 : since),
          lte(canvasDocEvents.docSeq, highWatermark),
          isNull(canvasDocEvents.payloadPrunedAt)
        )
      )
      .orderBy(asc(canvasDocEvents.docSeq))
      .limit(limit)
      .all();
    const receipts = tx.all<{
      eventId: string;
    }>(sql`SELECT e.event_id AS eventId FROM canvas_doc_events e
      WHERE e.document_id=${access.documentId} AND e.doc_seq<=${highWatermark}
      AND ${resetRequired ? sql`1` : sql`e.doc_seq>${since}`}
      ORDER BY ${resetRequired ? sql`${protectedEventSql} DESC,e.doc_seq DESC` : sql`e.doc_seq ASC`} LIMIT ${limit}`);
    const uncertain = !!tx.get(
      sql`SELECT 1 FROM canvas_doc_batches WHERE document_id=${access.documentId} AND status='in_doubt' LIMIT 1`
    );
    const failed =
      !!tx.get(sql`SELECT 1 FROM canvas_doc_deliveries WHERE document_id=${access.documentId}
      AND status IN ('failed','expired','unavailable') LIMIT 1`);
    // Compile/read each bounded selection once. These maps live only inside
    // this page's original transaction; authority and rows are reread next page.
    const selectedIds = [...new Set([...rows, ...receipts].map(({ eventId }) => eventId))];
    const retainedEvents = new Map(
      store.readReplayEvents(access.documentId, selectedIds, tx).map((row) => [row.eventId, row])
    );
    const readRetainedEvent = (eventId: string) => {
      const row = retainedEvents.get(eventId);
      if (!row) throw new DocChannelCorruptionError('canvas_doc_events', eventId);
      return row;
    };
    const retainedDeliveries = new Map<string, ReturnType<DocChannelStore['listDeliveries']>>();
    for (const row of store.readReplayDeliveries(
      access.documentId,
      receipts.map(({ eventId }) => eventId),
      tx
    )) {
      const outcomes = retainedDeliveries.get(row.eventId) ?? [];
      outcomes.push(row);
      retainedDeliveries.set(row.eventId, outcomes);
    }
    return {
      events: rows.map(({ eventId }) => {
        const row = readRetainedEvent(eventId);
        return {
          type: 'canvas_event' as const,
          documentId: row.documentId,
          scope: channel.scope,
          docSeq: row.docSeq,
          event: {
            id: row.eventId,
            type: row.type,
            payload: row.payload as CanvasChannelJsonValue,
            direction: row.direction,
            receivedAt: row.receivedAt,
          },
        };
      }),
      state: channel.state,
      stateRev: channel.stateRev,
      highWatermark,
      retentionFloor: channel.retentionFloor,
      receiptRetentionFloor: channel.receiptRetentionFloor,
      resetRequired,
      receipts: receipts.map(({ eventId }) => {
        const row = readRetainedEvent(eventId);
        return {
          id: row.eventId,
          docSeq: row.docSeq,
          payloadAvailable: row.payloadPrunedAt === null,
          deliveries: retainedDeliveries.get(row.eventId) ?? [],
        };
      }),
      health: {
        status: channel.closedAt
          ? ('closed' as const)
          : uncertain
            ? ('in_doubt' as const)
            : failed
              ? ('warning' as const)
              : ('ready' as const),
        reasons: channel.closedAt
          ? ['document_closed']
          : uncertain
            ? ['delivery_in_doubt']
            : failed
              ? ['delivery_failed']
              : [],
      },
    };
  });
}

/** Fixed direct-SQL replay projection; caller must own the current scoped transaction. */
export function readCurrentDocReplayInTransaction(
  tx: DbTransaction,
  documentId: string,
  scope: string,
  channel: import('./store.js').DocChannelRow,
  since: number,
  limit: number
): DocReplaySnapshot {
  if (
    !Number.isSafeInteger(since) ||
    since < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 200
  )
    throw new RangeError('Invalid replay page.');
  if (channel.documentId !== documentId || channel.scope !== scope)
    throw new Error('Document identity changed.');
  const highWatermark = channel.nextDocSeq - 1;
  const resetRequired = since < channel.retentionFloor - 1;
  const rows = tx
    .select({ eventId: canvasDocEvents.eventId })
    .from(canvasDocEvents)
    .where(
      and(
        eq(canvasDocEvents.documentId, documentId),
        gt(canvasDocEvents.docSeq, resetRequired ? channel.retentionFloor - 1 : since),
        lte(canvasDocEvents.docSeq, highWatermark),
        isNull(canvasDocEvents.payloadPrunedAt)
      )
    )
    .orderBy(asc(canvasDocEvents.docSeq))
    .limit(limit)
    .all();
  const receipts = tx.all<{
    eventId: string;
  }>(sql`SELECT e.event_id AS eventId FROM canvas_doc_events e
    WHERE e.document_id=${documentId} AND e.doc_seq<=${highWatermark}
    AND ${resetRequired ? sql`1` : sql`e.doc_seq>${since}`}
    ORDER BY ${resetRequired ? sql`${protectedEventSql} DESC,e.doc_seq DESC` : sql`e.doc_seq ASC`} LIMIT ${limit}`);
  const uncertain = !!tx.get(
    sql`SELECT 1 FROM canvas_doc_batches WHERE document_id=${documentId} AND status='in_doubt' LIMIT 1`
  );
  const failed = !!tx.get(sql`SELECT 1 FROM canvas_doc_deliveries WHERE document_id=${documentId}
    AND status IN ('failed','expired','unavailable') LIMIT 1`);
  const eventRow = (eventId: string) => {
    const row = readDocEventRow(tx, documentId, eventId);
    if (!row) throw new Error('Original replay row disappeared.');
    return row;
  };
  return {
    events: rows.map(({ eventId }) => {
      const row = eventRow(eventId);
      return {
        type: 'canvas_event' as const,
        documentId: row.documentId,
        scope: channel.scope,
        docSeq: row.docSeq,
        event: {
          id: row.eventId,
          type: row.type,
          payload: row.payload as CanvasChannelJsonValue,
          direction: row.direction,
          receivedAt: row.receivedAt,
        },
      };
    }),
    state: channel.state,
    stateRev: channel.stateRev,
    highWatermark,
    retentionFloor: channel.retentionFloor,
    receiptRetentionFloor: channel.receiptRetentionFloor,
    resetRequired,
    receipts: receipts.map(({ eventId }) => {
      const row = eventRow(eventId);
      return {
        id: row.eventId,
        docSeq: row.docSeq,
        payloadAvailable: row.payloadPrunedAt === null,
        deliveries: readChecked('canvas_doc_deliveries', eventId, () =>
          tx
            .select()
            .from(canvasDocDeliveries)
            .where(
              and(
                eq(canvasDocDeliveries.documentId, documentId),
                eq(canvasDocDeliveries.eventId, eventId)
              )
            )
            .orderBy(asc(canvasDocDeliveries.routeId))
            .all()
        ),
      };
    }),
    health: {
      status: channel.closedAt ? 'closed' : uncertain ? 'in_doubt' : failed ? 'warning' : 'ready',
      reasons: channel.closedAt
        ? ['document_closed']
        : uncertain
          ? ['delivery_in_doubt']
          : failed
            ? ['delivery_failed']
            : [],
    },
  };
}

/** Pure display projection only; it cannot verify authority or create a current scope. */
export function projectCurrentDocReplay(
  snapshot: DocReplaySnapshot,
  birth: DocDocumentBirth,
  generation: string,
  physical: typeof import('@dorkos/db').canvasDocuments.$inferSelect,
  channel: import('./store.js').DocChannelRow,
  canonicalScope: string
): DocCurrentReplayResponse {
  const origin = projectCurrentMcpOrigin(physical, channel, canonicalScope);
  const replay = CanvasChannelReplayResponseSchema.parse({
    ...snapshot,
    scope: canonicalScope,
    receipts: snapshot.receipts.map((row) => ({
      receipt: { id: row.id, status: 'recorded', docSeq: row.docSeq },
      deliveries: row.deliveries.map(publicCurrentDelivery),
      payloadAvailable: row.payloadAvailable,
    })),
  });
  const incarnation = CanvasDocIncarnationSchema.parse({
    v: 1,
    documentId: birth.documentId,
    physicalOpenedAt: birth.openedAt,
    channelCreatedAt: birth.createdAt,
    generation,
  });
  return copyCurrentDocData({
    ...(origin ? { mcpOrigin: origin } : {}),
    ...replay,
    // The same final-gated native birth owns every retained frame in this page.
    events: replay.events.map((frame) => ({ ...frame, incarnation })),
    incarnation,
  });
}

/** Pure stored-origin projection. Its caller must still finish the genuine private full-row/currentness gate. */
export function projectCurrentMcpOrigin(
  physical: typeof import('@dorkos/db').canvasDocuments.$inferSelect,
  channel: import('./store.js').DocChannelRow,
  canonicalScope: string
): DocCurrentReplayResponse['mcpOrigin'] {
  const scope = parseScope(canonicalScope);
  if (scope.kind !== 'session' || physical.roomId !== null || physical.contentType !== 'mcp_app')
    return undefined;
  const content = UiCanvasContentSchema.safeParse(physical.content);
  const declaration = CanvasChannelDeclarationSchema.safeParse(channel.declaration);
  if (
    !content.success ||
    content.data.type !== 'mcp_app' ||
    !declaration.success ||
    !content.data.serverName ||
    !content.data.uri.startsWith('ui://') ||
    !channel.declarationHash ||
    hashApprovalInput(declaration.data) !== channel.declarationHash
  )
    return undefined;
  return copyCurrentDocData({
    canonicalSessionId: scope.id,
    serverName: content.data.serverName,
    uri: content.data.uri,
    physicalRevision: physical.rev,
    declaration: declaration.data,
    declarationHash: channel.declarationHash,
  });
}

/** Pure fixed receipt projection; engine performs final private access after this immutable capture. */
export function projectCurrentDocReceipt(
  tx: DbTransaction,
  documentId: string,
  eventId: string,
  event: import('./store.js').DocEventRow | undefined,
  channel: import('./store.js').DocChannelRow,
  birth: DocDocumentBirth,
  generation: string
): import('./current/current-operation-types.js').DocReceiptInspection {
  return event
    ? copyCurrentDocData({
        kind: 'receipt',
        generation: generation,
        birth: birth,
        event: {
          receipt: { id: event.eventId, status: 'recorded', docSeq: event.docSeq },
          deliveries: tx
            .select()
            .from(canvasDocDeliveries)
            .where(
              and(
                eq(canvasDocDeliveries.documentId, documentId),
                eq(canvasDocDeliveries.eventId, eventId)
              )
            )
            .all()
            .map(publicCurrentDelivery),
          payloadAvailable: event.payloadPrunedAt === null,
        },
      })
    : copyCurrentDocData({
        kind: 'absent',
        generation: generation,
        birth: birth,
        eventId,
        receiptRetentionFloor: channel.receiptRetentionFloor,
      });
}

/** Literal fixed channel read after private final replay access, without callbacks or projection. */
export function readCurrentReplayChannelRow(tx: DbTransaction, documentId: string) {
  return readChecked('canvas_doc_channels', documentId, () =>
    tx.select().from(canvasDocChannels).where(eq(canvasDocChannels.documentId, documentId)).get()
  );
}

/** Literal fixed channel query for receipt projection; carries no caller currentness or permission. */
export function readCurrentReceiptChannelRow(tx: DbTransaction, documentId: string) {
  return tx
    .select()
    .from(canvasDocChannels)
    .where(eq(canvasDocChannels.documentId, documentId))
    .get();
}

export {
  buildOriginalRoomPendingSource,
  projectDurableAcceptedRoomPending,
} from './room-pending-projection.js';
