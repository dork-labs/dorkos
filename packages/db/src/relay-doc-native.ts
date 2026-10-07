/** Original protected native Relay fact/CAS sibling. No SDK authority or callback registrar. */
import { randomUUID, createHash } from 'node:crypto';
import {
  consumeRelayNativeConstruction,
  requireRelayNativeDatabase,
  type openProtectedRoomNativeDatabase,
} from './room-spend-native.js';
import type { RelayDocNativeOperation } from './relay-doc-statements.js';
type Native = ReturnType<typeof openProtectedRoomNativeDatabase>;
type Rows = readonly Readonly<Record<string, string | number | null>>[];
export type RelayNativeSelector = Readonly<{
  batchId: string;
  generation: string;
  documentId: string;
  routeId: string;
  scope: string;
  grantId: string;
  grantRevision: number;
  sessionId: string;
  agentId: string;
  runtime: string;
  agentPath: string;
  authorityDigest: string;
}>;
export interface OriginalRelayNativeFacts {
  readonly kind: 'original-relay-native-facts';
}
export interface OriginalRelayNativeClaim {
  readonly kind: 'original-relay-native-claim';
}
const facts = new WeakMap<
  OriginalRelayNativeFacts,
  {
    owner: OriginalRelayDocStorage;
    selector: RelayNativeSelector;
    hash: string;
    receiptId: string;
    consumed: boolean;
    claimState: 'unattempted' | 'unknown' | 'rollback_closed' | 'committed';
  }
>();
const claims = new WeakMap<
  OriginalRelayNativeClaim,
  {
    owner: OriginalRelayDocStorage;
    frame: object;
    attemptId: string;
    receiptId: string;
    settlementAttempted?: boolean;
    selector: RelayNativeSelector;
    bindings: Readonly<Record<string, string | number>>;
    sourceHash: string;
    principal: Rows;
    bindingId: string;
    ledgerSnapshot: { batch: Rows; receipt: Rows; deliveries: Rows };
    startHint: Readonly<{
      documentId: string;
      eventId: string;
      docSeq: number;
      envelopeHash: string;
      direction: 'system';
      type: 'event.status';
      receivedAt: string;
    }>;
  }
