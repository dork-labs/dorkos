/** Bounded snapshot/replay projection over the channel store, independent of scope-stream cursors. */
import { and, asc, eq, gt, isNull, lte, sql, canvasDocEvents } from '@dorkos/db';
import type {
  CanvasChannelFrame,
  CanvasChannelJsonValue,
} from '@dorkos/shared/canvas-channel-schemas';
import { protectedEventSql } from './accounting.js';
import { DocChannelStore, DocChannelClosedError } from './store.js';
import type { DocIngestAuthority } from './ingest-types.js';

/** Snapshot includes separate payload/receipt floors and at most one bounded page of receipt summaries. */
export interface DocReplaySnapshot {
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
    const retainedEvents = new Map<string, ReturnType<DocChannelStore['getEvent']>>();
    const readRetainedEvent = (eventId: string) => {
      if (!retainedEvents.has(eventId))
        retainedEvents.set(eventId, store.getEvent(access.documentId, eventId, tx));
      return retainedEvents.get(eventId)!;
    };
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
          deliveries: store.listDeliveries(access.documentId, row.eventId, tx),
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
