import { createHash } from 'node:crypto';
import type { openProtectedRoomNativeDatabase } from './room-spend-native.js';
import type { RelayDocNativeOperation } from './relay-doc-statements.js';

export type Native = ReturnType<typeof openProtectedRoomNativeDatabase>;
export type Rows = readonly Readonly<Record<string, string | number | null>>[];
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
/** Validate and freeze a bounded copy of the original Relay selector data. */
export function copySelector(value: RelayNativeSelector): RelayNativeSelector {
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
export function checkedRows(value: unknown, limit: number): Rows {
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
/** Canonicalize bounded JSON data by recursively ordering plain-object keys. */
export function orderedJson(value: unknown, depth = 0): unknown {
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
/** Verify the original upstream input envelope against its stored hash and size limits. */
export function checkedInput(row: Rows[number]): void {
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
/** Parse a canonical ISO timestamp, refusing invalid or differently formatted values. */
export function iso(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value)
    throw new Error('Canonical native Relay time required');
  return parsed;
}
/** Read and validate the bounded original Relay source, ledger membership and current grant. */
export function readOriginalRelaySource(
  run: Native['executeRelayFrame'],
  frame: object,
  selector: RelayNativeSelector,
  now: string
) {
  const call = (
    op: Exclude<RelayDocNativeOperation, 'begin' | 'commit' | 'rollback'>,
    max: number
  ) => checkedRows(run(frame, op, selector), max);
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