>();
function copySelector(value: RelayNativeSelector): RelayNativeSelector {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype)
    throw new Error('Original Relay selector DATA required');
  const keys = [
    'batchId',
    'generation',
    'documentId',
    'routeId',
    'scope',
    'grantId',
    'sessionId',
    'agentId',
    'runtime',
    'agentPath',
    'authorityDigest',
  ] as const;
  const result: Record<string, string | number> = {};
  for (const key of keys) {
    const slot = Object.getOwnPropertyDescriptor(value, key);
    if (
      !slot ||
      !('value' in slot) ||
      typeof slot.value !== 'string' ||
      !slot.value ||
      slot.value.length > 4096
    )
      throw new Error('Invalid original Relay selector');
    result[key] = slot.value;
  }
  const revision = Object.getOwnPropertyDescriptor(value, 'grantRevision');
  if (
    !revision ||
    !('value' in revision) ||
    !Number.isSafeInteger(revision.value) ||
    revision.value < 1
  )
    throw new Error('Invalid Relay grant revision');
  result.grantRevision = revision.value;
  if (
    !String(result.scope).startsWith('session:') ||
    String(result.scope).length <= 8 ||
    result.runtime !== 'claude-code'
  )
    throw new Error('Original Relay session/runtime required');
  return Object.freeze(result) as RelayNativeSelector;
}
/** Acquired native rows are bounded before encoding; SQLite's original result allocation is excluded. */
function checkedRows(value: unknown, limit: number): Rows {
  if (!Array.isArray(value) || value.length > limit) throw new Error('Native Relay row frontier');
  let bytes = 0;
  return Object.freeze(
    value.map((row) => {
      if (!row || Object.getPrototypeOf(row) !== Object.prototype)
        throw new Error('Native Relay row required');
      const copy: Record<string, string | number | null> = {};
      const keys = Object.keys(row);
      if (keys.length > 128) throw new Error('Native Relay field frontier');
      for (const key of keys) {
        const slot = Object.getOwnPropertyDescriptor(row, key);
        if (!slot || !('value' in slot)) throw new Error('Native Relay field DATA required');
        const field = slot.value;
        if (
          field !== null &&
          typeof field !== 'string' &&
          !(typeof field === 'number' && Number.isFinite(field))
        )
          throw new Error('Native Relay primitive required');
        bytes +=
          Buffer.byteLength(key) + (typeof field === 'string' ? Buffer.byteLength(field) : 16);
        if (bytes > 2097152) throw new Error('Native Relay byte frontier');
        copy[key] = field;
      }
      return Object.freeze(copy);
    })
  );
}
function orderedJson(value: unknown, depth = 0): unknown {
  if (depth > 64) throw new Error('Native Relay JSON depth frontier');
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return value;
  if (Array.isArray(value)) return value.map((item) => orderedJson(item, depth + 1));
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, orderedJson((value as Record<string, unknown>)[key], depth + 1)])
    );
  throw new Error('Native Relay JSON DATA required');
}
function checkedInput(row: Rows[number]): void {
  if (
    typeof row.payload !== 'string' ||
    Buffer.byteLength(row.payload) > 2097152 ||
    typeof row.event_id !== 'string' ||
    typeof row.type !== 'string' ||
    typeof row.envelope_hash !== 'string' ||
    row.direction !== 'upstream' ||
    row.payload_pruned_at !== null
  )
    throw new Error('Native Relay original input required');
  const envelope = {
    v: 1,
    id: row.event_id,
    type: row.type,
    payload: JSON.parse(row.payload),
    ...(row.coalesce_key === null ? {} : { coalesceKey: row.coalesce_key }),
    ...(row.client_ts === null ? {} : { ts: row.client_ts }),
  };
  const bytes = JSON.stringify(orderedJson(envelope));
  if (
    Buffer.byteLength(bytes) > 2097152 ||
    createHash('sha256').update(bytes).digest('hex') !== row.envelope_hash
  )
    throw new Error('Native Relay input envelope changed');
}
function iso(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value)
    throw new Error('Canonical native Relay time required');
  return parsed;
}
/** Constructed only by the original Db factory before public exposure. Fixed native calls are captured. */
export class OriginalRelayDocStorage {
  readonly #bootEpoch = randomUUID();
  readonly #begin: Native['beginRelayFrame'];
  readonly #run: Native['executeRelayFrame'];
  readonly #commit: Native['commitRelayFrame'];
  readonly #rollback: Native['rollbackRelayFrame'];
  readonly #committed: Native['committedRelayFrame'];
  constructor(native: Native) {
    consumeRelayNativeConstruction(native);
    this.#begin = native.beginRelayFrame;
    this.#run = native.executeRelayFrame;
    this.#commit = native.commitRelayFrame;
    this.#rollback = native.rollbackRelayFrame;
    this.#committed = native.committedRelayFrame;
  }
  #read(frame: object, selector: RelayNativeSelector, now: string) {
    const call = (
      op: Exclude<RelayDocNativeOperation, 'begin' | 'commit' | 'rollback'>,
      max: number
    ) => checkedRows(this.#run(frame, op, selector), max);
    const accepted = call('accepted', 2);
    const channel = call('channel', 2);
    const grant = call('grant', 2);
    const document = call('document', 2);
    const target = call('target', 2);
    const inputs = call('inputs', 101);
    if (
      accepted.length !== 1 ||
      channel.length !== 1 ||
      grant.length !== 1 ||
      document.length !== 1 ||
      target.length !== 1 ||
      !inputs.length ||
      inputs.length > 100
    )
      throw new Error('Original native Relay source unavailable');
    const ledgerSnapshot = {
      batch: call('fullBatch', 2),
      receipt: call('fullReceipt', 2),
      deliveries: call('fullDeliveries', 101),
    };
    if (
      ledgerSnapshot.batch.length !== 1 ||
      ledgerSnapshot.receipt.length !== 1 ||
      ledgerSnapshot.deliveries.length !== inputs.length
    )
      throw new Error('Original native Relay ledger membership changed');
    const ch = channel[0]!,
      g = grant[0]!,
      r = accepted[0]!;
    if (
      ch.closed_at !== null ||
      ch.scope !== selector.scope ||
      g.revoked_at !== null ||
      g.revision !== selector.grantRevision ||
      g.route_id !== selector.routeId ||
      g.target_agent_id !== selector.agentId ||
      g.target_session_id !== selector.sessionId ||
      g.target_runtime !== selector.runtime ||
      g.declaration_hash !== ch.declaration_hash ||
      g.manifest_hash !== ch.manifest_hash ||
      (g.expires_at !== null && (typeof g.expires_at !== 'string' || iso(g.expires_at) <= iso(now)))
    )
      throw new Error('Native Relay grant/channel changed');
    if (typeof g.limits !== 'string' || Buffer.byteLength(g.limits) > 16384)
      throw new Error('Native Relay approved limits required');
    const limits = JSON.parse(g.limits) as { turnsPerHour?: unknown };
    if (
      !limits ||
      Object.getPrototypeOf(limits) !== Object.prototype ||
      !Object.hasOwn(limits, 'turnsPerHour') ||
      !Number.isSafeInteger(limits.turnsPerHour) ||
      Number(limits.turnsPerHour) < 1 ||
      Number(limits.turnsPerHour) > 10
    )
      throw new Error('Native Relay approved route ceiling invalid');
    if (typeof r.input_event_ids !== 'string' || Buffer.byteLength(r.input_event_ids) > 16384)
      throw new Error('Native Relay immutable input selection required');
    const ids: unknown = JSON.parse(r.input_event_ids);
    if (
      !Array.isArray(ids) ||
      ids.length !== inputs.length ||
      ids.length > 100 ||
      new Set(ids).size !== ids.length ||
      !ids.every((id, index) => typeof id === 'string' && id === inputs[index]!.event_id)
    )
      throw new Error('Native Relay input selection changed');
    if (
      JSON.stringify(ledgerSnapshot.deliveries.map((row) => row.event_id).sort()) !==
      JSON.stringify([...ids].sort())
    )
      throw new Error('Original Relay delivery membership changed');
    for (let index = 0; index < inputs.length; index++) {
      const row = inputs[index]!;
      checkedInput(row);
      if (
        !Number.isSafeInteger(row.doc_seq) ||
        Number(row.doc_seq) < 1 ||
        (index > 0 && Number(row.doc_seq) <= Number(inputs[index - 1]!.doc_seq))
      )
        throw new Error('Native Relay input ordering changed');
    }
    if (
      !Number.isSafeInteger(r.attempt) ||
      Number(r.attempt) < 0 ||
      Number(r.attempt) >= Number.MAX_SAFE_INTEGER
    )
      throw new Error('Native Relay attempt ordinal invalid');
    if (
      typeof r.receipt_id !== 'string' ||
      typeof r.queue_message_id !== 'string' ||
      !r.queue_message_id ||
      !Number.isSafeInteger(ch.next_doc_seq) ||
      Number(ch.next_doc_seq) < 1 ||
      Number(ch.next_doc_seq) >= Number.MAX_SAFE_INTEGER
    )
      throw new Error('Original native Relay receipt/queue/sequence missing');
    return {
      ledgerSnapshot,
      sourceSnapshot: { channel, grant, document, target, inputs },
      hash: createHash('sha256')
        .update(
          JSON.stringify({ accepted, channel, grant, document, target, inputs, ledgerSnapshot })
        )
        .digest('hex'),
      sourceHash: createHash('sha256')
        .update(JSON.stringify({ channel, grant, document, target, inputs }))
        .digest('hex'),
      queueMessageId: r.queue_message_id,
      inputEventIds: JSON.stringify(ids),
      inputCount: inputs.length,
      docSeq: ch.next_doc_seq,
      receiptId: r.receipt_id,
      turnsPerHour: Number(limits.turnsPerHour),
      priorAttempt: Number(r.attempt),
    };
  }
  capture(selectorData: RelayNativeSelector, now: string): OriginalRelayNativeFacts {
    const selector = copySelector(selectorData);
    iso(now);
    let frame: object | undefined;
    let failed = false;
    let first: unknown;
    let result: OriginalRelayNativeFacts | undefined;
    try {
      frame = this.#begin();
      const read = this.#read(frame, selector, now);
      if (!this.#rollback(frame)) throw new Error('Native Relay capture rollback UNKNOWN');
      frame = undefined;
      result = Object.freeze({ kind: 'original-relay-native-facts' });
      facts.set(result, {
        owner: this,
        selector,
        ...read,
        consumed: false,
        claimState: 'unattempted',
      });
    } catch (cause) {
      failed = true;
      first = cause;
    }
    if (frame) {
      const closed = this.#rollback(frame);
      if (!closed && !failed) {
        failed = true;
        first = new Error('Native Relay capture closure UNKNOWN');
      }
    }
    if (failed) throw first;
    return result!;
  }
  /** Atomically consume original accepted receipt and charge its approved route before any SDK FIRST. */
  claim(
    token: OriginalRelayNativeFacts,
    now: string,
    turnsPerHour: number,
    bindingId: string,
    turnStartSeq: number
  ): OriginalRelayNativeClaim {
    const own = facts.get(token);
    if (!own || own.owner !== this || own.consumed)
      throw new Error('Original native Relay facts required');
    // One-use latch precedes all native work; refusal cannot be retried using this token.
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
      frame = this.#begin();
      const read = this.#read(frame, own.selector, now);
      const principal = checkedRows(
        this.#run(frame, 'principal', { ...own.selector, bindingId, now }),
        2
      );
      if (principal.length !== 1) throw new Error('Native Relay principal changed');
      if (
        read.hash !== own.hash ||
        read.receiptId !== own.receiptId ||
        read.turnsPerHour !== turnsPerHour
      )
        throw new Error('Native Relay source changed after preparation');
      const count = this.#run(frame, 'routeCharges', {
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
          bootEpoch: this.#bootEpoch,
          now,
          priorAttempt: read.priorAttempt,
          expectedAttempt: read.priorAttempt + 1,
          turnStartSeq,
          turnId: `projected:${own.receiptId}:${turnStartSeq}`,
          queueMessageId: read.queueMessageId,
        };
      for (const operation of ['claimReceipt', 'claimBatch'] as const) {
        const changed = this.#run(frame, operation, bindings) as { changes?: unknown } | undefined;
        if (changed?.changes !== 1) throw new Error('Original native Relay claim CAS refused');
      }
      const claimed = checkedRows(this.#run(frame, 'claimed', bindings), 2);
      if (claimed.length !== 1) throw new Error('Native Relay final receipt claim changed');
      const sourceRows = (
        operation: Exclude<RelayDocNativeOperation, 'begin' | 'commit' | 'rollback'>,
        max: number
      ) => checkedRows(this.#run(frame!, operation, own.selector), max);
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
        this.#run(frame, 'principal', { ...own.selector, bindingId, now }),
        2
      );
      if (
        finalPrincipal.length !== 1 ||
        JSON.stringify(finalPrincipal) !== JSON.stringify(principal)
      )
        throw new Error('Native Relay final principal changed');
      const queue = checkedRows(this.#run(frame, 'queueRow', bindings), 2);
      if (queue.length !== 1) throw new Error('Original Relay accepted queue row changed');
      for (const operation of ['removeQueue', 'startReceipt', 'startBatch'] as const) {
        const changed = this.#run(frame, operation, bindings) as { changes?: unknown } | undefined;
        if (changed?.changes !== 1) throw new Error('Original Relay projected start CAS refused');
      }
      const deliveries = this.#run(frame, 'startDeliveries', {
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
        const changed = this.#run(frame, operation, statusBindings) as
          { changes?: unknown } | undefined;
        if (changed?.changes !== 1) throw new Error('Original Relay start status append raced');
      }
      if (checkedRows(this.#run(frame, 'started', bindings), 2).length !== 1)
        throw new Error('Original Relay final projected receipt changed');
      // Check original target/grant/principal again after every actual native write.
      const postPrincipal = checkedRows(
        this.#run(frame, 'principal', { ...own.selector, bindingId, now }),
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
      const status = checkedRows(this.#run(frame, 'startStatus', statusBindings), 2);
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
          dispatch_boot_epoch: this.#bootEpoch,
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
      if (checkedRows(this.#run(frame, 'queueRow', bindings), 2).length !== 0)
        throw new Error('Original Relay queue deletion did not persist');
      const postSourceHash = createHash('sha256')
        .update(JSON.stringify(postSnapshot))
        .digest('hex');
      const startHint = Object.freeze({
        documentId: own.selector.documentId,
        eventId,
        docSeq,
        envelopeHash,
        direction: 'system' as const,
        type: 'event.status' as const,
        receivedAt: now,
      });
      this.#commit(frame);
      if (!this.#committed(frame)) throw new Error('Native Relay COMMIT UNKNOWN');
      result = Object.freeze({ kind: 'original-relay-native-claim' });
      claims.set(result, {
        owner: this,
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
      const closed = this.#rollback(frame);
      if (closed) own.claimState = 'rollback_closed';
      if (!closed && !failed) {
        failed = true;
        first = new Error('Native Relay claim closure UNKNOWN');
      }
    }
    if (failed) throw first;
    return result!;
  }
  /** Fixed terminal ledger CAS, called only after original server closed-turn correlation. */
  settle(
    token: OriginalRelayNativeClaim,
    now: string,
    outcome: 'completed' | 'failed' | 'blocked'
  ) {
    const own = claims.get(token);
    if (!own || own.owner !== this || own.settlementAttempted)
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
      frame = this.#begin();
      const read = (
        operation: Exclude<RelayDocNativeOperation, 'begin' | 'commit' | 'rollback'>,
        max: number
      ) => checkedRows(this.#run(frame!, operation, own.selector), max);
      const before = {
        batch: read('fullBatch', 2),
        receipt: read('fullReceipt', 2),
        deliveries: read('fullDeliveries', 101),
      };
      if (
        JSON.stringify(before.batch) !== JSON.stringify(own.ledgerSnapshot.batch) ||
        JSON.stringify(before.receipt) !== JSON.stringify(own.ledgerSnapshot.receipt) ||
        before.deliveries.length !== own.ledgerSnapshot.deliveries.length ||
        checkedRows(this.#run(frame, 'queueRow', own.bindings), 2).length
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
        const changed = this.#run(frame, operation, bindings) as { changes?: unknown } | undefined;
        if (changed?.changes !== 1) throw new Error('Original Relay terminal CAS refused');
      }
      const changed = this.#run(frame, 'settleDeliveries', { ...bindings, inputEventIds: ids }) as
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
          const write = this.#run(frame, operation, statusBindings) as
            { changes?: unknown } | undefined;
          if (write?.changes !== 1) throw new Error('Original Relay terminal status append raced');
        }
        const event = checkedRows(this.#run(frame, 'startStatus', statusBindings), 2);
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
        checkedRows(this.#run(frame, 'queueRow', own.bindings), 2).length
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
      this.#commit(frame);
      if (!this.#committed(frame)) throw new Error('Original Relay terminal COMMIT UNKNOWN');
      frame = undefined;
    } catch (cause) {
      failed = true;
      first = cause;
    }
    if (frame) {
      try {
        const closed = this.#rollback(frame);
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
  /** Fresh original claimed state read; it does not report SDK FIRST or certify process start. */
  requireClaimCurrent(token: OriginalRelayNativeClaim, now: string): void {
    const own = claims.get(token);
    if (!own || own.owner !== this) throw new Error('Original native Relay claim required');
    const at = iso(now);
    let frame: object | undefined;
    let failed = false;
    let first: unknown;
    try {
      frame = this.#begin();
      const claimed = checkedRows(this.#run(frame, 'started', own.bindings), 2);
      if (claimed.length !== 1) throw new Error('Original claimed Relay receipt changed');
      const ledger = {
        batch: checkedRows(this.#run(frame, 'fullBatch', own.selector), 2),
        receipt: checkedRows(this.#run(frame, 'fullReceipt', own.selector), 2),
        deliveries: checkedRows(this.#run(frame, 'fullDeliveries', own.selector), 101),
      };
      if (
        JSON.stringify(ledger) !== JSON.stringify(own.ledgerSnapshot) ||
        checkedRows(this.#run(frame, 'queueRow', own.bindings), 2).length !== 0
      )
        throw new Error('Original claimed Relay full ledger/queue changed');
      const rows = (
        operation: Exclude<RelayDocNativeOperation, 'begin' | 'commit' | 'rollback'>,
        max: number
      ) => checkedRows(this.#run(frame!, operation, own.selector), max);
      const channel = rows('channel', 2),
        grant = rows('grant', 2),
        document = rows('document', 2),
        target = rows('target', 2),
        inputs = rows('inputs', 101);
      if (
        channel.length !== 1 ||
        grant.length !== 1 ||
        document.length !== 1 ||
        target.length !== 1 ||
        inputs.length < 1 ||
        inputs.length > 100
      )
        throw new Error('Original claimed Relay source absent');
      const hash = createHash('sha256')
        .update(JSON.stringify({ channel, grant, document, target, inputs }))
        .digest('hex');
      if (hash !== own.sourceHash) throw new Error('Original claimed Relay source changed');
      const expiry = grant[0]!.expires_at;
      if (expiry !== null && (typeof expiry !== 'string' || iso(expiry) <= at))
        throw new Error('Original claimed Relay grant expired');
      const principal = checkedRows(
        this.#run(frame, 'principal', { ...own.selector, bindingId: own.bindingId, now }),
        2
      );
      if (principal.length !== 1 || JSON.stringify(principal) !== JSON.stringify(own.principal))
        throw new Error('Original claimed Relay principal changed');
      if (!this.#rollback(frame))
        throw new Error('Original claimed Relay current read closure UNKNOWN');
      frame = undefined;
    } catch (cause) {
      failed = true;
      first = cause;
    }
    if (frame) {
      const closed = this.#rollback(frame);
      if (!closed && !failed) {
        failed = true;
        first = new Error('Original claimed Relay closure UNKNOWN');
      }
    }
    if (failed) throw first;
  }
}

export interface ServerNativeRelayConstruction {
  readonly kind: 'server-native-relay-construction';
}
export interface FixedNativeRelayFacts {
  capture(selector: RelayNativeSelector, now: string): OriginalRelayNativeFacts;
  claim(
    facts: OriginalRelayNativeFacts,
    now: string,
    turnsPerHour: number,
    bindingId: string,
    turnStartSeq: number
  ): OriginalRelayNativeClaim;
  readCommittedStartHint(claim: OriginalRelayNativeClaim): Readonly<{
    documentId: string;
    eventId: string;
    docSeq: number;
    envelopeHash: string;
    direction: 'system';
    type: 'event.status';
    receivedAt: string;
  }>;
  settle(
    claim: OriginalRelayNativeClaim,
    now: string,
    outcome: 'completed' | 'failed' | 'blocked'
  ): ReturnType<OriginalRelayDocStorage['settle']>;
  requireClosed(): void;
  requireKnownNoClaim(facts: OriginalRelayNativeFacts): void;
  requireClaimCurrent(claim: OriginalRelayNativeClaim, now: string): void;
}
const originalConstructions = new WeakMap<
  ServerNativeRelayConstruction,
  { native: Native; db?: object; consumed: boolean; facade: FixedNativeRelayFacts }
>();
/** Original factory only. Exact SAME native Db must be wrapped before single consuming assembly. */
export function constructOriginalRelayDocStorage(native: Native) {
  const storage = new OriginalRelayDocStorage(native);
  const requireClosed = native.requireRelayFramesClosed;
  const capture = storage.capture.bind(storage),
    claim = storage.claim.bind(storage),
    requireClaimCurrent = storage.requireClaimCurrent.bind(storage);
  const settle = storage.settle.bind(storage);
  const facade = Object.freeze({
    capture,
    claim,
    requireClaimCurrent,
    requireClosed,
    settle,
    readCommittedStartHint(token: OriginalRelayNativeClaim) {
      const own = claims.get(token);
      if (!own || own.owner !== storage) throw new Error('Original committed Relay hint required');
      return own.startHint;
    },
    requireKnownNoClaim(token: OriginalRelayNativeFacts) {
      const own = facts.get(token);
      if (
        !own ||
        own.owner !== storage ||
        (own.claimState !== 'unattempted' && own.claimState !== 'rollback_closed')
      )
        throw new Error('Original native Relay no-claim closure UNKNOWN');
    },
  });
  const token: ServerNativeRelayConstruction = Object.freeze({
    kind: 'server-native-relay-construction',
  });
  const own = { native, db: undefined as object | undefined, consumed: false, facade };
  originalConstructions.set(token, own);
  return Object.freeze({
    serverNativeRelayConstruction: token,
    bindOriginalWrappedDb(db: object) {
      if (own.db) throw new Error('Original Relay database already bound');
      requireRelayNativeDatabase(native, db);
      own.db = db;
    },
  });
}
/** Consume the once-only Relay construction bound to this exact database handle. */
export function consumeServerNativeRelayConstruction(
  token: ServerNativeRelayConstruction,
  db: object
): FixedNativeRelayFacts {
  const own = originalConstructions.get(token);
  if (!own || own.consumed || own.db !== db)
    throw new Error('Original Relay construction unavailable');
  requireRelayNativeDatabase(own.native, db);
  own.consumed = true;
  return own.facade;
}
