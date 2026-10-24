import { createHash } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A name-based UUID, version 5 (RFC 4122 §4.3): SHA-1 over the namespace's 16 bytes and the
 * name's UTF-8 bytes, with the version and variant bits set.
 *
 * Import derives every restored row's ID as `uuidv5(importId, sourceId)`. The same import and
 * source ID always give the same result, so a resumed worker recomputes the IDs it already
 * used without a mapping table, and two imports of one export never share an ID because each
 * has its own namespace.
 */
export function uuidv5(namespace: string, name: string): string {
  if (!UUID.test(namespace)) throw new RangeError('The namespace must be a UUID');
  const bytes = createHash('sha1')
    .update(Buffer.from(namespace.replaceAll('-', ''), 'hex'))
    .update(name, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
