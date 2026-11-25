/**
 * The work graph reads' page cursor: the sort key of a page's last row,
 * sealed so the caller can't read it (AES-256-GCM, under a key this process
 * makes when it starts). A key can name a chat the reader may not read (the
 * last binding an `agent_chats` scan stopped at, a joint a tree page ended
 * on), so it must never be readable from the cursor.
 *
 * A cursor this process did not seal is refused `INVALID_CURSOR`, never read
 * as the first page. So one from before a restart is too: the caller starts
 * again.
 *
 * @module services/work-graph/reads/page-cursor
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { CapabilityToolError } from '../../core/capabilities/index.js';

/** This process's cursor key. */
const KEY = randomBytes(32);
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * The cursor for a sort key.
 *
 * @param key - The last row's key: one string per part.
 */
export function encodePageCursor(key: readonly string[]): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const sealed = Buffer.concat([cipher.update(JSON.stringify(key), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString('base64url');
}

/**
 * The sort key a cursor holds.
 *
 * @param cursor - The cursor as sent.
 * @param parts - How many parts the key has.
 * @throws {CapabilityToolError} `INVALID_CURSOR` for a cursor this process did not seal.
 */
export function decodePageCursor(cursor: string, parts: number): string[] {
  try {
    const raw = Buffer.from(cursor, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', KEY, raw.subarray(0, IV_BYTES));
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    const opened = Buffer.concat([
      decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
    const parsed: unknown = JSON.parse(opened);
    if (
      Array.isArray(parsed) &&
      parsed.length === parts &&
      parsed.every((part) => typeof part === 'string')
    ) {
      return parsed as string[];
    }
  } catch {
    // Falls through to the refusal.
  }
  throw invalidCursor();
}

/** The refusal for a cursor this read can't go on from. */
export function invalidCursor(): CapabilityToolError {
  return new CapabilityToolError({
    code: 'INVALID_CURSOR',
    error: 'That cursor was not given by this list. Leave it out to start again.',
  });
}
