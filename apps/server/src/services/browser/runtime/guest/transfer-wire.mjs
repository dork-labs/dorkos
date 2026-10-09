import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';
const exact = (v, names) =>
  v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join(',') === names.split(',').sort().join(',');
const tab = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{22,64}$/.test(value);
const transfer = (value) => typeof value === 'string' && /^[a-f0-9]{48}$/.test(value);
export const TRANSFER_CHUNK = 64512;
export function transferCommand(value) {
  if (
    !value ||
    !Number.isSafeInteger(value.request) ||
    value.request < 1 ||
    !tab(value.tabId) ||
    !transfer(value.transfer)
  )
    throw new Error('GUEST_TRANSFER_COMMAND');
  if (
    value.action === 'upload-stage' &&
    exact(value, 'request,action,tabId,transfer,byteLength,sha256') &&
    Number.isSafeInteger(value.byteLength) &&
    value.byteLength > 0 &&
    value.byteLength <= 2097152 &&
    typeof value.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.sha256)
  )
    return Object.freeze({ ...value });
  if (
    [
      'upload-seal',
      'upload-arm',
      'upload-complete',
      'download-arm',
      'download-next',
      'transfer-close',
    ].includes(value.action) &&
    exact(value, 'request,action,tabId,transfer')
  )
    return Object.freeze({ ...value });
  throw new Error('GUEST_TRANSFER_COMMAND');
}
/** Uses the existing frame lane in its otherwise unused host→guest direction.
 * Fixed type discriminates guest→host transfer bytes from JPEG records. */
export function encodeTransferChunk(type, value, bytes) {
  if (
    !['upload-chunk', 'download-chunk'].includes(type) ||
    !exact(value, 'request,tabId,transfer,sequence') ||
    !Number.isSafeInteger(value.request) ||
    value.request < 1 ||
    !tab(value.tabId) ||
    !transfer(value.transfer) ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength > TRANSFER_CHUNK
  )
    throw new Error('GUEST_TRANSFER_CHUNK');
  const metadata = Buffer.from(JSON.stringify({ type, ...value }));
  if (metadata.length > 512) throw new Error('GUEST_TRANSFER_METADATA');
  const result = Buffer.alloc(4 + metadata.length + bytes.byteLength);
  result.writeUInt32BE(metadata.length);
  metadata.copy(result, 4);
  Buffer.from(bytes).copy(result, 4 + metadata.length);
  return result;
}
export function decodeTransferChunk(type, original) {
  if (!(original instanceof Uint8Array) || original.byteLength < 5 || original.byteLength > 65536)
    throw new Error('GUEST_TRANSFER_FRAME');
  const bytes = Buffer.from(original),
    length = bytes.readUInt32BE(0);
  if (length < 1 || length > 512 || 4 + length > bytes.length)
    throw new Error('GUEST_TRANSFER_METADATA');
  const value = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(4, 4 + length))
  );
  if (!exact(value, 'type,request,tabId,transfer,sequence') || value.type !== type)
    throw new Error('GUEST_TRANSFER_FRAME');
  const body = Buffer.from(bytes.subarray(4 + length));
  const scope = {
    request: value.request,
    tabId: value.tabId,
    transfer: value.transfer,
    sequence: value.sequence,
  };
  encodeTransferChunk(type, scope, body);
  return Object.freeze({ metadata: Object.freeze(value), bytes: body });
}
