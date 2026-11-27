/**
 * The work graph reads' page cursor: where a page stopped, sealed so the
 * caller can't read it (AES-256-GCM, under a key this process makes when it
 * starts). Where a page stops can be a chat the reader may not read (the
 * last binding an `agent_chats` scan stopped at, a joint a tree page ended
 * on), so it must never be readable from the cursor (Security, DOR-4970):
 *
 * - **Bound to its reader.** The cursor seals the key the reader is known by
 *   (the owner, or an agent's account id, as `readerFor` names it), and any
 *   other reader's cursor is refused, so a cursor can't be handed to another
 *   agent to learn more.
 * - **One size.** What it holds is padded to a fixed length before it is
 *   sealed, so its size says nothing of counts, offsets or ids.
 *
 * A cursor this process did not seal is refused `INVALID_CURSOR`, never read
 * as the first page. So one from before a restart is too: the caller starts
 * again.
 *
 * @module services/work-graph/reads/page-cursor
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { invalidCursor } from '../../../lib/paging/keyset-page.js';
import type { AuditReader } from '../../audit/visibility.js';

/** This process's cursor key. */
const KEY = randomBytes(32);
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** The length a cursor's contents are padded to, unless a read needs more. */
export const PAGE_CURSOR_BYTES = 512;

/** The key a reader's cursors are bound to. */
function readerKey(reader: AuditReader): string {
  return reader.kind === 'owner' ? 'owner' : `agent:${reader.accountId}`;
}

/**
 * The cursor for where a page stopped.
 *
 * @param reader - Who got the page; only they may go on from it.
 * @param position - Where it stopped, as JSON.
 * @param bytes - The fixed length its contents are padded to.
 * @throws {Error} When the position does not fit, which is a bug in the caller.
 */
export function encodePageCursor(
  reader: AuditReader,
  position: unknown,
  bytes: number = PAGE_CURSOR_BYTES
): string {
  const text = Buffer.from(JSON.stringify([readerKey(reader), position]), 'utf8');
  if (text.length > bytes) throw new Error('A page cursor outgrew its fixed length.');
  const padded = Buffer.concat([text, Buffer.alloc(bytes - text.length, 0x20)]);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv, { authTagLength: TAG_BYTES });
  const sealed = Buffer.concat([cipher.update(padded), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString('base64url');
}

/**
 * Where a page stopped, as its cursor holds it, for the reader it was given to.
 *
 * @param reader - Who sends it.
 * @param cursor - The cursor as sent.
 * @param bytes - The fixed length its contents were padded to.
 * @returns The position, as JSON for the caller to check.
 * @throws {CapabilityToolError} `INVALID_CURSOR` for a cursor this process did
 *   not seal, of another length, or given to another reader.
 */
export function decodePageCursor(
  reader: AuditReader,
  cursor: string,
  bytes: number = PAGE_CURSOR_BYTES
): unknown {
  const parts = cursorLayout(Buffer.from(cursor, 'base64url'));
  if (!parts || parts.body.length !== bytes) throw invalidCursor();
  try {
    const decipher = createDecipheriv('aes-256-gcm', KEY, parts.iv, { authTagLength: TAG_BYTES });
    decipher.setAuthTag(parts.tag);
    const opened = Buffer.concat([decipher.update(parts.body), decipher.final()]).toString('utf8');
    const parsed: unknown = JSON.parse(opened);
    if (Array.isArray(parsed) && parsed.length === 2 && parsed[0] === readerKey(reader)) {
      return parsed[1];
    }
  } catch {
    // Falls through to the refusal.
  }
  throw invalidCursor();
}

/**
 * A sealed cursor's three parts, or `null` for one too short to hold a whole
 * IV and tag (28 bytes), which is refused before anything is decrypted.
 *
 * @param raw - The cursor's bytes.
 */
export function cursorLayout(raw: Buffer): { iv: Buffer; tag: Buffer; body: Buffer } | null {
  if (raw.length < IV_BYTES + TAG_BYTES) return null;
  return {
    iv: raw.subarray(0, IV_BYTES),
    tag: raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES),
    body: raw.subarray(IV_BYTES + TAG_BYTES),
  };
}

/**
 * A position of two strings, or the refusal.
 *
 * @param position - What {@link decodePageCursor} returned.
 */
export function pairOf(position: unknown): [string, string] {
  if (
    Array.isArray(position) &&
    position.length === 2 &&
    typeof position[0] === 'string' &&
    typeof position[1] === 'string'
  ) {
    return [position[0], position[1]];
  }
  throw invalidCursor();
}
