/**
 * The local space's id (ADR 261122-124821, decision 6).
 *
 * A local install is a space of its own: its rooms, agents and chats live in
 * it. Minting that space an id of its own at first run, beside the install id,
 * lets those rooms later move into a hub as themselves, and keeps "where the
 * thing lives" (the space) a different kind from "which computer runs it" (the
 * host). It is a ULID stored as one line in `<dorkHome>/space-id`.
 *
 * **Read or minted once, at boot.** The startup step that opens the install id
 * (`startup/steps/core-stores.ts`) calls {@link loadLocalSpaceId}, so "first
 * run" is the first boot. The value is then held here for the life of the
 * process, and a turn reads only the held value ({@link localSpaceId}): no
 * turn touches the file, and code that never booted (a unit test of a launch)
 * sees no space id and writes nothing.
 *
 * Unlike the install id (`lib/instance-id.ts`), this id is meant to be seen: a
 * signature names the space a write came from. The raw install id never goes
 * there, so the two must stay separate files with separate values.
 *
 * **Minted once, never rewritten.** Every reference to something in this space
 * carries the id, so replacing it would re-key them all. Only a missing file is
 * minted. A file that exists but is unreadable or does not hold a ULID is left
 * alone, logged once, and the id reads as absent, which costs a signature its
 * `space` field and nothing else. This is where it parts from the install id
 * helper, which writes a fresh UUID over an empty or unreadable file: that id
 * is an anonymous de-duplication key and losing it costs nothing.
 *
 * @module lib/identity/space-id
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ulid } from 'ulidx';
import { logger } from '../logger.js';

/** File name (under dorkHome) holding the local space's ULID. */
export const SPACE_ID_FILENAME = 'space-id';

/** Crockford base32, 26 characters: what `ulid()` mints. */
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Prefix of the temporary file a mint writes before linking it into place. */
const TEMP_PREFIX = `.${SPACE_ID_FILENAME}-`;

/** A temporary file this old belongs to a mint that died; a live one is milliseconds old. */
const STALE_TEMP_MS = 60_000;

/** What the file says: a valid id, nothing usable, or no file at all. */
type SpaceIdRead = { kind: 'id'; id: string } | { kind: 'unusable' } | { kind: 'missing' };

/** The id this process booted with, or `undefined` before boot or when unusable. */
let held: string | undefined;

/** Whether the unusable-file warning has been logged in this process. */
let warnedUnusable = false;

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

function warnUnusable(filePath: string): void {
  if (warnedUnusable) return;
  warnedUnusable = true;
  logger.warn(
    `[space-id] ${filePath} cannot be read as a space id; it is left as it is, and signatures omit the space`
  );
}

/** Remove temporary files that a mint which died part-way left behind. */
async function sweepStaleTemps(dorkHome: string): Promise<void> {
  const now = Date.now();
  const names = await fs.readdir(dorkHome).catch(() => [] as string[]);
  for (const name of names) {
    if (!name.startsWith(TEMP_PREFIX)) continue;
    const temp = path.join(dorkHome, name);
    const stat = await fs.stat(temp).catch(() => undefined);
    if (stat && now - stat.mtimeMs > STALE_TEMP_MS) await fs.rm(temp, { force: true });
  }
}

/**
 * Create the file with a fresh id, unless something else created it first.
 *
 * The id is written to a private temporary file and then hard-linked into
 * place: the link appears whole or not at all, and fails with `EEXIST` when
 * another process won the race, so two first reads at once still agree on one
 * id. Any other link failure (a filesystem with no hard links, such as exFAT or
 * some network shares) falls back to an exclusive create, which never
 * overwrites either.
 */
async function mintSpaceId(dorkHome: string, filePath: string): Promise<void> {
  await fs.mkdir(dorkHome, { recursive: true });
  await sweepStaleTemps(dorkHome);
  const id = ulid();
  const temporary = path.join(dorkHome, `${TEMP_PREFIX}${randomUUID()}`);
  try {
    await fs.writeFile(temporary, id, { encoding: 'utf8', flag: 'wx' });
    try {
      await fs.link(temporary, filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
      await fs.writeFile(filePath, id, { encoding: 'utf8', flag: 'wx' }).catch((fallback) => {
        if ((fallback as NodeJS.ErrnoException).code !== 'EEXIST') throw fallback;
      });
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/**
 * Read the local space's id from disk, minting and saving one if there is no
 * file yet. Boot calls this through {@link loadLocalSpaceId}; nothing on the
 * turn path does.
 *
 * Never throws and never rewrites an existing file: a file that is unreadable
 * or holds anything but a ULID (logged once per process), or a mint that
 * cannot be saved, reads as `undefined` (absent), so a caller leaves the space
 * out rather than guessing.
 *
 * @param dorkHome - The resolved dorkHome path (`lib/dork-home.ts`).
 * @returns The space's ULID, or `undefined` when it cannot be read or saved.
 */
export async function getOrCreateSpaceId(dorkHome: string): Promise<string | undefined> {
  const filePath = path.join(dorkHome, SPACE_ID_FILENAME);
  const first = await readSpaceIdFile(filePath);
  if (first.kind === 'id') return first.id;
  if (first.kind === 'unusable') {
    warnUnusable(filePath);
    return undefined;
  }
  try {
    await mintSpaceId(dorkHome, filePath);
  } catch {
    return undefined;
  }
  // Read back rather than trust the mint: a racing process may have won.
  const settled = await readSpaceIdFile(filePath);
  if (settled.kind === 'id') return settled.id;
  if (settled.kind === 'unusable') warnUnusable(filePath);
  return undefined;
}

/**
 * Read or mint the local space's id once, at boot, and hold it for every turn.
 *
 * @param dorkHome - The resolved dorkHome path (`lib/dork-home.ts`).
 * @returns The id now held, or `undefined` when it cannot be read or saved.
 */
export async function loadLocalSpaceId(dorkHome: string): Promise<string | undefined> {
  held = await getOrCreateSpaceId(dorkHome);
  return held;
}

/**
 * The local space's id as boot loaded it. `undefined` before
 * {@link loadLocalSpaceId} has run (any code that never booted the server) or
 * when the file could not be used. Never reads the disk.
 */
export function localSpaceId(): string | undefined {
  return held;
}

/**
 * Set the held id directly, or clear it with `undefined`. Boot goes through
 * {@link loadLocalSpaceId}; this exists so a test can put the process back to
 * "not booted" after loading one.
 *
 * @param id - The id to hold, or `undefined` for none.
 */
export function holdLocalSpaceId(id: string | undefined): void {
  held = id;
}
