/**
 * The local space's id (ADR 261122-124821, decision 6).
 *
 * A local install is a space of its own: its rooms, agents and chats live in
 * it. Minting that space an id of its own at first run, beside the install id,
 * lets those rooms later move into a hub as themselves, and keeps "where the
 * thing lives" (the space) a different kind from "which computer runs it" (the
 * host). It is a ULID stored as one line in `<dorkHome>/space-id`.
 *
 * Unlike the install id (`lib/instance-id.ts`), this id is meant to be seen: a
 * signature names the space a write came from. The raw install id never goes
 * there, so the two must stay separate files with separate values.
 *
 * **Minted once, never rewritten.** Every reference to something in this space
 * carries the id, so replacing it would re-key them all. Only a missing file is
 * minted. A file that exists but is unreadable or does not hold a ULID is left
 * alone and the id reads as absent, which costs a signature its `space` field
 * and nothing else. This is where it parts from the install id helper, which
 * writes a fresh UUID over an empty or unreadable file: that id is an anonymous
 * de-duplication key and losing it costs nothing.
 *
 * @module lib/identity/space-id
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ulid } from 'ulidx';

/** File name (under dorkHome) holding the local space's ULID. */
export const SPACE_ID_FILENAME = 'space-id';

/** Crockford base32, 26 characters: what `ulid()` mints. */
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** What the file says: a valid id, nothing usable, or no file at all. */
type SpaceIdRead = { kind: 'id'; id: string } | { kind: 'unusable' } | { kind: 'missing' };

async function readSpaceIdFile(filePath: string): Promise<SpaceIdRead> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'unusable' };
  }
  const id = raw.trim();
  return ULID_PATTERN.test(id) ? { kind: 'id', id } : { kind: 'unusable' };
}

/**
 * Create the file with a fresh id, unless something else created it first.
 *
 * The id is written to a private temporary file and then hard-linked into
 * place: the link appears whole or not at all, and fails with `EEXIST` when
 * another process won the race, so two first reads at once still agree on one
 * id. A filesystem with no hard links (exFAT, some network shares) falls back
 * to an exclusive create, which never overwrites either.
 */
async function mintSpaceId(dorkHome: string, filePath: string): Promise<void> {
  await fs.mkdir(dorkHome, { recursive: true });
  const id = ulid();
  const temporary = path.join(dorkHome, `.${SPACE_ID_FILENAME}-${randomUUID()}`);
  try {
    await fs.writeFile(temporary, id, { encoding: 'utf8', flag: 'wx' });
    try {
      await fs.link(temporary, filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') return;
      if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP') throw error;
      await fs.writeFile(filePath, id, { encoding: 'utf8', flag: 'wx' }).catch((fallback) => {
        if ((fallback as NodeJS.ErrnoException).code !== 'EEXIST') throw fallback;
      });
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/**
 * Read the local space's id, minting and saving one the first time it is read.
 *
 * Never throws and never rewrites an existing file: a file that is unreadable
 * or holds anything but a ULID, or a mint that cannot be saved, reads as
 * `undefined` (absent), so a caller leaves the space out rather than guessing.
 *
 * @param dorkHome - The resolved dorkHome path (`lib/dork-home.ts`).
 * @returns The space's ULID, or `undefined` when it cannot be read or saved.
 */
export async function getOrCreateSpaceId(dorkHome: string): Promise<string | undefined> {
  const filePath = path.join(dorkHome, SPACE_ID_FILENAME);
  const first = await readSpaceIdFile(filePath);
  if (first.kind === 'id') return first.id;
  if (first.kind === 'unusable') return undefined;
  try {
    await mintSpaceId(dorkHome, filePath);
  } catch {
    return undefined;
  }
  // Read back rather than trust the mint: a racing process may have won.
  const settled = await readSpaceIdFile(filePath);
  return settled.kind === 'id' ? settled.id : undefined;
}
