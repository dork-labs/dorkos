/** A read-aloud fingerprint of a full server-owned binding hash. Never a credential. */
import { createHash } from 'node:crypto';

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Derive twelve base-30 digits from all of the bound hash, grouped for comparison. */
export function requestCodeForHash(fullHash: string): string {
  const digest = createHash('sha256').update('dorkos.request-code.v1\0').update(fullHash).digest();
  let value = digest.readBigUInt64BE(0);
  let code = '';
  for (let digit = 0; digit < 12; digit++) {
    code = ALPHABET[Number(value % 30n)] + code;
    value /= 30n;
  }
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
}
