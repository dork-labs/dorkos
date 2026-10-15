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

/** Atomically consume original accepted receipt and charge its approved route before any SDK FIRST. */
export function claimOriginalRelay(
  ownerKey: object,
  token: OriginalRelayNativeFacts,
  now: string,
  turnsPerHour: number,
  bindingId: string,
  turnStartSeq: number
): OriginalRelayNativeClaim {
  const context = requireRelayNativeOperationOwner(ownerKey);
  const own = context.facts.get(token);
  if (!own || own.owner !== context.owner || own.consumed)
    throw new Error('Original native Relay facts required');
  // One-use latch precedes all native work; refusal cannot be retried using context.owner token.
  own.consumed = true;
  const at = iso(now);
  if (!Number.isSafeInteger(turnStartSeq) || turnStartSeq < 1)
    throw new Error('Original projected Relay turn_start sequence required');
  if (!Number.isSafeInteger(turnsPerHour) || turnsPerHour < 1 || turnsPerHour > 10)
    throw new Error('Approved native Relay route ceiling required');
  if (typeof bindingId !== 'string' || !bindingId || bindingId.length > 200)
    throw new Error('Original native Relay binding required');
  let frame: object | undefined;
  let failed = false;
  let first: unknown;
  let result: OriginalRelayNativeClaim | undefined;
  try {
    own.claimState = 'unknown';
    frame = context.begin();
    const read = context.read(frame, own.selector, now);
    const principal = checkedRows(
      context.run(frame, 'principal', { ...own.selector, bindingId, now }),
      2
    );
    if (principal.length !== 1) throw new Error('Native Relay principal changed');
    if (
      read.hash !== own.hash ||
      read.receiptId !== own.receiptId ||
      read.turnsPerHour !== turnsPerHour
    )
      throw new Error('Native Relay source changed after preparation');
    const count = context.run(frame, 'routeCharges', {
      documentId: own.selector.documentId,
      routeId: own.selector.routeId,
      floor: new Date(at - 3600000).toISOString(),
      now,
    }) as { charged?: unknown } | undefined;
    if (
      !count ||
      !Number.isSafeInteger(count.charged) ||
      Number(count.charged) < 0 ||
      Number(count.charged) >= turnsPerHour
    )
      throw new Error('Original native Relay route hour exhausted');
    const attemptId = randomUUID(),
      bindings = {
        ...own.selector,
        receiptId: own.receiptId,
        attemptId,
        bootEpoch: context.bootEpoch,
        now,
        priorAttempt: read.priorAttempt,
        expectedAttempt: read.priorAttempt + 1,
        turnStartSeq,
        turnId: `projected:${own.receiptId}:${turnStartSeq}`,
        queueMessageId: read.queueMessageId,
      };
    for (const operation of ['claimReceipt', 'claimBatch'] as const) {
      const changed = context.run(frame, operation, bindings) as { changes?: unknown } | undefined;
      if (changed?.changes !== 1) throw new Error('Original native Relay claim CAS refused');
    }
    const claimed = checkedRows(context.run(frame, 'claimed', bindings), 2);
    if (claimed.length !== 1) throw new Error('Native Relay final receipt claim changed');
    const sourceRows = (
      operation: Exclude<RelayDocNativeOperation, 'begin' | 'commit' | 'rollback'>,
      max: number
    ) => checkedRows(context.run(frame!, operation, own.selector), max);
    const finalSourceHash = createHash('sha256')
      .update(
        JSON.stringify({
          channel: sourceRows('channel', 2),
          grant: sourceRows('grant', 2),
          document: sourceRows('document', 2),
          target: sourceRows('target', 2),
          inputs: sourceRows('inputs', 101),
        })
      )
      .digest('hex');
    if (finalSourceHash !== read.sourceHash) throw new Error('Native Relay final source changed');
    const finalPrincipal = checkedRows(
      context.run(frame, 'principal', { ...own.selector, bindingId, now }),
      2
    );
    if (finalPrincipal.length !== 1 || JSON.stringify(finalPrincipal) !== JSON.stringify(principal))
      throw new Error('Native Relay final principal changed');
    const queue = checkedRows(context.run(frame, 'queueRow', bindings), 2);
    if (queue.length !== 1) throw new Error('Original Relay accepted queue row changed');
    for (const operation of ['removeQueue', 'startReceipt', 'startBatch'] as const) {
      const changed = context.run(frame, operation, bindings) as { changes?: unknown } | undefined;
      if (changed?.changes !== 1) throw new Error('Original Relay projected start CAS refused');
    }
    const deliveries = context.run(frame, 'startDeliveries', {
      ...bindings,
      inputEventIds: read.inputEventIds,
    }) as { changes?: unknown } | undefined;
    if (deliveries?.changes !== read.inputCount)
      throw new Error('Original Relay selected delivery membership changed');
    const eventId = randomUUID(),
      payload = {
        batchId: own.selector.batchId,
        routeId: own.selector.routeId,
        status: 'turn_started',
        receiptId: own.receiptId,
        messageId: read.queueMessageId,
        turnId: bindings.turnId,
      };
    const envelope = JSON.stringify(
      orderedJson({ v: 1, id: eventId, type: 'event.status', payload })
    );
    const envelopeHash = createHash('sha256').update(envelope).digest('hex'),
      docSeq = Number(read.docSeq);
    const statusBindings = {
      ...bindings,
      eventId,
      docSeq,
      statusPayload: JSON.stringify(payload),
      envelopeHash,
      envelopeBytes: Buffer.byteLength(envelope),
    };
    for (const operation of ['allocateStatus', 'appendStatus'] as const) {
      const changed = context.run(frame, operation, statusBindings) as
        { changes?: unknown } | undefined;
      if (changed?.changes !== 1) throw new Error('Original Relay start status append raced');
    }
    if (checkedRows(context.run(frame, 'started', bindings), 2).length !== 1)
      throw new Error('Original Relay final projected receipt changed');
    // Check original target/grant/principal again after every actual native write.
    const postPrincipal = checkedRows(
      context.run(frame, 'principal', { ...own.selector, bindingId, now }),
      2
    );
    if (postPrincipal.length !== 1 || JSON.stringify(postPrincipal) !== JSON.stringify(principal))
      throw new Error('Original Relay projected principal changed');
    const postSnapshot = {
      channel: sourceRows('channel', 2),
      grant: sourceRows('grant', 2),
      document: sourceRows('document', 2),
      target: sourceRows('target', 2),
      inputs: sourceRows('inputs', 101),
    };
    const expectedSnapshot = {
      ...read.sourceSnapshot,
      channel: read.sourceSnapshot.channel.map((row) => ({
        ...row,
        next_doc_seq: docSeq + 1,
        updated_at: now,
      })),
      inputs: read.sourceSnapshot.inputs.map((row) => ({
        ...row,
        delivery_status: 'turn_started',
        delivery_reason: null,
      })),
    };
    if (JSON.stringify(postSnapshot) !== JSON.stringify(expectedSnapshot))
      throw new Error('Original Relay immutable source changed during projected writes');
    const status = checkedRows(context.run(frame, 'startStatus', statusBindings), 2);
    if (
      status.length !== 1 ||
      status[0]!.doc_seq !== docSeq ||
      status[0]!.direction !== 'system' ||
      status[0]!.type !== 'event.status' ||
      status[0]!.payload !== statusBindings.statusPayload ||
      status[0]!.envelope_hash !== envelopeHash ||
      status[0]!.envelope_bytes !== statusBindings.envelopeBytes ||
      status[0]!.received_at !== now ||
      status[0]!.provenance !== '{"source":"doc-channel-service"}' ||
      status[0]!.payload_pruned_at !== null ||
      status[0]!.coalesce_key !== null ||
      status[0]!.client_ts !== null
    )
      throw new Error('Original Relay durable projected status changed');
    const ledgerSnapshot = {
      batch: sourceRows('fullBatch', 2),
      receipt: sourceRows('fullReceipt', 2),
      deliveries: sourceRows('fullDeliveries', 101),
    };
    const expectedLedger = {
      batch: read.ledgerSnapshot.batch.map((row) => ({
        ...row,
        status: 'turn_started',
        attempt: read.priorAttempt + 1,
        updated_at: now,
        turn_id: bindings.turnId,
        error_code: null,
      })),
      receipt: read.ledgerSnapshot.receipt.map((row) => ({
        ...row,
        state: 'turn_started',
        dispatch_attempt_id: attemptId,
        dispatch_boot_epoch: context.bootEpoch,
        dispatch_claimed_at: now,
        turn_start_seq: turnStartSeq,
        turn_started_at: now,
      })),
      deliveries: read.ledgerSnapshot.deliveries.map((row) => ({
        ...row,
        status: 'turn_started',
        turn_id: bindings.turnId,
        reason: null,
        updated_at: now,
      })),
    };
    if (JSON.stringify(ledgerSnapshot) !== JSON.stringify(expectedLedger))
      throw new Error('Original Relay full ledger changed during projected writes');
    if (checkedRows(context.run(frame, 'queueRow', bindings), 2).length !== 0)
      throw new Error('Original Relay queue deletion did not persist');
    const postSourceHash = createHash('sha256').update(JSON.stringify(postSnapshot)).digest('hex');
    const startHint = Object.freeze({
      documentId: own.selector.documentId,
      eventId,
      docSeq,
      envelopeHash,
      direction: 'system' as const,
      type: 'event.status' as const,
      receivedAt: now,
    });
    context.commit(frame);
    if (!context.committed(frame)) throw new Error('Native Relay COMMIT UNKNOWN');
    result = Object.freeze({ kind: 'original-relay-native-claim' });
    context.claims.set(result, {
      owner: context.owner,
      frame,
      attemptId,
      receiptId: own.receiptId,
      selector: own.selector,
      bindings: Object.freeze({ ...bindings }),
      sourceHash: postSourceHash,
      principal,
      bindingId,
      ledgerSnapshot,
      startHint,
    });
    own.claimState = 'committed';
    frame = undefined;
  } catch (cause) {
    failed = true;
    first = cause;
  }
  if (frame) {
    const closed = context.rollback(frame);
    if (closed) own.claimState = 'rollback_closed';
    if (!closed && !failed) {
      failed = true;
      first = new Error('Native Relay claim closure UNKNOWN');
    }
  }
  if (failed) throw first;
  return result!;
}
