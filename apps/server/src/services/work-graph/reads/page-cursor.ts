/**
 * The work graph reads' page cursor: the sort key of a page's last row, two
 * strings, opaque to the caller. A cursor this read did not write is refused
 * `INVALID_CURSOR`, never read as the first page.
 *
 * @module services/work-graph/reads/page-cursor
 */
import { CapabilityToolError } from '../../core/capabilities/index.js';

/**
 * The cursor for a sort key.
 *
 * @param key - The last row's key.
 */
export function encodePageCursor(key: readonly [string, string]): string {
  return Buffer.from(JSON.stringify(key)).toString('base64url');
}

/**
 * The sort key a cursor holds.
 *
 * @param cursor - The cursor as sent.
 * @throws {CapabilityToolError} `INVALID_CURSOR` for a cursor this read did not write.
 */
export function decodePageCursor(cursor: string): [string, string] {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string'
    ) {
      return [parsed[0], parsed[1]];
    }
  } catch {
    // Falls through to the refusal.
  }
  throw new CapabilityToolError({
    code: 'INVALID_CURSOR',
    error: 'That cursor was not given by this list. Leave it out to start again.',
  });
}
