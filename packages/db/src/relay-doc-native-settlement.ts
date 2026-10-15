import { randomUUID, createHash } from 'node:crypto';
import type { RelayDocNativeOperation } from './relay-doc-statements.js';
import {
  checkedRows,
  checkedInput,
  orderedJson,
  iso,
  type Rows,
  type OriginalRelayNativeFacts,
  type OriginalRelayNativeClaim,
} from './relay-doc-native-data.js';
import { requireRelayNativeOperationOwner } from './relay-doc-native.js';

/** Fixed terminal ledger CAS, called only after original server closed-turn correlation. */
export function settleOriginalRelay(
  ownerKey: object,
  token: OriginalRelayNativeClaim,
  now: string,
  outcome: 'completed' | 'failed' | 'blocked'
) {
  const context = requireRelayNativeOperationOwner(ownerKey);
  const own = context.claims.get(token);
  if (!own || own.owner !== context.owner || own.settlementAttempted)
    throw new Error('Original Relay settlement claim unavailable');
  own.settlementAttempted = true;
  iso(now);
  if (!['completed', 'failed', 'blocked'].includes(outcome))
    throw new Error('Original Relay policy outcome differs');
  const terminalStatus = outcome === 'completed' ? 'turn_done' : 'failed',
    settleOutcome = outcome === 'completed' ? 'completed' : 'failed';
  const bindings = { ...own.bindings, settledAt: now, terminalStatus, settleOutcome };
  let frame: object | undefined,
    failed = false,
    first: unknown;
  let hint: typeof own.startHint | undefined;
  try {
    frame = context.begin();
    const read = (
      operation: Exclude<RelayDocNativeOperation, 'begin' | 'commit' | 'rollback'>,
      max: number
    ) => checkedRows(context.run(frame!, operation, own.selector), max);
    const before = {
      batch: read('fullBatch', 2),
      receipt: read('fullReceipt', 2),
      deliveries: read('fullDeliveries', 101),
    };
    if (
      JSON.stringify(before.batch) !== JSON.stringify(own.ledgerSnapshot.batch) ||
      JSON.stringify(before.receipt) !== JSON.stringify(own.ledgerSnapshot.receipt) ||
      before.deliveries.length !== own.ledgerSnapshot.deliveries.length ||
      checkedRows(context.run(frame, 'queueRow', own.bindings), 2).length
    )
      throw new Error('Original Relay terminal receipt/batch/queue changed');
    const immutableDelivery = (row: Rows[number]) =>
      Object.fromEntries(
        Object.entries(row).filter(
          ([key]) =>
            ![
              'ack_outcome',
              'ack_evidence',
              'acknowledged_at',
              'acknowledged_by',
              'updated_at',
            ].includes(key)
        )
      );
    if (
      JSON.stringify(before.deliveries.map(immutableDelivery)) !==
      JSON.stringify(own.ledgerSnapshot.deliveries.map(immutableDelivery))
    )
      throw new Error('Original Relay terminal delivery identity changed');
    const source = {
      channel: read('channel', 2),
      grant: read('grant', 2),
      document: read('document', 2),
      target: read('target', 2),
      inputs: read('inputs', 101),
    };
    if (
      source.channel.length !== 1 ||
      source.channel[0]!.scope !== own.selector.scope ||
      source.inputs.length !== before.deliveries.length
    )
      throw new Error('Original Relay terminal source missing');
    const ids = JSON.stringify(before.deliveries.map((row) => row.event_id));
    for (const operation of ['settleReceipt', 'settleBatch'] as const) {
      const changed = context.run(frame, operation, bindings) as { changes?: unknown } | undefined;
      if (changed?.changes !== 1) throw new Error('Original Relay terminal CAS refused');
    }
    const changed = context.run(frame, 'settleDeliveries', { ...bindings, inputEventIds: ids }) as
      { changes?: unknown } | undefined;
    if (changed?.changes !== before.deliveries.length)
      throw new Error('Original Relay terminal membership changed');
    // A closed document retains its tombstone. Internal completion cannot reopen its log.
    let statusBindings: Record<string, string | number> | undefined;
    const channel = source.channel[0]!;
    if (channel.closed_at === null) {
      const docSeq = Number(channel.next_doc_seq);
      if (!Number.isSafeInteger(docSeq) || docSeq < 1 || docSeq >= Number.MAX_SAFE_INTEGER)
        throw new Error('Original Relay terminal document sequence differs');
      const eventId = randomUUID(),
        payload = {
          batchId: own.selector.batchId,
          routeId: own.selector.routeId,
          status: terminalStatus,
          receiptId: own.receiptId,
          messageId: own.bindings.queueMessageId,
          turnId: own.bindings.turnId,
        };
      const envelope = JSON.stringify(
        orderedJson({ v: 1, id: eventId, type: 'event.status', payload })
      );
      const envelopeHash = createHash('sha256').update(envelope).digest('hex');
      statusBindings = {
        ...bindings,
        now,
        eventId,
        docSeq,
        statusPayload: JSON.stringify(payload),
        envelopeHash,
        envelopeBytes: Buffer.byteLength(envelope),
      };
      for (const operation of ['allocateStatus', 'appendStatus'] as const) {
        const write = context.run(frame, operation, statusBindings) as
          { changes?: unknown } | undefined;
        if (write?.changes !== 1) throw new Error('Original Relay terminal status append raced');
      }
      const event = checkedRows(context.run(frame, 'startStatus', statusBindings), 2);
      if (
        event.length !== 1 ||
        event[0]!.doc_seq !== docSeq ||
        event[0]!.direction !== 'system' ||
        event[0]!.type !== 'event.status' ||
        event[0]!.payload !== statusBindings.statusPayload ||
        event[0]!.envelope_hash !== envelopeHash ||
        event[0]!.envelope_bytes !== statusBindings.envelopeBytes ||
        event[0]!.received_at !== now ||
        event[0]!.provenance !== '{"source":"doc-channel-service"}' ||
        event[0]!.payload_pruned_at !== null ||
        event[0]!.client_ts !== null ||
        event[0]!.coalesce_key !== null
      )
        throw new Error('Original Relay terminal status identity changed');
      hint = Object.freeze({
        documentId: own.selector.documentId,
        eventId,
        docSeq,
        envelopeHash,
        direction: 'system',
        type: 'event.status',
        receivedAt: now,
      });
    }
    const after = {
      batch: read('fullBatch', 2),
      receipt: read('fullReceipt', 2),
      deliveries: read('fullDeliveries', 101),
    };
    const expected = {
      batch: before.batch.map((row) => ({ ...row, status: terminalStatus, updated_at: now })),
      receipt: before.receipt.map((row) => ({
        ...row,
        state: 'settled',
        settled_at: now,
        settle_outcome: settleOutcome,
      })),
      deliveries: before.deliveries.map((row) => ({
        ...row,
        status: terminalStatus,
        updated_at: now,
      })),
    };
    if (
      JSON.stringify(after) !== JSON.stringify(expected) ||
      checkedRows(context.run(frame, 'queueRow', own.bindings), 2).length
    )
      throw new Error('Original Relay terminal ledger/ack/queue changed during writes');
    const postSource = {
      channel: read('channel', 2),
      grant: read('grant', 2),
      document: read('document', 2),
      target: read('target', 2),
      inputs: read('inputs', 101),
    };
    const expectedSource = {
      ...source,
      channel: source.channel.map((row) =>
        statusBindings
          ? { ...row, next_doc_seq: Number(row.next_doc_seq) + 1, updated_at: now }
          : row
      ),
      inputs: source.inputs.map((row) => ({ ...row, delivery_status: terminalStatus })),
    };
    if (JSON.stringify(postSource) !== JSON.stringify(expectedSource))
      throw new Error('Original Relay terminal source changed during writes');
    context.commit(frame);
    if (!context.committed(frame)) throw new Error('Original Relay terminal COMMIT UNKNOWN');
    frame = undefined;
  } catch (cause) {
    failed = true;
    first = cause;
  }
  if (frame) {
    try {
      const closed = context.rollback(frame);
      if (!closed && !failed) {
        failed = true;
        first = new Error('Original Relay terminal rollback UNKNOWN');
      }
    } catch (cause) {
      if (!failed) {
        failed = true;
        first = cause;
      }
    }
  }
  if (failed) throw first;
  return hint;
}
