import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';
import { createHash } from 'node:crypto';
const ref = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{22,64}$/.test(value);
const shapes = {
  'semantic-read': [],
  'semantic-resolve': ['lease', 'node'],
  'semantic-effect': ['lease', 'node', 'mode'],
  'semantic-edit-begin': ['edit', 'lease', 'node'],
  'semantic-edit-phase': ['edit', 'phase'],
  'semantic-edit-finish': ['edit'],
  'semantic-changes': [],
  'semantic-close': [],
};
/** Guest-local references correlate observations, never grant host authority. */
export function semanticCommand(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('GUEST_SEMANTIC_COMMAND');
  const fields = shapes[value.action];
  if (!fields) throw new Error('GUEST_SEMANTIC_ACTION');
  const keys = ['request', 'tabId', 'action', ...fields];
  if (
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key)) ||
    !Number.isSafeInteger(value.request) ||
    value.request < 1 ||
    !ref(value.tabId)
  )
    throw new Error('GUEST_SEMANTIC_COMMAND');
  for (const field of fields) {
    const row = value[field];
    if (
      field === 'mode'
        ? !['inspect', 'focus'].includes(row)
        : field === 'phase'
          ? !['idle', 'input', 'selection'].includes(row)
          : !ref(row)
    )
      throw new Error('GUEST_SEMANTIC_REFERENCE');
  }
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, value[key]])));
}
/** Only an already canonical-validated sanitized snapshot reaches this projection.
 * Native target IDs and the reader's synthetic identity are intentionally absent. */
export function guestSemanticSnapshot(snapshot) {
  const {
    semanticLeaseId,
    treeId,
    treeRevision,
    capturedAt,
    expiresInMs,
    rootRefs,
    nodes,
    focusedRef,
    focusState,
    focusRevision,
    completeness,
    reason,
  } = snapshot;
  return {
    guestLease: semanticLeaseId,
    treeRef: treeId,
    revision: treeRevision,
    capturedAt,
    expiresInMs,
    rootRefs,
    nodes,
    focusedRef,
    focusState,
    focusRevision,
    completeness,
    ...(reason === undefined ? {} : { reason }),
  };
}
/** One bounded original result, streamed as self-contained mux frames. Output
 * callbacks are captured once; no ACK is entered before every chunk returns. */
export async function sendSemanticResult(value, result, ports) {
  const sendFrame = ports.sendFrame.bind(ports),
    sendControl = ports.sendControl.bind(ports),
    guard = ports.guard.bind(ports);
  const bytes = Buffer.from(JSON.stringify(result), 'utf8');
  try {
    if (!bytes.length || bytes.length > 262144) throw new Error('GUEST_SEMANTIC_OUTPUT_BOUND');
    const sha256 = createHash('sha256').update(bytes).digest('hex'),
      chunks = Math.ceil(bytes.length / 61440);
    guard();
    await sendControl({
      event: 'semantic-result-begin',
      request: value.request,
      tabId: value.tabId,
      action: value.action,
      bytes: bytes.length,
      chunks,
      sha256,
    });
    // Once begin enters, drain this bounded original result even if its document
    // changes; final guard withholds success. Host retains/discards by occurrence.
    for (let sequence = 0; sequence < chunks; sequence++)
      await sendFrame(
        encodeSemanticChunk(
          { request: value.request, tabId: value.tabId, sequence },
          bytes.subarray(sequence * 61440, (sequence + 1) * 61440)
        )
      );
    await sendControl({
      event: 'semantic-result-end',
      request: value.request,
      tabId: value.tabId,
      sha256,
    });
    guard();
    await sendControl({
      event: 'semantic-completed',
      request: value.request,
      tabId: value.tabId,
      action: value.action,
    });
  } finally {
    bytes.fill(0);
  }
}
export const isSemanticAction = (value) =>
  typeof value === 'string' && Object.hasOwn(shapes, value);

export function encodeSemanticChunk(value, original) {
  if (
    Object.keys(value).sort().join(',') !== 'request,sequence,tabId' ||
    !Number.isSafeInteger(value.request) ||
    value.request < 1 ||
    !ref(value.tabId) ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 0 ||
    value.sequence > 4 ||
    !(original instanceof Uint8Array) ||
    !original.byteLength ||
    original.byteLength > 61440
  )
    throw new Error('GUEST_SEMANTIC_CHUNK');
  const metadata = Buffer.from(JSON.stringify({ type: 'semantic-result-chunk', ...value }));
  if (metadata.length > 512) throw new Error('GUEST_SEMANTIC_METADATA');
  const bytes = Buffer.alloc(4 + metadata.length + original.byteLength);
  bytes.writeUInt32BE(metadata.length);
  metadata.copy(bytes, 4);
  Buffer.from(original).copy(bytes, 4 + metadata.length);
  return bytes;
}
export function decodeSemanticChunk(original) {
  if (!(original instanceof Uint8Array) || original.byteLength < 5 || original.byteLength > 65536)
    throw new Error('GUEST_SEMANTIC_CHUNK');
  const bytes = Buffer.from(original),
    length = bytes.readUInt32BE(0);
  if (length < 1 || length > 512 || 4 + length >= bytes.length)
    throw new Error('GUEST_SEMANTIC_METADATA');
  const value = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(4, 4 + length))
  );
  if (
    Object.keys(value).sort().join(',') !== 'request,sequence,tabId,type' ||
    value.type !== 'semantic-result-chunk'
  )
    throw new Error('GUEST_SEMANTIC_METADATA');
  const metadata = { request: value.request, sequence: value.sequence, tabId: value.tabId },
    body = Buffer.from(bytes.subarray(4 + length));
  encodeSemanticChunk(metadata, body);
  return Object.freeze({ metadata: Object.freeze(value), bytes: body });
}
