/**
 * A page cursor the caller can't read: where a page stopped, sealed with
 * AES-256-GCM under a key this process makes when it starts. A list whose rows
 * can be private to some readers uses it, because a page can stop on a row the
 * reader may not read, and that must never be readable from the cursor
 * (Security, DOR-4970):
 *
 * - **Bound to its reader.** The cursor seals the key the reader is known by,
 *   and a cursor sealed for any other reader does not open, so a cursor can't
 *   be handed to another agent to learn more.
 * - **One size.** What it holds is padded to a fixed length before it is
 *   sealed, so its size says nothing of counts, offsets or ids.
 *
 * A cursor this process did not seal does not open, so neither does one from
 * before a restart: the caller starts again. The work graph reads
 * (`services/work-graph/reads/page-cursor.ts`) and the chat lists
 * (`keyset-page.ts`, given a reader) both seal here.
 *
 * @module lib/paging/sealed-cursor
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** This process's cursor key. */
const KEY = randomBytes(32);
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** The length a cursor's contents are padded to, unless a read needs more. */
export const PAGE_CURSOR_BYTES = 512;

/**
 * The key a reader's cursors are bound to: the owner, or an agent's account
 * id (an `AuditReader`, `services/audit/visibility.ts`).
 *
 * @param reader - Who is reading.
 */
export function readerKey(
  reader: { readonly kind: 'owner' } | { readonly kind: 'agent'; readonly accountId: string }
): string {
  return reader.kind === 'owner' ? 'owner' : `agent:${reader.accountId}`;
}

/**
 * The cursor for where a page stopped.
 *
 * @param boundTo - The key of the reader who got the page; only they may go on from it.
 * @param position - Where it stopped, as JSON.
 * @param bytes - The fixed length its contents are padded to.
 * @throws {Error} When the position does not fit, which is a bug in the caller.
 */
export function sealCursor(
  boundTo: string,
  position: unknown,
  bytes: number = PAGE_CURSOR_BYTES
): string {
  const text = Buffer.from(JSON.stringify([boundTo, position]), 'utf8');
  if (text.length > bytes) throw new Error('A page cursor outgrew its fixed length.');
  const padded = Buffer.concat([text, Buffer.alloc(bytes - text.length, 0x20)]);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv, { authTagLength: TAG_BYTES });
  const sealed = Buffer.concat([cipher.update(padded), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString('base64url');
}

/**
 * Where a page stopped, as its cursor holds it, or null for a cursor this
 * process did not seal, of another length, or sealed for another reader.
 *
 * @param boundTo - The key of the reader who sends it.
 * @param cursor - The cursor as sent.
 * @param bytes - The fixed length its contents were padded to.
 */
export function openCursor(
  boundTo: string,
  cursor: string,
  bytes: number = PAGE_CURSOR_BYTES
): { position: unknown } | null {
  const parts = cursorLayout(Buffer.from(cursor, 'base64url'));
  if (!parts || parts.body.length !== bytes) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', KEY, parts.iv, { authTagLength: TAG_BYTES });
    decipher.setAuthTag(parts.tag);
    const opened = Buffer.concat([decipher.update(parts.body), decipher.final()]).toString('utf8');
    const parsed: unknown = JSON.parse(opened);
    if (Array.isArray(parsed) && parsed.length === 2 && parsed[0] === boundTo) {
      return { position: parsed[1] };
    }
  } catch {
    // Falls through to the refusal.
  }
  return null;
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
